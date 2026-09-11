import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { AppSettings, SyncTableName } from './types'

/**
 * Supabase 客户端（按配置缓存单例）。
 *
 * 优先级：settings 里的 supabaseUrl / supabaseAnonKey → .env 中的 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY。
 * 任一来源缺失则返回 null，应用退化为纯本地模式。
 *
 * 同一 url+key 复用同一个 client（缓存命中），
 * 避免 useAutoSync 每分钟新建 GoTrueClient 触发
 * "Multiple GoTrueClient instances detected" 告警刷屏；
 * 配置变更（url/key 不同）时自然生成新 client，不存在缓存陈旧问题。
 */

const ENV_URL = (import.meta.env.VITE_SUPABASE_URL ?? '').trim()
const ENV_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim()

/** 实际生效的 Supabase 配置（settings 优先，env 兜底） */
export function resolveSettings(settings?: Pick<AppSettings, 'supabaseUrl' | 'supabaseAnonKey'>): {
  url: string
  key: string
  source: 'settings' | 'env' | 'none'
} {
  const sUrl = settings?.supabaseUrl?.trim() ?? ''
  const sKey = settings?.supabaseAnonKey?.trim() ?? ''
  if (sUrl && sKey) return { url: sUrl, key: sKey, source: 'settings' }
  if (ENV_URL && ENV_KEY) return { url: ENV_URL, key: ENV_KEY, source: 'env' }
  return { url: '', key: '', source: 'none' }
}

export function isSupabaseConfigured(settings?: Pick<AppSettings, 'supabaseUrl' | 'supabaseAnonKey'>): boolean {
  const r = resolveSettings(settings)
  return Boolean(r.url && r.key)
}

/** client 缓存：key = `${url}|${key}` */
const clientCache = new Map<string, SupabaseClient>()

/** 取共享 client（同配置复用单例） */
export function getSupabase(
  settings?: Pick<AppSettings, 'supabaseUrl' | 'supabaseAnonKey'>,
): SupabaseClient | null {
  const r = resolveSettings(settings)
  if (!r.url || !r.key) return null
  const cacheKey = `${r.url}|${r.key}`
  let client = clientCache.get(cacheKey)
  if (!client) {
    client = createClient(r.url, r.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    clientCache.set(cacheKey, client)
  }
  return client
}

// ============================================================
// 连接测试
// ============================================================

export interface TableStatus {
  table: string
  ok: boolean
  message?: string
}

export interface ConnectionTestResult {
  ok: boolean
  message: string
  source: 'settings' | 'env' | 'none'
  tables: TableStatus[]
}

/** 全部业务表，与 sync.ts 中的 SYNC_TABLES 保持一致 */
export const REQUIRED_TABLES: SyncTableName[] = [
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

/**
 * 探测 Supabase 连通性 + 9 张表是否就绪。
 *
 * 策略：
 *  1. 创建 client，select 任意一行（limit 0 不下载数据）做连通性 ping
 *  2. 对每张表做 head select（不下载行），表不存在会返回 42P01 或类似错误
 */
export async function testConnection(
  settings?: Pick<AppSettings, 'supabaseUrl' | 'supabaseAnonKey'>,
): Promise<ConnectionTestResult> {
  const r = resolveSettings(settings)
  if (!r.url || !r.key) {
    return {
      ok: false,
      message: '尚未填写 Supabase URL 或 anon key',
      source: r.source,
      tables: [],
    }
  }

  const client = getSupabase(settings)
  if (!client) {
    return {
      ok: false,
      message: '尚未填写 Supabase URL 或 anon key',
      source: r.source,
      tables: [],
    }
  }

  // 1) 连通性 ping：用 students 表做探测（任意一张都可）
  const ping = await client.from('students').select('id', { count: 'exact', head: true }).limit(0)
  if (ping.error && ping.error.code !== 'PGRST116') {
    // PGRST116=0 行不算错；其它错误通常意味着权限或网络问题
    return {
      ok: false,
      message: `连接失败：${ping.error.message}`,
      source: r.source,
      tables: [],
    }
  }

  // 2) 逐表探测
  const tables: TableStatus[] = []
  for (const table of REQUIRED_TABLES) {
    const head = await client.from(table).select('id', { head: true, count: 'exact' }).limit(0)
    if (head.error) {
      tables.push({ table, ok: false, message: head.error.message })
    } else {
      tables.push({ table, ok: true })
    }
  }

  // 2.5) 设置同步表（v9 新增，缺失不影响业务表，但设置不会云同步）
  {
    const head = await client.from('app_settings').select('id', { head: true }).limit(0)
    tables.push(
      head.error
        ? {
            table: 'app_settings',
            ok: false,
            message: '表不存在（设置暂不云同步）。在 SQL Editor 执行 supabase/migration-v9-app-settings.sql 即可补上',
          }
        : { table: 'app_settings', ok: true },
    )
  }

  const missing = tables.filter((t) => !t.ok)
  // app_settings 缺失只降级提示（设置暂不云同步），不算连接失败
  const critical = missing.filter((t) => t.table !== 'app_settings')
  if (critical.length > 0) {
    const names = critical.map((t) => t.table).join('、')
    return {
      ok: false,
      message: `已连通，但缺少表：${names}。请在 Supabase SQL Editor 执行 schema.sql 建表。`,
      source: r.source,
      tables,
    }
  }
  if (missing.length > 0) {
    return {
      ok: true,
      message: '连接正常，业务表全部就绪；app_settings 缺失（设置暂不云同步），可执行 migration-v9-app-settings.sql 补上',
      source: r.source,
      tables,
    }
  }

  return {
    ok: true,
    message: `连接正常，${REQUIRED_TABLES.length} 张业务表 + 设置同步表全部就绪`,
    source: r.source,
    tables,
  }
}