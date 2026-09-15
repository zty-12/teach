import type { Table } from 'dexie'
import { db, saveSettings, saveSettingsFull, DEFAULT_SETTINGS, planPointRuleOrderFixes } from './db'
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
  // v16：课堂积分
  'classActivities',
  'classActivityRecords',
]

export interface SyncResult {
  pushed: number
  pulled: number
  errors: string[]
}

/**
 * 云端 NOT NULL 列在本地老数据中可能整个字段都不存在
 * （典型：v16 时期建的课堂活动没有 v17 新增的 auto 字段）。
 *
 * PostgREST 批量 upsert 时，会把数组里「键不一致」的缺失键统一补成 null，
 * 于是触发 `null value in column "auto" ... violates not-null constraint`，
 * 导致该表整批推送失败。
 *
 * 这里在推送前按表补全默认值，作为本地数据迁移之外的第二道防线
 * （其它设备 / 未跑迁移的旧数据同样受益）。
 */
const PUSH_DEFAULTS: Partial<Record<SyncTableName, Record<string, unknown>>> = {
  // ⚠ PostgREST 批量 upsert 的坑：它用「整批对象键的并集」拼一条 INSERT，
  //   数组里缺某个键的行会被填成 **null**（而不是走列 DEFAULT）→ 若该列是 NOT NULL
  //   就报 `null value in column "x" violates not-null constraint`，**整张表推送失败**。
  //   故凡是「云端 NOT NULL + 本地可能整键缺失」的列，都要在这里兜底。
  //
  //   ⚠ 反例（不要兜底）：`classActivities.ruleIds` / `checkInTasks.ruleIds`
  //   的 `undefined` 与 `[]` **语义不同**（undefined = 沿用旧内嵌规则 / 回退全部启用规则；
  //   [] = 明确不引用任何规则）。若兜底成 [] 会把历史活动的规则清空、积分归零。
  //   这两列改为让**云端列可空**（见 supabase/schema.sql），缺键补 null 后
  //   `Array.isArray(null) === false` 仍走旧回退分支，语义正确。
  //
  // pointRules.kind 云端是 NOT NULL DEFAULT 'base'，而 v20 起新规则不再写该字段；
  // scope / mode 同理（旧规则可能整键缺失）——统一兜底，值取云端 DEFAULT。
  pointRules: {
    kind: 'base',
    scope: 'checkin',
    mode: 'auto',
  },
  classActivities: {
    auto: false,
    rules: [],
    note: '',
    title: '',
    groupId: null,
    activityDate: null,
    sourceCourseId: null,
    courseId: null,
  },
  classActivityRecords: {
    ledgerId: null,
    pointsAwarded: 0,
    note: '',
    status: 'pending',
    // v30.3：手动叠加规则列表（云端为 jsonb，缺键会被补成 null → 这里兜底空数组）
    manualRuleIds: [],
  },
  // v21/v30.4：云端 groups 有 6 个 NOT NULL 列，而 TS 类型里全是可选
  //           （v8~v21 之间创建的班课可能整键缺失）→ 缺键被补 null，整表推送失败
  //           （实测：`[groups] 推送失败: null value in column "checkInWeekdays"`）。
  //           这些字段的「缺省值」与「空值」语义等价（见各 resolve 处的守卫），兜底安全。
  groups: {
    checkInAuto: true,
    checkInDays: 7,
    checkInStartOffset: 1,
    checkInWeekdays: [],
    classActivityAuto: true,
    autoClassRuleIds: [],
  },
  checkInTasks: {
    auto: false,
    // days 缺省 [] = 「未指定」，下游用 dueAt 兜底（与 undefined 语义一致）
    days: [],
  },
  knowledgePoints: {
    // tags 云端 NOT NULL（下游 p.tags.map 无守卫，不能置空）
    tags: [],
  },
}

/** 对单条待推送记录补齐云端 NOT NULL 列的缺省值 */
function applyPushDefaults(
  table: SyncTableName,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const defaults = PUSH_DEFAULTS[table]
  if (!defaults) return row
  let patched = false
  const out: Record<string, unknown> = { ...row }
  for (const [key, value] of Object.entries(defaults)) {
    if (out[key] === undefined || out[key] === null) {
      out[key] = value
      patched = true
    }
  }
  return patched ? out : row
}

/**
 * v30.6：推送前对「云端 int4 列」做兜底归一化，避免整批 upsert 被 PostgREST 拒绝。
 *
 * 背景：pointRules."order" / "points" 是 integer（int4，上限 2147483647）。
 *   早期代码用 `order: Date.now()`（毫秒时间戳 ≈1.8e12）写入本地 IndexedDB，
 *   一旦本地残留此类脏值，推送时 PostgREST 报
 *   `value "1789311709042" is out of range for type integer` → **整张表推送失败**。
 *   复用 db.ts 的 planPointRuleOrderFixes（与 v15 迁移同源），保证「本地迁移」
 *   与「推送自愈」语义完全一致；同时把干净值写回本地，避免下次再推脏值。
 */
