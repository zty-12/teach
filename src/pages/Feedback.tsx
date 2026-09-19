import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { format } from 'date-fns'
import {
  BookOpen,
  ChevronRight,
  FileText,
  Loader2,
  MessageSquareText,
  Pencil,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react'
import { db, markDeleted, touch, withSyncFields, uniqueMemberStudentIds } from '@/lib/db'
import { useBreakpoint } from '@/hooks/useBreakpoint'
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
  SegmentedControl,
  Textarea,
} from '@/components/ui'
import { cn, courseDurationMin, formatCourseRange, subjectColorVar } from '@/lib/utils'
import {
  buildVisionCfg,
  generateFeedback,
  generateFeedbackWithTemplate,
  isAiConfigured,
  LlmError,
  recommendKnowledgePoints,
} from '@/lib/llm'
import { extractTextFromFile } from '@/lib/fileImport'
import {
  getCourseKnowledgeIds,
  setCourseKnowledges,
  softDeleteCourseKnowledges,
} from '@/lib/courseKnowledge'
import {
  analyzeTemplateImageToFields,
  analyzeTemplateToFields,
  generateStructuredFeedback,
  renderStructuredContent,
  type AnalyzedField,
  type FeedbackMaterialContext,
} from '@/lib/feedbackStructure'
import type {
  Course,
  CourseFeedback,
  FeedbackTemplate,
  FeedbackTemplateField,
  FieldSourceKind,
  Group,
  KnowledgePoint,
  Textbook,
  TextbookUnit,
} from '@/lib/types'
import { FEEDBACK_PLACEHOLDERS, FIELD_SOURCE_LABEL } from '@/lib/types'

