import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { copyFileSync } from 'node:fs'
import path from 'node:path'

/**
 * LLM 同源代理中间件（绕开不支持 CORS 预检的服务商网关，如商汤 SenseNova）。
 *
 * 前端把请求发到同源路径：/_llm-proxy/{encodeURIComponent(完整目标URL)}
 * 中间件解码目标 URL 后由 Node 侧转发（Node fetch 不受浏览器预检限制）。
 * 仅允许 https 目标、仅允许 POST，避免被滥用为开放代理。
 */
function llmProxyPlugin(): Plugin {
  const handler = (req: any, res: any) => {
    // connect 已剥掉 /_llm-proxy 前缀（可能残留前导 /）；兼容未剥前缀的情况
    const raw = decodeURIComponent(req.url ?? '')
      .replace(/^\/?_llm-proxy\/?/, '')
      .replace(/^\//, '')
    let target: URL
    try {
      target = new URL(raw)
    } catch {
      res.statusCode = 400
      res.end('bad target')
      return
    }
    if (target.protocol !== 'https:') {
      res.statusCode = 400
      res.end('only https targets allowed')
      return
    }

    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      try {
        const headers: Record<string, string> = {
          'Content-Type': req.headers['content-type'] ?? 'application/json',
        }
        if (req.headers['authorization']) {
          headers['Authorization'] = String(req.headers['authorization'])
        }
        const upstream = await fetch(target, {
          method: 'POST',
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
        res.statusCode = upstream.status
        const contentType = upstream.headers.get('content-type')
        if (contentType) res.setHeader('Content-Type', contentType)
        res.end(Buffer.from(await upstream.arrayBuffer()))
      } catch (e) {
        res.statusCode = 502
        res.end(`proxy error: ${String(e)}`)
      }
    })
  }

  return {
    name: 'llm-same-origin-proxy',
    configureServer(server) {
      server.middlewares.use('/_llm-proxy', handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/_llm-proxy', handler)
    },
  }
}

/**
 * GitHub Pages 是静态托管、不会把未知路径重写到 index.html。
 * SPA 刷新 / 深链（如 /teach/schedule）会 404。复制一份 index.html 为 404.html，
 * 让 GitHub Pages 在 404 时回退到同一份 SPA 外壳，由前端路由接管。
 * 配合 BrowserRouter 的 basename="/teach" 使用。
 */
function spa404Plugin(): Plugin {
  return {
    name: 'spa-404-fallback',
    apply: 'build',
    closeBundle() {
      const src = path.resolve(import.meta.dirname, 'dist', 'index.html')
      const dst = path.resolve(import.meta.dirname, 'dist', '404.html')
      try {
        copyFileSync(src, dst)
      } catch {
        /* 构建未产出 index.html 时忽略 */
      }
    },
  }
}

/**
 * 构建标识（v30.3）：显示在界面角落，用来一眼确认「线上跑的是哪一版」——
 * 排查「部署了但页面还是旧行为」（Service Worker / HTTP 缓存）时非常有用。
 *
 * ⚠ 发版时**记得同步改这里的版本号**（v31.0 起作为发版检查项）。
 *   此前一直停留在 v30.3，导致线上显示与真实版本不符，
 *   排查「v30.8 没生效」时反而被误导（实际是页面跑着旧缓存 / 版本号没更新）。
 */
const APP_VERSION = 'v31.1'
const BUILD_ID = (() => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${APP_VERSION} · ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
})()

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [
    react(),
    tailwindcss(),
    llmProxyPlugin(),
    spa404Plugin(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: '教务工作台',
        short_name: '教务台',
        description: '面向个人老师的教务管理工具：学生、排课、课表、财务、反馈',
        lang: 'zh-CN',
        theme_color: '#4f46e5',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'any',
        start_url: '/teach/',
        scope: '/teach/',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        cleanupOutdatedCaches: true,
        navigateFallback: '/teach/index.html',
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  // GitHub Pages 项目站部署：仓库名 teach，站点根路径为 /teach/。
  // 注意：改这里的同时要同步调整下面 VitePWA 的 start_url / scope /
  // navigateFallback，否则子路径部署下 PWA 会失效或白屏。
  // 若要部署到域名根路径，把这三处统一改回 '/' 即可。
  base: '/teach/',
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
})
