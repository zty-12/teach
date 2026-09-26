import { getSupabase } from './supabase'

/**
 * 应用内口令门 —— 云端已验证设备管理（v31.11 新增，参考工作台 v21.41 方案）。
 *
 * 职责（纯逻辑 + 云端读写，不含 UI）：
 * - 设备指纹：每台设备一个随机 id，存 localStorage，卸载清缓存才换。
 * - 本地「记住此设备」：存口令哈希（旧行为保留）。
 * - 云端已验证设备清单：复用 app_settings 表里独立的一行 id='gate'（value.jsonb），
 *   **不** 与设置同步的 id='app' 行（sync.ts）互相干扰，无需改 schema。
 * - 云端权威：进站时若云端可达且清单里没有本机（被机主移除过），即使本地记住了也重新锁上；
 *   云端不可达时退回本地判断（离线可用）。
 * - 登记时机：只有「输对口令」才登记；被移除的设备绝不会自动重新登记。
 *
 * 并发：清单用「读-改-写」整体回写 + 回读校验，最多重试 3 次，
 * 防止多台设备同时登记时互相覆盖（与工作台同款策略）。
 */

/** 本地：设备指纹 */
const DEVICE_ID_KEY = 'ew-gate.device-id'
/** 本地：记住此设备（存口令哈希）—— 沿用 v31.10 的 key，旧用户无需重新输 */
const REMEMBER_KEY = 'edu-workbench.access-gate.ok'
/** 云端：app_settings 表里设备清单行的 id */
export const GATE_ROW_ID = 'gate'

export interface GateDevice {
  /** 设备指纹（localStorage 随机 id） */
  id: string
  /** 展示名（按 UA 自动生成） */
  name: string
  /** 最近一次验证/登记时间（ms） */
  at: number
}

export interface GateRegistry {
  v: number
  devices: GateDevice[]
}

// ============================================================
// 本地设备身份与记忆
// ============================================================

/** 设备指纹：首次生成后固定（清浏览器数据会换新 → 需重新输口令，符合预期） */
export function getDeviceId(): string {
  try {
    const existed = localStorage.getItem(DEVICE_ID_KEY)
    if (existed) return existed
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    localStorage.setItem(DEVICE_ID_KEY, id)
    return id
  } catch {
    // 隐私模式等拿不到 localStorage：会话内退化成随机 id（每次刷新要重输，可接受）
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
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
    return localStorage.getItem(REMEMBER_KEY) === hash && hash !== ''
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

// ============================================================
// 云端设备清单（app_settings 表，独立行 id='gate'）
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

/** 读云端清单。返回 null = 不可达 / 行不存在 / 出错（调用方按「无云端清单」处理） */
export async function fetchGateRegistry(timeoutMs = 5000): Promise<GateRegistry | null> {
  const client = getSupabase() // 不传 settings → 走 .env 编译凭据，解锁前也可用
  if (!client) return null
  try {
    const { data, error } = await withTimeout(
      client.from('app_settings').select('value').eq('id', GATE_ROW_ID).maybeSingle(),
      timeoutMs,
    )
    if (error || !data) return null
    const value = (data as { value: GateRegistry | null }).value
    if (!value || !Array.isArray(value.devices)) return null
    return {
      v: typeof value.v === 'number' ? value.v : 1,
      devices: value.devices.filter(
        (d): d is GateDevice => !!d && typeof d.id === 'string' && typeof d.name === 'string',
      ),
    }
  } catch {
    return null
  }
}

/**
 * 读-改-写：修改云端清单（整体回写）。
 * mutate 收到当前清单（可能为 null = 行不存在），返回新 devices 数组。
 * 写后回读校验 mutate 的效果确实落库（自增/自删场景），最多重试 3 次。
 */
async function mutateGateRegistry(
  mutate: (current: GateDevice[] | null) => GateDevice[],
  verify: (next: GateDevice[]) => boolean,
  timeoutMs = 8000,
): Promise<GateDevice[]> {
  const client = getSupabase()
  if (!client) throw new Error('未配置 Supabase，无法读写云端设备清单')
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const cur = await fetchGateRegistry(timeoutMs)
      const devices = mutate(cur?.devices ?? null)
      const payload = { id: GATE_ROW_ID, value: { v: 1, devices }, updatedAt: Date.now() }
      const { error } = await withTimeout(
        client.from('app_settings').upsert(payload, { onConflict: 'id' }),
        timeoutMs,
      )
      if (error) throw new Error(error.message)
      // 回读校验（防并发覆盖）
      const check = await fetchGateRegistry(timeoutMs)
      if (check && verify(check.devices)) return check.devices
      lastErr = new Error('回读校验未通过（可能被其他设备并发修改）')
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * 把本机登记进云端清单（输对口令后调用；被移除的设备不会走这里）。
 * 已在清单里 → 仅刷新时间戳与名称。
 */
export async function registerGateDevice(timeoutMs = 8000): Promise<GateDevice[]> {
  const self: GateDevice = { id: getDeviceId(), name: getDeviceName(), at: Date.now() }
  return mutateGateRegistry(
    (cur) => {
      const rest = (cur ?? []).filter((d) => d.id !== self.id)
      return [...rest, self].sort((a, b) => b.at - a.at)
    },
    (next) => next.some((d) => d.id === self.id),
    timeoutMs,
  )
}

/** 从云端清单移除指定设备（传 'all' 清空全部）。返回剩余清单。 */
export async function removeGateDevices(
  target: string[] | 'all',
  timeoutMs = 8000,
): Promise<GateDevice[]> {
  return mutateGateRegistry(
    (cur) =>
      (cur ?? []).filter((d) => target !== 'all' && !target.includes(d.id)),
    (next) =>
      target === 'all'
        ? next.length === 0
        : next.every((d) => !target.includes(d.id)),
    timeoutMs,
  )
}

// ============================================================
// 进站判定
// ============================================================

/**
 * 进站判定（口令门已开启即 hash 非空时调用）：
 * 1. 本地没记住 → locked（必须输口令）
 * 2. 本地记住 + 云端清单不可用（离线/未登记过任何设备）→ open（离线兜底）
 * 3. 本地记住 + 云端清单里没有本机 → locked（被机主移除），并清掉本地记忆
 * 4. 本地记住 + 云端在册 → open
 */
export async function evaluateGateAccess(hash: string): Promise<'open' | 'locked'> {
  if (!hasLocalRemember(hash)) return 'locked'
  const registry = await fetchGateRegistry()
  if (!registry) return 'open' // 云端不可达或从未登记过任何设备：退回本地信任
  const inCloud = registry.devices.some((d) => d.id === getDeviceId())
  if (!inCloud) {
    forgetLocal()
    return 'locked'
  }
  return 'open'
}
