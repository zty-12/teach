import { useCallback, useEffect, useState } from 'react'
import { format } from 'date-fns'
import {
  KeyRound,
  Loader2,
  LockOpen,
  MonitorSmartphone,
  RefreshCw,
  ShieldOff,
  Trash2,
} from 'lucide-react'
import { Button, Card, CardHeader, Input } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  closeGate,
  forgetLocal,
  getDeviceId,
  getDeviceName,
  removeGateDevices,
  resolveGateConfig,
  saveGatePassphrase,
  type GateConfig,
} from '@/lib/accessGate'

/**
 * 应用口令门管理卡片（v31.12，设置 → 云端同步；对齐工作台 v21.41）。
 *
 * - 口令哈希存云端：应用内即可 开启 / 修改口令 / 关闭，立即对全部设备生效。
 * - 已验证设备清单：输对口令并勾选「记住」的设备自动登记；可单台移除或清空全部。
 * - 与工作台一致：修改口令后已验证设备仍免输；要让全员重新验证就点「清空全部设备」。
 * - 忘记口令自救：Supabase Dashboard → SQL Editor 执行
 *   delete from app_settings where id='gate';
 *   （删除后回到构建时注入的口令）
 */

type BusyKey = '' | 'pass' | 'close' | 'clear' | `dev-${string}`

