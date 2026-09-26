import { getSupabase } from './supabase'

/**
 * 应用内口令门 —— 云端配置 + 已验证设备管理（v31.12，对齐工作台 v21.41 方案）。
 *
 * 云端存储：复用 app_settings 表里独立的一行 id='gate'（value.jsonb）：
 *   { v: 1, hash?: string, devices: GateDevice[] }
 * - hash = sha256(salt + 口令)，**明文不落盘不上云**；hash 缺省/未定义 = 沿用构建时
 *   注入的 __ACCESS_GATE__.hash（v31.11 旧行兼容）；hash = '' = 口令门关闭。
 * - devices = 已验证设备清单：输对口令并勾选「记住」的设备自动登记，机主可移除。
 * - 与设置同步的 id='app' 行互不干扰，零 schema 改动。
 *
 * 权威顺序：云端可达 → 以云端为准（改口令/关闭立即对全部设备生效）；
 * 云端不可达 → 退回本地缓存的最近一次云端配置，再退构建时哈希（离线可用）。
 *
 * 并发：行用「读-改-写」整体回写 + 回读校验，最多重试 3 次，
 * 防止多台设备同时登记/改配置互相覆盖（与工作台同款策略）。
 */

/** 本地：设备指纹 */
const DEVICE_ID_KEY = 'ew-gate.device-id'
/** 本地：记住此设备（存口令哈希）—— 沿用 v31.10 的 key，老用户无需重新输 */
const REMEMBER_KEY = 'edu-workbench.access-gate.ok'
/** 本地：最近一次云端配置缓存（离线兜底用） */
const CFG_CACHE_KEY = 'ew-gate.cfg'
/** 云端：口令门行的 id */
export const GATE_ROW_ID = 'gate'

export interface GateDevice {
  /** 设备指纹（localStorage 随机 id） */
  id: string
  /** 展示名（按 UA 自动生成） */
  name: string
  /** 最近一次验证/登记时间（ms） */
  at: number
}

interface GateRow {
  v?: number
  /** sha256(salt+口令)；undefined=未设置（用构建哈希兜底）；''=口令门关闭 */
  hash?: string
  devices: GateDevice[]
}

/** 解析后的口令门配置（供门禁与管理卡片共用） */
export interface GateConfig {
  enabled: boolean
  /** 生效中的口令哈希（enabled=false 时为 ''） */
  hash: string
  salt: string
  devices: GateDevice[]
  /** cloud=以云端为准；local=云端不可达，用的是本地缓存/构建兜底 */
  source: 'cloud' | 'local'
}

// ============================================================
// 本地设备身份与记忆
// ============================================================

/** 设备指纹：首次生成后固定（清浏览器数据会换新 → 需重新输口令，符合预期） */
export function getDeviceId(): string {
  const gen = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  try {
    const existed = localStorage.getItem(DEVICE_ID_KEY)
    if (existed) return existed
    const id = gen()
    localStorage.setItem(DEVICE_ID_KEY, id)
    return id
  } catch {
    // 隐私模式等拿不到 localStorage：会话内退化成随机 id（每次刷新要重输，可接受）
    return gen()
  }
}

/** 按 UA 生成设备展示名，如「Chrome · Windows」「Safari · iPhone」 */
export function getDeviceName(): string {
  try {
    const ua = navigator.userAgent
    const os = /Windows/i.test(ua)
      ? 'Windows'
      : /Android/i.test(ua)
        ? 'Android'
        : /iPhone|iPad|iPod/i.test(ua)
          ? 'iOS'
          : /Mac OS X/i.test(ua)
            ? 'Mac'
            : /Linux/i.test(ua)
              ? 'Linux'
              : '未知系统'
    const browser = /Edg\//i.test(ua)
      ? 'Edge'
      : /OPR\//i.test(ua)
        ? 'Opera'
        : /Firefox\//i.test(ua)
          ? 'Firefox'
          : /Chrome\//i.test(ua)
            ? 'Chrome'
            : /Safari\//i.test(ua)
              ? 'Safari'
              : '浏览器'
    return `${browser} · ${os}`
  } catch {
    return '未知设备'
  }
}

export function hasLocalRemember(hash: string): boolean {
  try {
    return hash !== '' && localStorage.getItem(REMEMBER_KEY) === hash
  } catch {
    return false
  }
}

