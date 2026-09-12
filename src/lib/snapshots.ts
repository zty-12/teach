import type { Table } from 'dexie'
import { db, newId, saveSettingsFull } from './db'
import { SYNC_TABLES } from './sync'
import { getSupabase } from './supabase'
import { useSettings } from '@/store/useSettings'
import type { DataSnapshot } from './types'

/**
 * 数据版本快照（v15）
 *
 * 目标：同步成功后自动留档，本地 + 云端双份，可回滚到任意历史版本。
 *
 * 设计要点：
 *  - **本地为主**：每次有变化的同步都往 `db.snapshots` 写一份（滚动保留最近 LOCAL_KEEP 个）；
 *    云端 `data_snapshots` 表另存一份（滚动保留 CLOUD_KEEP 个），用于跨设备恢复。
 *  - **签名去重**：签名 = 各表行数 + 各表最大 updatedAt + 设置修订号。
 *    数据没变化（如空跑的周期同步）不会产生重复版本。
 *  - **节流**：自动版本两次之间至少间隔 MIN_AUTO_INTERVAL，避免高频改动刷屏。
 *  - **恢复**：整体覆盖本地各表（保留 id，置 dirty=1 待重新推送），恢复前自动再存一份当前状态，可撤销。
 *  - 云端失败（未配置 / 表不存在 / 体积超限）只影响云端留档，本地版本始终可用。
 */

/** 本地保留的版本数 */
export const LOCAL_KEEP = 20
/** 云端保留的版本数 */
export const CLOUD_KEEP = 50
/** 自动版本最小间隔（ms） */
const MIN_AUTO_INTERVAL_MS = 60_000
/** 云端快照表名 */
const CLOUD_TABLE = 'data_snapshots'

export type SnapshotSource = 'local' | 'cloud' | 'both'

export interface SnapshotMeta {
  id: string
  createdAt: number
  label: string
  auto: boolean
  device: string
  counts: Record<string, number>
  /** 该版本存在于哪里 */
  source: SnapshotSource
}

function tableOf(name: string): Table<never, string> {
  return (db as unknown as Record<string, Table<never, string>>)[name]
}

/** 粗略识别当前端类型（用于区分设备） */
function deviceLabel(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/Android/i.test(ua)) return 'Android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac'
  if (/Windows/i.test(ua)) return 'Windows'
  return 'Web'
}

/** 汇总各表行数（轻量，用于展示与签名） */
async function collectCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const name of SYNC_TABLES) {
    try {
      counts[name] = await tableOf(name).count()
    } catch {
      counts[name] = 0
    }
  }
  return counts
}

/**
 * 计算内容签名：各表行数 + 各表最大 updatedAt + 设置修订号。
 * 覆盖「新增/删除（行数变）」与「编辑（updatedAt 变）」两类变化。
 */
async function computeSignature(counts: Record<string, number>): Promise<string> {
  const parts: string[] = []
  for (const name of SYNC_TABLES) {
    let maxUpdated = 0
    try {
      const last = await tableOf(name).orderBy('updatedAt').last()
      maxUpdated = (last as unknown as { updatedAt?: number } | undefined)?.updatedAt ?? 0
    } catch {
      maxUpdated = 0
    }
    parts.push(`${name}:${counts[name] ?? 0}:${maxUpdated}`)
  }
  const settingsRev = useSettings.getState().settings.settingsUpdatedAt ?? 0
  parts.push(`settings:${settingsRev}`)
  return parts.join('|')
}

/** 收集全量数据 */
async function collectPayload(): Promise<Record<string, unknown[]>> {
  const payload: Record<string, unknown[]> = {}
  for (const name of SYNC_TABLES) {
    try {
      payload[name] = (await tableOf(name).toArray()) as unknown[]
    } catch {
      payload[name] = []
    }
  }
  return payload
}

// ============================================================
// 云端映射
// ============================================================

interface CloudRow {
  id: string
  created_at: number
  label: string
  auto: boolean
  device: string
  counts: Record<string, number>
  signature: string
  payload: Record<string, unknown[]>
  settings_row: { key: string; value: unknown } | null
}

function toCloudRow(s: DataSnapshot): CloudRow {
  return {
    id: s.id,
    created_at: s.createdAt,
    label: s.label,
    auto: s.auto,
    device: s.device,
    counts: s.counts,
    signature: s.signature,
    payload: s.payload,
    settings_row: s.settingsRow,
  }
}