export default function FeedbackPage() {
  const bp = useBreakpoint()
  const isDesktop = bp === 'desktop'

  const [editing, setEditing] = useState<CourseFeedback | null>(null)
  const [seedCourse, setSeedCourse] = useState<Course | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [templateModalOpen, setTemplateModalOpen] = useState(false)

  const courses = useLiveQuery(() => db.courses.toArray(), [])
  const feedbacks = useLiveQuery(() => db.courseFeedbacks.toArray(), [])
  const students = useLiveQuery(() => db.students.toArray(), [])
  const groups = useLiveQuery(() => db.groups.toArray(), [])
  const templates = useLiveQuery(() => db.feedbackTemplates.toArray(), [])

  const { done, written, courseTitleOf, defaultTemplate, groupMap } = useMemo(() => {
    const liveCourses = (courses ?? []).filter((c) => !c.deletedAt)
    const liveFb = (feedbacks ?? []).filter((f) => !f.deletedAt)
    const sMap = new Map((students ?? []).filter((s) => !s.deletedAt).map((s) => [s.id, s]))
    const gMap = new Map((groups ?? []).filter((g) => !g.deletedAt).map((g) => [g.id, g]))
    const fbByCourse = new Map<string, CourseFeedback>()
    for (const f of liveFb) {
      const prev = fbByCourse.get(f.courseId)
      if (!prev || f.updatedAt > prev.updatedAt) fbByCourse.set(f.courseId, f)
    }
    const titleOf = (c: Course): string => {
      if (c.studentId && sMap.get(c.studentId)) return sMap.get(c.studentId)!.name
      if (c.groupId && gMap.get(c.groupId)) return gMap.get(c.groupId)!.name
      return c.groupId ? '班课' : '课程'
    }
    const doneList = liveCourses
      .filter((c) => c.status === 'done' && !fbByCourse.has(c.id))
      .sort((a, b) => b.startAt - a.startAt)
    const writtenList = [...liveFb].sort((a, b) => b.updatedAt - a.updatedAt)
    const liveTemplates = (templates ?? []).filter((t) => !t.deletedAt)
    const def = liveTemplates.find((t) => t.isDefault) ?? liveTemplates[0] ?? null
    return { done: doneList, written: writtenList, courseTitleOf: titleOf, defaultTemplate: def, groupMap: gMap }
  }, [courses, feedbacks, students, groups, templates])

  function openNew(course: Course) {
    setEditing(null)
    setSeedCourse(course)
    setModalOpen(true)
  }
  function openEdit(fb: CourseFeedback) {
    setEditing(fb)
    setSeedCourse((courses ?? []).find((c) => c.id === fb.courseId) ?? null)
    setModalOpen(true)
  }
  async function handleDelete(fb: CourseFeedback) {
    if (!confirm('确定删除这条反馈吗？')) return
    await db.courseFeedbacks.put(markDeleted(fb))
    // 同步清理 CourseKnowledge（软删留墓碑，实现见 lib/courseKnowledge.ts）
    await softDeleteCourseKnowledges(fb.courseId)
  }
  async function togglePublish(fb: CourseFeedback) {
    await db.courseFeedbacks.put(
      touch({ ...fb, isDraft: !fb.isDraft, publishedAt: fb.isDraft ? Date.now() : null }),
    )
  }

  const liveTemplates = (templates ?? []).filter((t) => !t.deletedAt).sort((a, b) => b.createdAt - a.createdAt)

  return (
    <div>
      <PageHeader
        title="课后反馈"
        subtitle={`待写 ${done.length} · 已写 ${written.length} · 模板 ${liveTemplates.length}`}
        action={
          <Button variant="secondary" size="sm" onClick={() => setTemplateModalOpen(true)}>
            <Settings2 size={14} /> 反馈模板
          </Button>
        }
      />

      {/* 待写反馈 */}
      <Card className="mb-4">
        <CardHeader
          title="待写反馈"
          subtitle={done.length ? `${done.length} 节已完成课程待补` : undefined}
        />
        {done.length === 0 ? (
          <EmptyState
            icon={<MessageSquareText size={24} />}
            title="全部已补完"
            description="没有待写的课后反馈"
          />
        ) : isDesktop ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line-1 bg-surface-2 text-left text-[13px] text-text-2">
                <th className="px-4 py-2.5 font-medium">学生 / 班课</th>
                <th className="px-4 py-2.5 font-medium">科目</th>
                <th className="px-4 py-2.5 font-medium">上课时间</th>
                <th className="px-4 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-1">
              {done.map((c) => (
                <tr key={c.id} className="transition-colors hover:bg-surface-1">
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: subjectColorVar(c.colorSlot) }}
                      />
                      <span className="font-medium text-text-1">{courseTitleOf(c)}</span>
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-text-2">{c.subject}</td>
                  <td className="px-4 py-2.5 tabular-nums text-text-2">
                    {format(c.startAt, 'yyyy-MM-dd HH:mm')}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button size="sm" variant="primary" onClick={() => openNew(c)}>
                      <Plus size={14} /> 写反馈
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <ul className="divide-y divide-line-1">
            {done.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-3">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: subjectColorVar(c.colorSlot) }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text-1">
                    {courseTitleOf(c)} · {c.subject}
                  </p>
                  <p className="text-xs text-text-3">{format(c.startAt, 'M月d日 HH:mm')}</p>
                </div>
                <Button size="sm" variant="primary" onClick={() => openNew(c)}>
                  写反馈
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* 已写反馈 */}
      <Card className="mb-4">
        <CardHeader title="已写反馈" subtitle={written.length ? `${written.length} 条` : undefined} />
        {written.length === 0 ? (
          <EmptyState
            icon={<MessageSquareText size={24} />}
            title="还没有反馈记录"
            description="完成课程后，来写第一条课后反馈"
          />
        ) : (
          <ul className="divide-y divide-line-1">
            {written.map((f) => {
              const c = (courses ?? []).find((x) => x.id === f.courseId)
              return (
                <li key={f.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {c && (
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ background: subjectColorVar(c.colorSlot) }}
                          />
                        )}
                        <span className="truncate text-sm font-medium text-text-1">
                          {c ? `${courseTitleOf(c)} · ${c.subject}` : '已删课程'}
                        </span>
                        <Badge
                          className={cn(
                            f.isDraft ? 'bg-surface-2 text-text-2' : 'bg-done-soft text-done',
                          )}
                        >
                          {f.isDraft ? '草稿' : '已发布'}
                        </Badge>
                      </div>
                      {f.summary && (
                        <p className="mt-1 truncate text-[13px] text-text-2">{f.summary}</p>
                      )}
                      {f.content && (
                        <p className="mt-1 line-clamp-2 text-xs text-text-3">{f.content}</p>
                      )}
                      <p className="mt-1 text-[11px] text-text-3">
                        {f.aiGenerated ? 'AI 生成 · ' : ''}
                        {format(f.updatedAt, 'yyyy-MM-dd HH:mm')}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col gap-1">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(f)}>
                        <Pencil size={13} />
                        编辑
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void togglePublish(f)}>
                        {f.isDraft ? '发布' : '转草稿'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void handleDelete(f)}>
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <FeedbackModal
        open={modalOpen}
        feedback={editing}
        course={seedCourse}
        courseTitle={seedCourse ? courseTitleOf(seedCourse) : ''}
        defaultTemplate={defaultTemplate}
        templates={liveTemplates}
        groupMap={groupMap}
        onClose={() => setModalOpen(false)}
      />

      <TemplateManagerModal
        open={templateModalOpen}
        templates={liveTemplates}
        onClose={() => setTemplateModalOpen(false)}
      />
    </div>
  )
}

// ============================================================
// 反馈编辑器（核心：模板 + 知识点勾选 + AI）
// ============================================================

function FeedbackModal({
  open,
  feedback,
  course,
  courseTitle,
  defaultTemplate,
  templates,
  groupMap,
  onClose,
}: {
  open: boolean
  feedback: CourseFeedback | null
  course: Course | null
  courseTitle: string
  defaultTemplate: FeedbackTemplate | null
  templates: FeedbackTemplate[]
  groupMap: Map<string, Group>
  onClose: () => void
}) {
  const aiSettings = useSettings((s) => s.settings)
  const [summary, setSummary] = useState('')
  const [content, setContent] = useState('')
  const [isDraft, setIsDraft] = useState(true)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [templateId, setTemplateId] = useState<string | null>(null)
  const [selectedKps, setSelectedKps] = useState<Set<string>>(new Set())
  const [recommending, setRecommending] = useState(false)
  /** 生成 / 推荐已等待秒数：让「AI 在跑」可感知（v31.5） */
  const [aiElapsed, setAiElapsed] = useState(0)
  const [recommendElapsed, setRecommendElapsed] = useState(0)
  /**
   * 知识点推荐的缓存与在途请求（v31.5 提速）。
   * 弹窗打开后会静默预热一次，老师点「AI 推荐」时命中缓存 → 0 等待；
   * 同时复用「在途 promise」，连点也不会重复发起请求。
   */
  const recommendCacheRef = useRef<{ key: string; ids: string[] } | null>(null)
  const recommendInFlightRef = useRef<{ key: string; promise: Promise<string[]> } | null>(null)
  /** 保存中锁：防止双击写入两条同课程的反馈（v26 审查：P2） */
  const [saving, setSaving] = useState(false)

  const textbooks = useLiveQuery(() => db.textbooks.toArray(), [])
  const units = useLiveQuery(() => db.textbookUnits.toArray(), [])
  const allKps = useLiveQuery(() => db.knowledgePoints.toArray(), [])
  const feedbacks = useLiveQuery(() => db.courseFeedbacks.toArray(), [])

  useEffect(() => {
    if (!open) return
    if (feedback) {
      setSummary(feedback.summary)
      setContent(feedback.content)
      setIsDraft(feedback.isDraft)
      setTemplateId(null)
    } else {
      setSummary('')
      setContent('')
      setIsDraft(true)
      setTemplateId(defaultTemplate?.id ?? null)
    }
    setAiError('')
    setSelectedKps(new Set())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, feedback?.id, defaultTemplate?.id])

  // 加载已有 CourseKnowledge
  useEffect(() => {
    if (!open || !course) return
    void (async () => {
      setSelectedKps(new Set(await getCourseKnowledgeIds(course.id)))
    })()
  }, [open, course?.id])

  // AI 耗时计时：让「正在生成」可感知（模型慢时至少知道还在跑，而不是卡住了）
  useEffect(() => {
    if (!aiLoading) return
    const t0 = Date.now()
    setAiElapsed(0)
    const timer = setInterval(() => setAiElapsed(Math.round((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [aiLoading])

  useEffect(() => {
    if (!recommending) return
    const t0 = Date.now()
    setRecommendElapsed(0)
    const timer = setInterval(() => setRecommendElapsed(Math.round((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [recommending])

  const liveTextbooks = (textbooks ?? []).filter((t) => !t.deletedAt)
  const liveUnits = (units ?? []).filter((u) => !u.deletedAt)
  const liveKps = (allKps ?? []).filter((p) => !p.deletedAt)
  const liveFeedbacks = (feedbacks ?? []).filter((f) => !f.deletedAt)

  const kpsByUnit = useMemo(() => {
    const m = new Map<string, KnowledgePoint[]>()
    for (const kp of liveKps) {
      if (!m.has(kp.unitId)) m.set(kp.unitId, [])
      m.get(kp.unitId)!.push(kp)
    }
    return m
  }, [liveKps])

  const template = useMemo(
    () => templates.find((t) => t.id === templateId) ?? defaultTemplate ?? null,
    [templateId, templates, defaultTemplate],
  )

  // v8：结构化模板的字段，以及生成反馈要投喂的各类工作台资料
  const templateFields = useLiveQuery(
    () =>
      template?.kind === 'structured' && template?.id
        ? db.feedbackTemplateFields.where('templateId').equals(template.id).toArray()
        : Promise.resolve([] as FeedbackTemplateField[]),
    [template?.id, template?.kind],
  )
  const allProfiles = useLiveQuery(() => db.studentProfiles.toArray(), [])
  const allCheckInTasksFb = useLiveQuery(() => db.checkInTasks.toArray(), [])
  const allCheckInRecords = useLiveQuery(() => db.checkInRecords.toArray(), [])
  const allAttendancesFb = useLiveQuery(() => db.courseAttendances.toArray(), [])
  const allStudentsFb = useLiveQuery(() => db.students.toArray(), [])
  const allMembersFb = useLiveQuery(() => db.groupMembers.toArray(), [])

  /**
   * 装配「生成反馈」所需的全部素材：知识点 / 出勤课时 / 学生画像 / 打卡。
   * 结构化模板按字段 source 各取所需（见 collectFieldMaterial）。
   */
  function buildMaterialCtx(): FeedbackMaterialContext {
    const c = course!
    const sMap = new Map(
      (allStudentsFb ?? []).filter((s) => !s.deletedAt).map((s) => [s.id, s]),
    )
    const studentIds = c.studentId
      ? [c.studentId]
      : uniqueMemberStudentIds(allMembersFb ?? [], c.groupId)

    const knowledges = Array.from(selectedKps)
      .map((id) => liveKps.find((p) => p.id === id))
      .filter((k): k is KnowledgePoint => Boolean(k))
      .map((k) => ({ title: k.title, summary: k.summary }))

    const attendance = studentIds.map((sid) => {
      const s = sMap.get(sid)
      const a = (allAttendancesFb ?? []).find(
        (x) => !x.deletedAt && x.courseId === c.id && x.studentId === sid,
      )
      return {
        name: s?.name ?? '学生',
        present: a?.present ?? true,
        remainingHours: s?.remainingHours ?? 0,
      }
    })

    const profiles = studentIds
      .map((sid) => {
        const s = sMap.get(sid)
        const p = (allProfiles ?? []).find((x) => !x.deletedAt && x.studentId === sid)
        if (!p) return null
        return {
          name: s?.name ?? '学生',
          strengths: p.strengths,
          weaknesses: p.weaknesses,
          teachingStyle: p.teachingStyle,
        }
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x))

    const taskIds = new Set(
      (allCheckInTasksFb ?? []).filter((t) => !t.deletedAt).map((t) => t.id),
    )
    const checkins = studentIds.map((sid) => {
      const s = sMap.get(sid)
      const rel = (allCheckInRecords ?? []).filter(
        (r) => !r.deletedAt && r.studentId === sid && taskIds.has(r.taskId),
      )
      return {
        name: s?.name ?? '学生',
        doneCount: rel.filter((r) => r.status === 'done').length,
        totalCount: rel.length,
        notes: rel.filter((r) => r.note).slice(-3).map((r) => r.note),
      }
    })

    return {
      who: courseTitle,
      subject: c.subject,
      timeText: formatCourseRange(c, groupMap),
      durationText: `${courseDurationMin(c, groupMap) ?? 60} 分钟`,
      courseNote: c.note,
      knowledges,
      attendance,
      profiles,
      checkins,
    }
  }

  function toggleKp(id: string) {
    setSelectedKps((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /**
   * 组装「推荐知识点」所需的上下文与候选项（v31.5 抽出）。
   * 预热与手动点击共用同一份构造逻辑，保证命中缓存时结果一致。
   */
  function buildRecommendInput() {
    if (!course) return null
    const recent = liveFeedbacks
      .filter((f) => {
        if (f.id === feedback?.id) return false
        const c = coursesInRecent?.find((x) => x.id === f.courseId)
        if (!c) return false
        return c.studentId === course.studentId && c.groupId === course.groupId
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5)
      .map((f) => f.summary)
      .filter(Boolean)
    // 备注一并入 note
    const recentNotes = (coursesInRecent ?? [])
      .filter((c) => c.studentId === course.studentId && c.groupId === course.groupId)
      .map((c) => c.note)
      .filter(Boolean)
      .slice(0, 5)
      .join('\n')
    const candidates = liveKps.slice(0, 50).map((k) => {
      const u = liveUnits.find((x) => x.id === k.unitId)
      const t = liveTextbooks.find((x) => x.id === k.textbookId)
      const path = [t?.name, u?.name].filter(Boolean).join(' · ')
      return { id: k.id, title: k.title, path, summary: k.summary }
    })
    if (candidates.length === 0) return null
    return {
      candidates,
      ctx: {
        who: courseTitle,
        subject: course.subject,
        timeText: format(course.startAt, 'M-d HH:mm'),
        note: [course.note, recentNotes].filter(Boolean).join('\n'),
        recentFeedbacks: recent,
      },
      // 课程 / 备注 / 候选规模变了就重新推荐，否则沿用缓存
      key: `${course.id}|${course.updatedAt}|${course.note}|${candidates.length}|${recent.length}`,
    }
  }

  /** 取推荐结果：命中缓存立即返回；有在途请求则复用；否则才发起一次 LLM */
  function ensureRecommend(): Promise<string[]> {
    const input = buildRecommendInput()
    if (!input) return Promise.resolve([])
    if (recommendCacheRef.current?.key === input.key) {
      return Promise.resolve(recommendCacheRef.current.ids)
    }
    const inFlight = recommendInFlightRef.current
    if (inFlight && inFlight.key === input.key) return inFlight.promise
    const promise = recommendKnowledgePoints(aiSettings, input.ctx, input.candidates)
      .then((ids) => {
        recommendCacheRef.current = { key: input.key, ids }
        return ids
      })
      .finally(() => {
        if (recommendInFlightRef.current?.promise === promise) recommendInFlightRef.current = null
      })
    recommendInFlightRef.current = { key: input.key, promise }
    return promise
  }

  async function handleAiRecommend() {
    if (!course) return
    if (!isAiConfigured(aiSettings)) {
      setAiError('尚未配置 AI。请在「设置 → AI 辅助」填入 Base URL 与 API Key。')
      return
    }
    // 预热已拿到结果 → 直接应用，不再等一次 LLM
    const input = buildRecommendInput()
    const cached = recommendCacheRef.current
    if (input && cached && cached.key === input.key) {
      setAiError('')
      setSelectedKps(new Set(cached.ids))
      return
    }
    setRecommending(true)
    setAiError('')
    try {
      const ids = await ensureRecommend()
      setSelectedKps(new Set(ids))
    } catch (e) {
      setAiError(e instanceof LlmError ? e.message : `AI 推荐失败：${String(e)}`)
    } finally {
      setRecommending(false)
    }
  }

  /**
   * 预热：弹窗打开后静默跑一次知识点推荐（不覆盖老师已勾选的内容）。
   * 把「等 5-10 秒」挪到老师看模板、准备写反馈的空档里执行；
   * 点「AI 推荐」时大概率直接命中缓存 —— 0 等待。失败静默忽略，不影响手工勾选。
   */
  useEffect(() => {
    if (!open || !course || !isAiConfigured(aiSettings)) return
    const timer = setTimeout(() => {
      void ensureRecommend().catch(() => {})
    }, 500)
    return () => clearTimeout(timer)
    // 依赖弹窗 / 课程 / 知识库规模（知识库加载完才有候选项）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, course?.id, liveKps.length])

  // 取课程（只在最近推荐时用）
  const coursesInRecent = useLiveQuery(() => db.courses.toArray(), [])

  async function handleAi() {
    if (!course) return
    if (!isAiConfigured(aiSettings)) {
      setAiError('尚未配置 AI。请在「设置 → AI 辅助」填入 Base URL 与 API Key。')
      return
    }
    setAiLoading(true)
    setAiError('')
    try {
      // v8：结构化模板 → 按字段 + 各字段关联的资料生成
      const structuredFields = (templateFields ?? [])
        .filter((f) => !f.deletedAt)
        .sort((a, b) => a.order - b.order)
      if (template?.kind === 'structured' && structuredFields.length > 0) {
        const sections = await generateStructuredFeedback(
          aiSettings,
          buildMaterialCtx(),
          structuredFields,
        )
        if (sections.length === 0) throw new Error('AI 未返回可用内容，请重试。')
        setContent(renderStructuredContent(sections))
        const first = sections.find((s) => s.content)
        setSummary(first ? first.content.slice(0, 60) : '')
        setIsDraft(true)
        setAiLoading(false)
        return
      }
      if (template) {
        // 按模板 + 勾选知识点 生成
        const knowledges = Array.from(selectedKps)
          .map((id) => liveKps.find((p) => p.id === id))
          .filter(Boolean)
          .map((k) => {
            const u = liveUnits.find((x) => x.id === k!.unitId)
            const t = liveTextbooks.find((x) => x.id === k!.textbookId)
            const path = [t?.name, u?.name].filter(Boolean).join(' · ')
            return { title: k!.title, summary: k!.summary, path }
          })
        const recent = liveFeedbacks
          .filter((f) => {
            const c = (coursesInRecent ?? []).find((x) => x.id === f.courseId)
            if (!c) return false
            return c.studentId === course.studentId && c.groupId === course.groupId
          })
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 5)
          .map((f) => f.summary)
          .filter(Boolean)
        const res = await generateFeedbackWithTemplate(aiSettings, {
          templateBody: template.body,
          ctx: {
            who: courseTitle,
            subject: course.subject,
            timeText: formatCourseRange(course, groupMap),
            note: course.note,
            recentFeedbacks: recent,
          },
          knowledges,
          durationMin: courseDurationMin(course, groupMap) ?? 60,
        })
        setSummary(res.summary)
        setContent(res.content)
      } else {
        // 自由生成（沿用旧行为）
        const res = await generateFeedback(aiSettings, course, courseTitle)
        setSummary(res.summary)
        setContent(res.content)
      }
      setIsDraft(true)
    } catch (e) {
      setAiError(e instanceof LlmError ? e.message : `AI 生成失败：${String(e)}`)
    } finally {
      setAiLoading(false)
    }
  }

  async function handleSave() {
    if (!course || saving) return
    setSaving(true)
    try {
      const payload = {
        summary: summary.trim(),
        content: content.trim(),
        isDraft,
        publishedAt: isDraft ? null : feedback?.publishedAt ?? Date.now(),
        aiGenerated: feedback?.aiGenerated ?? false,
      }
      let savedFbId: string
      if (feedback) {
        await db.courseFeedbacks.put(touch({ ...feedback, ...payload }))
        savedFbId = feedback.id
      } else {
        const newFb = withSyncFields<CourseFeedback>({
          courseId: course.id,
          createdAt: Date.now(),
          ...payload,
        })
        await db.courseFeedbacks.put(newFb)
        savedFbId = newFb.id
      }
      // 保存本次勾选的知识点（软删取消的 + 新增勾选的，差分实现见 lib/courseKnowledge.ts）
      await setCourseKnowledges(course.id, selectedKps)
      void savedFbId
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={feedback ? '编辑反馈' : '写课后反馈'}
      size="xl"
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {course && (
          <div className="rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-text-2">
            {courseTitle} · {course.subject} · {format(course.startAt, 'yyyy-MM-dd HH:mm')}
          </div>
        )}

        {/* 模板选择 */}
        {templates.length > 0 && (
          <Field label="反馈模板" hint="留空则按自由风格生成">
            <SelectUnderlined
              value={templateId ?? ''}
              onChange={(v) => setTemplateId(v || null)}
              options={[
                { value: '', label: '不使用模板' },
                ...templates.map((t) => ({ value: t.id, label: t.name + (t.isDefault ? '（默认）' : '') })),
              ]}
            />
            {template && (
              <details className="mt-1.5 text-[12px] text-text-3">
                <summary className="cursor-pointer select-none">查看模板结构</summary>
                <pre className="mt-1 whitespace-pre-wrap rounded bg-surface-2 p-2 text-[11px] leading-relaxed">
                  {template.body}
                </pre>
              </details>
            )}
          </Field>
        )}

        {/* 本次覆盖知识点 */}
        <Field
          label="本次覆盖知识点"
          hint={`已选 ${selectedKps.size} 个 · 点击勾选本次课涉及的知识点，可用于 AI 生成时组织内容`}
        >
          <div className="flex items-center justify-between gap-2 pb-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void handleAiRecommend()}
              disabled={recommending}
              title="根据课程信息 + 备注 + 历史反馈，让 AI 推荐本次可能涉及的知识点（打开弹窗时已后台预热，点开通常秒出）"
            >
              {recommending ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
              {recommending ? `推荐中… ${recommendElapsed}s` : 'AI 推荐'}
            </Button>
            {selectedKps.size > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setSelectedKps(new Set())}>
                清空
              </Button>
            )}
          </div>
          {liveTextbooks.length === 0 ? (
            <p className="rounded-md bg-surface-2 px-3 py-2 text-[12px] text-text-3">
              <BookOpen size={12} className="mr-1 inline" /> 知识库还没有教材。
              <a className="ml-1 text-accent hover:underline" href="#/knowledge">
                去添加 →
              </a>
            </p>
          ) : (
            <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border border-line-1 bg-surface-0 p-2">
              {liveTextbooks.map((t) => (
                <TextbookKpGroup
                  key={t.id}
                  textbook={t}
                  units={liveUnits.filter((u) => u.textbookId === t.id)}
                  kpsByUnit={kpsByUnit}
                  selected={selectedKps}
                  onToggle={toggleKp}
                />
              ))}
            </div>
          )}
        </Field>

        <Field label="一句话摘要">
          <Input
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="本课重点 / 学生表现概要"
          />
        </Field>

        <Field label="详细反馈">
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={
              template
                ? 'AI 会按上方模板的结构组织内容；点击右侧「按模板生成」一键填充'
                : '知识点掌握、课堂表现、改进建议…'
            }
            rows={6}
          />
        </Field>

        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Field label="发布状态" hint="草稿仅自己可见，发布后可在报告中使用">
              <SegmentedControl
                value={isDraft ? 'draft' : 'published'}
                onChange={(v) => setIsDraft(v === 'draft')}
                options={[
                  { value: 'draft', label: '草稿' },
                  { value: 'published', label: '发布' },
                ]}
              />
            </Field>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="secondary"
              onClick={() => void handleAi()}
              disabled={aiLoading}
              title={
                template
                  ? `按模板「${template.name}」+ 勾选的 ${selectedKps.size} 个知识点生成`
                  : '根据课程信息自动生成反馈（无模板）'
              }
            >
              {aiLoading ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Sparkles size={15} />
              )}
              {aiLoading ? `生成中… ${aiElapsed}s` : template ? '按模板生成' : 'AI 生成'}
            </Button>
          </div>
        </div>

        {aiError && (
          <div className="flex items-start justify-between gap-2 rounded-lg bg-money-due-soft px-3 py-2 text-[13px] text-money-due">
            <span className="min-w-0 flex-1">{aiError}</span>
            {!isAiConfigured(aiSettings) && (
              <a
                href="#/settings"
                onClick={onClose}
                className="flex shrink-0 items-center gap-1 font-medium text-money-due hover:underline"
              >
                <Settings2 size={14} /> 去设置
              </a>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

// ============================================================
// 知识点勾选分组
// ============================================================

function TextbookKpGroup({
  textbook,
  units,
  kpsByUnit,
  selected,
  onToggle,
}: {
  textbook: Textbook
  units: TextbookUnit[]
  kpsByUnit: Map<string, KnowledgePoint[]>
  selected: Set<string>
  onToggle: (id: string) => void
}) {
  const [open, setOpen] = useState(true)
  const totalCount = units.reduce((acc, u) => acc + (kpsByUnit.get(u.id)?.length ?? 0), 0)
  const selectedCount = units.reduce(
    (acc, u) => acc + (kpsByUnit.get(u.id)?.filter((k) => selected.has(k.id)).length ?? 0),
    0,
  )
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-surface-1"
      >
        <ChevronRight
          size={12}
          className={cn('transition-transform', open && 'rotate-90')}
        />
        <span className="flex-1 truncate text-[13px] font-medium text-text-1">{textbook.name}</span>
        <span className="text-[11px] text-text-3">
          {totalCount === 0 ? '空' : `${selectedCount}/${totalCount}`}
        </span>
      </button>
      {open && (
        <div className="ml-4 mt-1 space-y-1">
          {units.map((u) => {
            const kps = kpsByUnit.get(u.id) ?? []
            if (kps.length === 0) return null
            return (
              <div key={u.id} className="rounded-md">
                <div className="px-2 text-[11px] text-text-3">{u.name}</div>
                <div className="flex flex-wrap gap-1 px-2 py-1">
                  {kps.map((k) => {
                    const isOn = selected.has(k.id)
                    return (
                      <button
                        key={k.id}
                        type="button"
                        onClick={() => onToggle(k.id)}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                          isOn
                            ? 'border-accent bg-accent-soft text-accent-text'
                            : 'border-line-1 text-text-2 hover:bg-surface-2',
                        )}
                      >
                        {k.title}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// 极简内联 Select 组件（避免引入过多依赖）
function SelectUnderlined({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border border-line-1 bg-surface-0 px-3 py-2 text-sm text-text-1 focus:border-accent focus:outline-none"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

// ============================================================
// 模板管理 Modal
// ============================================================

function TemplateManagerModal({
  open,
  templates,
  onClose,
}: {
  open: boolean
  templates: FeedbackTemplate[]
  onClose: () => void
}) {
  const [editing, setEditing] = useState<FeedbackTemplate | null>(null)
  const [adding, setAdding] = useState(false)
  /** 导入模板（图片 / 文字 → AI 识别字段） */
  const [importing, setImporting] = useState(false)
  /** 正在编辑字段的结构化模板 */
  const [fieldsOf, setFieldsOf] = useState<FeedbackTemplate | null>(null)

  async function handleDelete(t: FeedbackTemplate) {
    if (!confirm(`删除模板「${t.name}」？`)) return
    await db.feedbackTemplates.put(markDeleted(t))
  }
  async function handleSetDefault(t: FeedbackTemplate) {
    // ⚠ 不复用 bulkPut 全表 touch：那会把「值没变」的行也标 dirty 触发整表推送，
    //   且会改写已软删模板的 isDefault（v26 审查：P3）。
    const all = await db.feedbackTemplates.toArray()
    const stale = all.filter((x) => !x.deletedAt && x.id !== t.id && x.isDefault)
    for (const x of stale) {
      await db.feedbackTemplates.put(touch({ ...x, isDefault: false }))
    }
    const row = await db.feedbackTemplates.get(t.id)
    if (row && !row.deletedAt && !row.isDefault) {
      await db.feedbackTemplates.put(touch({ ...row, isDefault: true }))
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="反馈模板"
      size="xl"
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          <Button onClick={() => setImporting(true)}>
            <Sparkles size={14} /> 导入模板（AI 识别字段）
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setAdding(true)
              setEditing(null)
            }}
          >
            <Plus size={14} /> 新建模板
          </Button>
        </>
      }
    >
      {templates.length === 0 ? (
        <EmptyState
          icon={<FileText size={22} />}
          title="还没有模板"
          description="可创建多套模板（如「英语课」「班课汇报」）并设为默认"
        />
      ) : (
        <ul className="space-y-2">
          {templates.map((t) => (
            <li
              key={t.id}
              className={cn(
                'group rounded-lg border border-line-1 bg-surface-0 p-3 transition-colors',
                t.isDefault && 'border-accent/40 bg-accent-soft/40',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-text-1">{t.name}</span>
                    {t.isDefault && <Badge variant="primary">默认</Badge>}
                  </div>
                  <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[12px] text-text-3">
                    {t.body}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {t.kind === 'structured' && (
                    <Button size="sm" variant="ghost" onClick={() => setFieldsOf(t)}>
                      字段
                    </Button>
                  )}
                  {!t.isDefault && (
                    <Button size="sm" variant="ghost" onClick={() => void handleSetDefault(t)}>
                      设为默认
                    </Button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(t)
                      setAdding(false)
                    }}
                    className="hidden h-7 w-7 items-center justify-center rounded-md text-text-3 hover:bg-surface-2 hover:text-text-1 group-hover:flex"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(t)}
                    className="hidden h-7 w-7 items-center justify-center rounded-md text-text-3 hover:bg-money-out/10 hover:text-money-out group-hover:flex"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {(adding || editing) && (
        <TemplateEditModal
          template={editing}
          onClose={() => {
            setEditing(null)
            setAdding(false)
          }}
        />
      )}

      {importing && <ImportTemplateModal onClose={() => setImporting(false)} />}

      {fieldsOf && (
        <TemplateFieldsModal template={fieldsOf} onClose={() => setFieldsOf(null)} />
      )}

      {/* 占位符说明（折叠） */}
      {templates.length > 0 && (
        <details className="mt-4 rounded-lg bg-surface-2 p-3 text-[12px] text-text-3">
          <summary className="cursor-pointer select-none">支持的占位符</summary>
          <table className="mt-2 w-full">
            <tbody>
              {FEEDBACK_PLACEHOLDERS.map((p) => (
                <tr key={p.key} className="border-b border-line-1 last:border-0">
                  <td className="py-1 pr-3 font-mono text-[11px]">{`{{${p.key}}}`}</td>
                  <td className="py-1 pr-3 font-medium text-text-1">{p.label}</td>
                  <td className="py-1 text-text-3">{p.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </Modal>
  )
}

function TemplateEditModal({
  template,
  onClose,
}: {
  template: FeedbackTemplate | null
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  /** 保存中锁：防止双击写入两套模板（v26 审查：P2） */
  const [saving, setSaving] = useState(false)

  useMemo(() => {
    if (!template) return
    setName(template.name)
    setBody(template.body)
    setIsDefault(template.isDefault)
  }, [template])

  async function handleSave() {
    const payload = {
      name: name.trim(),
      body: body.trim(),
      isDefault,
    }
    if (!payload.name || !payload.body || saving) return
    setSaving(true)
    try {
      // 用写库对象自身的 id 作为 newId ——
      // ⚠ 不能用 `all[all.length - 1]?.id` 猜新行：toArray 按 UUID 主键排序，新行位置随机，
      //   「设为默认」会标到别的模板上（v26 审查：P2）。
      let newId: string
      if (template) {
        const next = touch({ ...template, ...payload })
        await db.feedbackTemplates.put(next)
        newId = next.id
      } else {
        const created = withSyncFields<FeedbackTemplate>({ ...payload, createdAt: Date.now() })
        await db.feedbackTemplates.put(created)
        newId = created.id
      }
      // 设为默认 → 取消其它模板的默认标记。
      // ⚠ 只处理**未软删**的行，且只写「值确实变化」的行，避免无谓的 dirty 推送（v26 审查：P3）。
      if (payload.isDefault) {
        const all = await db.feedbackTemplates.toArray()
        const stale = all.filter((x) => !x.deletedAt && x.id !== newId && x.isDefault)
        for (const x of stale) {
          await db.feedbackTemplates.put(touch({ ...x, isDefault: false }))
        }
      }
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={template ? '编辑模板' : '新建模板'}
      size="xl"
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="模板名称">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：英语课常规反馈 / 班课阶段汇报"
          />
        </Field>
        <Field
          label="模板正文"
          hint="支持 {{占位符}}（见下方），AI 会按此结构生成内容"
        >
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
            placeholder={EXAMPLE_TEMPLATE}
          />
        </Field>
        <label className="inline-flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
          />
          设为默认模板
        </label>
      </div>
    </Modal>
  )
}

const EXAMPLE_TEMPLATE = `【本节课重点】
（...）

【学生表现】
（...）

【家庭配合建议】
（...）`

/** 把本地图片读成 dataURL（用于直接发给视觉模型） */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('读取图片失败，请重试'))
    r.readAsDataURL(file)
  })
}

// ============================================================
// 导入模板：图片 / 文字 → AI 识别字段 → 存成结构化模板
// ============================================================

function ImportTemplateModal({ onClose }: { onClose: () => void }) {
  const settings = useSettings((s) => s.settings)
  const [mode, setMode] = useState<'text' | 'image'>('text')
  const [rawText, setRawText] = useState('')
  const [imgFile, setImgFile] = useState<File | null>(null)
  const [imgDataUrl, setImgDataUrl] = useState('')
  const [tplName, setTplName] = useState('')
  const [fields, setFields] = useState<AnalyzedField[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [stage, setStage] = useState<'input' | 'review'>('input')

  const visionCfg = useMemo(() => buildVisionCfg(settings), [settings])
  const hasVision = Boolean(visionCfg)

  async function handleAnalyze() {
    setErr('')
    if (!isAiConfigured(settings)) {
      setErr('尚未配置 AI。请在「设置 → AI 辅助」填入 Base URL 与 API Key。')
      return
    }
    if (mode === 'text' && !rawText.trim()) {
      setErr('请先粘贴模板文字。')
      return
    }
    if (mode === 'image' && !imgFile) {
      setErr('请先选择模板图片。')
      return
    }
    setBusy(true)
    try {
      let out: AnalyzedField[] = []
      if (mode === 'image') {
        const file = imgFile!
        if (hasVision) {
          // 图片直发视觉模型：读文字 + 拆字段一次完成。
          // 注意：onChange 里是异步转 dataURL 的，这里兜底等它就绪，避免发出空图。
          const url = imgDataUrl || (await fileToDataUrl(file))
          if (url !== imgDataUrl) setImgDataUrl(url)
          out = await analyzeTemplateImageToFields(settings, url, visionCfg)
        } else {
          // 未配视觉模型 → 本地 OCR 读出文字，再拆字段
          const r = await extractTextFromFile(file)
          if (!r.chars) throw new Error('未能从图片识别出文字，请改用「文字」方式粘贴模板内容。')
          out = await analyzeTemplateToFields(settings, r.text)
        }
      } else {
        out = await analyzeTemplateToFields(settings, rawText)
      }
      if (out.length === 0) {
        throw new Error('AI 未能识别出模板字段。可换个更清晰的模板，或改用「新建模板」手动填写。')
      }
      setFields(out)
      if (!tplName.trim()) {
        const auto =
          mode === 'image' ? (imgFile?.name ?? '').replace(/\.[^.]+$/, '') : '粘贴的模板'
        setTplName(auto || '导入的模板')
      }
      setStage('review')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleSave() {
    if (!tplName.trim() || fields.length === 0) return
    const now = Date.now()
    const tpl = withSyncFields<FeedbackTemplate>({
      name: tplName.trim(),
      body: fields.map((f) => `【${f.name}】`).join('\n'),
      isDefault: false,
      createdAt: now,
      kind: 'structured',
    })
    await db.feedbackTemplates.put(tpl)
    await db.feedbackTemplateFields.bulkPut(
      fields.map((f, i) =>
        withSyncFields<FeedbackTemplateField>({
          templateId: tpl.id,
          name: f.name,
          hint: f.hint,
          source: f.source,
          order: i,
          createdAt: now,
        }),
      ),
    )
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="导入模板 · AI 识别字段"
      size="xl"
      footer={
        stage === 'input' ? (
          <>
            <Button onClick={onClose}>取消</Button>
            <Button variant="primary" disabled={busy} onClick={() => void handleAnalyze()}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
              {busy ? '识别中…' : 'AI 识别字段'}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => setStage('input')}>上一步</Button>
            <Button variant="primary" onClick={() => void handleSave()}>
              保存模板
            </Button>
          </>
        )
      }
    >
      {stage === 'input' ? (
        <div className="space-y-3">
          <SegmentedControl
            value={mode}
            onChange={(v) => setMode(v as 'text' | 'image')}
            options={[
              { value: 'text', label: '粘贴文字' },
              { value: 'image', label: '上传图片' },
            ]}
          />

          {mode === 'text' ? (
            <Field label="模板原文" hint="把反馈表/模板的文字粘进来，AI 会拆成字段">
              <Textarea
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                rows={10}
                placeholder={EXAMPLE_TEMPLATE}
              />
            </Field>
          ) : (
            <div className="space-y-2">
              <Field
                label="模板图片"
                hint={
                  hasVision
                    ? '已配置视觉模型，将由图直接识别并拆字段'
                    : '未配置视觉模型，将先用本地 OCR 读文字（清晰度会影响效果）'
                }
              >
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null
                    setImgFile(f)
                    setImgDataUrl('')
                    if (!f) return
                    if (hasVision) {
                      void fileToDataUrl(f).then(setImgDataUrl).catch((er) => setErr(String(er)))
                    }
                  }}
                  className="block w-full text-[13px] file:mr-2 file:rounded-md file:border-0 file:bg-surface-2 file:px-3 file:py-1.5 file:text-[12px] file:text-text-1"
                />
              </Field>
              {imgDataUrl && (
                <img
                  src={imgDataUrl}
                  alt="模板预览"
                  className="max-h-52 rounded-lg border border-line-1 object-contain"
                />
              )}
            </div>
          )}
          {err && <p className="text-[13px] text-leave">{err}</p>}
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="模板名称">
            <Input value={tplName} onChange={(e) => setTplName(e.target.value)} />
          </Field>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium text-text-2">
                识别到 {fields.length} 个字段
              </span>
              <Button size="sm" variant="ghost" onClick={() => setFields([...fields, { name: '', hint: '', source: 'none' }])}>
                <Plus size={12} /> 加一个
              </Button>
            </div>
            {fields.map((f, i) => (
              <FieldRow
                key={i}
                field={f}
                onChange={(next) =>
                  setFields(fields.map((x, j) => (j === i ? next : x)))
                }
                onRemove={() => setFields(fields.filter((_, j) => j !== i))}
              />
            ))}
          </div>
          <p className="text-[11px] text-text-3">
            「关联资料」决定生成反馈时 AI 拿工作台里的哪类素材来写这一段，可按需调整。
          </p>
          {err && <p className="text-[13px] text-leave">{err}</p>}
        </div>
      )}
    </Modal>
  )
}

// ============================================================
// 结构化模板的字段编辑
// ============================================================

function TemplateFieldsModal({
  template,
  onClose,
}: {
  template: FeedbackTemplate
  onClose: () => void
}) {
  const [fields, setFields] = useState<FeedbackTemplateField[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      const rows = await db.feedbackTemplateFields
        .where('templateId')
        .equals(template.id)
        .toArray()
      const live = rows.filter((r) => !r.deletedAt).sort((a, b) => a.order - b.order)
      if (!alive) return
      setFields(live)
      setLoaded(true)
    })()
    return () => {
      alive = false
    }
  }, [template.id])

  async function handleSave() {
    const now = Date.now()
    const valid = fields.filter((f) => f.name.trim())
    // 本次提交之外的旧字段软删，保持与界面一致
    const existing = await db.feedbackTemplateFields
      .where('templateId')
      .equals(template.id)
      .toArray()
    const keepIds = new Set(valid.map((f) => f.id))
    for (const old of existing) {
      if (!old.deletedAt && !keepIds.has(old.id)) {
        await db.feedbackTemplateFields.put(touch({ ...old, deletedAt: now }))
      }
    }
    await db.feedbackTemplateFields.bulkPut(
      valid.map((f, i) => touch({ ...f, order: i })),
    )
    // 同步模板正文，让列表预览也能看到字段结构
    await db.feedbackTemplates.put(
      touch({ ...template, body: valid.map((f) => `【${f.name}】`).join('\n') }),
    )
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`字段设置 · ${template.name}`}
      size="xl"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={!loaded} onClick={() => void handleSave()}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {fields.length === 0 ? (
          <EmptyState
            icon={<FileText size={22} />}
            title="还没有字段"
            description="点下方按钮新增字段，每个字段可关联一类工作台资料"
          />
        ) : (
          fields.map((f, i) => (
            <FieldRow
              key={f.id}
              field={{ name: f.name, hint: f.hint, source: f.source }}
              onChange={(next) =>
                setFields(fields.map((x, j) => (j === i ? { ...x, ...next } : x)))
              }
              onRemove={() => setFields(fields.filter((_, j) => j !== i))}
            />
          ))
        )}
        <Button
          variant="ghost"
          onClick={() =>
            setFields([
              ...fields,
              withSyncFields<FeedbackTemplateField>({
                templateId: template.id,
                name: '',
                hint: '',
                source: 'none',
                order: fields.length,
                createdAt: Date.now(),
              }),
            ])
          }
        >
          <Plus size={13} /> 新增字段
        </Button>
      </div>
    </Modal>
  )
}

/** 单个字段的编辑行：名称 / 写作要求 / 关联资料 */
function FieldRow({
  field,
  onChange,
  onRemove,
}: {
  field: AnalyzedField
  onChange: (next: AnalyzedField) => void
  onRemove: () => void
}) {
  return (
    <div className="rounded-lg border border-line-1 bg-surface-0 p-2.5">
      <div className="flex items-center gap-2">
        <Input
          value={field.name}
          onChange={(e) => onChange({ ...field, name: e.target.value })}
          placeholder="字段名，如：本节课重点"
          className="flex-1"
        />
        <select
          value={field.source}
          onChange={(e) =>
            onChange({ ...field, source: e.target.value as FieldSourceKind })
          }
          className="h-8 shrink-0 rounded-md border border-line-1 bg-surface-0 px-2 text-[12px] text-text-1"
        >
          {(Object.keys(FIELD_SOURCE_LABEL) as FieldSourceKind[]).map((k) => (
            <option key={k} value={k}>
              {FIELD_SOURCE_LABEL[k]}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onRemove}
          aria-label="删除字段"
          className="shrink-0 rounded-md p-1.5 text-text-3 hover:bg-money-out/10 hover:text-money-out"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <Input
        value={field.hint}
        onChange={(e) => onChange({ ...field, hint: e.target.value })}
        placeholder="写作要求（给 AI 的指令，可留空）"
        className="mt-1.5"
      />
    </div>
  )
}