export function rememberLocal(hash: string): void {
  try {
    localStorage.setItem(REMEMBER_KEY, hash)
  } catch {
    /* 隐私模式忽略 */
  }
}

export function forgetLocal(): void {
  try {
    localStorage.removeItem(REMEMBER_KEY)
  } catch {
    /* 忽略 */
  }
}

/** SHA-256（仅在安全上下文 https/localhost 可用） */
export async function sha256Hex(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ============================================================
// 云端口令门行（app_settings 表，独立行 id='gate'）
// ============================================================

function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`超时（${ms}ms）`)), ms)
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

function validDevice(d: unknown): d is GateDevice {
  return (
    !!d &&
    typeof d === 'object' &&
    typeof (d as GateDevice).id === 'string' &&
    typeof (d as GateDevice).name === 'string'
  )
}

/**
 * 读云端口令门行。
 * 返回 ok=false = 不可达/未配置/出错；ok=true 且 row=null = 可达但行不存在。
 */
async function fetchGateRow(
  timeoutMs = 5000,
): Promise<{ ok: boolean; row: GateRow | null }> {
  const client = getSupabase() // 不传 settings → 走 .env 编译凭据，解锁前也可用
  if (!client) return { ok: false, row: null }
  try {
    const { data, error } = await withTimeout(
      client.from('app_settings').select('value').eq('id', GATE_ROW_ID).maybeSingle(),
      timeoutMs,
    )
    if (error) return { ok: false, row: null }
    if (!data) return { ok: true, row: null }
    const value = (data as { value: Partial<GateRow> | null }).value
    if (!value) return { ok: true, row: null }
    return {
      ok: true,
      row: {
        v: typeof value.v === 'number' ? value.v : 1,
        hash: typeof value.hash === 'string' ? value.hash : undefined,
        devices: Array.isArray(value.devices) ? value.devices.filter(validDevice) : [],
      },
    }
  } catch {
    return { ok: false, row: null }
  }
}

/** 构建时注入的兜底哈希（v31.10/v31.11 行为；云端没设 hash 时沿用） */
function compiledFallback(): { enabled: boolean; hash: string } {
  const h = __ACCESS_GATE__.hash
  return { enabled: h !== '', hash: h }
}

/** 离线/未配置时的配置：本地缓存 → 构建兜底 */
function localConfig(): GateConfig {
  try {
    const cached = JSON.parse(localStorage.getItem(CFG_CACHE_KEY) ?? 'null') as
      | { hash?: string; enabled?: boolean }
      | null
    if (cached && typeof cached.hash === 'string' && typeof cached.enabled === 'boolean') {
      return {
        enabled: cached.enabled,
        hash: cached.hash,
        salt: __ACCESS_GATE__.salt,
        devices: [],
        source: 'local',
      }
    }
  } catch {
    /* 忽略 */
  }
  const fb = compiledFallback()
  return { ...fb, salt: __ACCESS_GATE__.salt, devices: [], source: 'local' }
}

/**
 * 解析当前生效的口令门配置（门禁与管理卡片共用）。
 * 云端可达：hash 有值=开启；''=关闭；缺省=构建兜底（v31.11 旧行兼容）。
 * 顺手把生效配置写入本地缓存供离线兜底。
 */
export async function resolveGateConfig(timeoutMs = 5000): Promise<GateConfig> {
  const salt = __ACCESS_GATE__.salt
  const res = await fetchGateRow(timeoutMs)
  if (!res.ok) return localConfig()
  let enabled: boolean
  let hash: string
  if (res.row && typeof res.row.hash === 'string') {
    hash = res.row.hash
    enabled = hash !== ''
  } else {
    const fb = compiledFallback()
    enabled = fb.enabled
    hash = fb.hash
  }
  const cfg: GateConfig = {
    enabled,
    hash,
    salt,
    devices: res.row?.devices ?? [],
    source: 'cloud',
  }
  try {
    localStorage.setItem(CFG_CACHE_KEY, JSON.stringify({ hash, enabled, at: Date.now() }))
  } catch {
    /* 忽略 */
  }
  return cfg
}

