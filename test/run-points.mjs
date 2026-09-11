import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(process.cwd())
const entryPath = resolve(root, 'test/__points.test.entry.ts')
const outPath = resolve(root, 'test/__points.test.mjs')

console.log('打包 points 测试入口……')
await build({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outPath,
  alias: {
    '@': resolve(root, 'src'),
    '@lib': resolve(root, 'src/lib'),
  },
  logLevel: 'error',
})
console.log('打包完成，执行断言……\n')

const child = spawn(process.execPath, [outPath], { stdio: 'inherit', cwd: root })
child.on('exit', (code) => process.exit(code ?? 1))
