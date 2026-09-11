import type { Table } from 'dexie'
import { db, saveSettings, saveSettingsFull, DEFAULT_SETTINGS } from './db'
import { getSupabase, isSupabaseConfigured } from './supabase'
import { useSettings } from '@/store/useSettings'
import type { AppSettings, SyncTableName } from './types'

/**
 * 同步引擎（local-first）
 *
 * 策略：
 *  - 推送：把 dirty=1 的本地记录 upsert 到云端，成功后置 dirty=0
 *  - 拉取：拉取 updatedAt > lastPulledAt 的云端记录，远端 updatedAt 更大才覆盖本地
 *  - 冲突：last-write-wins（时间戳大者胜）
 *  - 删除：软删除（deletedAt 非空），随同步传播，保证多端一致
 *
 * 同步完成后会把 lastSyncAt 写回 settings（用于设置页展示）。
 */

export const SYNC_TABLES: SyncTableName[] = [
  'students',
  'groups',
  'groupMembers',
  'courses',
  'courseAttendances',
  'courseFeedbacks',
  'learningReports',
  'learningTags',
  'studentTags',
  'payments',
  'settlements',
  // v4/v5：知识库 / 反馈模板 / 打卡 / 积分 / 兑换
  'textbooks',
  'textbookUnits',
  'knowledgePoints',
  'feedbackTemplates',
  'courseKnowledges',
  'checkInTasks',
  'checkInRecords',
  'pointRules',
  'pointLedgers',
  'rewardItems',
  'redemptions',
  // v7：学生画像
  'studentProfiles',
  // v8：结构化反馈模板字段
  'feedbackTemplateFields',
]

export interface SyncResult {
  pushed: number
  pulled: number
  errors: string[]
}

/** 推送本地待同步记录到云端 */
export async function pushAll(settings?: AppSettings): Promise<SyncResult> {
  const result: SyncResult = { pushed: 0, pulled: 0, errors: [] }
  const client = getSupabase(settings)
  if (!client) return result

  for (const name of SYNC_TABLES) {
    try {
      const table = (db as unknown as Record<string, Table<never, string>>)[name]
      const dirty = (await table.where('dirty').equals(1).toArray()) as Record<string, unknown>[]
      if (dirty.length === 0) continue

      // dirty 是本地字段，不上传
      const payload = dirty.map(({ dirty: _dirty, ...rest }) => rest)

      const { error } = await client.from(name).upsert(payload, { onConflict: 'id' })
      if (error) {
        result.errors.push(`[${name}] 推送失败: ${error.message}`)
        continue
      }

      await table.bulkPut(dirty.map((r) => ({ ...r, dirty: 0 })) as never[])
      result.pushed += dirty.length

      await db.syncMeta.put({
        table: name,
        lastPulledAt: (await db.syncMeta.get(name))?.lastPulledAt ?? 0,
        lastPushedAt: Date.now(),
      })
    } catch (e) {
      result.errors.push(`[${name}] 推送异常: ${String(e)}`)
    }
  }

  return result
}

/** 从云端拉取增量并合并到本地 */
export async function pullAll(settings?: AppSettings): Promise<SyncResult> {
  const result: SyncResult = { pushed: 0, pulled: 0, errors: [] }
  const client = getSupabase(settings)
  if (!client) return result

  for (const name of SYNC_TABLES) {
    try {
      const table = (db as unknown as Record<string, Table<never, string>>)[name]
      const meta = await db.syncMeta.get(name)
      const since = meta?.lastPulledAt ?? 0

      const { data, error } = await client.from(name).select('*').gt('updatedAt', since)
      if (error) {
        result.errors.push(`[${name}] 拉取失败: ${error.message}`)
        continue
      }
      if (!data || data.length === 0) continue

      const remote = data as Record<string, unknown>[]
      const toPut: Record<string, unknown>[] = []

      for (const r of remote) {
        const id = r.id as string
        const local = (await table.get(id)) as Record<string, unknown> | undefined
        const localUpdated = (local?.updatedAt as number) ?? 0
        const remoteUpdated = (r.updatedAt as number) ?? 0

        // 远端更新更晚，或本地无此记录 → 采用远端
        if (!local || remoteUpdated > localUpdated) {
          toPut.push({ ...r, dirty: 0 })
        }
      }

      if (toPut.length > 0) {
        await table.bulkPut(toPut as never[])
        result.pulled += toPut.length
      }

      await db.syncMeta.put({
        table: name,
        lastPulledAt: Date.now(),
        lastPushedAt: meta?.lastPushedAt ?? 0,
      })
    } catch (e) {
      result.errors.push(`[${name}] 拉取异常: ${String(e)}`)
    }
  }

  return result
}

