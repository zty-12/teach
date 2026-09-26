import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

// basename 跟随 vite.config.ts 的 base 走：
// GitHub Pages 项目站 → /teach；Cloudflare Pages（CF_PAGES 注入）→ /
const BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '') || '/'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={BASENAME}>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
