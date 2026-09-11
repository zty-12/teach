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