/** 完整同步：先推送后拉取（含设置同步，设置失败不影响业务表同步结果） */
export async function syncNow(settings?: AppSettings): Promise<SyncResult> {
  if (!isSupabaseConfigured(settings)) {
    return { pushed: 0, pulled: 0, errors: ['未配置 Supabase，当前为纯本地模式'] }
  }
  const push = await pushAll(settings)
  const pull = await pullAll(settings)

  // 设置同步：best-effort，云端缺 app_settings 表（未跑 v9）时只记错误不中断
  const settingsErrors = await syncSettings(settings)

  // 全部成功 → 写回 lastSyncAt
  if (push.errors.length === 0 && pull.errors.length === 0 && settingsErrors.length === 0) {
    await saveSettings({ lastSyncAt: Date.now() })
  }

  return {
    pushed: push.pushed,
    pulled: pull.pulled,
    errors: [...push.errors, ...pull.errors, ...settingsErrors],
  }
}

// ============================================================
// 设置云同步（app_settings 表，单行 id='app'）
//
// 策略：本地设置带 settingsUpdatedAt 修订时间戳（saveSettings 自动刷新），
// 双向比较修订号 last-write-wins：
//  - 本地修订 > 云端 → 推送整份设置（除 lastSyncAt）
//  - 云端修订 > 本地 → 拉取并整体覆盖本地（保留本地 lastSyncAt）
// ============================================================

/** 设置行在云端的 id */
const SETTINGS_ROW_ID = 'app'
/** syncMeta 里给设置行用的键 */
const SETTINGS_META_KEY = 'app_settings'

interface AppSettingsRow {
  id: string
  value: AppSettings
  updatedAt: number
}

/** 上传/下载时剥离本地运行时字段，避免无意义的修订号跳动 */
function sanitizeForCloud(s: AppSettings): AppSettings {
  const { lastSyncAt: _lastSyncAt, ...rest } = s
  return rest as AppSettings
}

async function syncSettings(settings?: AppSettings): Promise<string[]> {
  const errors: string[] = []
  try {
    const client = getSupabase(settings)
    if (!client) return errors

    const local = useSettings.getState().settings
    const meta = (await db.syncMeta.get(SETTINGS_META_KEY)) ?? {
      table: SETTINGS_META_KEY,
      lastPulledAt: 0,
      lastPushedAt: 0,
    }

    // 1) 推送：本地修订比上次推送时新
    if (local.settingsUpdatedAt > meta.lastPushedAt) {
      const payload: AppSettingsRow = {
        id: SETTINGS_ROW_ID,
        value: sanitizeForCloud(local),
        updatedAt: local.settingsUpdatedAt,
      }
      const { error } = await client.from('app_settings').upsert(payload, { onConflict: 'id' })
      if (error) {
        errors.push(`[设置] 推送失败: ${error.message}（若提示表不存在，请先在 SQL Editor 执行 supabase/migration-v9-app-settings.sql）`)
      } else {
        await db.syncMeta.put({ ...meta, lastPushedAt: local.settingsUpdatedAt })
      }
    }

    // 2) 拉取：云端修订比本地新 → 整体覆盖本地
    const { data, error } = await client
      .from('app_settings')
      .select('*')
      .eq('id', SETTINGS_ROW_ID)
      .maybeSingle()
    if (error) {
      // 表不存在等错误已在推送侧提示过，这里静默（避免重复刷屏）
      if (!errors.length) errors.push(`[设置] 拉取失败: ${error.message}`)
    } else if (data) {
      const remote = data as AppSettingsRow
      const remoteRev = typeof remote.updatedAt === 'number' ? remote.updatedAt : 0
      if (remoteRev > local.settingsUpdatedAt && remote.value) {
        const merged: AppSettings = {
          ...DEFAULT_SETTINGS,
          ...remote.value,
          // 本地运行时字段不跟云走
          lastSyncAt: local.lastSyncAt,
          settingsUpdatedAt: remoteRev,
        }
        await saveSettingsFull(merged)
        useSettings.getState().applyRemote(merged)
        // 本地修订号已对齐远端，记入推送标记避免下轮又被推回去
        const meta2 = (await db.syncMeta.get(SETTINGS_META_KEY)) ?? meta
        await db.syncMeta.put({ ...meta2, lastPushedAt: remoteRev })
      }
    }
  } catch (e) {
    errors.push(`[设置] 同步异常: ${String(e)}`)
  }
  return errors
}

/** 统计本地待推送记录数 */
export async function pendingCount(): Promise<number> {
  let total = 0
  for (const name of SYNC_TABLES) {
    const table = (db as unknown as Record<string, Table<never, string>>)[name]
    total += await table.where('dirty').equals(1).count()
  }
  return total
}