function fromCloudRow(r: Partial<CloudRow>): DataSnapshot {
  return {
    id: String(r.id ?? ''),
    createdAt: Number(r.created_at) || 0,
    label: r.label ?? '',
    auto: !!r.auto,
    device: r.device ?? '',
    counts: (r.counts as Record<string, number>) ?? {},
    signature: r.signature ?? '',
    payload: (r.payload as Record<string, unknown[]>) ?? {},
    settingsRow: (r.settings_row as DataSnapshot['settingsRow']) ?? null,
  }
}

// ============================================================
// 创建 / 裁剪
// ============================================================

/**
 * 创建一份版本快照。
 * @returns 新建的快照；若被去重 / 节流跳过则返回 null
 */
export async function createSnapshot(
  opts: { auto?: boolean; label?: string; force?: boolean } = {},
): Promise<DataSnapshot | null> {
  const auto = opts.auto ?? false
  const counts = await collectCounts()
  const signature = await computeSignature(counts)

  const latest = await db.snapshots.orderBy('createdAt').last()
  if (!opts.force) {
    // 数据未变 → 不重复建版本
    if (latest && latest.signature === signature) return null
    // 自动版本节流
    if (auto && latest && Date.now() - latest.createdAt < MIN_AUTO_INTERVAL_MS) return null
  }

  const snap: DataSnapshot = {
    id: newId(),
    createdAt: Date.now(),
    label: opts.label ?? (auto ? '自动存档' : '手动版本'),
    auto,
    device: deviceLabel(),
    counts,
    signature,
    payload: await collectPayload(),
    settingsRow: (await db.settings.get('app')) ?? null,
  }

  await db.snapshots.put(snap)
  await pruneLocal()
  // 云端留档 best-effort，不阻塞、不抛错
  void pushSnapshotToCloud(snap)
  return snap
}

/** 本地滚动裁剪：只保留最近 LOCAL_KEEP 个 */
async function pruneLocal(): Promise<void> {
  const all = await db.snapshots.orderBy('createdAt').reverse().toArray()
  const extra = all.slice(LOCAL_KEEP)
  if (extra.length) await db.snapshots.bulkDelete(extra.map((s) => s.id))
}

/** 云端滚动裁剪：只保留最近 CLOUD_KEEP 个 */
async function pruneCloud(): Promise<void> {
  const client = getSupabase(useSettings.getState().settings)
  if (!client) return
  const { data, error } = await client
    .from(CLOUD_TABLE)
    .select('id')
    .order('created_at', { ascending: false })
  if (error || !data) return
  const extra = data.slice(CLOUD_KEEP).map((r) => (r as { id: string }).id)
  if (extra.length) await client.from(CLOUD_TABLE).delete().in('id', extra)
}

async function pushSnapshotToCloud(snap: DataSnapshot): Promise<void> {
  const client = getSupabase(useSettings.getState().settings)
  if (!client) return
  try {
    const { error } = await client
      .from(CLOUD_TABLE)
      .upsert(toCloudRow(snap), { onConflict: 'id' })
    if (error) return
    await pruneCloud()
  } catch {
    /* 云端失败忽略：本地版本仍可用 */
  }
}

// ============================================================
// 列表
// ============================================================

function toMeta(s: DataSnapshot, source: SnapshotSource): SnapshotMeta {
  return {
    id: s.id,
    createdAt: s.createdAt,
    label: s.label,
    auto: s.auto,
    device: s.device,
    counts: s.counts,
    source,
  }
}

async function listCloudMetas(): Promise<SnapshotMeta[]> {
  const client = getSupabase(useSettings.getState().settings)
  if (!client) return []
  const { data, error } = await client
    .from(CLOUD_TABLE)
    .select('id, created_at, label, auto, device, counts')
    .order('created_at', { ascending: false })
    .limit(CLOUD_KEEP)
  if (error || !data) return []
  return (data as Array<Partial<CloudRow>>).map((r) => ({
    id: String(r.id ?? ''),
    createdAt: Number(r.created_at) || 0,
    label: r.label ?? '',
    auto: !!r.auto,
    device: r.device ?? '',
    counts: (r.counts as Record<string, number>) ?? {},
    source: 'cloud' as const,
  }))
}

