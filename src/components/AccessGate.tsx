import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { Button, Input } from '@/components/ui'
import {
  getDeviceId,
  hasLocalRemember,
  registerGateDevice,
  rememberLocal,
  resolveGateConfig,
  sha256Hex,
  type GateConfig,
} from '@/lib/accessGate'

/**
 * 应用内口令门（v31.10 新增；v31.12 对齐工作台 v21.41：云端配置 + 已验证设备管理）。
 *
 * 设计要点：
 * - 口令哈希存云端（app_settings 表 id='gate' 行，明文不落盘不上云）：
 *   机主可在 设置 → 云端同步 → 应用口令门 里修改口令 / 关闭 / 开启，立即对全部设备生效。
 * - 云端没设 hash（旧行）或云端不可达 → 用构建时注入的 __ACCESS_GATE__.hash 兜底。
 * - 「记住此设备」= 本地存口令哈希 + 输对后自动登记进云端设备清单。
 *   机主可随时移除；被移除的设备下次进站会被云端权威判定重新锁上。
 * - 定位是挡住陌生人的软门槛，不是加密：口令太弱理论上可被穷举，请设长一些。
 *   它只挡 UI，不挡 API —— 云端数据本身仍由 Supabase anon key 保护。
 */

const MAX_ATTEMPTS = 5
const COOLDOWN_MS = 30_000

export default function AccessGate({ children }: { children: ReactNode }) {
  // checking：还没查完云端配置与本机状态；open：放行；locked：要求输口令
  const [phase, setPhase] = useState<'checking' | 'locked' | 'open'>('checking')
  const [cfg, setCfg] = useState<GateConfig | null>(null)
  const [value, setValue] = useState('')
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [fails, setFails] = useState(0)
  const [cooldownLeft, setCooldownLeft] = useState(0)

  useEffect(() => {
    let alive = true
    void resolveGateConfig().then((c) => {
      if (!alive) return
      setCfg(c)
      if (!c.enabled) {
        setPhase('open')
        return
      }
      const remembered = hasLocalRemember(c.hash)
      const inCloudList =
        c.source === 'cloud' && c.devices.some((d) => d.id === getDeviceId())
      // 云端可达时要求「本地记住 + 云端在册」双条件（被机主移除的设备即使本地记住了也锁上）；
      // 离线时只看本地记忆
      setPhase(remembered && (c.source === 'local' || inCloudList) ? 'open' : 'locked')
    })
    return () => {
      alive = false
    }
  }, [])

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
    if (busy || cooldownLeft > 0 || !cfg) return
    setBusy(true)
    setError('')
    try {
      const digest = await sha256Hex(cfg.salt + value)
      if (digest && digest === cfg.hash) {
        if (remember) {
          rememberLocal(cfg.hash)
          // 登记进云端已验证设备清单（后台进行，不阻塞进站；失败只影响「云端在册」，
          // 下次进站若云端可达且不在册会要求重输 —— 到时再输一次即重新登记）
          void registerGateDevice().catch(() => {})
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
          记住此设备（登记后长期免输，可被机主远程移除）
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
