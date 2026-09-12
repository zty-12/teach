import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  BookOpen,
  FileUp,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react'
import { db, markDeleted, touch, withSyncFields } from '@/lib/db'
import { useSettings } from '@/store/useSettings'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Textarea,
} from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  buildVisionCfg,
  classifyImportedDocument,
  detectUnitTitles,
  isAiConfigured,
  LlmError,
  summarizeImportedPoint,
  summarizeKnowledgePoint,
} from '@/lib/llm'
import {
  extractTextFromFile,
  type ExtractedText,
  type ExtractProgress,
  type ImportStrategy,
} from '@/lib/fileImport'
import { BatchRunner, BatchCancelledError } from '@/lib/batchRunner'
import type {
  ImportedDocClassification,
  ImportedUnit,
} from '@/lib/llm'
import type {
  AppSettings,
  KnowledgePoint,
  Textbook,
  TextbookUnit,
} from '@/lib/types'

export default function KnowledgePage() {
  const textbooks = useLiveQuery(() => db.textbooks.toArray(), [])
  const units = useLiveQuery(() => db.textbookUnits.toArray(), [])
  const points = useLiveQuery(() => db.knowledgePoints.toArray(), [])

  const [selectedTextbookId, setSelectedTextbookId] = useState<string | null>(null)
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const liveTextbooks = (textbooks ?? []).filter((t) => !t.deletedAt)
  const liveUnits = (units ?? []).filter((u) => !u.deletedAt)
  const livePoints = (points ?? []).filter((p) => !p.deletedAt)

  // 默认选中第一个教材/单元
  const activeTextbookId =
    selectedTextbookId && liveTextbooks.some((t) => t.id === selectedTextbookId)
      ? selectedTextbookId
      : liveTextbooks[0]?.id ?? null
  const unitsOfActive = useMemo(
    () =>
      liveUnits
        .filter((u) => u.textbookId === activeTextbookId)
        .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt),
    [liveUnits, activeTextbookId],
  )
  const activeUnitId =
    selectedUnitId && unitsOfActive.some((u) => u.id === selectedUnitId)
      ? selectedUnitId
      : unitsOfActive[0]?.id ?? null

  const pointsOfActive = useMemo(() => {
    const list = livePoints.filter((p) => p.unitId === activeUnitId)
    const q = search.trim().toLowerCase()
    if (!q) return list.sort((a, b) => a.createdAt - b.createdAt)
    return list
      .filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.content.toLowerCase().includes(q) ||
          (p.summary ?? '').toLowerCase().includes(q),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
  }, [livePoints, activeUnitId, search])

  // 教材表单/弹窗
  const [editingTextbook, setEditingTextbook] = useState<Textbook | null>(null)
  const [textbookModalOpen, setTextbookModalOpen] = useState(false)
  function openNewTextbook() {
    setEditingTextbook(null)
    setTextbookModalOpen(true)
  }
  function openEditTextbook(t: Textbook) {
    setEditingTextbook(t)
    setTextbookModalOpen(true)
  }

  // 单元表单/弹窗
  const [editingUnit, setEditingUnit] = useState<TextbookUnit | null>(null)
  const [unitModalOpen, setUnitModalOpen] = useState(false)
  function openNewUnit() {
    setEditingUnit(null)
    if (activeTextbookId) setUnitModalOpen(true)
  }
  function openEditUnit(u: TextbookUnit) {
    setEditingUnit(u)
    setUnitModalOpen(true)
  }

  // 知识点表单/弹窗
  const [editingPoint, setEditingPoint] = useState<KnowledgePoint | null>(null)
  const [pointModalOpen, setPointModalOpen] = useState(false)
  function openNewPoint() {
    if (!activeUnitId) return
    setEditingPoint(null)
    setPointModalOpen(true)
  }
  function openEditPoint(p: KnowledgePoint) {
    setEditingPoint(p)
    setPointModalOpen(true)
  }

  // 文件导入弹窗
  const [importModalOpen, setImportModalOpen] = useState(false)
  // AI 摘要后台生成进度（弹窗关闭后仍在页面顶部提示）
  const [summaryJob, setSummaryJob] = useState<{ done: number; total: number } | null>(null)

  async function handleDeleteTextbook(t: Textbook) {
    if (!confirm(`删除教材「${t.name}」？会同时删除其下单元与知识点。`)) return
    await db.textbooks.put(markDeleted(t))
    // 同步删除其下单元与知识点
    const unitIds = liveUnits.filter((u) => u.textbookId === t.id).map((u) => u.id)
    for (const u of liveUnits.filter((x) => x.textbookId === t.id)) {
      await db.textbookUnits.put(markDeleted(u))
    }
    for (const p of livePoints.filter((x) => unitIds.includes(x.unitId))) {
      await db.knowledgePoints.put(markDeleted(p))
    }
  }
  async function handleDeleteUnit(u: TextbookUnit) {
    if (!confirm(`删除单元「${u.name}」？会同时删除其下知识点。`)) return
    await db.textbookUnits.put(markDeleted(u))
    for (const p of livePoints.filter((x) => x.unitId === u.id)) {
      await db.knowledgePoints.put(markDeleted(p))
    }
  }
  async function handleDeletePoint(p: KnowledgePoint) {
    if (!confirm(`删除知识点「${p.title}」？`)) return
    await db.knowledgePoints.put(markDeleted(p))
  }

  return (
    <div>
      <PageHeader
        title="知识库"
        subtitle={
          summaryJob
            ? `AI 摘要生成中 ${summaryJob.done}/${summaryJob.total} · 教材 ${liveTextbooks.length} · 单元 ${liveUnits.length} · 知识点 ${livePoints.length}`
            : `教材 ${liveTextbooks.length} · 单元 ${liveUnits.length} · 知识点 ${livePoints.length}`
        }
        action={
          <div className="flex gap-2">
            <Button onClick={() => setImportModalOpen(true)} variant="secondary">
              <FileUp size={14} /> 导入文件
            </Button>
            <Button onClick={openNewTextbook} variant="primary">
              <Plus size={14} /> 新建教材
            </Button>
          </div>
        }
      />
      <ImportDocModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        textbooks={liveTextbooks}
        onSummaryProgress={(done, total) => setSummaryJob(done >= total ? null : { done, total })}
      />

      {/* 教材 + 单元 + 知识点 三栏布局 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_220px_1fr]">
        {/* 教材栏 */}
        <Card>
          <CardHeader title="教材" subtitle={`${liveTextbooks.length} 本`} />
          {liveTextbooks.length === 0 ? (
            <EmptyState
              icon={<BookOpen size={24} />}
              title="还没有教材"
              description="点击右上角「新建教材」开始"
              action={
                <Button size="sm" onClick={openNewTextbook}>
                  <Plus size={13} /> 新建教材
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-line-1">
              {liveTextbooks.map((t) => {
                const unitCount = liveUnits.filter((u) => u.textbookId === t.id).length
                const pointCount = livePoints.filter((p) => p.textbookId === t.id).length
                const active = t.id === activeTextbookId
                return (
                  <li
                    key={t.id}
                    className={cn(
                      'group flex items-start gap-2 px-3 py-2.5 transition-colors',
                      active ? 'bg-accent-soft' : 'hover:bg-surface-1',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedTextbookId(t.id)
                        setSelectedUnitId(null)
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="truncate text-sm font-medium text-text-1">{t.name}</div>
                      <div className="mt-0.5 text-[11px] text-text-3">
                        {t.subject || '未分类'} · {unitCount} 单元 · {pointCount} 知识点
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditTextbook(t)}
                      className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-surface-2 hover:text-text-1 group-hover:flex"
                      title="编辑教材"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteTextbook(t)}
                      className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-money-out/10 hover:text-money-out group-hover:flex"
                      title="删除教材"
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        {/* 单元栏 */}
        <Card>
          <CardHeader
            title="单元"
            subtitle={activeTextbookId ? `${unitsOfActive.length} 个` : '未选教材'}
            action={
              activeTextbookId && (
                <Button size="sm" variant="ghost" onClick={openNewUnit}>
                  <Plus size={13} />
                </Button>
              )
            }
          />
          {!activeTextbookId ? (
            <EmptyState title="先选一本教材" description="在左侧选择或新建教材后，单元列表会出现在这里" />
          ) : unitsOfActive.length === 0 ? (
            <EmptyState
              icon={<BookOpen size={22} />}
              title="还没有单元"
              description="点击右上角「+」添加第一个单元"
            />
          ) : (
            <ul className="divide-y divide-line-1">
              {unitsOfActive.map((u, idx) => {
                const active = u.id === activeUnitId
                return (
                  <li
                    key={u.id}
                    className={cn(
                      'group flex items-center gap-2 px-3 py-2.5 transition-colors',
                      active ? 'bg-accent-soft' : 'hover:bg-surface-1',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedUnitId(u.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant="primary">{idx + 1}</Badge>
                        <span className="truncate text-sm font-medium text-text-1">{u.name}</span>
                      </div>
                      {u.note && (
                        <div className="mt-0.5 truncate text-[11px] text-text-3">{u.note}</div>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditUnit(u)}
                      className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-surface-2 hover:text-text-1 group-hover:flex"
                      title="编辑单元"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteUnit(u)}
                      className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-money-out/10 hover:text-money-out group-hover:flex"
                      title="删除单元"
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        {/* 知识点栏 */}
        <Card>
          <CardHeader
            title="知识点"
            subtitle={
              activeUnitId
                ? `${pointsOfActive.length} 个`
                : '未选单元'
            }
            action={
              activeUnitId && (
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={openNewPoint}>
                    <Plus size={13} /> 新建知识点
                  </Button>
                </div>
              )
            }
          />
          {!activeUnitId ? (
            <EmptyState
              title="先选一个单元"
              description="左侧选好教材与单元后，知识点列表会出现在这里"
            />
          ) : (
            <>
              <div className="border-b border-line-1 px-3 py-2">
                <div className="relative">
                  <Search
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-text-3"
                  />
                  <Input
                    className="pl-9"
                    placeholder="搜索本单元知识点标题或摘要"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              </div>
              {pointsOfActive.length === 0 ? (
                <EmptyState
                  icon={<BookOpen size={22} />}
                  title={search ? '没有匹配的知识点' : '还没有知识点'}
                  description={search ? '试试别的关键字' : '点击「新建知识点」开始梳理'}
                />
              ) : (
                <ul className="divide-y divide-line-1">
                  {pointsOfActive.map((p) => (
                    <PointRow
                      key={p.id}
                      p={p}
                      onEdit={() => openEditPoint(p)}
                      onDelete={() => void handleDeletePoint(p)}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </Card>
      </div>

      {/* 教材弹窗 */}
      <TextbookModal
        open={textbookModalOpen}
        textbook={editingTextbook}
        onClose={() => setTextbookModalOpen(false)}
      />
      {/* 单元弹窗 */}
      <UnitModal
        open={unitModalOpen}
        unit={editingUnit}
        textbookId={activeTextbookId}
        defaultOrder={unitsOfActive.length + 1}
        onClose={() => setUnitModalOpen(false)}
      />
      {/* 知识点弹窗 */}
      <KnowledgePointModal
        open={pointModalOpen}
        point={editingPoint}
        unitId={activeUnitId}
        textbookId={activeTextbookId}
        textbookName={
          (textbooks ?? []).find((t) => t.id === activeTextbookId)?.name ?? ''
        }
        unitName={
          (units ?? []).find((u) => u.id === activeUnitId)?.name ?? ''
        }
        onClose={() => setPointModalOpen(false)}
      />
    </div>
  )
}

// ============================================================
// 知识点行（含 AI 总结按钮）
// ============================================================

function PointRow({
  p,
  onEdit,
  onDelete,
}: {
  p: KnowledgePoint
  onEdit: () => void
  onDelete: () => void
}) {
  const [summarizing, setSummarizing] = useState(false)
  const settings = useSettings((s) => s.settings)

  async function handleSummarize() {
    if (!isAiConfigured(settings)) {
      alert('尚未配置 AI。请在「设置 → AI 辅助」填入 Base URL 与 API Key。')
      return
    }
    setSummarizing(true)
    try {
      const res = await summarizeKnowledgePoint(settings, {
        textbookName: '', // 由 modal 内补
        unitName: '',
        subject: '',
        title: p.title,
        content: p.content,
      })
      const summary = `${res.gist}\n\n要点：\n${res.keyPoints.map((k) => `• ${k}`).join('\n')}${
        res.pitfalls.length > 0
          ? `\n\n易错点：\n${res.pitfalls.map((k) => `• ${k}`).join('\n')}`
          : ''
      }`
      await db.knowledgePoints.put(
        touch({ ...p, summary, summarizedAt: Date.now() }),
      )
    } catch (e) {
      alert(e instanceof LlmError ? e.message : `AI 总结失败：${String(e)}`)
    } finally {
      setSummarizing(false)
    }
  }

  return (
    <li className="group px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-text-1">{p.title}</span>
            {p.summarizedAt ? (
              <Badge variant="success">已总结</Badge>
            ) : (
              <Badge variant="neutral">未总结</Badge>
            )}
            {p.tags.map((t) => (
              <Badge key={t}>{t}</Badge>
            ))}
          </div>
          {p.summary && (
            <pre className="mt-1.5 whitespace-pre-wrap break-words rounded-md bg-surface-2 px-2 py-1.5 text-[12px] leading-relaxed text-text-2">
              {p.summary}
            </pre>
          )}
          {!p.summary && p.content && (
            <p className="mt-1 line-clamp-2 text-[12px] text-text-3">{p.content}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => void handleSummarize()} disabled={summarizing}>
            {summarizing ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Sparkles size={13} />
            )}
            {summarizing ? '总结中' : 'AI 总结'}
          </Button>
          <button
            type="button"
            onClick={onEdit}
            className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-surface-2 hover:text-text-1 group-hover:flex"
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-money-out/10 hover:text-money-out group-hover:flex"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </li>
  )
}

// ============================================================
// 文件导入弹窗（PDF/DOCX/图片/文本 → AI 归类）
// ============================================================

function ImportDocModal({
  open,
  onClose,
  textbooks,
  onSummaryProgress,
}: {
  open: boolean
  onClose: () => void
  textbooks: Textbook[]
  onSummaryProgress?: (done: number, total: number) => void
}) {
  const settings = useSettings((s) => s.settings)

  const [file, setFile] = useState<File | null>(null)
  const [extracted, setExtracted] = useState<ExtractedText | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [classifying, setClassifying] = useState(false)
  const [saving, setSaving] = useState(false)
  const [classification, setClassification] = useState<ImportedDocClassification | null>(null)
  const [targetTextbookId, setTargetTextbookId] = useState<string>('__new__')
  const [autoSummary, setAutoSummary] = useState(true)
  // 每个 unit 是否导入（默认全选）
  const [unitKept, setUnitKept] = useState<Record<number, boolean>>({})
  // 每个知识点是否导入（默认全选）
  const [pointKept, setPointKept] = useState<Record<string, boolean>>({})
  const [pasteMode, setPasteMode] = useState(false)
  const [pastedText, setPastedText] = useState('')
  const [error, setError] = useState('')
  const [progress, setProgress] = useState('')
  /** 是否处于暂停态（仅长任务进行中有效） */
  const [paused, setPaused] = useState(false)
  /** 实时进度（用于进度条）；done/total 为全局页数 */
  const [prog, setProg] = useState<
    { done: number; total: number; phase: ExtractProgress['phase']; method?: ExtractProgress['method'] } | null
  >(null)
  /** 当前分批任务控制器，用于在长识别任务中途暂停 / 取消 */
  const runnerRef = useRef<BatchRunner | null>(null)
  /** 识别策略：auto=混合（每页自动择优，推荐）；vision=仅视觉；ocr=仅本地 OCR */
  const [strategy, setStrategy] = useState<ImportStrategy>('auto')
  /** 识别并发页数：同时处理几页。视觉识别是「渲染→上传→等模型」的网络等待型任务，
   *  并发后总耗时近似除以并发数；页数多时建议调到 5。 */
  const [concurrency, setConcurrency] = useState(3)
  /** 当前可用的视觉模型配置（strategy==='ocr' 时为 null，即不调用视觉模型） */
  const visionCfg = useMemo(
    () => (strategy !== 'ocr' ? buildVisionCfg(settings) : null),
    [strategy, settings],
  )

  /**
   * 本地结构化识别出的单元标题（导入前诊断）。
   * 让老师在点「AI 分析」之前就能看出分块是否合理，
   * 而不是导入完才发现单元错乱、知识点缺失。
   */
  const unitTitles = useMemo(() => {
    const t = extracted?.text ?? pastedText
    if (!t || t.trim().length < 200) return [] as string[]
    try {
      return detectUnitTitles(t)
    } catch {
      return [] as string[]
    }
  }, [extracted, pastedText])

  // 关闭 / 打开时重置（用 useEffect，不用 useMemo —— React 19 并发模式下 useMemo 回调时机不可预测，会在 handlePickFile 设置 extracted 后又被清回 null，导致 AI 按钮永远 disabled）
  useEffect(() => {
    if (!open) return
    setFile(null)
    setExtracted(null)
    setClassification(null)
    setTargetTextbookId('__new__')
    setAutoSummary(true)
    setUnitKept({})
    setPointKept({})
    setPasteMode(false)
    setPastedText('')
    setError('')
    setProgress('')
    setPaused(false)
    setProg(null)
    runnerRef.current = null
  }, [open])

  const enabledPointCount = useMemo(() => {
    if (!classification) return 0
    let n = 0
    classification.units.forEach((u, ui) => {
      if (unitKept[ui] === false) return
      u.points.forEach((_, pi) => {
        if (pointKept[`${ui}:${pi}`] !== false) n++
      })
    })
    return n
  }, [classification, unitKept, pointKept])

  async function handlePickFile(f: File) {
    setFile(f)
    setExtracted(null)
    setClassification(null)
    setError('')
    setProgress('')
    setPaused(false)
    setProg(null)
    setExtracting(true)
    setProgress(`正在提取「${f.name}」的文字…（将自动识别全部页）`)
    // 新建分批控制器，全程透传给识别流程，支持中途暂停 / 取消
    const runner = new BatchRunner()
    runnerRef.current = runner
    try {
      const r = await extractTextFromFile(
        f,
        (p) => {
          setProg({ done: p.done, total: p.total, phase: p.phase, method: p.method })
          const batch =
            typeof p.batchIndex === 'number' && typeof p.batchCount === 'number'
              ? `（第 ${p.batchIndex + 1}/${p.batchCount} 批）`
              : ''
          const methodLabel =
            p.method === 'text'
              ? '文本层'
              : p.method === 'vision'
                ? '视觉模型'
                : p.method === 'ocr-backstop'
                  ? 'OCR 兜底'
                  : '本地 OCR'
          const base =
            p.phase === 'vision'
              ? `视觉模型识别中… 第 ${p.done}/${p.total} 页`
              : p.phase === 'ocr'
                ? `本地 OCR 识别中… 第 ${p.done}/${p.total} 页`
                : `读取 PDF 文本层… 第 ${p.done}/${p.total} 页`
          setProgress(`${base}${batch}（本页：${methodLabel}）`)
        },
        visionCfg,
        runner,
        strategy,
        { concurrency, skipBlankPages: true },
      )
      setExtracted(r)
      if (r.chars === 0) {
        setError(
          r.kind === 'image'
            ? '未能从图片识别出文字。可改用「粘贴文字」或换更清晰的图片。'
            : r.kind === 'pdf'
              ? 'PDF 文本层为空且 OCR 也未识别到文字。请改用「粘贴文字」方式导入。'
              : '未能从该文件提取到文字，请核实文件内容。',
        )
        setProgress('')
      } else {
        const via =
          r.viaOcr === 'vision'
            ? '（已通过视觉模型识别）'
            : r.viaOcr === 'tesseract'
              ? '（已通过本地 OCR 识别）'
              : ''
        const pages =
          r.pagesRead && r.pageCount ? `，处理 ${r.pagesRead}/${r.pageCount} 页` : ''
        setProgress(`提取到 ${r.chars} 字${via}${pages}，可交给 AI 归类。`)
      }
    } catch (e) {
      // 用户主动取消：丢弃结果，给出明确提示
      if (e instanceof BatchCancelledError) {
        setExtracted(null)
        setProgress('已取消导入。')
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setExtracting(false)
      setPaused(false)
      setProg(null)
      runnerRef.current = null
    }
  }

  /** 暂停 / 继续 / 取消：作用于当前分批识别任务 */
  function handlePause() {
    runnerRef.current?.pause()
    setPaused(true)
  }
  function handleResume() {
    runnerRef.current?.resume()
    setPaused(false)
  }
  function handleCancel() {
    runnerRef.current?.cancel()
    // 任务会在当前页/批结束后抛错退出，extracting 在 finally 中复位
  }
  /** 关闭弹窗：若识别仍在进行，先取消后台任务，避免继续消耗 API / 算力 */
  function handleModalClose() {
    if (runnerRef.current) runnerRef.current.cancel()
    onClose()
  }

  async function handleClassify() {
    const text = extracted?.text ?? pastedText
    if (!text.trim()) {
      setError('暂无可用文本，请先导入文件或粘贴文字。')
      return
    }
    if (!isAiConfigured(settings)) {
      setError('尚未配置 AI。请在「设置 → AI 辅助」填入 Base URL 与 API Key。')
      return
    }
    setError('')
    setClassifying(true)
    setProgress('AI 正在通读并归类…这可能要 10-20 秒')
    try {
      const res = await classifyImportedDocument(
        settings,
        text,
        file?.name ?? '粘贴文本',
        textbooks.map((t) => ({ name: t.name, subject: t.subject })),
        (p) => {
          setProgress(
            p.retrying
              ? `部分段落刚才被限流，正在补试…（已完成 ${p.done}/${p.total} 段）`
              : p.total > 1
                ? `AI 正在分析第 ${Math.min(p.done + 1, p.total)}/${p.total} 段…（长文档分段处理，请耐心等待）`
                : 'AI 正在通读并归类…这可能要 10-20 秒',
          )
        },
      )
      setClassification(res)
      const keepless: Record<number, boolean> = {}
      res.units.forEach((_, i) => (keepless[i] = true))
      setUnitKept(keepless)
      // 默认「归入已有同名教材」而不是新建：AI 建议的教材名往往带科目后缀，
      // 直接新建会攒出「…入门A」「…入门A（英语）」「…入门A（英语）（英语）」一堆重复教材。
      const matchBook = textbooks.find((t) => isSameTextbookName(t.name, res.textbookName || ''))
      setTargetTextbookId(matchBook ? matchBook.id : '__new__')
      setProgress(
        matchBook
          ? `归类完成（将并入已有教材「${matchBook.name}」），请确认后导入。`
          : '归类完成，请确认后导入。',
      )
    } catch (e) {
      setError(e instanceof LlmError ? e.message : `AI 归类失败：${String(e)}`)
    } finally {
      setClassifying(false)
    }
  }

  async function handleSave() {
    if (!classification) return
    setSaving(true)
    setError('')
    try {
      const r = await persistClassification(
        settings,
        {
          classification,
          autoSummary,
          targetTextbookId,
          unitKept,
          pointKept,
        },
        onSummaryProgress,
      )
      setProgress(
        r.summaryQueued > 0
          ? `已导入 ${r.units} 个单元 / ${r.points} 个知识点。AI 摘要正在后台逐条生成，可在列表中点开查看。`
          : `已导入：${r.points} 个知识点。`,
      )
      onClose()
    } catch (e) {
      setError(e instanceof LlmError ? e.message : `导入失败：${String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const targetOptions = [
    { value: '__new__', label: `新建教材「${classification?.textbookName || '未命名教材'}」` },
    ...textbooks.map((t) => ({
      value: t.id,
      label: `归入已有教材：${t.name}${t.subject ? `（${t.subject}）` : ''}`,
    })),
  ]

  return (
    <Modal
      open={open}
      onClose={handleModalClose}
      title="导入教材 / 讲义"
      size="xl"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          {!classification ? (
            <Button
              variant="primary"
              disabled={extracting || classifying || !((extracted || pastedText) && isAiConfigured(settings))}
              onClick={() => void handleClassify()}
            >
              {classifying ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {classifying ? '分析中…' : 'AI 分析并归类'}
            </Button>
          ) : (
            <Button variant="primary" disabled={saving || enabledPointCount === 0} onClick={() => void handleSave()}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              确认导入 {enabledPointCount > 0 ? `${enabledPointCount} 个知识点` : ''}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {/* 1) 选择来源 */}
        {!classification && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[13px] font-medium text-text-1">选择来源</span>
              <button
                type="button"
                onClick={() => {
                  setPasteMode((v) => !v)
                  setFile(null)
                  setExtracted(null)
                  setError('')
                }}
                className="text-[12px] text-accent hover:underline"
              >
                {pasteMode ? '改选文件' : '改用粘贴文字'}
              </button>
            </div>
            {pasteMode ? (
              <Textarea
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                rows={6}
                placeholder="把教材/讲义/笔记的文字粘贴到这里，再点「AI 分析并归类」"
              />
            ) : (
              <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-line-1 px-4 py-8 text-center transition-colors hover:border-accent">
                <FileUp size={28} className="mb-2 text-text-3" />
                <span className="text-sm text-text-1">
                  {file ? file.name : '点击选择或拖入文件'}
                </span>
                <span className="mt-1 text-[11px] text-text-3">
                  支持 PDF · Word(docx) · 图片(png/jpg/webp) · 文本(txt/md)
                </span>
                <input
                  type="file"
                  className="hidden"
                  accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,.bmp"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void handlePickFile(f)
                  }}
                />
              </label>
            )}
          </div>
        )}

        {/* 识别策略：混合（自动择优，推荐）/ 仅视觉 / 仅 OCR；仅在已配置视觉模型时提供视觉相关选项 */}
        {!classification && settings.aiEnabled && settings.aiVisionModel.trim() && (
          <div className="space-y-1">
            <span className="text-[12px] font-medium text-text-2">识别策略</span>
            <Select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as ImportStrategy)}
            >
              <option value="auto">混合策略（每页自动择优，推荐）</option>
              <option value="vision">仅视觉模型（质量最高，页数多较慢）</option>
              <option value="ocr">仅本地 OCR（免费更快，中文小字略弱）</option>
            </Select>
            <p className="text-[11px] text-text-3">
              混合策略：文本层可读的页直接采用，缺文本 / 乱码的页才调用识别，并在视觉结果偏弱时自动用本地 OCR 兜底择优。
            </p>
          </div>
        )}
        {!classification && !(settings.aiVisionEnabled && settings.aiVisionBaseUrl.trim() && settings.aiVisionApiKey.trim() && settings.aiVisionModel.trim()) && (
          <p className="text-[12px] text-text-3">
            未配置视觉模型，将自动使用「文本层 + 本地 OCR」。如需更准的中文识别，可在「设置 → AI 辅助」填入视觉模型（如 sensenova-6.8-flash-lite）。
          </p>
        )}

        {/* 识别速度：并发页数。视觉识别是「渲染→上传→等模型」的网络等待型任务，
            并发后总耗时近似除以并发数（150 页：并发 1 约十几分钟 → 并发 5 约三四分钟）。 */}
        {!classification && !pasteMode && (
          <div className="space-y-1">
            <span className="text-[12px] font-medium text-text-2">识别速度</span>
            <Select
              value={String(concurrency)}
              onChange={(e) => setConcurrency(Number(e.target.value))}
            >
              <option value="1">稳妥（1 页串行，最省内存 / 最稳）</option>
              <option value="3">标准（3 页并发，推荐）</option>
              <option value="5">极速（5 页并发，页数多时最快）</option>
            </Select>
            <p className="text-[11px] text-text-3">
              并发越高越快，但占用更多内存与视觉 API 配额。页数超过 50 页时建议选「极速」。
            </p>
          </div>
        )}

        {/* 2) 进度 / 预览 / 结果 */}
        {progress && <p className="text-[13px] text-accent">{progress}</p>}
        {/* 长任务进度条 + 暂停 / 继续 / 取消（仅识别进行中显示） */}
        {extracting && prog && prog.total > 0 && (
          <div className="space-y-1.5">
            <div className="h-2 w-full overflow-hidden rounded-full bg-line-1">
              <div
                className="h-full rounded-full bg-accent transition-all duration-200"
                style={{ width: `${Math.min(100, Math.round((prog.done / prog.total) * 100))}%` }}
              />
            </div>
            <div className="flex items-center justify-end gap-1">
              {!paused ? (
                <Button size="sm" variant="ghost" onClick={handlePause} className="gap-1">
                  <Pause size={12} /> 暂停
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={handleResume} className="gap-1">
                  <Play size={12} /> 继续
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={handleCancel} className="gap-1">
                <Square size={12} /> 取消
              </Button>
            </div>
          </div>
        )}
        {error && <p className="text-[13px] text-leave">{error}</p>}

        {/* 提取诊断：路径（文本层/OCR）、截断、质量。乱码问题在这里第一时间暴露 */}
        {!classification && extracted?.note && (
          <p className="text-[12px] text-pending">⚠ {extracted.note}</p>
        )}

        {/* 文本开头直接摆出来（不用展开），一眼判断是否乱码 */}
        {!classification && extracted && extracted.text && (
          <div className="rounded-md border border-line-1 px-3 py-2">
            <p className="mb-1 text-[11px] text-text-3">
              提取文本开头（
              {extracted.note?.startsWith('混合策略')
                ? '混合识别（自动择优）'
                : extracted.viaOcr === 'vision'
                  ? '视觉模型识别'
                  : extracted.viaOcr === 'tesseract'
                    ? '本地 OCR 识别'
                    : 'PDF 文本层'}
              {typeof extracted.quality === 'number'
                ? ` · 可读性 ${Math.round(extracted.quality * 100)}%`
                : ''}
              ，可直接判断是否乱码）
            </p>
            <p className="max-h-24 overflow-auto whitespace-pre-wrap text-[12px] leading-relaxed text-text-2">
              {extracted.text.slice(0, 200)}
              {extracted.text.length > 200 ? '…' : ''}
            </p>
          </div>
        )}

        {!classification && (extracted?.text || pastedText) && !isAiConfigured(settings) && (
          <p className="text-[13px] text-leave">
            ⚠ 尚未配置 AI。请先到「设置 → AI 辅助」填入 Base URL 与 API Key，然后再点「AI 分析并归类」。
          </p>
        )}

        {/* 单元边界诊断：导入前就能看出 AI 会按哪些单元分组 */}
        {!classification && unitTitles.length > 0 && (
          <details className="rounded-md border border-line-1" open>
            <summary className="cursor-pointer px-3 py-2 text-[12px] text-text-2">
              已识别到 <span className="font-semibold text-text-1">{unitTitles.length}</span> 个单元边界（点击展开核对）
            </summary>
            <div className="px-3 pb-2 text-[12px] leading-relaxed text-text-2">
              {unitTitles.map((t, i) => (
                <div key={i} className="truncate">
                  <span className="mr-1 text-text-3">{i + 1}.</span>
                  {t}
                </div>
              ))}
            </div>
          </details>
        )}
        {!classification &&
          unitTitles.length === 0 &&
          (extracted?.text ?? pastedText).trim().length >= 200 && (
            <p className="text-[12px] text-pending">
              未识别到明确的单元标题（如「Unit 1」「第 3 单元」）：AI 将按字数分段归类，单元可能不够整齐。
              建议检查原文是否包含单元标题行。
            </p>
          )}

        {!classification && extracted && extracted.text && (
          <details className="rounded-md border border-line-1">
            <summary className="cursor-pointer px-3 py-2 text-[12px] text-text-2">
              预览提取文本（{extracted.chars} 字，点击展开）
            </summary>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap px-3 pb-3 text-[12px] leading-relaxed text-text-2">
              {extracted.text.slice(0, 3000)}
              {extracted.text.length > 3000 ? '\n…（已截断预览）' : ''}
            </pre>
          </details>
        )}

        {/* 3) 归类结果确认 */}
        {classification && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="导入到">
                <Select
                  value={targetTextbookId}
                  onChange={(e) => setTargetTextbookId(e.target.value)}
                >
                  {targetOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="额外处理">
                <label className="inline-flex items-center gap-2 pt-2">
                  <input
                    type="checkbox"
                    checked={autoSummary}
                    onChange={(e) => setAutoSummary(e.target.checked)}
                  />
                  <span className="text-[13px]">AI 生成每条知识点摘要（导入后后台逐条生成，不阻塞本次导入）</span>
                </label>
              </Field>
            </div>

            <div className="max-h-72 overflow-y-auto rounded-md border border-line-1">
              {classification.units.length === 0 ? (
                <p className="p-3 text-[12px] text-text-3">
                  AI 未能从该文档识别出明确的知识结构，可返回手动新建教材/知识点。
                </p>
              ) : (
                classification.units.map((u: ImportedUnit, ui: number) => {
                  const kept = unitKept[ui] !== false
                  return (
                    <div key={ui} className="border-b border-line-1 last:border-0">
                      <div className="flex items-center gap-2 bg-surface-1 px-3 py-2">
                        <input
                          type="checkbox"
                          checked={kept}
                          onChange={() => setUnitKept((prev) => ({ ...prev, [ui]: !kept }))}
                        />
                        <Badge variant="primary">{ui + 1}</Badge>
                        <Input
                          className="flex-1"
                          value={u.name}
                          onChange={(e) => {
                            const units = [...classification.units]
                            units[ui] = { ...u, name: e.target.value }
                            setClassification({ ...classification, units })
                          }}
                        />
                      </div>
                      {kept ? (
                        <ul className="space-y-1 py-2 pl-8 pr-3">
                          {u.points.map((p, pi) => {
                            const pkey = `${ui}:${pi}`
                            const pKept = pointKept[pkey] !== false
                            return (
                              <li key={pkey} className="flex items-start gap-2">
                                <input
                                  type="checkbox"
                                  className="mt-0.5"
                                  checked={pKept}
                                  onChange={() =>
                                    setPointKept((prev) => ({ ...prev, [pkey]: !pKept }))
                                  }
                                />
                                <div className="min-w-0 flex-1">
                                  <Input
                                    value={p.title}
                                    onChange={(e) => {
                                      const units = [...classification.units]
                                      const ups = [...units[ui].points]
                                      ups[pi] = { title: e.target.value, content: p.content }
                                      units[ui] = { ...u, points: ups }
                                      setClassification({ ...classification, units })
                                    }}
                                    placeholder="知识点标题"
                                  />
                                  <Textarea
                                    rows={2}
                                    className="mt-1"
                                    value={p.content}
                                    onChange={(e) => {
                                      const units = [...classification.units]
                                      const ups = [...units[ui].points]
                                      ups[pi] = { title: p.title, content: e.target.value }
                                      units[ui] = { ...u, points: ups }
                                      setClassification({ ...classification, units })
                                    }}
                                    placeholder="要点内容（AI 已从原文提炼，可修改补充）"
                                  />
                                </div>
                              </li>
                            )
                          })}
                        </ul>
                      ) : null}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

/** 名称归一化：去空白/括号/常见标点，转小写（用于教材名、单元名的模糊匹配） */
function normName(s: string): string {
  return s.toLowerCase().replace(/[\s（）()【】\[\]，,。.、·\-_/\\|]/g, '')
}

/**
 * 判断两个教材名是否指同一本教材。
 * 历史数据里出现过 AI 把科目后缀叠加成「…入门A（英语）（英语）」，
 * 归一化后成为包含关系 —— 这里按「短名占长名 80% 以上」判定为同一本，
 * 避免每次导入都新建一本重复教材。
 */
function isSameTextbookName(a: string, b: string): boolean {
  const x = normName(a)
  const y = normName(b)
  if (!x || !y) return false
  if (x === y) return true
  const short = x.length <= y.length ? x : y
  const long = x.length <= y.length ? y : x
  return long.includes(short) && short.length / long.length >= 0.8
}

/**
 * 单元匹配键：优先取编号（Unit 3 ↔ 第三单元 ↔ 第3课），
 * 取不到编号时退化为归一化名称。用于重复导入时复用已有单元，避免重复建单元。
 */
function unitMatchKey(name: string): string {
  const m = name
    .trim()
    .match(
      /(?:units?|lessons?|chapters?|modules?|parts?|stages?)\s*(\d+)|第\s*(\d+|[一二三四五六七八九十百零两]+)\s*(?:单元|章节?|讲|课时|课|节)/i,
    )
  if (m && (m[1] || m[2])) return `#${m[1] ?? cnDigits(m[2]!)}`
  return normName(name)
}

/** 单元排序用编号（取不到编号的排到最后，不影响原有相对顺序） */
function unitOrderNum(name: string): number {
  const m = unitMatchKey(name).match(/^#(\d+)$/)
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}

/** 简单中文数字 → 阿拉伯数字（只在单元编号场景使用） */
function cnDigits(s: string): string {
  if (/^\d+$/.test(s)) return s
  const map: Record<string, number> = {
    零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  }
  if (s.includes('十')) {
    const [a, b] = s.split('十')
    const tens = a === '' ? 1 : (map[a] ?? 0)
    const ones = b === '' ? 0 : (map[b] ?? 0)
    return String(tens * 10 + ones)
  }
  return String(map[s] ?? s)
}

// 把 AI 归类结果落库（新建或并入已有教材 → 单元 → 知识点）。
// autoSummary 开启时：先落库、立即返回，AI 摘要转后台逐条生成回写，避免用户长时间干等。
async function persistClassification(
  settings: AppSettings,
  input: {
    classification: ImportedDocClassification
    autoSummary: boolean
    targetTextbookId: string
    unitKept: Record<number, boolean>
    pointKept: Record<string, boolean>
  },
  onSummaryProgress?: (done: number, total: number) => void,
): Promise<{ units: number; points: number; summaryQueued: number }> {
  const { classification, autoSummary, targetTextbookId, unitKept, pointKept } = input

  // 1) 确定教材（新建时先按归一化名称查重，避免 AI 叠加后缀造成重复教材）
  let textbookId: string
  const existingTextbook = targetTextbookId === '__new__' ? null : await db.textbooks.get(targetTextbookId)
  if (targetTextbookId === '__new__') {
    const incomingName = classification.textbookName || '导入教材'
    const allBooks = (await db.textbooks.toArray()).filter((t) => !t.deletedAt)
    const dup = allBooks.find((t) => isSameTextbookName(t.name, incomingName))
    if (dup) {
      textbookId = dup.id
    } else {
      const created = await db.textbooks.put(
        withSyncFields<Textbook>({
          name: incomingName,
          subject: classification.subject,
          grade: '',
          note: '',
          createdAt: Date.now(),
        }),
      )
      textbookId = created
    }
  } else if (existingTextbook) {
    textbookId = existingTextbook.id
  } else {
    throw new Error('目标教材不存在')
  }

  // 2) 已有单元：复用同名单元（按编号匹配）而不是重复新建；
  //    同一材料重复导入时不会产生「Unit 1 出现两次」。
  const allUnits = await db.textbookUnits.toArray()
  const existingUnits = allUnits.filter((u) => !u.deletedAt && u.textbookId === textbookId)
  const unitIdByKey = new Map<string, string>()
  for (const u of existingUnits) {
    const key = unitMatchKey(u.name)
    if (key && !unitIdByKey.has(key)) unitIdByKey.set(key, u.id)
  }
  let order = existingUnits.reduce((m, u) => Math.max(m, u.order ?? 0), 0) + 1

  // 已有知识点标题索引（unitId → 标题集合），用于重复导入时去重
  const allPoints = await db.knowledgePoints.toArray()
  const pointTitlesByUnit = new Map<string, Set<string>>()
  for (const kp of allPoints) {
    if (kp.deletedAt) continue
    let set = pointTitlesByUnit.get(kp.unitId)
    if (!set) {
      set = new Set()
      pointTitlesByUnit.set(kp.unitId, set)
    }
    set.add(kp.title.trim())
  }

  const now = Date.now()
  let unitCount = 0
  let pointCount = 0
  const jobs: Array<{ id: string; title: string; content: string }> = []
  for (let ui = 0; ui < classification.units.length; ui++) {
    if (unitKept[ui] === false) continue
    const u = classification.units[ui]
    const unitName = u.name || `单元 ${ui + 1}`
    const key = unitMatchKey(unitName)
    const reusedId = key ? unitIdByKey.get(key) : undefined
    let unitId: string
    if (reusedId) {
      unitId = reusedId
      unitIdByKey.delete(key)
      // 用最新一次识别的名称覆盖旧名：旧名可能是「第1单元 基础词汇与冠词」
      // 这类把知识点描述当单元名的脏数据，重新导入时应当被纠正。
      const prevUnit = existingUnits.find((x) => x.id === reusedId)
      if (prevUnit && prevUnit.name !== unitName) {
        await db.textbookUnits.put(touch({ ...prevUnit, name: unitName }))
      }
    } else {
      unitId = await db.textbookUnits.put(
        withSyncFields<TextbookUnit>({
          textbookId,
          name: unitName,
          order: order++,
          note: '',
          createdAt: now,
        }),
      )
      unitCount++
      if (key) unitIdByKey.set(key, unitId)
    }
    for (let pi = 0; pi < u.points.length; pi++) {
      if (pointKept[`${ui}:${pi}`] === false) continue
      const p = u.points[pi]
      const title = p.title.trim()
      if (!title) continue
      // 同单元下已有同名知识点 → 跳过（避免重复导入产生重复条目）
      let seen = pointTitlesByUnit.get(unitId)
      if (!seen) {
        seen = new Set()
        pointTitlesByUnit.set(unitId, seen)
      }
      if (seen.has(title)) continue
      seen.add(title)
      const id = await db.knowledgePoints.put(
        withSyncFields<KnowledgePoint>({
          unitId,
          textbookId,
          title,
          content: p.content.trim(),
          summary: '',
          summarizedAt: null,
          tags: [],
          createdAt: now,
        }),
      )
      pointCount++
      if (autoSummary) jobs.push({ id, title, content: p.content.trim() })
    }
  }
  // 归一化单元顺序：复用了已有单元时（重复导入），新老单元的 order 会交错，
  // 这里按单元编号统一重排，保证列表顺序与教材目录一致（Unit 1 → Unit 15）。
  const finalUnits = (await db.textbookUnits.toArray()).filter(
    (x) => !x.deletedAt && x.textbookId === textbookId,
  )
  finalUnits.sort(
    (a, b) => unitOrderNum(a.name) - unitOrderNum(b.name) || (a.order ?? 0) - (b.order ?? 0),
  )
  for (let i = 0; i < finalUnits.length; i++) {
    const fu = finalUnits[i]!
    const want = i + 1
    if ((fu.order ?? 0) !== want) {
      await db.textbookUnits.put(touch({ ...fu, order: want }))
    }
  }

  // 落库已完成，先返回；AI 摘要转后台生成，避免几十秒干等
  if (autoSummary && jobs.length > 0) {
    void summarizeInBackground(settings, jobs, onSummaryProgress)
  }
  return { units: unitCount, points: pointCount, summaryQueued: jobs.length }
}

// 后台逐条生成 AI 摘要并回写。单条失败只跳过（用户稍后可在知识点详情里手动「AI 摘要」）。
async function summarizeInBackground(
  settings: AppSettings,
  jobs: Array<{ id: string; title: string; content: string }>,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]
    try {
      const summary = await summarizeImportedPoint(settings, job.title, job.content)
      if (summary) {
        const row = await db.knowledgePoints.get(job.id)
        if (row) await db.knowledgePoints.put(touch({ ...row, summary, summarizedAt: Date.now() }))
      }
    } catch {
      /* 单条失败不阻塞后续条目 */
    }
    onProgress?.(i + 1, jobs.length)
  }
}

// ============================================================
// 教材弹窗
// ============================================================

function TextbookModal({
  open,
  textbook,
  onClose,
}: {
  open: boolean
  textbook: Textbook | null
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [subject, setSubject] = useState('')
  const [grade, setGrade] = useState('')
  const [note, setNote] = useState('')

  // 同步初值
  useMemo(() => {
    if (!open) return
    setName(textbook?.name ?? '')
    setSubject(textbook?.subject ?? '')
    setGrade(textbook?.grade ?? '')
    setNote(textbook?.note ?? '')
  }, [open, textbook])

  async function handleSave() {
    const payload = {
      name: name.trim(),
      subject: subject.trim(),
      grade: grade.trim(),
      note: note.trim(),
    }
    if (!payload.name) return
    if (textbook) {
      await db.textbooks.put(touch({ ...textbook, ...payload }))
    } else {
      await db.textbooks.put(
        withSyncFields<Textbook>({ ...payload, createdAt: Date.now() }),
      )
    }
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={textbook ? '编辑教材' : '新建教材'}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => void handleSave()}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="教材名称">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：新概念英语第一册" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="科目">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="如：英语" />
          </Field>
          <Field label="适用年级">
            <Input value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="如：初一" />
          </Field>
        </div>
        <Field label="备注">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="出版社、版本号等" />
        </Field>
      </div>
    </Modal>
  )
}

// ============================================================
// 单元弹窗
// ============================================================

function UnitModal({
  open,
  unit,
  textbookId,
  defaultOrder,
  onClose,
}: {
  open: boolean
  unit: TextbookUnit | null
  textbookId: string | null
  defaultOrder: number
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [order, setOrder] = useState('')
  const [note, setNote] = useState('')

  useMemo(() => {
    if (!open) return
    setName(unit?.name ?? '')
    setOrder(unit ? String(unit.order) : String(defaultOrder))
    setNote(unit?.note ?? '')
  }, [open, unit, defaultOrder])

  async function handleSave() {
    if (!textbookId) return
    const payload = {
      name: name.trim(),
      order: Number(order) || 0,
      note: note.trim(),
    }
    if (!payload.name) return
    if (unit) {
      await db.textbookUnits.put(touch({ ...unit, ...payload }))
    } else {
      await db.textbookUnits.put(
        withSyncFields<TextbookUnit>({
          textbookId,
          ...payload,
          createdAt: Date.now(),
        }),
      )
    }
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={unit ? '编辑单元' : '新建单元'}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => void handleSave()}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="单元名称">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：Unit 1" />
        </Field>
        <Field label="排序" hint="数字越小越靠前">
          <Input
            type="number"
            value={order}
            onChange={(e) => setOrder(e.target.value)}
            placeholder={String(defaultOrder)}
          />
        </Field>
        <Field label="备注">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="教学目标、进度备注等" />
        </Field>
      </div>
    </Modal>
  )
}

// ============================================================
// 知识点弹窗
// ============================================================

function KnowledgePointModal({
  open,
  point,
  unitId,
  textbookId,
  textbookName,
  unitName,
  onClose,
}: {
  open: boolean
  point: KnowledgePoint | null
  unitId: string | null
  textbookId: string | null
  textbookName: string
  unitName: string
  onClose: () => void
}) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tagsText, setTagsText] = useState('')
  const settings = useSettings((s) => s.settings)
  const [summarizing, setSummarizing] = useState(false)

  useMemo(() => {
    if (!open) return
    setTitle(point?.title ?? '')
    setContent(point?.content ?? '')
    setTagsText((point?.tags ?? []).join(','))
  }, [open, point])

  async function handleAiSummarize() {
    if (!title.trim()) {
      alert('请先填写知识点标题')
      return
    }
    if (!isAiConfigured(settings)) {
      alert('尚未配置 AI。请在「设置 → AI 辅助」填入 Base URL 与 API Key。')
      return
    }
    setSummarizing(true)
    try {
      const res = await summarizeKnowledgePoint(settings, {
        textbookName,
        unitName,
        subject: '',
        title,
        content,
      })
      const summary = `${res.gist}\n\n要点：\n${res.keyPoints.map((k) => `• ${k}`).join('\n')}${
        res.pitfalls.length > 0
          ? `\n\n易错点：\n${res.pitfalls.map((k) => `• ${k}`).join('\n')}`
          : ''
      }`
      if (point) {
        await db.knowledgePoints.put(
          touch({ ...point, title, content, tags: tagsText.split(',').map((s) => s.trim()).filter(Boolean), summary, summarizedAt: Date.now() }),
        )
      } else if (unitId && textbookId) {
        await db.knowledgePoints.put(
          withSyncFields<KnowledgePoint>({
            unitId,
            textbookId,
            title,
            content,
            summary,
            summarizedAt: Date.now(),
            tags: tagsText.split(',').map((s) => s.trim()).filter(Boolean),
            createdAt: Date.now(),
          }),
        )
      }
      onClose()
    } catch (e) {
      alert(e instanceof LlmError ? e.message : `AI 总结失败：${String(e)}`)
    } finally {
      setSummarizing(false)
    }
  }

  async function handleSave() {
    if (!unitId || !textbookId) return
    const payload = {
      title: title.trim(),
      content: content.trim(),
      summary: point?.summary ?? '',
      summarizedAt: point?.summarizedAt ?? null,
      tags: tagsText.split(',').map((s) => s.trim()).filter(Boolean),
    }
    if (!payload.title) return
    if (point) {
      await db.knowledgePoints.put(touch({ ...point, ...payload }))
    } else {
      await db.knowledgePoints.put(
        withSyncFields<KnowledgePoint>({
          unitId,
          textbookId,
          ...payload,
          createdAt: Date.now(),
        }),
      )
    }
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={point ? '编辑知识点' : '新建知识点'}
      size="xl"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="secondary"
            onClick={() => void handleAiSummarize()}
            disabled={summarizing}
            title="保存前先用 AI 总结一下"
          >
            {summarizing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Sparkles size={14} />
            )}
            {summarizing ? '总结中…' : 'AI 总结并保存'}
          </Button>
          <Button variant="primary" onClick={() => void handleSave()}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="标题" hint="例如：U1 第一篇课文 / 一般现在时">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="知识点 / 课文标题"
          />
        </Field>
        <Field
          label="原始内容"
          hint="老师填写的备课笔记或原文摘录，AI 会基于这些内容做梳理"
        >
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="可粘贴课文原文、教学目标、关键句型等"
            rows={6}
          />
        </Field>
        <Field label="标签" hint="逗号分隔，如：现在时, 阅读, 课文">
          <Input
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="现在时, 阅读, 课文"
          />
        </Field>
      </div>
    </Modal>
  )
}
