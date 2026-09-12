import { useEffect, useRef, useState } from 'react'
import { format } from 'date-fns'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ClipboardCopy,
  Cloud,
  CloudOff,
  Download,
  Eye,
  EyeOff,
  Loader2,
  Moon,
  Palette,
  RefreshCw,
  Save,
  Sparkles,
  Sun,
  Upload,
  XCircle,
} from 'lucide-react'
import { useSettings } from '@/store/useSettings'
import {
  resolveSettings,
  testConnection,
  type ConnectionTestResult,
} from '@/lib/supabase'
import { pendingCount, syncNow } from '@/lib/sync'
import { createSnapshot } from '@/lib/snapshots'
import { VersionHistoryCard } from '@/components/VersionHistoryCard'
import { isAiConfigured, testLlm, testVisionLlm, LLM_PRESETS } from '@/lib/llm'
import { exportBackupJson, importBackupJson } from '@/lib/exporters'
import {
  CardHeader,
  Field,
  Input,
  Button,
  SegmentedControl,
  Select,
  Card,
} from '@/components/ui'
import { cn } from '@/lib/utils'
import type { AppSettings } from '@/lib/types'

type ThemeMode = AppSettings['themeMode']
type SyncState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'testing' }
  | { kind: 'syncing' }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string }

export default function SettingsPage() {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)

  const [draftUrl, setDraftUrl] = useState(settings.supabaseUrl)
  const [draftKey, setDraftKey] = useState(settings.supabaseAnonKey)
  const [showKey, setShowKey] = useState(false)
  const [syncState, setSyncState] = useState<SyncState>({ kind: 'idle' })
  const [pending, setPending] = useState(0)
  const [lastTest, setLastTest] = useState<ConnectionTestResult | null>(null)
  const [copied, setCopied] = useState(false)
  // 同步过程中检测到云端缺表时的引导（用于手动同步而非 testConnection 的场景）
  const [syncSchemaHint, setSyncSchemaHint] = useState<string | null>(null)
  // 数据版本列表刷新信号（同步/恢复后 +1 触发重载）
  const [versionRefresh, setVersionRefresh] = useState(0)
  const [aiStatus, setAiStatus] = useState<'idle' | 'testing' | 'ok' | 'err'>(() =>
    isAiConfigured(settings) ? 'ok' : 'idle',
  )
  const [aiMessage, setAiMessage] = useState('')
  const [visionStatus, setVisionStatus] = useState<'idle' | 'testing' | 'ok' | 'err'>('idle')
  const [visionMessage, setVisionMessage] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // settings 变化时同步到草稿（外部改也跟上）
  useEffect(() => {
    setDraftUrl(settings.supabaseUrl)
    setDraftKey(settings.supabaseAnonKey)
  }, [settings.supabaseUrl, settings.supabaseAnonKey])

  useEffect(() => {
    void pendingCount().then(setPending)
  }, [settings.lastSyncAt, settings.supabaseUrl, settings.supabaseAnonKey])

  const resolved = resolveSettings(settings)
  const hasSavedConfig = Boolean(settings.supabaseUrl.trim() && settings.supabaseAnonKey.trim())
  const draftChanged =
    draftUrl.trim() !== settings.supabaseUrl.trim() ||
    draftKey.trim() !== settings.supabaseAnonKey.trim()

  async function handleSave() {
    setSyncState({ kind: 'saving' })
    try {
      await update({ supabaseUrl: draftUrl.trim(), supabaseAnonKey: draftKey.trim() })
      setSyncState({ kind: 'success', message: '已保存到本机' })
      setLastTest(null)
    } catch (e) {
      setSyncState({ kind: 'error', message: String(e) })
    }
  }

  async function handleTest() {
    // 先把当前草稿存起来再测，避免「填了不存就测」导致测的是旧值
    let s = settings
    if (draftChanged) {
      await update({ supabaseUrl: draftUrl.trim(), supabaseAnonKey: draftKey.trim() })
      s = { ...settings, supabaseUrl: draftUrl.trim(), supabaseAnonKey: draftKey.trim() }
    }
    setSyncState({ kind: 'testing' })
    try {
      const result = await testConnection(s)
      setLastTest(result)
      setSyncState(
        result.ok
          ? { kind: 'success', message: result.message }
          : { kind: 'error', message: result.message },
      )
    } catch (e) {
      setSyncState({ kind: 'error', message: `测试失败：${String(e)}` })
    }
  }

  async function handleSync() {
    if (draftChanged) await update({ supabaseUrl: draftUrl.trim(), supabaseAnonKey: draftKey.trim() })
    setSyncState({ kind: 'syncing' })
    setSyncSchemaHint(null)
    try {
      const r = await syncNow({
        ...settings,
        supabaseUrl: draftUrl.trim() || settings.supabaseUrl,
        supabaseAnonKey: draftKey.trim() || settings.supabaseAnonKey,
      })
      // 检测「云端缺少表」类错误（schema 版本不一致），给出补建表引导
      const missingTable = r.errors.find((m) => /could not find the table|schema cache|table does not exist/i.test(m))
      const fatal = r.errors.length > 0 && r.pushed === 0 && r.pulled === 0
      if (missingTable) {
        setSyncState({ kind: 'error', message: '同步中断：云端缺少部分数据表' })
        setSyncSchemaHint(missingTable)
      } else if (fatal) {
        setSyncState({ kind: 'error', message: r.errors[0] ?? '同步失败' })
      } else {
        const tail = r.errors.length > 0 ? `（${r.errors[0]}）` : ''
        setSyncState({
          kind: 'success',
          message: `已推送 ${r.pushed} 条，拉取 ${r.pulled} 条${tail}`,
        })
      }
      // 同步无致命错误 → 留档一个数据版本（数据未变会自动去重），并刷新版本列表
      if (!missingTable && !fatal) {
        await createSnapshot({ auto: true }).catch(() => null)
        setVersionRefresh((v) => v + 1)
      }
      setPending(await pendingCount())
      // 触发 settings 重读，让 lastSyncAt 刷新
      await update({})
    } catch (e) {
      setSyncState({ kind: 'error', message: `同步失败：${String(e)}` })
    }
  }

  async function handleCopySchema() {
    try {
      await navigator.clipboard.writeText(SCHEMA_INSTRUCTIONS)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* 剪贴板不可用时静默 */
    }
  }

  async function handleTestAi() {
    setAiStatus('testing')
    setAiMessage('')
    try {
      // 用 store 最新值测试（受控输入已实时写入 settings）
      const latest = useSettings.getState().settings
      await update({
        aiBaseUrl: latest.aiBaseUrl.trim(),
        aiApiKey: latest.aiApiKey.trim(),
        aiModel: latest.aiModel.trim(),
        aiProxyUrl: latest.aiProxyUrl.trim(),
        aiProxyToken: latest.aiProxyToken.trim(),
      })
      const reply = await testLlm(latest)
      setAiStatus('ok')
      setAiMessage(`连接成功，模型响应：${reply}`)
    } catch (e) {
      setAiStatus('err')
      setAiMessage(`连接失败：${String(e instanceof Error ? e.message : e)}`)
    }
  }

  async function handleTestVision() {
    setVisionStatus('testing')
    setVisionMessage('')
    try {
      const latest = useSettings.getState().settings
      await update({
        aiVisionEnabled: latest.aiVisionEnabled,
        aiVisionBaseUrl: latest.aiVisionBaseUrl.trim(),
        aiVisionApiKey: latest.aiVisionApiKey.trim(),
        aiVisionModel: latest.aiVisionModel.trim(),
        aiVisionProxyUrl: latest.aiVisionProxyUrl.trim(),
        aiVisionProxyToken: latest.aiVisionProxyToken.trim(),
      })
      const reply = await testVisionLlm(latest)
      setVisionStatus('ok')
      setVisionMessage(`连接成功，模型响应：${reply}`)
    } catch (e) {
      setVisionStatus('err')
      setVisionMessage(`连接失败：${String(e instanceof Error ? e.message : e)}`)
    }
  }

  function copyAiToVision() {
    void update({
      aiVisionBaseUrl: settings.aiBaseUrl,
      aiVisionApiKey: settings.aiApiKey,
      aiVisionProxyMode: settings.aiProxyMode,
      aiVisionProxyUrl: settings.aiProxyUrl,
      aiVisionProxyToken: settings.aiProxyToken,
    })
  }

  function applyPreset(presetIndex: number) {
    const p = LLM_PRESETS[presetIndex]
    if (!p) return
    void update({
      aiProvider: 'openai-compatible',
      aiBaseUrl: p.baseUrl,
      aiModel: p.model,
    })
  }

  async function handleExport() {
    try {
      await exportBackupJson()
    } catch (e) {
      alert(`导出失败：${String(e)}`)
    }
  }

  async function handleImportFile(file: File) {
    try {
      const res = await importBackupJson(file)
      alert(
        `恢复完成：共 ${res.tables} 张表 / ${res.rows} 条记录已合并到本地。\n请刷新页面查看；开启同步后，新数据会自动推送到云端。`,
      )
      setPending((await pendingCount()) + 1)
    } catch (e) {
      alert(`恢复失败：${String(e instanceof Error ? e.message : e)}`)
    }
  }

  const syncIndicator = (() => {
    if (!resolved.url) {
      return { icon: CloudOff, label: '未配置', tone: 'idle' as const }
    }
    if (lastTest?.ok) {
      return { icon: CheckCircle2, label: '已连接', tone: 'ok' as const }
    }
    if (lastTest && !lastTest.ok) {
      return { icon: XCircle, label: '连接异常', tone: 'err' as const }
    }
    return { icon: Cloud, label: '已配置（待测试）', tone: 'wait' as const }
  })()
  const SyncIcon = syncIndicator.icon

  return (
    <div className="max-w-2xl space-y-4">
      {/* 外观 */}
      <Card>
        <CardHeader title="外观" subtitle="主题与配色" />

        <div className="space-y-4 p-4">
          <Field label="主题模式" hint="跟随系统会随设备设置自动切换">
            <SegmentedControl<ThemeMode>
              value={settings.themeMode}
              onChange={(v) => void update({ themeMode: v })}
              options={[
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
                { value: 'system', label: '跟随系统' },
              ]}
            />
          </Field>

          <div className="flex gap-2">
            <ThemePreview mode="light" active={settings.themeMode === 'light'} />
            <ThemePreview mode="dark" active={settings.themeMode === 'dark'} />
          </div>

          <Field label="科目配色" hint="用于课程块、头像与标签的 8 个色槽">
            <div className="flex flex-wrap gap-2">
              {settings.subjectColors.map((color, i) => (
                <label key={i} className="relative cursor-pointer">
                  <input
                    type="color"
                    value={color}
                    onChange={(e) => {
                      const next = [...settings.subjectColors]
                      next[i] = e.target.value
                      void update({ subjectColors: next })
                    }}
                    className="h-9 w-9 cursor-pointer rounded-lg border border-line-1 bg-transparent"
                    aria-label={`配色 ${i + 1}`}
                  />
                </label>
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void update({
                    subjectColors: [
                      '#3b82f6',
                      '#10b981',
                      '#f59e0b',
                      '#ef4444',
                      '#8b5cf6',
                      '#ec4899',
                      '#06b6d4',
                      '#84cc16',
                    ],
                  })
                }
              >
                <Palette size={14} />
                重置
              </Button>
            </div>
          </Field>
        </div>
      </Card>

      {/* 个人 */}
      <Card>
        <CardHeader title="个人" subtitle="显示名称与默认参数" />
        <div className="space-y-3 p-4">
          <Field label="称呼">
            <Input
              value={settings.teacherName}
              onChange={(e) => void update({ teacherName: e.target.value })}
              placeholder="老师"
            />
          </Field>

          <div className="grid grid-cols-3 gap-3">
            <Field label="默认时长">
              <Input
                type="number"
                min={15}
                step={15}
                value={settings.defaultDurationMin}
                onChange={(e) =>
                  void update({ defaultDurationMin: Number(e.target.value) || 60 })
                }
              />
            </Field>
            <Field label="日程起始">
              <Select
                value={String(settings.dayStartHour)}
                onChange={(e) => void update({ dayStartHour: Number(e.target.value) })}
              >
                {Array.from({ length: 12 }, (_, i) => i + 6).map((h) => (
                  <option key={h} value={h}>
                    {h}:00
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="日程结束">
              <Select
                value={String(settings.dayEndHour)}
                onChange={(e) => void update({ dayEndHour: Number(e.target.value) })}
              >
                {Array.from({ length: 12 }, (_, i) => i + 14).map((h) => (
                  <option key={h} value={h}>
                    {h}:00
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
      </Card>

      {/* AI 辅助 */}
      <Card>
        <CardHeader
          title="AI 辅助"
          subtitle="自动生成课后反馈与学习报告"
          action={
            <span
              className={cn(
                'flex items-center gap-1 text-xs',
                aiStatus === 'ok' && 'text-done',
                aiStatus === 'err' && 'text-money-due',
                aiStatus === 'testing' && 'text-text-2',
                aiStatus === 'idle' && 'text-text-3',
              )}
            >
              {aiStatus === 'ok' ? (
                <>
                  <CheckCircle2 size={14} /> 已连接
                </>
              ) : aiStatus === 'err' ? (
                <>
                  <XCircle size={14} /> 连接异常
                </>
              ) : aiStatus === 'testing' ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> 测试中
                </>
              ) : isAiConfigured(settings) ? (
                <>
                  <Cloud size={14} /> 已配置
                </>
              ) : (
                <>
                  <CloudOff size={14} /> 未配置
                </>
              )}
            </span>
          }
        />

        <div className="space-y-3 p-4">
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-text-2">
            <input
              type="checkbox"
              checked={settings.aiEnabled}
              onChange={(e) => void update({ aiEnabled: e.target.checked })}
              className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
            />
            启用 AI 功能
          </label>

          <Field label="提供方预设" hint="一键填入常用服务的 Base URL 与默认模型">
            <div className="flex flex-wrap gap-2">
              {LLM_PRESETS.map((p, i) => (
                <Button key={p.label} size="sm" variant="secondary" onClick={() => applyPreset(i)}>
                  {p.label}
                </Button>
              ))}
            </div>
          </Field>

          <Field label="Base URL" hint="OpenAI 兼容 /v1 接口，通常以 /v1 结尾">
            <Input
              value={settings.aiBaseUrl}
              onChange={(e) => void update({ aiBaseUrl: e.target.value })}
              placeholder="https://api.deepseek.com/v1"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>

          <Field label="API Key" hint="存于本机设置，仅在你的浏览器中用于调用">
            <Input
              value={settings.aiApiKey}
              onChange={(e) => void update({ aiApiKey: e.target.value })}
              type="password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="sk-..."
            />
          </Field>

          <Field label="模型名" hint="文本生成模型，用于课后反馈 / 学习报告 / 知识点总结">
            <Input
              value={settings.aiModel}
              onChange={(e) => void update({ aiModel: e.target.value })}
              placeholder="deepseek-chat / gpt-4o-mini"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>

          <div className="rounded-lg border border-line-1 bg-surface-1 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <Field label="请求模式" hint="浏览器直连被 CORS 拦时切到 Edge Function">
                <Select
                  value={settings.aiProxyMode}
                  onChange={(e) => void update({ aiProxyMode: e.target.value as 'direct' | 'proxy' })}
                >
                  <option value="direct">直连 LLM（浏览器 → API）</option>
                  <option value="proxy">经 Supabase Edge Function 中转</option>
                </Select>
              </Field>
            </div>
            {settings.aiProxyMode === 'proxy' && (
              <>
                <Field label="Edge Function URL" hint="Supabase Functions → llm-proxy 的调用地址">
                  <Input
                    value={settings.aiProxyUrl}
                    onChange={(e) => void update({ aiProxyUrl: e.target.value })}
                    placeholder="https://xxx.supabase.co/functions/v1/llm-proxy"
                    inputMode="url"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </Field>
                <Field
                  label="中转 Token"
                  hint="Supabase Secret LLM_PROXY_TOKEN 的值（前端经 x-proxy-token 头携带）"
                >
                  <Input
                    value={settings.aiProxyToken}
                    onChange={(e) => void update({ aiProxyToken: e.target.value })}
                    type="password"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="与 Supabase Secret LLM_PROXY_TOKEN 一致"
                  />
                </Field>
                <p className="text-[11px] text-text-3 leading-relaxed">
                  首次使用需先在 Supabase Edge Functions 部署 <code className="rounded bg-surface-0 px-1">llm-proxy</code>（源码见 <code className="rounded bg-surface-0 px-1">supabase/functions/llm-proxy/index.ts</code>），并在项目 Secrets 中加 <code className="rounded bg-surface-0 px-1">LLM_PROXY_TOKEN</code>。
                  <br />
                  若提示「API 401 / Proxy 401」：说明函数网关默认开启 JWT 校验，把本 Token 当作 JWT 拒绝了。请
                  <strong className="text-text-2"> 重新粘贴上面源码并重新部署 llm-proxy</strong>
                  ——新版函数改从 <code className="rounded bg-surface-0 px-1">x-proxy-token</code> 头读取共享密钥，会由前端自动携带 Supabase anon key 通过网关校验（需在「数据同步」里填好 URL 与 anon key）。
                </p>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => void handleTestAi()}
              disabled={
                !settings.aiEnabled ||
                !settings.aiBaseUrl.trim() ||
                !settings.aiApiKey.trim() ||
                (settings.aiProxyMode === 'proxy' &&
                  (!settings.aiProxyUrl.trim() || !settings.aiProxyToken.trim())) ||
                aiStatus === 'testing'
              }
            >
              {aiStatus === 'testing' ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Sparkles size={15} />
              )}
              测试连接
            </Button>
          </div>

          {aiMessage && (
            <p
              className={cn(
                'text-[13px]',
                aiStatus === 'ok' ? 'text-done' : 'text-money-due',
              )}
            >
              {aiMessage}
            </p>
          )}

          <div className="my-2 border-t border-line-1" />

          {/* 视觉模型（图片识别）—— 与通用 AI 完全独立的一组配置 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-medium text-text-1">视觉模型（图片识别）</span>
              <span
                className={cn(
                  'flex items-center gap-1 text-xs',
                  visionStatus === 'ok' && 'text-done',
                  visionStatus === 'err' && 'text-money-due',
                  visionStatus === 'testing' && 'text-text-2',
                  visionStatus === 'idle' && 'text-text-3',
                )}
              >
                {visionStatus === 'ok' ? (
                  <>
                    <CheckCircle2 size={14} /> 已连接
                  </>
                ) : visionStatus === 'err' ? (
                  <>
                    <XCircle size={14} /> 连接异常
                  </>
                ) : visionStatus === 'testing' ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> 测试中
                  </>
                ) : settings.aiVisionEnabled ? (
                  <>
                    <Cloud size={14} /> 已配置
                  </>
                ) : (
                  <>
                    <CloudOff size={14} /> 未配置
                  </>
                )}
              </span>
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-text-2">
              <input
                type="checkbox"
                checked={settings.aiVisionEnabled}
                onChange={(e) => void update({ aiVisionEnabled: e.target.checked })}
                className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
              />
              启用视觉模型（用于图片型 PDF / 扫描件识别）
            </label>

            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => void copyAiToVision()}>
                <ClipboardCopy size={13} /> 沿用通用 AI 配置
              </Button>
            </div>

            <Field label="Base URL" hint="可与通用 AI 不同，例如独立的多模态服务地址">
              <Input
                value={settings.aiVisionBaseUrl}
                onChange={(e) => void update({ aiVisionBaseUrl: e.target.value })}
                placeholder="https://api.xxx.com/v1"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </Field>

            <Field label="API Key" hint="存于本机设置，仅用于你的浏览器调用">
              <Input
                type="password"
                value={settings.aiVisionApiKey}
                onChange={(e) => void update({ aiVisionApiKey: e.target.value })}
                placeholder="sk-..."
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </Field>

            <Field label="模型名" hint="例：sensenova-6.8-flash-lite、gpt-4o-mini、qwen-vl-max">
              <Input
                value={settings.aiVisionModel}
                onChange={(e) => void update({ aiVisionModel: e.target.value })}
                placeholder="sensenova-6.8-flash-lite"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </Field>

            <div className="rounded-lg border border-line-1 bg-surface-1 p-3 space-y-2">
              <Field label="请求模式" hint="浏览器直连被 CORS 拦时切到 Edge Function">
                <Select
                  value={settings.aiVisionProxyMode}
                  onChange={(e) => void update({ aiVisionProxyMode: e.target.value as 'direct' | 'proxy' })}
                >
                  <option value="direct">直连（浏览器 → API）</option>
                  <option value="proxy">经 Supabase Edge Function 中转</option>
                </Select>
              </Field>
              {settings.aiVisionProxyMode === 'proxy' && (
                <>
                  <Field label="Edge Function URL">
                    <Input
                      value={settings.aiVisionProxyUrl}
                      onChange={(e) => void update({ aiVisionProxyUrl: e.target.value })}
                      placeholder="https://xxx.supabase.co/functions/v1/llm-proxy"
                      inputMode="url"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                  </Field>
                  <Field label="中转 Token" hint="与文本模型一致，来自 LLM_PROXY_TOKEN">
                    <Input
                      type="password"
                      value={settings.aiVisionProxyToken}
                      onChange={(e) => void update({ aiVisionProxyToken: e.target.value })}
                      placeholder="与 Supabase Secret LLM_PROXY_TOKEN 一致"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                  </Field>
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => void handleTestVision()}
                disabled={
                  !settings.aiVisionEnabled ||
                  !settings.aiVisionBaseUrl.trim() ||
                  !settings.aiVisionApiKey.trim() ||
                  (settings.aiVisionProxyMode === 'proxy' &&
                    (!settings.aiVisionProxyUrl.trim() || !settings.aiVisionProxyToken.trim())) ||
                  visionStatus === 'testing'
                }
              >
                {visionStatus === 'testing' ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Sparkles size={15} />
                )}
                测试连接
              </Button>
            </div>

            {visionMessage && (
              <p className={cn('text-[13px]', visionStatus === 'ok' ? 'text-done' : 'text-money-due')}>
                {visionMessage}
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* 云端同步 */}
      <Card>
        <CardHeader
          title="云端同步"
          subtitle="填写 Supabase 项目后即可跨设备同步"
          action={
            <span
              className={cn(
                'flex items-center gap-1 text-xs',
                syncIndicator.tone === 'ok' && 'text-done',
                syncIndicator.tone === 'err' && 'text-money-due',
                syncIndicator.tone === 'wait' && 'text-text-2',
                syncIndicator.tone === 'idle' && 'text-text-3',
              )}
            >
              <SyncIcon size={14} />
              {syncIndicator.label}
            </span>
          }
        />

        <div className="space-y-3 p-4">
          <Field label="Project URL" hint="形如 https://xxx.supabase.co">
            <Input
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              placeholder="https://xxx.supabase.co"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>

          <Field label="anon public key" hint="在 Supabase 控制台 Settings → API 中获取">
            <div className="relative">
              <Input
                value={draftKey}
                onChange={(e) => setDraftKey(e.target.value)}
                placeholder="eyJhbGciOi..."
                type={showKey ? 'text' : 'password'}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? '隐藏 key' : '显示 key'}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-3 hover:bg-surface-2 hover:text-text-1"
              >
                {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </Field>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => void handleSave()}
              disabled={!draftChanged || syncState.kind === 'saving'}
            >
              {syncState.kind === 'saving' ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Save size={15} />
              )}
              保存
            </Button>
            <Button
              variant="secondary"
              onClick={() => void handleTest()}
              disabled={!hasSavedConfig && !draftUrl.trim() && !draftKey.trim() || syncState.kind === 'testing'}
            >
              {syncState.kind === 'testing' ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <CheckCircle2 size={15} />
              )}
              测试连接
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleSync()}
              disabled={
                !hasSavedConfig ||
                syncState.kind === 'syncing' ||
                syncState.kind === 'testing' ||
                syncState.kind === 'saving'
              }
            >
              {syncState.kind === 'syncing' ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <RefreshCw size={15} />
              )}
              立即同步
            </Button>
          </div>

          {/* 反馈区 */}
          {syncState.kind !== 'idle' && syncState.kind !== 'saving' && syncState.kind !== 'testing' && syncState.kind !== 'syncing' && (
            <p
              className={cn(
                'text-[13px]',
                syncState.kind === 'success' ? 'text-done' : 'text-money-due',
              )}
            >
              {syncState.message}
            </p>
          )}

          {/* 表缺失时引导建表 */}
          {lastTest && !lastTest.ok && lastTest.tables.some((t) => !t.ok) && (
            <div className="rounded-lg border border-line-1 bg-surface-2 p-3">
              <div className="mb-2 flex items-center gap-2 text-[13px] text-text-1">
                <AlertTriangle size={14} className="text-money-due" />
                缺少业务表，需要先在 Supabase 建表
              </div>
              <ol className="list-decimal space-y-1 pl-5 text-[12px] leading-relaxed text-text-2">
                <li>打开 Supabase 项目 → SQL Editor</li>
                <li>新建查询，粘贴 <code className="rounded bg-surface-3 px-1">supabase/schema.sql</code> 全部内容</li>
                <li>点 Run 执行，然后回到这里再点「测试连接」</li>
              </ol>
              <div className="mt-2">
                <Button size="sm" variant="ghost" onClick={() => void handleCopySchema()}>
                  <ClipboardCopy size={14} />
                  {copied ? '已复制指引' : '复制完整指引'}
                </Button>
              </div>
            </div>
          )}

          {/* 同步时检测到云端缺表（schema 版本不一致）*/}
          {syncSchemaHint && (
            <div className="rounded-lg border border-line-1 bg-surface-2 p-3">
              <div className="mb-2 flex items-center gap-2 text-[13px] text-text-1">
                <AlertTriangle size={14} className="text-money-due" />
                云端缺少数据表，同步中断
              </div>
              <p className="text-[12px] leading-relaxed text-text-2">
                当前 Supabase 项目是<strong>旧版本建表</strong>的，缺少最新的一张表（
                <code className="rounded bg-surface-3 px-1">{syncSchemaHint}</code>
                ）。请重新跑一次最新建表脚本：
              </p>
              <ol className="mt-1 list-decimal space-y-1 pl-5 text-[12px] leading-relaxed text-text-2">
                <li>打开 Supabase 项目 → SQL Editor</li>
                <li>新建查询，粘贴 <code className="rounded bg-surface-3 px-1">supabase/schema.sql</code> 全部内容</li>
                <li>点 Run 执行（会补建缺失的 studentTags 表），然后回来点「立即同步」</li>
              </ol>
              <div className="mt-2">
                <Button size="sm" variant="ghost" onClick={() => void handleCopySchema()}>
                  <ClipboardCopy size={14} />
                  {copied ? '已复制指引' : '复制完整指引'}
                </Button>
              </div>
            </div>
          )}

          {/* 未配置时显示占位 */}
          {!hasSavedConfig && (
            <p className="text-[13px] text-text-3">
              当前为纯本地模式。填入 Supabase URL 与 anon key 即可启用跨设备同步。
            </p>
          )}

          {/* 已配置时显示连接来源 + 上次同步时间 + 待推送数 */}
          {hasSavedConfig && (
            <div className="space-y-1 text-[13px] text-text-2">
              <p>
                配置来源：
                <span className="ml-1 text-text-1">
                  {resolved.source === 'settings' ? '设置（本机）' : resolved.source === 'env' ? '.env' : '未配置'}
                </span>
              </p>
              <p>
                待推送 <span className="font-medium text-text-1">{pending}</span> 条变更
                {settings.lastSyncAt > 0 && (
                  <>
                    {' · '}
                    上次同步 {format(settings.lastSyncAt, 'M月d日 HH:mm')}
                  </>
                )}
              </p>
              {syncEnabledToggle(settings, update)}
            </div>
          )}
        </div>
      </Card>

      {/* 数据版本（同步后自动留档，可回滚到历史版本） */}
      <VersionHistoryCard
        refreshKey={versionRefresh}
        hasCloud={hasSavedConfig}
        onChanged={async () => {
          setVersionRefresh((v) => v + 1)
          setPending(await pendingCount())
        }}
      />

      {/* 数据 */}
      <Card>
        <CardHeader title="数据" subtitle="备份与迁移" />
        <div className="p-4">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void handleExport()}>
              <Download size={15} />
              导出全部数据（JSON）
            </Button>
            <Button onClick={() => fileInputRef.current?.click()}>
              <Upload size={15} />
              导入备份
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleImportFile(f)
                e.target.value = ''
              }}
            />
          </div>
          <p className="mt-2 text-xs text-text-3">
            导出文件包含所有学生、班课、课程、财务、反馈、报告与标签，可用于备份或迁移。导入会按记录 id
            合并到本地（不覆盖云端已有数据），开启同步后新数据自动推送。
          </p>
        </div>
      </Card>
    </div>
  )
}

