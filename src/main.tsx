import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import AccessGate from '@/components/AccessGate'
import './index.css'

// basename 跟随 vite.config.ts 的 base 走：
// GitHub Pages 项目站 → /teach；Cloudflare（CF_PAGES / WORKERS_CI 注入）→ /
const BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '') || '/'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={BASENAME}>
      {/* 口令门：未验证前不挂载 App（数据完全不加载）；hash 为空时直接放行 */}
      <AccessGate>
        <App />
      </AccessGate>
    </BrowserRouter>
  </StrictMode>,
)
