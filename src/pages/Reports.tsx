import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Bot,
  BookOpenText,
  FileText,
  Loader2,
  Plus,
  Settings2,
  Sparkles,
  Tag as TagIcon,
  Trash2,
  Users,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { db, markDeleted, touch, withSyncFields } from '@/lib/db'
import { useBreakpoint } from '@/hooks/useBreakpoint'
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
  SegmentedControl,
  Select,
  Textarea,
} from '@/components/ui'
import { useSettings } from '@/store/useSettings'
import { generateReport, isAiConfigured, type ReportInput } from '@/lib/llm'
import {
  TAG_TYPES,
  type LearningReport,
  type LearningTag,
  type Student,
  type StudentTag,
} from '@/lib/types'
import { cn, initialOf, subjectColorVar } from '@/lib/utils'
import { exportReports } from '@/lib/exporters'

type TabKey = 'reports' | 'tags'
type PeriodKey = 'thisMonth' | 'lastMonth' | 'last30' | 'custom'

const PERIOD_LABEL: Record<PeriodKey, string> = {
  thisMonth: '本月',
  lastMonth: '上月',
  last30: '近 30 天',
  custom: '自定义',
}

function periodRange(key: PeriodKey, custom: { start: string; end: string }) {
  const now = new Date()
  if (key === 'thisMonth') {
    const s = new Date(now.getFullYear(), now.getMonth(), 1)
    const e = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
    return { start: s.getTime(), end: e.getTime() }
  }
  if (key === 'lastMonth') {
    const s = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const e = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59)
    return { start: s.getTime(), end: e.getTime() }
  }
  if (key === 'last30') {
    const s = new Date(now.getTime() - 29 * 86400000)
    s.setHours(0, 0, 0, 0)
    return { start: s.getTime(), end: now.getTime() }
  }
  const s = custom.start ? new Date(`${custom.start}T00:00:00`) : new Date(now.getFullYear(), now.getMonth(), 1)
  const e = custom.end ? new Date(`${custom.end}T23:59:59`) : now
  return { start: s.getTime(), end: e.getTime() }
}

