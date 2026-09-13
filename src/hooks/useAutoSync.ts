import { useEffect, useRef } from 'react'
import { liveQuery, type Table } from 'dexie'
import { db } from '@/lib/db'
import { isSupabaseConfigured } from '@/lib/supabase'
import { syncNow } from '@/lib/sync'
import { createSnapshot } from '@/lib/snapshots'
import { useSettings } from '@/store/useSettings'
import { SYNC_TABLES, type SyncResult } from '@/lib/sync'
import type { AppSettings } from '@/lib/types'

/**
 * 后台自动同步
 *
 * 当 settings.syncEnabled 为 true 且 Supabase 已配置时：
 *  - 每隔 AUTO_INTERVAL（60s）自动同步一次
 *  - 任一本地表发生变更（dirty>0）时，防抖 3s 后立即同步
 *  - 关闭开关或卸载组件时停止调度
 *
 * 用模块级标志锁避免多次同步并发（手动 + 自动 + 定时同时触发时只跑一个）。
 */

const AUTO_INTERVAL = 60_000 // 周期同步间隔
const CHANGE_DEBOUNCE = 3_000 // 变更后延迟

// 模块级并发互斥：以「是否真的有同步在飞行」为准（而不是以调用是否返回为准）
let inFlight: Promise<SyncResult> | null = null
let inFlightAt = 0
/** 僵尸同步阈值：超过它仍未落地则强制放行下一次，避免网络黑洞把同步永久卡死 */
const STALE_MS = 120_000

async function runSyncOnce(
  settings: AppSettings,
  timeoutMs = 25_000,
): Promise<void> {
  // ⚠ 互斥必须看 inFlight，而不是「本轮 await 是否已返回」：
  //   旧写法用 Promise.race 超时后 finally 立刻解锁，但 syncNow **仍在后台跑**，
  //   于是下一轮（周期 60s / 脏数据防抖 3s）会与它并发，两个 pushAll 同时 upsert 同一批行
  //   （v26 审查：P2）。
  if (inFlight && Date.now() - inFlightAt < STALE_MS) return
  const work = syncNow(settings)
  inFlight = work
  inFlightAt = Date.now()
  // 真正落地时才释放锁（成功/失败都释放）；用 then 的双回调避免未处理的 rejection
  work.then(
    () => {
      inFlight = null
    },
    () => {
      inFlight = null
    },
  )
  try {
    // 限时只是「本轮不再等待」，不表示同步结束 —— 锁由上面的 then 释放
    const r = await Promise.race([
      work,
      new Promise<null>((res) => setTimeout(() => res(null), timeoutMs)),
    ])
    // 同步成功（无错误）后自动留档一个数据版本；失败/超时不留（多为网络问题）
    // 数据未变化时 createSnapshot 内部签名去重会跳过，不会产生重复版本
    if (r && r.errors.length === 0) {
      await createSnapshot({ auto: true }).catch(() => null)
    }
  } catch {
    /* 同步失败静默忽略，下个周期再试；错误在设置页手动同步时可见 */
  }
}

export function useAutoSync(): void {
  const settings = useSettings((s) => s.settings)

  // 用 ref 保存最新 settings，防抖回调里读取（避免闭包捕获旧值）
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // 3) 设置变更也触发同步（设置现在参与云同步；lastSyncAt 回写不刷新修订号，不会死循环）
  const settingsRev = settings.settingsUpdatedAt
  useEffect(() => {
    if (!settingsRev) return
    const s = settingsRef.current
    if (!s.syncEnabled || !isSupabaseConfigured(s)) return
    const timer = window.setTimeout(() => {
      void runSyncOnce(settingsRef.current)
    }, CHANGE_DEBOUNCE)
    return () => window.clearTimeout(timer)
  }, [settingsRev])

  useEffect(() => {
    if (!settings.syncEnabled || !isSupabaseConfigured(settings)) return

    // 1) 周期同步
    const interval = window.setInterval(() => {
      void runSyncOnce(settingsRef.current)
    }, AUTO_INTERVAL)

    // 2) 本地变更触发的防抖同步（订阅所有同步表）
    //    真正的防抖：每次变更重置计时器，3s 无新变更才同步一次
    let debounceTimer: number | null = null
    const sub = liveQuery(async () => {
      let total = 0
      for (const name of SYNC_TABLES) {
        const table = (db as unknown as Record<string, Table<never, string>>)[name]
        if (!table) continue
        total += await table.where('dirty').equals(1).count()
      }
      // 变化即返回一个值，驱动 liveQuery 通知订阅者
      return total
    })
      .subscribe((total) => {
        // total=0 表示没有待推送记录（比如同步刚完成），无需调度
        if (!total) return
        if (debounceTimer !== null) window.clearTimeout(debounceTimer)
        debounceTimer = window.setTimeout(() => {
          debounceTimer = null
          void runSyncOnce(settingsRef.current)
        }, CHANGE_DEBOUNCE)
      })

    return () => {
      window.clearInterval(interval)
      if (debounceTimer !== null) window.clearTimeout(debounceTimer)
      sub.unsubscribe()
    }
  }, [settings.syncEnabled, settings.supabaseUrl, settings.supabaseAnonKey])
}