function syncEnabledToggle(
  settings: AppSettings,
  update: (patch: Partial<AppSettings>) => Promise<void>,
) {
  return (
    <label className="mt-2 flex cursor-pointer items-center gap-2 text-[13px] text-text-2">
      <input
        type="checkbox"
        checked={settings.syncEnabled}
        onChange={(e) => void update({ syncEnabled: e.target.checked })}
        className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
      />
      启用自动同步（开启后每次本地变更会在后台推送到云端）
    </label>
  )
}

function ThemePreview({ mode, active }: { mode: 'light' | 'dark'; active: boolean }) {
  const light = mode === 'light'
  return (
    <div
      className={cn(
        'flex flex-1 items-center gap-2 rounded-lg border p-3',
        active ? 'border-accent' : 'border-line-1',
        light ? 'bg-white' : 'bg-[#0f172a]',
      )}
    >
      {light ? (
        <Sun size={16} className="text-[#0f172a]" />
      ) : (
        <Moon size={16} className="text-[#f1f5f9]" />
      )}
      <span className={cn('text-[13px]', light ? 'text-[#0f172a]' : 'text-[#f1f5f9]')}>
        {light ? '浅色' : '深色'}
      </span>
      {active && <Check size={14} className="ml-auto text-accent" />}
    </div>
  )
}

/** 复制到剪贴板的完整指引 */
const SCHEMA_INSTRUCTIONS = `Supabase 建表指引（教务工作台）

1. 登录 https://supabase.com/dashboard 进入你的项目
2. 左侧菜单 → SQL Editor → New query
3. 将 supabase/schema.sql 的全部内容粘贴到编辑器
4. 点击右下角 Run 执行
5. 回到工作台「设置 → 云端同步」点「测试连接」

schema.sql 已为你创建 9 张业务表：
- students / groups / groupMembers
- courses / courseFeedbacks
- learningReports / learningTags
- payments / settlements

并对每张表开启 RLS，anon 角色全权读写（单人自用设计）。`