export default function ReportsPage() {
  const navigate = useNavigate()
  const isDesktop = useBreakpoint() === 'desktop'
  const [tab, setTab] = useState<TabKey>('reports')
  const [studentId, setStudentId] = useState('')
  const [periodKey, setPeriodKey] = useState<PeriodKey>('thisMonth')
  const [custom, setCustom] = useState({ start: '', end: '' })

  const students = useLiveQuery(() => db.students.toArray(), [])
  const tags = useLiveQuery(() => db.learningTags.toArray(), [])
  const studentTags = useLiveQuery(() => db.studentTags.toArray(), [])
  const reports = useLiveQuery(() => db.learningReports.toArray(), [])
  const courses = useLiveQuery(() => db.courses.toArray(), [])
  const feedbacks = useLiveQuery(() => db.courseFeedbacks.toArray(), [])
  const checkInRecords = useLiveQuery(() => db.checkInRecords.toArray(), [])

  const liveStudents = useMemo(
    () => (students ?? []).filter((s) => !s.deletedAt && s.status !== 'archived'),
    [students],
  )
  const liveTags = useMemo(() => (tags ?? []).filter((t) => !t.deletedAt), [tags])
  const liveStudentTags = useMemo(
    () => (studentTags ?? []).filter((t) => !t.deletedAt),
    [studentTags],
  )
  const liveReports = useMemo(
    () => (reports ?? []).filter((r) => !r.deletedAt),
    [reports],
  )

  // 未选择学生时默认选中第一个在读学生
  const effectiveStudentId =
    studentId || liveStudents.find((s) => s.status === 'active')?.id || liveStudents[0]?.id || ''
  const student = liveStudents.find((s) => s.id === effectiveStudentId)

  const range = useMemo(() => periodRange(periodKey, custom), [periodKey, custom])

  /** 该学生在周期内的课程 */
  const periodCourses = useMemo(() => {
    if (!student) return []
    return (courses ?? [])
      .filter(
        (c) =>
          !c.deletedAt &&
          c.studentId === student.id &&
          c.startAt >= range.start &&
          c.startAt <= range.end,
      )
      .sort((a, b) => a.startAt - b.startAt)
  }, [courses, student, range])

  /** 周期内课程的反馈摘要 */
  const feedbackSummaries = useMemo(() => {
    const ids = new Set(periodCourses.map((c) => c.id))
    return (feedbacks ?? [])
      .filter((f) => !f.deletedAt && ids.has(f.courseId) && f.summary.trim())
      .map((f) => f.summary.trim())
  }, [feedbacks, periodCourses])

  /** 周期内打卡备注（含 AI 家长反馈）——作为学习报告 AI 生成的数据源 */
  const checkInNotes = useMemo(() => {
    if (!student) return []
    return (checkInRecords ?? [])
      .filter(
        (r) =>
          !r.deletedAt &&
          r.studentId === student.id &&
          r.dayAt !== null &&
          r.dayAt >= range.start &&
          r.dayAt <= range.end &&
          ((r.note ?? '').trim().length > 0 || (r.aiFeedback ?? '').trim().length > 0),
      )
      .map((r) => ({ dayAt: r.dayAt as number, note: r.note ?? '', aiFeedback: r.aiFeedback ?? '' }))
      .sort((a, b) => a.dayAt - b.dayAt)
  }, [checkInRecords, student, range])

  const studentTagNames = useMemo(() => {
    const ids = new Set(
      liveStudentTags.filter((t) => t.studentId === effectiveStudentId).map((t) => t.tagId),
    )
    return liveTags.filter((t) => ids.has(t.id))
  }, [liveStudentTags, liveTags, effectiveStudentId])

  /** 已存在的同周期报告 */
  const existingReport = useMemo(
    () =>
      liveReports.find(
        (r) =>
          r.studentId === effectiveStudentId &&
          r.periodStart === range.start &&
          r.periodEnd === range.end,
      ),
    [liveReports, effectiveStudentId, range],
  )

  const studentReports = useMemo(
    () =>
      liveReports
        .filter((r) => r.studentId === effectiveStudentId)
        .sort((a, b) => b.periodStart - a.periodStart),
    [liveReports, effectiveStudentId],
  )

  return (
    <div>
      <PageHeader
        title="学习报告"
        subtitle="阶段性学习总结与学习标签库"
        action={
          <SegmentedControl
            value={tab}
            onChange={(v) => setTab(v as TabKey)}
            options={[
              { value: 'reports', label: '报告' },
              { value: 'tags', label: '标签库' },
            ]}
          />
        }
      />

      {tab === 'reports' ? (
        isDesktop ? (
          <div className="grid grid-cols-[260px_1fr] gap-4">
            <StudentPicker
              students={liveStudents}
              value={effectiveStudentId}
              onChange={setStudentId}
              tags={liveTags}
              studentTags={liveStudentTags}
            />
            <ReportPanel
              student={student}
              range={range}
              periodKey={periodKey}
              setPeriodKey={setPeriodKey}
              custom={custom}
              setCustom={setCustom}
              periodCourses={periodCourses}
              feedbackSummaries={feedbackSummaries}
              checkInNotes={checkInNotes}
              tags={studentTagNames.map((t) => t.name)}
              existingReport={existingReport}
              studentReports={studentReports}
              onNavigateSettings={() => navigate('/settings')}
            />
          </div>
        ) : (
          <div className="space-y-3">
            <Card>
              <div className="space-y-3 p-4">
                <Field label="学生">
                  <Select
                    value={effectiveStudentId}
                    onChange={(e) => setStudentId(e.target.value)}
                  >
                    <option value="">（未选择）</option>
                    {liveStudents.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.grade ? ` · ${s.grade}` : ''}
                      </option>
                    ))}
                  </Select>
                </Field>
                {studentTagNames.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {studentTagNames.map((t) => (
                      <TagChip key={t.id} tag={t} />
                    ))}
                  </div>
                )}
              </div>
            </Card>
            <ReportPanel
              student={student}
              range={range}
              periodKey={periodKey}
              setPeriodKey={setPeriodKey}
              custom={custom}
              setCustom={setCustom}
              periodCourses={periodCourses}
              feedbackSummaries={feedbackSummaries}
              checkInNotes={checkInNotes}
              tags={studentTagNames.map((t) => t.name)}
              existingReport={existingReport}
              studentReports={studentReports}
              onNavigateSettings={() => navigate('/settings')}
            />
          </div>
        )
      ) : (
        <TagLibrary
          isDesktop={isDesktop}
          students={liveStudents}
          tags={liveTags}
          studentTags={liveStudentTags}
        />
      )}
    </div>
  )
}

