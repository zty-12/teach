/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  /** AI 代理端点（Supabase Edge Function 地址） */
  readonly VITE_AI_ENDPOINT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** 构建标识（由 vite.config.ts 的 define 注入，见 __BUILD_ID__） */
declare const __BUILD_ID__: string

/** 口令门参数（vite.config.ts 注入）：hash = sha256(salt + ACCESS_PASSPHRASE)，hash 为空串表示未启用 */
declare const __ACCESS_GATE__: { hash: string; salt: string }