/** 合并本地 + 云端版本列表（同一 id 去重，标记为 both） */
export async function listSnapshots(): Promise<SnapshotMeta[]> {
  const localMetas = (await db.snapshots.orderBy('createdAt').reverse().toArray()).map((s) =>
    toMeta(s, 'local'),
  )
  let cloudMetas: SnapshotMeta[] = []
  try {
    cloudMetas = await listCloudMetas()
  } catch {
    cloudMetas = []
  }

  const map = new Map<string, SnapshotMeta>()
  for (const c of cloudMetas) map.set(c.id, c)
  for (const l of localMetas) {
    const existing = map.get(l.id)
    if (existing) existing.source = 'both'
    else map.set(l.id, l)
  }
  return [...map.values()].sort((a, b) => b.createdAt - a.createdAt)
}

/** 读单份快照完整数据（本地优先，其次云端） */
async function loadSnapshot(id: string, source: SnapshotSource): Promise<DataSnapshot | null> {
  if (source === 'local' || source === 'both') {
    const local = await db.snapshots.get(id)
    if (local) return local
  }
  const client = getSupabase(useSettings.getState().settings)
  if (!client) return null
  const { data, error } = await client.from(CLOUD_TABLE).select('*').eq('id', id).maybeSingle()
  if (error || !data) return null
  return fromCloudRow(data as Partial<CloudRow>)
}

// ============================================================
// 恢复 / 删除
// ============================================================

export interface RestoreResult {
  tables: number
  rows: number
}

/**
 * 恢复到指定版本：整体覆盖本地各表（置 dirty=1 待重新推送），并回写设置。
 * 恢复前会自动为「当前状态」再存一份版本，便于撤销本次恢复。
 */
export async function restoreSnapshot(
  id: string,
  source: SnapshotSource = 'local',
): Promise<RestoreResult> {
  const snap = await loadSnapshot(id, source)
  if (!snap) throw new Error('该版本不存在（可能已被滚动裁剪）')

  // 恢复前自动备份当前状态（可撤销）
  await createSnapshot({ auto: false, label: '恢复前自动备份', force: true }).catch(() => null)

  let rows = 0
  for (const name of SYNC_TABLES) {
    // 快照未包含该表（理论上不会，collectPayload 会补空数组）→ 不动本地，避免误清空
    if (!(name in snap.payload)) continue
    const table = tableOf(name)
    const list = (
      Array.isArray(snap.payload[name]) ? snap.payload[name] : []
    ) as Array<Record<string, unknown>>
    const valid = list
      .filter((r) => !!r && typeof r.id === 'string')
      .map((r) => ({ ...r, dirty: 1 }))
    await table.clear()
    if (valid.length) {
      await table.bulkPut(valid as never[])
      rows += valid.length
    }
  }

  // 设置回写：整体回滚，但保留「连接类」字段（Supabase 配置 / 同步开关 / 上次同步时间），
  // 避免回滚把同步配置改回旧值导致意外断连。刷新修订号以便随下次同步推送。
  if (snap.settingsRow?.value) {
    const current = useSettings.getState().settings
    const merged = {
      ...(snap.settingsRow.value as typeof current),
      supabaseUrl: current.supabaseUrl,
      supabaseAnonKey: current.supabaseAnonKey,
      syncEnabled: current.syncEnabled,
      lastSyncAt: current.lastSyncAt,
      settingsUpdatedAt: Date.now(),
    }
    await saveSettingsFull(merged)
    useSettings.getState().applyRemote(merged)
  }

  return { tables: SYNC_TABLES.length, rows }
}

/** 删除某个版本（本地 + 云端） */
export async function deleteSnapshot(id: string, source: SnapshotSource): Promise<void> {
  if (source === 'local' || source === 'both') {
    await db.snapshots.delete(id).catch(() => undefined)
  }
  if (source === 'cloud' || source === 'both') {
    const client = getSupabase(useSettings.getState().settings)
    if (client) {
      await client.from(CLOUD_TABLE).delete().eq('id', id).then(
        () => undefined,
        () => undefined,
      )
    }
  }
}

/** 本地已有版本数（用于展示） */
export async function localSnapshotCount(): Promise<number> {
  return db.snapshots.count()
}