// ============================================================
// 学生选择（PC 左栏）
// ============================================================

function StudentPicker({
  students,
  value,
  onChange,
  tags,
  studentTags,
}: {
  students: Student[]
  value: string
  onChange: (id: string) => void
  tags: LearningTag[]
  studentTags: StudentTag[]
}) {
  return (
    <Card className="h-fit">
      <CardHeader title="学生" subtitle={`${students.length} 人`} />
      {students.length === 0 ? (
        <div className="p-4 text-sm text-text-3">还没有学生</div>
      ) : (
        <ul className="max-h-[520px] divide-y divide-line-1 overflow-y-auto">
          {students.map((s) => {
            const mine = studentTags
              .filter((t) => t.studentId === s.id)
              .map((t) => tags.find((x) => x.id === t.tagId))
              .filter((t): t is LearningTag => Boolean(t))
            return (
              <li key={s.id}>
                <button
                  onClick={() => onChange(s.id)}
                  className={cn(
                    'w-full px-4 py-3 text-left transition-colors',
                    value === s.id ? 'bg-surface-2' : 'hover:bg-surface-1',
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-medium text-white"
                      style={{ background: subjectColorVar(s.colorSlot) }}
                    >
                      {initialOf(s.name)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-text-1">{s.name}</p>
                      {s.grade && (
                        <p className="truncate text-xs text-text-3">{s.grade}</p>
                      )}
                    </div>
                  </div>
                  {mine.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {mine.slice(0, 3).map((t) => (
                        <TagChip key={t.id} tag={t} small />
                      ))}
                      {mine.length > 3 && (
                        <span className="text-[11px] text-text-3">+{mine.length - 3}</span>
                      )}
                    </div>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

// ============================================================
// 报告面板
// ============================================================

function ReportPanel({
  student,
  range,
  periodKey,
  setPeriodKey,
  custom,
  setCustom,
  periodCourses,
  feedbackSummaries,
  checkInNotes,
  tags,
  existingReport,
  studentReports,
  onNavigateSettings,
}: {
  student?: Student
  range: { start: number; end: number }
  periodKey: PeriodKey
  setPeriodKey: (k: PeriodKey) => void
  custom: { start: string; end: string }
  setCustom: (v: { start: string; end: string }) => void
  periodCourses: Array<{ id: string; subject: string; status: string; startAt: number }>
  feedbackSummaries: string[]
  checkInNotes: Array<{ dayAt: number; note: string; aiFeedback: string }>
  tags: string[]
  existingReport?: LearningReport
  studentReports: LearningReport[]
  onNavigateSettings: () => void
}) {
  const settings = useSettings((s) => s.settings)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [saved, setSaved] = useState(false)

  // 切换学生/周期/已有报告时载入内容
  useEffect(() => {
    setTitle(existingReport?.title ?? '')
    setContent(existingReport?.content ?? '')
    setAiError('')
    setSaved(Boolean(existingReport))
  }, [existingReport?.id, student?.id, range.start, range.end])

  const doneCount = periodCourses.filter((c) => c.status === 'done').length
  const subjects = Array.from(new Set(periodCourses.map((c) => c.subject).filter(Boolean)))
  const aiReady = isAiConfigured(settings)

  async function handleAi() {
    if (!student) return
    setAiError('')
    if (!aiReady) {
      setAiError('尚未配置 AI，请到「设置 → AI 辅助」填写接口信息。')
      return
    }
    setAiLoading(true)
    try {
      const input: ReportInput = {
        studentName: student.name,
        grade: student.grade,
        periodStart: range.start,
        periodEnd: range.end,
        doneCount,
        totalCount: periodCourses.length,
        subjects,
        tags,
        feedbackSummaries,
        checkInNotes,
      }
      const out = await generateReport(settings, input)
      setTitle(out.title || defaultTitle(student, range))
      setContent(out.content)
      setSaved(false)
    } catch (e) {
      setAiError(e instanceof Error ? e.message : String(e))
    } finally {
      setAiLoading(false)
    }
  }

  async function handleSave() {
    if (!student) return
    const payload = {
      studentId: student.id,
      title: title.trim() || defaultTitle(student, range),
      periodStart: range.start,
      periodEnd: range.end,
      content: content.trim(),
      aiGenerated: existingReport?.aiGenerated ?? false,
    }
    if (existingReport) {
      await db.learningReports.put(touch({ ...existingReport, ...payload }))
    } else {
      await db.learningReports.put(
        withSyncFields<LearningReport>({ ...payload, createdAt: Date.now() }),
      )
    }
    setSaved(true)
  }

  async function handleDelete() {
    if (!existingReport) return
    await db.learningReports.put(markDeleted(existingReport))
    setTitle('')
    setContent('')
    setSaved(false)
  }

  if (!student) {
    return (
      <Card>
        <EmptyState
          icon={<Users size={20} />}
          title="还没有学生"
          description="请先在「学生」页添加学生，再来生成学习报告"
        />
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      {/* 周期选择 + 统计 */}
      <Card>
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SegmentedControl
              value={periodKey}
              onChange={(v) => setPeriodKey(v as PeriodKey)}
              options={(Object.keys(PERIOD_LABEL) as PeriodKey[]).map((k) => ({
                value: k,
                label: PERIOD_LABEL[k],
              }))}
            />
            <span className="text-xs text-text-3">
              {new Date(range.start).toLocaleDateString('zh-CN')} —{' '}
              {new Date(range.end).toLocaleDateString('zh-CN')}
            </span>
          </div>

          {periodKey === 'custom' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="开始日期">
                <Input
                  type="date"
                  value={custom.start}
                  onChange={(e) => setCustom({ ...custom, start: e.target.value })}
                />
              </Field>
              <Field label="结束日期">
                <Input
                  type="date"
                  value={custom.end}
                  onChange={(e) => setCustom({ ...custom, end: e.target.value })}
                />
              </Field>
            </div>
          )}

          <div className="flex flex-wrap gap-4 border-t border-line-1 pt-3 text-sm">
            <Stat label="已完成" value={`${doneCount} 节`} />
            <Stat label="已排课" value={`${periodCourses.length} 节`} />
            <Stat label="课后反馈" value={`${feedbackSummaries.length} 条`} />
            <Stat label="打卡备注" value={`${checkInNotes.length} 条`} />
            <Stat label="科目" value={subjects.join('、') || '—'} />
          </div>

          {tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-text-3">标签：</span>
              {tags.map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* 打卡备注（含 AI 家长反馈）——AI 生成报告时会作为素材 */}
      {checkInNotes.length > 0 && (
        <Card>
          <CardHeader
            title="打卡备注"
            subtitle={`${checkInNotes.length} 条 · AI 生成报告时会作为素材`}
          />
          <ul className="divide-y divide-line-1">
            {checkInNotes.map((n) => (
              <li key={n.dayAt} className="px-4 py-2.5">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0 text-xs text-text-3">
                    {new Date(n.dayAt).toLocaleDateString('zh-CN', {
                      month: 'numeric',
                      day: 'numeric',
                    })}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    {n.note && (
                      <p className="text-[13px] text-text-1">{n.note}</p>
                    )}
                    {n.aiFeedback && (
                      <p className="rounded bg-accent-soft/60 px-2 py-1 text-[12px] text-accent-text">
                        <Bot size={11} className="mr-1 inline" />
                        {n.aiFeedback}
                      </p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* 报告编辑 */}
      <Card>
        <CardHeader
          title={`${student.name} 的学习报告`}
          subtitle={existingReport ? '已保存，可继续编辑' : '尚未生成'}
          action={
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => void handleAi()}
                disabled={aiLoading}
              >
                {aiLoading ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Sparkles size={15} />
                )}
                {aiLoading ? '生成中' : 'AI 生成'}
              </Button>
              <Button variant="primary" onClick={() => void handleSave()}>
                {existingReport ? '更新' : '保存'}
              </Button>
            </div>
          }
        />

        <div className="space-y-3 p-4">
          {aiError && (
            <div className="rounded-lg bg-money-out-bg px-3 py-2 text-[13px] text-money-out">
              <p>{aiError}</p>
              {!aiReady && (
                <button
                  onClick={onNavigateSettings}
                  className="mt-1 inline-flex items-center gap-1 underline"
                >
                  <Settings2 size={13} />
                  去设置
                </button>
              )}
            </div>
          )}

          <Field label="标题">
            <Input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value)
                setSaved(false)
              }}
              placeholder={defaultTitle(student, range)}
            />
          </Field>

          <Field label="正文" hint="支持 Markdown">
            <Textarea
              rows={12}
              value={content}
              onChange={(e) => {
                setContent(e.target.value)
                setSaved(false)
              }}
              placeholder="点击「AI 生成」自动撰写，或手动填写本报告内容"
            />
          </Field>

          <div className="flex items-center justify-between">
            <span className="text-xs text-text-3">
              {saved ? '已保存' : '有未保存的修改'}
            </span>
            <div className="flex gap-2">
              {studentReports.length > 0 && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    void exportReports(
                      studentReports,
                      { [student.id]: student.name },
                      `学习报告_${student.name}`,
                    )
                  }
                >
                  导出 Excel
                </Button>
              )}
              {existingReport && (
                <Button variant="danger" onClick={() => void handleDelete()}>
                  <Trash2 size={15} />
                  删除
                </Button>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* 历史报告 */}
      {studentReports.length > 0 && (
        <Card>
          <CardHeader title="历史报告" subtitle={`${studentReports.length} 份`} />
          <ul className="divide-y divide-line-1">
            {studentReports.map((r) => (
              <li
                key={r.id}
                className={cn(
                  'flex items-center gap-3 px-4 py-2.5',
                  existingReport?.id === r.id && 'bg-surface-2',
                )}
              >
                <FileText size={15} className="shrink-0 text-text-3" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-text-1">
                    {r.title || '未命名报告'}
                  </p>
                  <p className="text-xs text-text-3">
                    {new Date(r.periodStart).toLocaleDateString('zh-CN')} —{' '}
                    {new Date(r.periodEnd).toLocaleDateString('zh-CN')}
                  </p>
                </div>
                {r.aiGenerated && (
                  <Badge>
                    <Bot size={11} className="mr-1 inline" />
                    AI
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function defaultTitle(student: Student, range: { start: number }): string {
  const d = new Date(range.start)
  return `${student.name} ${d.getMonth() + 1}月学习报告`
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-text-3">{label}</p>
      <p className="mt-0.5 text-sm text-text-1">{value}</p>
    </div>
  )
}

// ============================================================
// 标签库
// ============================================================

function TagLibrary({
  isDesktop,
  students,
  tags,
  studentTags,
}: {
  isDesktop: boolean
  students: Student[]
  tags: LearningTag[]
  studentTags: StudentTag[]
}) {
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<LearningTag | null>(null)
  const [name, setName] = useState('')
  const [type, setType] = useState<string>(TAG_TYPES[0])
  const [colorSlot, setColorSlot] = useState(1)
  const [error, setError] = useState('')

  const [assignStudent, setAssignStudent] = useState('')

  useEffect(() => {
    if (!modalOpen) return
    if (editing) {
      setName(editing.name)
      setType(editing.type || TAG_TYPES[0])
      setColorSlot(editing.colorSlot || 1)
    } else {
      setName('')
      setType(TAG_TYPES[0])
      setColorSlot(((tags.length + 1) % 8) + 1)
    }
    setError('')
  }, [modalOpen, editing])

  function openCreate() {
    setEditing(null)
    setModalOpen(true)
  }

  function openEdit(t: LearningTag) {
    setEditing(t)
    setModalOpen(true)
  }

  async function handleSave() {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('请填写标签名')
      return
    }
    const payload = { name: trimmed, type, colorSlot }
    if (editing) {
      await db.learningTags.put(touch({ ...editing, ...payload }))
    } else {
      await db.learningTags.put(withSyncFields<LearningTag>(payload))
    }
    setModalOpen(false)
  }

  async function handleDelete(t: LearningTag) {
    await db.learningTags.put(markDeleted(t))
    // 同时清理关联
    const links = studentTags.filter((s) => s.tagId === t.id)
    for (const l of links) {
      await db.studentTags.put(markDeleted(l))
    }
  }

  async function toggleTag(studentId: string, tagId: string) {
    const existing = studentTags.find(
      (s) => s.studentId === studentId && s.tagId === tagId && !s.deletedAt,
    )
    if (existing) {
      await db.studentTags.put(markDeleted(existing))
    } else {
      const stale = studentTags.find(
        (s) => s.studentId === studentId && s.tagId === tagId && s.deletedAt,
      )
      if (stale) {
        await db.studentTags.put(
          touch({ ...stale, deletedAt: null, assignedAt: Date.now() }),
        )
      } else {
        await db.studentTags.put(
          withSyncFields<StudentTag>({
            studentId,
            tagId,
            assignedAt: Date.now(),
          }),
        )
      }
    }
  }

  const grouped = useMemo(() => {
    const map = new Map<string, LearningTag[]>()
    for (const t of tags) {
      const key = t.type || '未分类'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(t)
    }
    return Array.from(map.entries())
  }, [tags])

  const effectiveStudent =
    assignStudent || students.find((s) => s.status === 'active')?.id || students[0]?.id || ''
  const assignedIds = new Set(
    studentTags
      .filter((s) => s.studentId === effectiveStudent && !s.deletedAt)
      .map((s) => s.tagId),
  )

  return (
    <div className={cn('space-y-3', isDesktop && 'grid grid-cols-2 gap-4 items-start')}>
      {/* 标签定义 */}
      <Card>
        <CardHeader
          title="标签库"
          subtitle={`${tags.length} 个标签`}
          action={
            <Button variant="primary" onClick={openCreate}>
              <Plus size={15} />
              新建
            </Button>
          }
        />
        {tags.length === 0 ? (
          <EmptyState
            icon={<TagIcon size={20} />}
            title="还没有标签"
            description="新建「一元二次方程」「作业拖拉」这类标签，便于在报告与筛选中使用"
          />
        ) : (
          <div className="space-y-4 p-4">
            {grouped.map(([typeName, list]) => (
              <div key={typeName}>
                <p className="mb-2 text-xs text-text-3">{typeName}</p>
                <div className="flex flex-wrap gap-2">
                  {list.map((t) => (
                    <span
                      key={t.id}
                      className="group inline-flex items-center gap-1.5 rounded-full bg-surface-2 py-1 pl-2.5 pr-1.5 text-[13px] text-text-1"
                    >
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: subjectColorVar(t.colorSlot) }}
                      />
                      {t.name}
                      <button
                        onClick={() => openEdit(t)}
                        aria-label={`编辑 ${t.name}`}
                        className="rounded p-0.5 text-text-3 hover:text-text-1"
                      >
                        <BookOpenText size={12} />
                      </button>
                      <button
                        onClick={() => void handleDelete(t)}
                        aria-label={`删除 ${t.name}`}
                        className="rounded p-0.5 text-text-3 hover:text-money-out"
                      >
                        <Trash2 size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* 给学生打标签 */}
      <Card>
        <CardHeader title="给学生打标签" subtitle="点击标签即可切换" />
        <div className="space-y-3 p-4">
          <Field label="学生">
            <Select
              value={effectiveStudent}
              onChange={(e) => setAssignStudent(e.target.value)}
            >
              <option value="">（未选择）</option>
              {students.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.grade ? ` · ${s.grade}` : ''}
                </option>
              ))}
            </Select>
          </Field>

          {tags.length === 0 ? (
            <p className="text-sm text-text-3">请先在左侧创建标签</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.map((t) => {
                const on = assignedIds.has(t.id)
                return (
                  <button
                    key={t.id}
                    onClick={() => void toggleTag(effectiveStudent, t.id)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] transition-colors',
                      on
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-line-2 text-text-2 hover:bg-surface-2',
                    )}
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{
                        background: on ? 'currentColor' : subjectColorVar(t.colorSlot),
                      }}
                    />
                    {t.name}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </Card>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? '编辑标签' : '新建标签'}
      >
        <div className="space-y-3">
          <Field label="名称" error={error}>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError('')
              }}
              placeholder="例如：函数薄弱 / 作业拖拉 / 课堂积极"
            />
          </Field>

          <Field label="类型">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {TAG_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="配色">
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 8 }, (_, i) => i + 1).map((slot) => (
                <button
                  key={slot}
                  type="button"
                  aria-label={`配色 ${slot}`}
                  onClick={() => setColorSlot(slot)}
                  className={cn(
                    'h-8 w-8 rounded-full transition-transform',
                    colorSlot === slot && 'ring-2 ring-accent ring-offset-2',
                  )}
                  style={{ background: subjectColorVar(slot) }}
                />
              ))}
            </div>
          </Field>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setModalOpen(false)}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void handleSave()}>
              保存
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

function TagChip({ tag, small }: { tag: LearningTag; small?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-surface-2 text-text-2',
        small ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-xs',
      )}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: subjectColorVar(tag.colorSlot) }}
      />
      {tag.name}
    </span>
  )
}
