import { useEffect, useRef } from 'react'
import { liveQuery, type Table } from 'dexie'
import { db } from '@/lib/db'
import { isSupabaseConfigured } from '@/lib/supabase'
import { syncNow } from '@/lib/sync'
import { useSettings } from '@/store/useSettings'
import { SYNC_TABLES } from '@/lib/sync'
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

// 模块级并发锁
let syncingFlag = false

async function runSyncOnce(
  settings: AppSettings,
  timeoutMs = 25_000,
): Promise<void> {
  if (syncingFlag) return
  syncingFlag = true
  try {
    // 限时：避免网络卡死挂起后续调度
    await Promise.race([
      syncNow(settings),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ])
  } catch {
    /* 同步失败静默忽略，下个周期再试；错误在设置页手动同步时可见 */
  } finally {
    syncingFlag = false
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
