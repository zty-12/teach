import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
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

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    llmProxyPlugin(),
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
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        cleanupOutdatedCaches: true,
        navigateFallback: '/index.html',
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
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
})
