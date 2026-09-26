import { useCallback, useEffect, useState } from 'react'
import { format } from 'date-fns'
import { Loader2, MonitorSmartphone, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { Button, Card, CardHeader } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  fetchGateRegistry,
  forgetLocal,
  getDeviceId,
  removeGateDevices,
  type GateDevice,
} from '@/lib/accessGate'

/**
 * 已验证设备管理卡片（v31.11，设置 → 云端同步）。
 *
 * 参考「工作台」v21.41 的云端设备管理：
 * - 展示云端口令门清单里的全部设备（输对口令的设备会自动登记）。
 * - 机主可移除任意设备 / 清空全部；被移除的设备下次进站会被重新锁上。
 * - 移除本机时顺带清掉本地「记住」标记（当前会话仍放行，刷新后生效）。
 */

type LoadState = 'loading' | 'ok' | 'unreachable' | 'disabled'

export function GateDevicesCard() {
  const gateEnabled = __ACCESS_GATE__.hash !== ''
  const [state, setState] = useState<LoadState>(() => (gateEnabled ? 'loading' : 'disabled'))
  const [devices, setDevices] = useState<GateDevice[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [message, setMessage] = useState('')
  const selfId = getDeviceId()

  const reload = useCallback(async () => {
    if (!gateEnabled) return
    setState('loading')
    const reg = await fetchGateRegistry()
    if (reg) {
      setDevices([...reg.devices].sort((a, b) => b.at - a.at))
      setState('ok')
    } else {
      setDevices([])
      setState('unreachable')
    }
  }, [gateEnabled])

  useEffect(() => {
    void reload()
  }, [reload])

  const handleRemove = async (ids: string[] | 'all') => {
    const label = ids === 'all' ? '全部设备' : devices.find((d) => d.id === ids[0])?.name ?? '该设备'
    setBusyId(ids === 'all' ? '__all__' : ids[0])
    setMessage('')
    try {
      const rest = await removeGateDevices(ids)
      setDevices([...rest].sort((a, b) => b.at - a.at))
      if (ids === 'all' || ids.includes(selfId)) {
        forgetLocal() // 本机被移除 → 顺带清本地记忆（刷新后需重输口令）
        setMessage(`已移除${label}。本机的免输标记已清除，刷新页面后需重新输入口令`)
      } else {
        setMessage(`已移除「${label}」，该设备下次进站将要求重新输口令`)
      }
    } catch (e) {
      setMessage(`移除失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyId(null)
      setConfirmClear(false)
    }
  }

  return (
    <Card>
      <CardHeader
        title="口令门 · 已验证设备"
        subtitle="输对进站口令的设备会登记到这里，可随时移除"
        action={
          <Button size="sm" variant="ghost" onClick={() => void reload()} disabled={state === 'loading'}>
            {state === 'loading' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            刷新
          </Button>
        }
      />

      <div className="space-y-3 p-4">
        {state === 'disabled' && (
          <p className="text-[13px] text-text-3">
            当前构建未启用口令门（构建时未注入 ACCESS_PASSPHRASE）。
          </p>
        )}

        {state === 'loading' && (
          <p className="flex items-center gap-2 text-[13px] text-text-2">
            <Loader2 size={14} className="animate-spin" />
            正在读取云端设备清单…
          </p>
        )}

        {state === 'unreachable' && (
          <p className="text-[13px] text-text-3">
            云端暂无设备清单（可能未配置 Supabase、网络不可达，或还没有设备开启「记住此设备」）。
            各设备输对口令并勾选「记住此设备」后会自动登记。
          </p>
        )}

        {state === 'ok' && (
          <>
            {devices.length === 0 ? (
              <p className="text-[13px] text-text-3">清单为空：所有设备下次进站都需重新输口令。</p>
            ) : (
              <ul className="divide-y divide-line-1 overflow-hidden rounded-lg border border-line-1">
                {devices.map((d) => {
                  const isSelf = d.id === selfId
                  const busy = busyId === d.id || busyId === '__all__'
                  return (
                    <li key={d.id} className="flex items-center gap-3 bg-surface-2/30 px-3 py-2.5">
                      <MonitorSmartphone
                        size={16}
                        className={cn('shrink-0', isSelf ? 'text-accent' : 'text-text-3')}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 truncate text-[13px] text-text-1">
                          {d.name}
                          {isSelf && (
                            <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                              本机
                            </span>
                          )}
                        </p>
                        <p className="truncate text-[11px] text-text-3">
                          最近验证 {d.at > 0 ? format(d.at, 'M月d日 HH:mm') : '—'}
                          {' · '}
                          <span className="font-mono">{d.id.slice(0, 8)}</span>
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="shrink-0 text-money-out"
                        disabled={busy}
                        onClick={() => void handleRemove([d.id])}
                      >
                        {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                        移除
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}

            {devices.length > 0 && (
              <div className="flex items-center gap-2">
                {confirmClear ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="text-money-out"
                      onClick={() => void handleRemove('all')}
                    >
                      确认清空
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>
                      取消
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-money-out"
                    onClick={() => setConfirmClear(true)}
                  >
                    清空全部设备
                  </Button>
                )}
              </div>
            )}
          </>
        )}

        {message && <p className="text-[12px] text-money-due">{message}</p>}

        <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-text-3">
          <ShieldCheck size={13} className="mt-0.5 shrink-0" />
          修改进站口令 = 换新的 ACCESS_PASSPHRASE 重新构建发布；改后所有设备的本地记忆自动失效，
          需重新输口令。
        </p>
      </div>
    </Card>
  )
}
