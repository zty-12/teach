import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { Button, Input } from '@/components/ui'

/**
 * 应用内口令门（软性访问控制，v31.10 新增）。
 *
 * 设计要点：
 * - 口令本身不进代码：构建时只注入 sha256(salt + 口令) 的哈希（__ACCESS_GATE__，
 *   由 vite.config.ts 计算，口令来自 ACCESS_PASSPHRASE 环境变量）。改口令 = 改环境变量重新构建。
 * - 「记住此设备」只写 localStorage（存的是口令哈希），换设备/清缓存需重输；
 *   哈希变化（改了口令）后旧标记自动失效。
 * - 定位是挡住陌生人的软门槛，不是加密：口令太弱理论上可被穷举，请设长一些。
 *   它只挡 UI，不挡 API —— 云端数据本身仍由 Supabase anon key 保护。
 */

const STORE_KEY = 'edu-workbench.access-gate.ok'
const MAX_ATTEMPTS = 5
const COOLDOWN_MS = 30_000

async function sha256Hex(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null // 仅在安全上下文（https / localhost）可用
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export default function AccessGate({ children }: { children: ReactNode }) {
  const { hash, salt } = __ACCESS_GATE__

  // checking：还没查完「本机是否已记住」；open：放行；locked：要求输口令
  const [phase, setPhase] = useState<'checking' | 'locked' | 'open'>(() =>
    hash ? 'checking' : 'open',
  )
  const [value, setValue] = useState('')
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [fails, setFails] = useState(0)
  const [cooldownLeft, setCooldownLeft] = useState(0)

  useEffect(() => {
    if (!hash) return
    try {
      if (localStorage.getItem(STORE_KEY) === hash) setPhase('open')
      else setPhase('locked')
    } catch {
      setPhase('locked')
    }
  }, [hash])

  // 连续错误后的冷却倒计时（仅本会话；刷新页面计数清零）
  useEffect(() => {
    if (cooldownLeft <= 0) return
    const t = setInterval(() => setCooldownLeft((s) => Math.max(0, s - 1)), 1000)
    return () => clearInterval(t)
  }, [cooldownLeft])

  if (phase === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-1">
        <p className="text-sm text-text-2">正在加载…</p>
      </div>
    )
  }

  if (phase === 'open') return <>{children}</>

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || cooldownLeft > 0) return
    setBusy(true)
    setError('')
    try {
      const digest = await sha256Hex(salt + value)
      if (digest && digest === hash) {
        if (remember) {
          try {
            localStorage.setItem(STORE_KEY, hash)
          } catch {
            /* 隐私模式等场景忽略 */
          }
        }
        setPhase('open')
        return
      }
      const next = fails + 1
      setFails(next)
      setValue('')
      if (next >= MAX_ATTEMPTS) {
        setCooldownLeft(COOLDOWN_MS / 1000)
        setFails(0)
        setError(`错误次数过多，请 ${COOLDOWN_MS / 1000} 秒后再试`)
      } else {
        setError(`口令不对，还可尝试 ${MAX_ATTEMPTS - next} 次`)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-1 px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-xs rounded-xl border border-line-1 bg-surface-2/40 p-5"
      >
        <div className="mb-4 flex flex-col items-center gap-2 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-accent">
            <Lock size={20} />
          </div>
          <h1 className="text-[15px] font-semibold text-text-1">访问验证</h1>
          <p className="text-[12px] text-text-3">请输入访问口令继续</p>
        </div>

        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="访问口令"
          autoFocus
          disabled={busy || cooldownLeft > 0}
          className="w-full"
        />

        {error && <p className="mt-2 text-[12px] text-money-out">{error}</p>}

        <label className="mt-3 flex cursor-pointer items-center gap-2 text-[12px] text-text-2">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-4 w-4 accent-[var(--color-accent)]"
          />
          记住此设备（本机不再重复输入）
        </label>

        <Button
          type="submit"
          variant="primary"
          block
          className="mt-4"
          disabled={busy || cooldownLeft > 0 || !value}
        >
          {busy ? '验证中…' : cooldownLeft > 0 ? `请等待 ${cooldownLeft}s` : '进入'}
        </Button>
      </form>
    </div>
  )
}
