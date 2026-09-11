/**
 * esbuild 打包 schedule 测试入口 + 注入 fake-indexeddb，
 * 然后用 Node 直接执行（无需 jsdom 浏览器环境，纯逻辑/DB 测试）。
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ENTRY = resolve(__dirname, '__schedule.test.entry.ts')
const OUT = resolve(__dirname, '__schedule.test.mjs')

// 注入 fake-indexeddb 全局垫片
const SHIM = `
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
if (typeof globalThis.crypto === 'undefined') globalThis.crypto = webcrypto
`

const entrySource = await readFile(ENTRY, 'utf8')
const tmpEntry = resolve(__dirname, '__schedule.test.entry.shim.ts')
await writeFile(tmpEntry, SHIM + '\n' + entrySource, 'utf8')

await build({
  entryPoints: [tmpEntry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: OUT,
  alias: {
    '@': resolve(__dirname, '../src'),
  },
  external: [],
  logLevel: 'error',
})

const { pathToFileURL: p2f } = await import('node:url')
await import(p2f(OUT).href)