export function GateDevicesCard() {
  const [cfg, setCfg] = useState<GateConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [pass1, setPass1] = useState('')
  const [pass2, setPass2] = useState('')
  const [busy, setBusy] = useState<BusyKey>('')
  const [confirmClose, setConfirmClose] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [msg, setMsg] = useState('')
  const [msgOk, setMsgOk] = useState(false)
  const selfId = getDeviceId()

  const reload = useCallback(async () => {
    setLoading(true)
    const c = await resolveGateConfig()
    setCfg(c)
    setLoading(false)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const flash = (text: string, ok = false) => {
    setMsg(text)
    setMsgOk(ok)
  }

  /** 开启（未开启时）/ 修改口令（已开启时）—— 同一个云端入口 */
  const handleSavePass = async () => {
    const wasEnabled = cfg?.enabled ?? false
    if (pass1.length < 4) return flash('新口令至少 4 位')
    if (pass1 !== pass2) return flash('两次输入的口令不一致')
    setBusy('pass')
    try {
      await saveGatePassphrase(pass1)
      setPass1('')
      setPass2('')
      flash(
        wasEnabled
          ? '口令已更新：已验证设备仍免输；要让所有设备重新验证，请点「清空全部设备」'
          : '口令门已开启：所有设备需输新口令进入，输对并勾选「记住」即登记',
        true,
      )
      await reload()
    } catch (e) {
      flash(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy('')
    }
  }

  const handleClose = async () => {
    setBusy('close')
    try {
      await closeGate()
      flash('口令门已关闭：任何人可直接进入；重新开启后所有设备需重输口令', true)
      await reload()
    } catch (e) {
      flash(`关闭失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy('')
      setConfirmClose(false)
    }
  }

  const handleRemove = async (ids: string[] | 'all') => {
    const label = ids === 'all' ? '全部设备' : (cfg?.devices.find((d) => d.id === ids[0])?.name ?? '该设备')
    setBusy(ids === 'all' ? 'clear' : `dev-${ids[0]}`)
    try {
      const rest = await removeGateDevices(ids)
      setCfg((c) => (c ? { ...c, devices: rest } : c))
      if (ids === 'all' || ids.includes(selfId)) {
        forgetLocal() // 本机被移除 → 顺带清本地记忆（刷新后需重输口令）
        flash(`已移除${label}。本机免输标记已清除，刷新页面后需重新输口令`, true)
      } else {
        flash(`已移除「${label}」，该设备下次进站将要求重新输口令`, true)
      }
    } catch (e) {
      flash(`移除失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy('')
      setConfirmClear(false)
    }
  }

  const passReady = pass1.length >= 4 && pass1 === pass2

  return (
    <Card>
      <CardHeader
        title="应用口令门"
        subtitle="进站口令与已验证设备管理（云端权威，所有设备共用）"
        action={
          <Button size="sm" variant="ghost" onClick={() => void reload()} disabled={loading}>
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            刷新
          </Button>
        }
      />

      <div className="space-y-3 p-4">
        {loading && !cfg && (
          <p className="flex items-center gap-2 text-[13px] text-text-2">
            <Loader2 size={14} className="animate-spin" />
            正在读取口令门配置…
          </p>
        )}

        {cfg && (
          <>
            {/* 状态行 */}
            <p className="text-[13px] text-text-2">
              状态：
              <span className={cn('font-medium', cfg.enabled ? 'text-done' : 'text-text-3')}>
                {cfg.enabled ? '已开启' : '未开启'}
              </span>
              {cfg.source === 'local' && (
                <span className="ml-2 text-[11px] text-money-due">
                  （云端不可达，当前按本机缓存判断，暂无法远程管理）
                </span>
              )}
              {' · '}本机：{getDeviceName()}
            </p>

            {/* 云端不可达提示 */}
            {cfg.source === 'local' && (
              <p className="text-[12px] text-text-3">
                离线状态下无法修改口令或管理设备；联网后点「刷新」恢复。
              </p>
            )}

            {/* 口令设置区（云端可达时） */}
            {cfg.source === 'cloud' && (
              <div className="space-y-2 rounded-lg border border-line-1 bg-surface-2/30 p-3">
                <p className="flex items-center gap-1.5 text-[13px] font-medium text-text-1">
                  <KeyRound size={14} className="text-accent" />
                  {cfg.enabled ? '修改口令' : '开启口令门'}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    type="password"
                    value={pass1}
                    onChange={(e) => setPass1(e.target.value)}
                    placeholder="新口令（至少4位）"
                    disabled={busy === 'pass'}
                  />
                  <Input
                    type="password"
                    value={pass2}
                    onChange={(e) => setPass2(e.target.value)}
                    placeholder="再输一遍"
                    disabled={busy === 'pass'}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!passReady || busy === 'pass'}
                    onClick={() => void handleSavePass()}
                  >
                    {busy === 'pass' ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <LockOpen size={14} />
                    )}
                    {cfg.enabled ? '修改口令' : '开启口令门'}
                  </Button>

                  {cfg.enabled &&
                    (confirmClose ? (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="text-money-out"
                          disabled={busy === 'close'}
                          onClick={() => void handleClose()}
                        >
                          {busy === 'close' ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <ShieldOff size={14} />
                          )}
                          确认关闭
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmClose(false)}>
                          取消
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-money-out"
                        onClick={() => setConfirmClose(true)}
                      >
                        <ShieldOff size={14} />
                        关闭口令门
                      </Button>
                    ))}
                </div>
              </div>
            )}

            {/* 已验证设备 */}
            <div className="space-y-2">
              <p className="text-[13px] font-medium text-text-1">
                已验证设备（{cfg.devices.length}）
              </p>
              {cfg.devices.length === 0 ? (
                <p className="text-[12px] text-text-3">
                  {cfg.enabled
                    ? '清单为空：所有设备下次进站都需输口令。'
                    : '口令门未开启。'}
                </p>
              ) : (
                <ul className="divide-y divide-line-1 overflow-hidden rounded-lg border border-line-1">
                  {cfg.devices.map((d) => {
                    const isSelf = d.id === selfId
                    const key: BusyKey = `dev-${d.id}`
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
                          disabled={busy !== '' || cfg.source !== 'cloud'}
                          onClick={() => void handleRemove([d.id])}
                        >
                          {busy === key ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Trash2 size={14} />
                          )}
                          移除
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              )}

              {cfg.devices.length > 0 && cfg.source === 'cloud' && (
                <div className="flex items-center gap-2">
                  {confirmClear ? (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="text-money-out"
                        disabled={busy === 'clear'}
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
            </div>

            {/* 结果消息 */}
            {msg && (
              <p className={cn('text-[12px]', msgOk ? 'text-done' : 'text-money-due')}>{msg}</p>
            )}

            {/* 说明 */}
            <p className="text-[12px] leading-relaxed text-text-3">
              口令哈希存云端 settings 表，明文不落盘不上云；修改口令后已验证设备仍免输，要让所有设备重新验证，改口令后点「清空全部设备」。
              <br />
              忘记口令的自救：Supabase Dashboard → SQL Editor 执行{' '}
              <code className="rounded bg-surface-3 px-1">
                delete from app_settings where id='gate';
              </code>
            </p>
          </>
        )}
      </div>
    </Card>
  )
}