const INT4_MAX = 2147483647
const INT4_MIN = -2147483648
function sanitizeInt4ForPush(
  table: SyncTableName,
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (table !== 'pointRules') return rows
  const fixes = planPointRuleOrderFixes(rows)
  const orderById = new Map(fixes.map((f) => [String(f.id), f.order]))
  return rows.map((r) => {
    const out: Record<string, unknown> = { ...r }
    const id = String(out.id)
    if (orderById.has(id)) out.order = orderById.get(id)
    // points 同样为 int4：非有限整数 / 越界 → 归 0（正常分值不会触发此分支）
    const p = out.points
    if (typeof p !== 'number' || !Number.isFinite(p) || p > INT4_MAX || p < INT4_MIN) {
      out.points = 0
    } else {
      out.points = Math.trunc(p)
    }
    return out
  })
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

      // dirty 是本地字段，不上传；推送前先对 int4 列做兜底归一化（见 sanitizeInt4ForPush）
      const sanitized = sanitizeInt4ForPush(name, dirty)
      const payload = sanitized.map(({ dirty: _dirty, ...rest }) =>
        applyPushDefaults(name, rest),
      )

      const { error } = await client.from(name).upsert(payload, { onConflict: 'id' })
      if (error) {
        result.errors.push(`[${name}] 推送失败: ${error.message}`)
        continue
      }

      const pushed = sanitized.map((r) => ({ ...r, dirty: 0 }))
      await table.bulkPut(pushed as never[])
      result.pushed += dirty.length

      // 软删（deletedAt 非空）记录已成功推送到云端，本地物理清除墓碑，
      // 避免下次推送时重复上传，也回收 IndexedDB 空间（云端已留存删除标记）。
      const tombstoneIds = (pushed as Array<Record<string, unknown>>)
        .filter((r) => r.deletedAt)
        .map((r) => r.id as string)
      if (tombstoneIds.length) await table.bulkDelete(tombstoneIds)

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

/** 拉取时间重叠窗口：容忍写入端时钟与本机水位的偏差（LWW 合并会去重，重拉无害） */
const PULL_OVERLAP_MS = 5 * 60_000

/** 从云端拉取增量并合并到本地 */
export async function pullAll(settings?: AppSettings): Promise<SyncResult> {
  const result: SyncResult = { pushed: 0, pulled: 0, errors: [] }
  const client = getSupabase(settings)
  if (!client) return result

  for (const name of SYNC_TABLES) {
    try {
      const table = (db as unknown as Record<string, Table<never, string>>)[name]
      const meta = await db.syncMeta.get(name)
      const watermark = meta?.lastPulledAt ?? 0
      // 查询下界回拨一个重叠窗口：覆盖「写入端时钟略慢于水位」的记录
      const since = Math.max(0, watermark - PULL_OVERLAP_MS)

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
        // 远端墓碑 + 本地从未有过该行 → 不写回。
        // 否则 pushAll 刚清理掉的本地墓碑会被同一轮拉取写回来，清理形同虚设。
        if (!local && r.deletedAt) continue
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

      // 水位用「已见到的最大远端 updatedAt」推进，而不是本机时钟 ——
      // 否则写入端时钟慢于本机时，其记录会永远落在水位之下，被静默丢弃。
      // 同时封顶到本机当前时间，避免某台设备时钟超前把水位顶到未来、之后什么都拉不到。
      const maxRemote = remote.reduce(
        (m, r) => Math.max(m, (r.updatedAt as number) ?? 0),
        watermark,
      )
      await db.syncMeta.put({
        table: name,
        lastPulledAt: Math.min(maxRemote, Date.now()),
        lastPushedAt: meta?.lastPushedAt ?? 0,
      })
    } catch (e) {
      result.errors.push(`[${name}] 拉取异常: ${String(e)}`)
    }
  }

  return result
}

/**
 * 物理清除本地所有墓碑（deletedAt 非空）。
 *
 * 仅在**未配置云端**时使用：此时没有云端可「复活」，启动后清理一次即可，
 * 避免软删记录长期堆积。
 * ⚠️ 已配置云端时**不要**调用 —— 墓碑必须保留到推送成功，
 * 否则删除永远到不了云端（pushAll 会在推送成功后自行清理对应的墓碑）。
 */
export async function purgeTombstones(): Promise<number> {
  let total = 0
  for (const name of SYNC_TABLES) {
    try {
      const table = (db as unknown as Record<string, Table<never, string>>)[name]
      const rows = (await table.toArray()) as Array<{ id: string; deletedAt?: number | null }>
      const ids = rows.filter((r) => r.deletedAt).map((r) => r.id)
      if (ids.length === 0) continue
      await table.bulkDelete(ids)
      total += ids.length
    } catch {
      /* 单表异常不影响其它表 */
    }
  }
  return total
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