/**
 * 读-改-写：修改云端口令门行（整体回写）。
 * mutate 收到当前行（可能为 null = 行不存在），返回新行。
 * 写后回读校验效果确实落库，最多重试 3 次。
 */
async function mutateGateRow(
  mutate: (current: GateRow | null) => GateRow,
  verify: (next: GateRow | null) => boolean,
  timeoutMs = 8000,
): Promise<GateRow> {
  const client = getSupabase()
  if (!client) throw new Error('未配置 Supabase，无法修改口令门')
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchGateRow(timeoutMs)
      if (!res.ok) throw new Error('云端不可达')
      const next = mutate(res.row)
      // hash 为 undefined 时不写入该键（JSON 序列化自动省略），保持「用构建哈希兜底」语义
      const value: Record<string, unknown> = { v: 1, devices: next.devices }
      if (next.hash !== undefined) value.hash = next.hash
      const payload = { id: GATE_ROW_ID, value, updatedAt: Date.now() }
      const { error } = await withTimeout(
        client.from('app_settings').upsert(payload, { onConflict: 'id' }),
        timeoutMs,
      )
      if (error) throw new Error(error.message)
      const check = await fetchGateRow(timeoutMs)
      if (check.ok && verify(check.row)) return check.row ?? next
      lastErr = new Error('回读校验未通过（可能被其他设备并发修改）')
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * 把本机登记进已验证设备清单（输对口令后调用；被移除的设备不会走这里）。
 * 已在清单里 → 仅刷新时间戳与名称。
 */
export async function registerGateDevice(timeoutMs = 8000): Promise<GateDevice[]> {
  const self: GateDevice = { id: getDeviceId(), name: getDeviceName(), at: Date.now() }
  const row = await mutateGateRow(
    (cur) => ({
      hash: cur?.hash,
      devices: [...(cur?.devices ?? []).filter((d) => d.id !== self.id), self].sort(
        (a, b) => b.at - a.at,
      ),
    }),
    (r) => !!r && r.devices.some((d) => d.id === self.id),
    timeoutMs,
  )
  return row.devices
}

/** 从清单移除指定设备（传 'all' 清空全部）。返回剩余清单。 */
export async function removeGateDevices(
  target: string[] | 'all',
  timeoutMs = 8000,
): Promise<GateDevice[]> {
  const row = await mutateGateRow(
    (cur) => ({
      hash: cur?.hash,
      devices: (cur?.devices ?? []).filter((d) => target !== 'all' && !target.includes(d.id)),
    }),
    (r) =>
      target === 'all'
        ? !!r && r.devices.length === 0
        : !!r && r.devices.every((d) => !target.includes(d.id)),
    timeoutMs,
  )
  return row.devices
}

/**
 * 设置/修改进站口令（开启与修改同一个入口）。
 * 与工作台一致：已验证设备仍免输（本机在册时自动更新本地记忆）；
 * 要让所有设备重新验证，需另点「清空全部设备」。
 */
export async function saveGatePassphrase(newPass: string, timeoutMs = 8000): Promise<void> {
  const salt = __ACCESS_GATE__.salt
  const hash = await sha256Hex(salt + newPass)
  if (!hash) throw new Error('当前环境不支持 SHA-256（需 https 或 localhost）')
  const row = await mutateGateRow(
    (cur) => ({ hash, devices: cur?.devices ?? [] }),
    (r) => !!r && r.hash === hash,
    timeoutMs,
  )
  try {
    localStorage.setItem(CFG_CACHE_KEY, JSON.stringify({ hash, enabled: true, at: Date.now() }))
  } catch {
    /* 忽略 */
  }
  if (row.devices.some((d) => d.id === getDeviceId())) rememberLocal(hash)
}

/** 关闭口令门：清云端哈希并清空设备清单（重新开启后所有设备需重输口令） */
export async function closeGate(timeoutMs = 8000): Promise<void> {
  await mutateGateRow(
    () => ({ hash: '', devices: [] }),
    (r) => !!r && r.hash === '' && r.devices.length === 0,
    timeoutMs,
  )
  forgetLocal()
  try {
    localStorage.setItem(CFG_CACHE_KEY, JSON.stringify({ hash: '', enabled: false, at: Date.now() }))
  } catch {
    /* 忽略 */
  }
}
