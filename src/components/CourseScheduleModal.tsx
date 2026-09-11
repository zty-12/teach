import { useEffect, useMemo, useState } from 'react'
import {
  CalendarDays,
  CalendarPlus,
  Clock,
  FileText,
  Loader2,
  MapPin,
  Trash2,
  UserPlus,
  Users,
  Wallet,
  X,
} from 'lucide-react'
import { addDays, format } from 'date-fns'
import { db, markDeleted, touch, withSyncFields } from '@/lib/db'
import {
  BILLING_RULE_LABEL,
  COURSE_STATUS_LABEL,
  type Course,
  type CourseAttendance,
  type CourseStatus,
  type Group,
  type Student,
  type TeachMethod,
} from '@/lib/types'
import {
  cn,
  courseEnd,
  findConflicts,
  formatTime,
  slotFromString,
} from '@/lib/utils'
import {
  Badge,
  Button,
  IconButton,
  Input,
  Modal,
  SegmentedControl,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui'

// ============================================================
// 时间 / 日期工具
// ============================================================

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

function minutesToTime(total: number): string {
  const norm = ((total % 1440) + 1440) % 1440
  const h = Math.floor(norm / 60)
  const m = norm % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function addMinutesToTime(time: string, mins: number): string {
  if (!time) return ''
  return minutesToTime(parseTimeToMinutes(time) + mins)
}

function durationOf(start: string, end: string): number {
  if (!start || !end) return 0
  return Math.max(0, parseTimeToMinutes(end) - parseTimeToMinutes(start))
}

function dateKey(ts: number): string {
  return format(new Date(ts), 'yyyy-MM-dd')
}

function fromDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function toTimestamp(dateKeyStr: string, time: string): number {
  const d = fromDateKey(dateKeyStr)
  const mins = parseTimeToMinutes(time)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(mins / 60), mins % 60).getTime()
}

function durationText(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '时间设置有误'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h > 0 ? `${h} 小时 ` : ''}${m > 0 ? `${m} 分钟` : ''}`.trim()
}

const WEEKDAY_OPTIONS = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' },
]
const CAL_WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

function getMonthGridDays(monthDate: Date): Date[] {
  const first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1)
  const offset = (first.getDay() + 6) % 7
  const start = addDays(first, -offset)
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

// ============================================================
// 表单状态
// ============================================================

/**
 * 取班课的有效排课时长（分钟）：
 * 优先用班课配置的每周时间窗（endTimeMin - startTimeMin），
 * 其次才回退到 defaultDurationMin。避免"设了 13:00-15:00 却只排 1 小时"。
 */
function groupPlannedDuration(g?: Group | null): number | null {
  if (!g) return null
  if (
    typeof g.startTimeMin === 'number' &&
    g.startTimeMin >= 0 &&
    typeof g.endTimeMin === 'number' &&
    g.endTimeMin > g.startTimeMin
  ) {
    return g.endTimeMin - g.startTimeMin
  }
  return g.defaultDurationMin ?? null
}

interface ScheduleForm {
  kind: 'one_on_one' | 'group'
  studentId: string
  groupId: string
  subject: string
  date: string
  startTime: string
  durationMin: number
  method: TeachMethod
  location: string
  feeYuan: string
  note: string
  status: CourseStatus
  colorSlot: number
}

const emptyForm = (): ScheduleForm => ({
  kind: 'one_on_one',
  studentId: '',
  groupId: '',
  subject: '',
  date: dateKey(Date.now()),
  startTime: '10:00',
  durationMin: 60,
  method: 'offline',
  location: '',
  feeYuan: '',
  note: '',
  status: 'pending',
  colorSlot: 1,
})

interface CourseScheduleModalProps {
  open: boolean
  course: Course | null
  defaultStart: number | null
  existing: Course[]
  students: Student[]
  groups: Group[]
  onClose: () => void
  onComplete?: (c: Course) => Promise<void>
  /** 从学生卡片发起排课时预选该学生（新建模式） */
  prefillStudentId?: string | null
  /** 从班课/课程明细发起排课时预选该班课（新建模式） */
  prefillGroupId?: string | null
}

export function CourseScheduleModal({
  open,
  course,
  defaultStart,
  existing,
  students,
  groups,
  onClose,
  onComplete,
  prefillStudentId,
  prefillGroupId,
}: CourseScheduleModalProps) {
  const [form, setForm] = useState<ScheduleForm>(emptyForm)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const [createMode, setCreateMode] = useState<'single' | 'bulk'>('single')
  const [activeTab, setActiveTab] = useState<'basic' | 'notes'>('basic')
  const [bulkRule, setBulkRule] = useState<'weekly' | 'manual'>('weekly')
  const [bulkEndMode, setBulkEndMode] = useState<'count' | 'date'>('count')
  const [bulkRepeatCount, setBulkRepeatCount] = useState('4')
  const [bulkEndDate, setBulkEndDate] = useState('')
  const [bulkWeekdays, setBulkWeekdays] = useState<number[]>([])
  const [bulkSelectedDates, setBulkSelectedDates] = useState<string[]>([])
  const [bulkCalendarMonth, setBulkCalendarMonth] = useState(() => fromDateKey(dateKey(Date.now())))

  // 补课模式：常规排课 / 补课（学生缺勤班课后单独补的一对一课时）
  const [courseType, setCourseType] = useState<'regular' | 'makeup'>('regular')
  const [makeupSourceCourseId, setMakeupSourceCourseId] = useState('')

  // 读取时表单重置
  useEffect(() => {
    if (!open) return
    setError('')
    setSaving(false)
    if (course) {
      const d = new Date(course.startAt)
      // 编辑既有课程：若该课程来自班课，durationMin 用班课最新时长刷新，
      // 避免「班课时段调整 → 已有课仍按旧时长显示」的 off-by-N 小时。
      // 用户在表单里仍可手动覆盖。
      const g0 = course.groupId ? groups.find((x) => x.id === course.groupId) ?? null : null
      const planned = groupPlannedDuration(g0)
      setForm({
        kind: course.groupId ? 'group' : 'one_on_one',
        studentId: course.studentId ?? '',
        groupId: course.groupId ?? '',
        subject: course.subject,
        date: format(d, 'yyyy-MM-dd'),
        startTime: format(d, 'HH:mm'),
        durationMin: planned ?? course.durationMin,
        method: course.method,
        location: course.location,
        feeYuan: course.feeCents ? String(course.feeCents / 100) : '',
        note: course.note,
        status: course.status,
        colorSlot: course.colorSlot,
      })
      setCourseType(course.isMakeup ? 'makeup' : 'regular')
      setMakeupSourceCourseId(course.makeupSourceCourseId ?? '')
    } else {
      const base = defaultStart ? new Date(defaultStart) : new Date()
      setForm({
        ...emptyForm(),
        date: format(base, 'yyyy-MM-dd'),
        startTime: format(base, 'HH:mm'),
      })
      const wk = fromDateKey(format(base, 'yyyy-MM-dd')).getDay()
      setBulkWeekdays([wk])
      setBulkSelectedDates([format(base, 'yyyy-MM-dd')])
      setBulkCalendarMonth(new Date(base.getFullYear(), base.getMonth(), 1))
      setCreateMode('single')
      setBulkRule('weekly')
      setCourseType('regular')
      setMakeupSourceCourseId('')
      // 从学生卡片发起排课：预选该学生并带入其科目/配色
      if (prefillStudentId) {
        const s = students.find((x) => x.id === prefillStudentId)
        if (s) {
          setForm((f) => ({
            ...f,
            kind: 'one_on_one',
            studentId: s.id,
            colorSlot: s.colorSlot || f.colorSlot,
          }))
        }
      }
      // 从班课/课程明细发起排课：预选该班课并带入其科目/配色/默认时长
      if (prefillGroupId) {
        const g = groups.find((x) => x.id === prefillGroupId)
        if (g) {
          setForm((f) => ({
            ...f,
            kind: 'group',
            groupId: g.id,
            subject: g.subject,
            colorSlot: g.colorSlot || f.colorSlot,
            durationMin: groupPlannedDuration(g) || f.durationMin,
          }))
        }
      }
    }
  }, [open, course, defaultStart, prefillStudentId, prefillGroupId, students, groups])

  const patch = (p: Partial<ScheduleForm>) => setForm((f) => ({ ...f, ...p }))

  const groupMap = useMemo(
    () => new Map(groups.filter((g) => !g.deletedAt).map((g) => [g.id, g])),
    [groups],
  )

  // 派生：结束时间 = 开始 + 时长
  const endTime = useMemo(() => addMinutesToTime(form.startTime, form.durationMin), [form.startTime, form.durationMin])

  const startTimestamp = useMemo(() => {
    if (!form.date || !form.startTime) return NaN
    return toTimestamp(form.date, form.startTime)
  }, [form.date, form.startTime])

  const conflicts = useMemo(() => {
    if (Number.isNaN(startTimestamp)) return []
    return findConflicts(
      { startAt: startTimestamp, durationMin: form.durationMin, id: course?.id },
      existing,
      groupMap,
    )
  }, [startTimestamp, form.durationMin, course?.id, existing, groupMap])

  // 排课对象标签（预览用）
  const targetLabel = useMemo(() => {
    if (form.kind === 'group') return groups.find((g) => g.id === form.groupId)?.name ?? '请选择排课对象'
    return students.find((s) => s.id === form.studentId)?.name ?? '请选择排课对象'
  }, [form.kind, form.groupId, form.studentId, groups, students])

  const targetKindLabel = form.kind === 'group' ? '班级' : '个人学生'

  const billingLabel = useMemo(() => {
    if (form.kind === 'group') {
      const g = groups.find((x) => x.id === form.groupId)
      return g ? `班课 · ¥${Math.round((g.perStudentFeeCents || 0) / 100)}/人` : '请选择排课对象'
    }
    const s = students.find((x) => x.id === form.studentId)
    if (!s) return '请选择排课对象'
    if (s.isTrial) return '试听学生'
    return BILLING_RULE_LABEL[s.billingRule]
  }, [form.kind, form.groupId, form.studentId, groups, students])

  // 补课可选的「原课」（带班课的已排课程，通常是请假/已完成的班课）
  const makeupSourceOptions = useMemo(() => {
    if (courseType !== 'makeup') return []
    return existing
      .filter((c) => c.groupId && !c.deletedAt)
      .map((c) => ({
        id: c.id,
        label: `${groupMap.get(c.groupId ?? '')?.name ?? '班课'} · ${format(new Date(c.startAt), 'M月d日')} ${formatTime(c.startAt)} ${c.subject}`,
        subject: c.subject,
        colorSlot: c.colorSlot,
        durationMin: c.durationMin,
        method: c.method,
        note: c.note,
        group: c.groupId ? groupMap.get(c.groupId) : undefined,
      }))
      .sort((a, b) => b.id.localeCompare(a.id))
  }, [courseType, existing, groupMap])

  // 排课类型切换：一对一 / 班课（清空另一个对象 ID）
  function handleKindChange(kind: 'one_on_one' | 'group') {
    patch({ kind, studentId: '', groupId: '', subject: '' })
    setError('')
  }

  // 课程类型切换：常规 / 补课
  function handleCourseTypeChange(type: 'regular' | 'makeup') {
    setCourseType(type)
    setError('')
    if (type === 'makeup') {
      patch({ kind: 'one_on_one', groupId: '' })
    } else {
      setMakeupSourceCourseId('')
    }
  }

  // 选择补的原课：自动带入科目、一半时长、人均课酬（计 1 课时）
  function handleMakeupSourceChange(id: string) {
    setMakeupSourceCourseId(id)
    const c = makeupSourceOptions.find((o) => o.id === id)
    if (!c) return
    patch({
      subject: c.subject,
      colorSlot: c.colorSlot,
      durationMin: Math.max(15, Math.ceil(c.durationMin / 2)),
      method: c.method,
      feeYuan:
        c.group && c.group.perStudentFeeCents > 0
          ? String(c.group.perStudentFeeCents / 100)
          : '',
      note: c.note ? `补课（原：${c.note}）` : '补课',
    })
  }

  // 批量日期
  const bulkDates = useMemo(() => {
    if (course || createMode !== 'bulk') return []
    if (bulkRule === 'manual') return [...bulkSelectedDates].sort()
    if (!form.date || bulkWeekdays.length === 0) return []
    const set = new Set(bulkWeekdays)
    const start = fromDateKey(form.date)
    const result: string[] = []
    if (bulkEndMode === 'date') {
      if (!bulkEndDate) return []
      const end = fromDateKey(bulkEndDate)
      if (end < start) return []
      for (let c = start; c <= end && result.length < 120; c = addDays(c, 1)) {
        if (set.has(c.getDay())) result.push(dateKey(c.getTime()))
      }
    } else {
      const count = Math.max(0, Math.min(120, Math.floor(Number(bulkRepeatCount) || 0)))
      for (let c = start; result.length < count; c = addDays(c, 1)) {
        if (set.has(c.getDay())) result.push(dateKey(c.getTime()))
      }
    }
    return result
  }, [bulkEndDate, bulkEndMode, bulkRepeatCount, bulkRule, bulkSelectedDates, bulkWeekdays, createMode, form.date, course])

  const isValid = useMemo(() => {
    if (Number.isNaN(startTimestamp)) return false
    if (form.kind === 'group' && !form.groupId) return false
    if (form.kind === 'one_on_one' && !form.studentId) return false
    const subject = form.subject.trim() || (form.kind === 'group' ? groups.find((g) => g.id === form.groupId)?.subject : '') || ''
    if (!subject) return false
    if (!form.date || !form.startTime) return false
    if (form.durationMin <= 0) return false
    return true
  }, [startTimestamp, form.kind, form.groupId, form.studentId, form.subject, form.date, form.startTime, form.durationMin, groups])

  const isBulkValid = isValid && (createMode === 'single' || bulkDates.length > 0)

  // 目标切换高级联动（选对象时带入默认科目/时长）
  const handleTargetChange = (value: string) => {
    if (form.kind === 'group') {
      const g = groups.find((x) => x.id === value)
      patch({
        groupId: value,
        subject: g?.subject || '',
        colorSlot: g?.colorSlot || form.colorSlot,
        durationMin: groupPlannedDuration(g) || form.durationMin,
      })
    } else {
      const s = students.find((x) => x.id === value)
      patch({ studentId: value, colorSlot: s?.colorSlot || form.colorSlot })
    }
  }

  const handleStartChange = (time: string) => {
    patch({ startTime: time })
  }

  const handleEndChange = (time: string) => {
    const dur = durationOf(form.startTime, time)
    patch({ durationMin: dur > 0 ? dur : form.durationMin })
  }

  const buildPayload = (dateStr: string, fs: ScheduleForm) => {
    const group = fs.kind === 'group' ? groups.find((g) => g.id === fs.groupId) : null
    const subject = fs.subject.trim() || group?.subject || ''
    return {
      studentId: fs.kind === 'group' ? null : fs.studentId,
      groupId: fs.kind === 'group' ? fs.groupId : null,
      subject,
      startAt: toTimestamp(dateStr, fs.startTime),
      durationMin: fs.durationMin,
      method: fs.method,
      location: fs.location.trim(),
      note: fs.note.trim(),
      status: fs.status,
      colorSlot: group ? group.colorSlot : fs.colorSlot || slotFromString(subject),
      feeCents: fs.feeYuan ? Math.round(Number(fs.feeYuan) * 100) : 0,
      isMakeup: courseType === 'makeup' || undefined,
      makeupSourceCourseId: courseType === 'makeup' ? makeupSourceCourseId || null : null,
    }
  }

  async function ensureAttendance(saved: Course) {
    const members = (await db.groupMembers.toArray()).filter((m) => !m.deletedAt && m.groupId === saved.groupId)
    const ids = saved.groupId ? members.map((m) => m.studentId) : saved.studentId ? [saved.studentId] : []
    for (const sid of ids) {
      if (!sid) continue
      const exists = (await db.courseAttendances.toArray()).some(
        (a) => !a.deletedAt && a.courseId === saved.id && a.studentId === sid,
      )
      if (!exists) {
        await db.courseAttendances.put(
          withSyncFields<CourseAttendance>({
            courseId: saved.id,
            studentId: sid,
            present: true,
            attendAt: null,
            createdAt: Date.now(),
          }),
        )
      }
    }
  }

  async function handleSave() {
    if (!isBulkValid) {
      setError('请填写完整信息，并确保起止时间有效；批量排课需至少生成一个日期')
      return
    }

    setSaving(true)
    try {
      if (course) {
        const saved = { ...course, ...buildPayload(form.date, form) }
        await db.courses.put(touch(saved))
        onClose()
        return
      }

      if (createMode === 'single') {
        const saved = withSyncFields<Course>({ ...buildPayload(form.date, form), createdAt: Date.now() })
        await db.courses.put(saved)
        await ensureAttendance(saved)
        onClose()
        return
      }

      // 批量创建
      const all = (await db.courses.toArray()).filter((c) => !c.deletedAt)
      let created = 0
      let skipped = 0
      for (const d of bulkDates) {
        const payload = buildPayload(d, form)
        const clash = findConflicts({ startAt: payload.startAt, durationMin: payload.durationMin }, all, groupMap)
        if (clash.length > 0) {
          skipped += 1
          continue
        }
        const saved = withSyncFields<Course>({ ...payload, createdAt: Date.now() })
        await db.courses.put(saved)
        all.push(saved)
        await ensureAttendance(saved)
        created += 1
      }
      onClose()
      window.alert(`已创建 ${created} 节课` + (skipped > 0 ? `，跳过冲突 ${skipped} 节` : ''))
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!course) return
    if (!window.confirm('确定删除这节课吗？')) return
    await db.courses.put(markDeleted(course))
    onClose()
  }

  async function handleMarkDone() {
    if (!course || !onComplete) return
    await handleSave()
    await onComplete(course)
  }

  const sectionTitle = 'mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-3'
  const fieldHint = 'mt-1.5 text-[11px] font-medium text-text-3'
  const panel = 'rounded-xl border border-line-1 bg-surface-0 p-4'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={course ? '编辑课程' : '安排新行程'}
      size="xl"
      header={
        <div className="flex items-start justify-between gap-4 border-b border-line-1 px-5 py-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-white">
              <CalendarPlus size={20} />
            </div>
            <div className="min-w-0">
              <h2 className="text-[18px] font-semibold leading-none text-text-1">
                {course ? '编辑课程' : '安排新行程'}
              </h2>
              <p className="mt-1 text-[13px] leading-6 text-text-2">
                统一排课对象、时间、授课方式与结算，保持当前业务流程不变。
              </p>
            </div>
          </div>
          <IconButton label="关闭" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
      }
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {course && (
              <Button variant="danger" size="md" onClick={() => void handleDelete()} disabled={saving}>
                <Trash2 size={16} />
                删除
              </Button>
            )}
            {course && course.status !== 'done' && onComplete && (
              <Button variant="secondary" size="md" onClick={() => void handleMarkDone()} disabled={saving}>
                标记完成
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="md" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button variant="primary" size="md" onClick={() => void handleSave()} disabled={saving || !isBulkValid}>
              {saving ? <Loader2 size={16} className="animate-spin" /> : null}
              {course ? '更新课程' : createMode === 'bulk' ? `确认创建 ${bulkDates.length} 节课` : '确认排课安排'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        {error && (
          <div className="rounded-lg bg-leave-soft px-3 py-2 text-[13px] text-leave">{error}</div>
        )}

        <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-2">
          {/* 左栏：表单 */}
          <div className="space-y-5">
            {course ? (
              <div>
                <div className={sectionTitle}>课程状态</div>
                <SegmentedControl
                  value={form.status}
                  onChange={(v) => patch({ status: v as CourseStatus })}
                  variant="strong"
                  layout="grid"
                  size="sm"
                  options={(Object.keys(COURSE_STATUS_LABEL) as CourseStatus[]).map((k) => ({
                    value: k,
                    label: COURSE_STATUS_LABEL[k],
                  }))}
                />
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <div className={sectionTitle}>排课模式</div>
                  <SegmentedControl
                    value={createMode}
                    onChange={(v) => setCreateMode(v as 'single' | 'bulk')}
                    variant="strong"
                    layout="grid"
                    size="sm"
                    options={[
                      { value: 'single', label: '单次排课' },
                      { value: 'bulk', label: '批量排课' },
                    ]}
                  />
                </div>
                <div>
                  <div className={sectionTitle}>课程类型</div>
                  <SegmentedControl
                    value={courseType}
                    onChange={(v) => handleCourseTypeChange(v as 'regular' | 'makeup')}
                    variant="strong"
                    layout="grid"
                    size="sm"
                    options={[
                      { value: 'regular', label: '常规排课' },
                      { value: 'makeup', label: '补课' },
                    ]}
                  />
                </div>
              </div>
            )}

            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'basic' | 'notes')}>
              <TabsList className="mb-4 grid grid-cols-2">
                <TabsTrigger value="basic">基本与结算设置</TabsTrigger>
                <TabsTrigger value="notes">备注说明</TabsTrigger>
              </TabsList>

              <TabsContent value="basic" className="mt-0 space-y-5">
                <section>
                  <div className={sectionTitle}>基本信息</div>
                  <div className={panel}>
                    {!course && courseType !== 'makeup' && (
                      <div className="mb-4">
                        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-text-1">
                          <Users size={16} className="text-text-3" /> 排课类型
                        </div>
                        <SegmentedControl
                          value={form.kind}
                          onChange={(v) => handleKindChange(v as 'one_on_one' | 'group')}
                          variant="toggle"
                          layout="grid"
                          size="sm"
                          disabled={saving}
                          options={[
                            { value: 'one_on_one', label: '一对一' },
                            { value: 'group', label: '班课' },
                          ]}
                        />
                      </div>
                    )}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div>
                        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-text-1">
                          <UserPlus size={16} className="text-text-3" /> 排课对象
                        </div>
                        <Select value={form.kind === 'group' ? form.groupId : form.studentId} onChange={(e) => handleTargetChange(e.target.value)} disabled={saving}>
                          <option value="">
                            {form.kind === 'group' ? '选择班级…' : '选择学生…'}
                          </option>
                          {form.kind === 'group'
                            ? groups.map((g) => (
                                <option key={g.id} value={g.id}>{g.name}</option>
                              ))
                            : students.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name}
                                  {s.grade ? ` · ${s.grade}` : ''}
                                  {s.isTrial ? ' · 试听' : ''}
                                </option>
                              ))}
                        </Select>
                        <div className={fieldHint}>请选择 {form.kind === 'group' ? '班级' : '学生'} 作为本次排课对象</div>
                      </div>
                      <div>
                        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-text-1">
                          <FileText size={16} className="text-text-3" /> 课程科目
                        </div>
                        <Input
                          value={form.subject}
                          onChange={(e) => {
                            patch({
                              subject: e.target.value,
                              colorSlot: slotFromString(e.target.value.trim() || 'x'),
                            })
                            setError('')
                          }}
                          placeholder="数学 / 英语 / 物理"
                          disabled={saving}
                        />
                        <div className={fieldHint}>课程项目会限定本次可用科目</div>
                      </div>
                    </div>

                    {/* 补课：选择原课，自动带出科目 / 一半时长 / 人均课酬（计 1 课时） */}
                    {!course && courseType === 'makeup' && (
                      <div className="mt-4">
                        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-text-1">
                          <CalendarDays size={16} className="text-text-3" /> 补的原课（可选）
                        </div>
                        <Select value={makeupSourceCourseId} onChange={(e) => handleMakeupSourceChange(e.target.value)} disabled={saving}>
                          <option value="">（不关联原课，仅按一对一补课）</option>
                          {makeupSourceOptions.map((o) => (
                            <option key={o.id} value={o.id}>{o.label}</option>
                          ))}
                        </Select>
                        <div className={fieldHint}>
                          {courseType === 'makeup'
                            ? '补课为单个学生一对一：默认按原班课一半时长，计 1 课时课酬'
                            : '选择后自动带入原班课信息'}
                        </div>
                      </div>
                    )}
                  </div>
                </section>

                <section>
                  <div className={sectionTitle}>{!course && createMode === 'bulk' ? '批量与结算' : '上课与结算'}</div>
                  <div className={cn(panel, 'space-y-4')}>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div>
                        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-text-1">
                          <CalendarDays size={16} className="text-text-3" />
                          {!course && createMode === 'bulk' ? '开始日期' : '上课日期'}
                        </div>
                        <Input
                          type="date"
                          value={form.date}
                          onChange={(e) => patch({ date: e.target.value })}
                          disabled={saving}
                        />
                        <div className={fieldHint}>
                          {!course && createMode === 'bulk' ? '作为批量规则的起始日期，系统会从这一天开始生成课次' : '选择课程发生的具体日期'}
                        </div>
                      </div>
                      <div>
                        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-text-1">
                          <MapPin size={16} className="text-text-3" /> 授课方式
                        </div>
                        <Select value={form.method} onChange={(e) => patch({ method: e.target.value as TeachMethod })} disabled={saving}>
                          <option value="offline">线下授课</option>
                          <option value="online">线上授课</option>
                        </Select>
                        <div className={fieldHint}>仅支持两种统一形式：线上授课、线下授课</div>
                      </div>
                    </div>

                    <div>
                      <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-text-1">
                        <Clock size={16} className="text-text-3" /> 起止时间
                      </div>
                      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:gap-3">
                        <Input type="time" value={form.startTime} onChange={(e) => handleStartChange(e.target.value)} disabled={saving} />
                        <span className="text-text-3">→</span>
                        <Input type="time" value={endTime} onChange={(e) => handleEndChange(e.target.value)} disabled={saving} />
                      </div>
                      <div className="mt-2">
                        <Badge variant="primary">{durationText(form.durationMin)}</Badge>
                      </div>
                      <div className={fieldHint}>请填写准确的开始与结束时间，系统会自动计算时长</div>
                    </div>

                    <div>
                      <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-text-1">
                        <Wallet size={16} className="text-text-3" /> 课酬 / 结算
                      </div>
                      <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-3">
                        <Input
                          type="number"
                          min={0}
                          step={10}
                          inputMode="decimal"
                          value={form.feeYuan}
                          onChange={(e) => patch({ feeYuan: e.target.value })}
                          placeholder="自动"
                          disabled={saving || form.kind === 'group'}
                        />
                        <div className="flex min-h-10 min-w-0 items-center rounded-lg border border-line-1 bg-surface-2 px-3 text-[11px] font-medium leading-5 text-text-2 sm:shrink-0">
                          {billingLabel}
                        </div>
                      </div>
                      <div className={fieldHint}>
                        {courseType === 'makeup'
                          ? '补课按 1 课时计：后付在完成时计 1 课时待收，预付在完成时扣 1 课时'
                          : form.kind === 'group'
                            ? '班课课酬 = 每人单价 × 实际出席人数，完成时自动计算'
                            : '后付按本节课酬计待收；预付在完成时按实际出席扣课时'}
                      </div>
                    </div>
                  </div>
                </section>
              </TabsContent>

              <TabsContent value="notes" className="mt-0 space-y-5">
                <section>
                  <div className={sectionTitle}>备注说明</div>
                  <div className={panel}>
                    <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-text-1">
                      <FileText size={16} className="text-text-3" /> 备注说明
                    </div>
                    <textarea
                      value={form.note}
                      onChange={(e) => patch({ note: e.target.value })}
                      placeholder="添加试听记录、备课重点或学生表现..."
                      rows={4}
                      disabled={saving}
                      className="min-h-28 w-full resize-none rounded-lg border border-line-1 bg-surface-0 px-3 py-2 text-sm text-text-1 placeholder:text-text-3 focus:border-accent focus:outline-none"
                    />
                    <div className={fieldHint}>这里可以填写课堂目标、作业安排、课堂反馈或需要提醒家长的内容</div>
                  </div>
                </section>
              </TabsContent>
            </Tabs>
          </div>

          {/* 右栏：效果预览 / 批量规则 */}
          <div className="space-y-5 md:sticky md:top-0">
            {createMode === 'single' ? (
              <section className="space-y-4">
                <div className={sectionTitle}>排课效果预览</div>
                <div className="relative overflow-hidden rounded-xl border border-line-1 bg-gradient-to-br from-surface-0 to-surface-2 p-5">
                  <div className="absolute right-3 top-3">
                    <Badge variant="primary" className="text-[10px]">实时预览</Badge>
                  </div>
                  <div className="flex items-center gap-4 border-b border-line-1 pb-4">
                    <div className="relative flex h-20 w-16 shrink-0 flex-col overflow-hidden rounded-xl border border-line-1 bg-surface-0 text-center shadow-sm">
                      <div className="bg-accent py-1 text-[11px] font-bold leading-none text-white">
                        {form.date ? `${fromDateKey(form.date).getMonth() + 1}月` : 'MM'}
                      </div>
                      <div className="flex flex-1 items-center justify-center pt-0.5 text-[26px] font-extrabold leading-none text-text-1">
                        {form.date ? fromDateKey(form.date).getDate() : '--'}
                      </div>
                      <div className="border-t border-line-1 bg-surface-2 py-0.5 text-[9px] font-semibold leading-none text-text-2">
                        {form.date ? WEEKDAY_OPTIONS.find((w) => w.value === fromDateKey(form.date).getDay())?.label : '周--'}
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {form.subject && (
                          <Badge variant="primary" className="text-[10px] font-bold">{form.subject}</Badge>
                        )}
                        {courseType === 'makeup' && (
                          <Badge variant="warning" className="text-[10px] font-bold">补课</Badge>
                        )}
                        <Badge variant="neutral" className="text-[10px]">{targetKindLabel}</Badge>
                      </div>
                      <h3 className="mt-1.5 truncate text-[16px] font-bold text-text-1">{targetLabel}</h3>
                      <p className="mt-0.5 truncate text-[12px] text-text-2">{billingLabel}</p>
                    </div>
                  </div>
                  <div className="space-y-3 pt-4">
                    <div className="flex items-center gap-3 text-[13px] text-text-2">
                      <Clock size={16} className="shrink-0 text-text-3" />
                      <div>
                        <span className="font-semibold text-text-1">{form.startTime} - {endTime}</span>
                        <span className="ml-2 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-text-3">{durationText(form.durationMin)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-[13px] text-text-2">
                      <MapPin size={16} className="shrink-0 text-text-3" />
                      <span className="font-semibold text-text-1">{form.method === 'online' ? '线上授课' : '线下授课'}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[13px] text-text-2">
                      <Wallet size={16} className="shrink-0 text-text-3" />
                      <div>
                        <span className="text-text-2">课酬：</span>
                        <span className="font-bold text-accent">{form.feeYuan ? `¥${form.feeYuan}` : '自动'}</span>
                      </div>
                    </div>
                  </div>
                  {form.note && (
                    <div className="mt-3.5 border-t border-line-1 pt-3">
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-3">备注摘要</div>
                      <p className="text-[12px] italic leading-relaxed text-text-2 line-clamp-2">“ {form.note} ”</p>
                    </div>
                  )}
                </div>

                {conflicts.length > 0 && (
                  <div className="rounded-lg bg-leave-soft px-3 py-2.5 text-[13px] text-leave">
                    <p className="font-medium">时间冲突：该时段已有 {conflicts.length} 节课</p>
                    <ul className="mt-1 space-y-0.5">
                      {conflicts.slice(0, 3).map((c) => (
                        <li key={c.id} className="truncate">
                          {formatTime(c.startAt)}–{formatTime(courseEnd(c, groupMap))} {c.subject}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1 opacity-80">仍可保存，但请注意调整。</p>
                  </div>
                )}
              </section>
            ) : (
              <section className="space-y-4">
                <div className={sectionTitle}>批量规则</div>
                <div className={cn(panel, 'space-y-4')}>
                  <SegmentedControl
                    value={bulkRule}
                    onChange={(v) => setBulkRule(v as 'weekly' | 'manual')}
                    variant="toggle"
                    layout="grid"
                    size="sm"
                    options={[
                      { value: 'weekly', label: '按周复刻' },
                      { value: 'manual', label: '选择多日' },
                    ]}
                  />

                  {bulkRule === 'weekly' ? (
                    <>
                      <div>
                        <div className="mb-2 text-[13px] font-semibold text-text-1">重复星期</div>
                        <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
                          {WEEKDAY_OPTIONS.map((w) => {
                            const active = bulkWeekdays.includes(w.value)
                            return (
                              <button
                                key={w.value}
                                type="button"
                                onClick={() =>
                                  setBulkWeekdays((cur) =>
                                    cur.includes(w.value) ? cur.filter((v) => v !== w.value) : [...cur, w.value],
                                  )
                                }
                                className={cn(
                                  'h-9 rounded-xl border text-[12px] font-semibold transition-colors',
                                  active
                                    ? 'border-accent bg-accent text-white'
                                    : 'border-line-1 bg-surface-0 text-text-2 hover:border-surface-3',
                                )}
                              >
                                {w.label}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                      <div className="grid min-w-0 gap-3 sm:grid-cols-[150px_minmax(0,1fr)]">
                        <Select value={bulkEndMode} onChange={(e) => setBulkEndMode(e.target.value as 'count' | 'date')}>
                          <option value="count">按次数结束</option>
                          <option value="date">按结束日期</option>
                        </Select>
                        {bulkEndMode === 'count' ? (
                          <Input
                            type="number"
                            min={1}
                            max={120}
                            value={bulkRepeatCount}
                            onChange={(e) => setBulkRepeatCount(e.target.value)}
                            placeholder="重复次数"
                          />
                        ) : (
                          <Input type="date" value={bulkEndDate} onChange={(e) => setBulkEndDate(e.target.value)} />
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="space-y-3">
                      <div className="rounded-xl border border-line-1 bg-surface-2 p-2.5 sm:p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <Button size="sm" variant="ghost" onClick={() => setBulkCalendarMonth((cur) => new Date(cur.getFullYear(), cur.getMonth() - 1, 1))}>
                            ‹
                          </Button>
                          <div className="text-[13px] font-semibold text-text-1">
                            {bulkCalendarMonth.getFullYear()}年{bulkCalendarMonth.getMonth() + 1}月
                          </div>
                          <Button size="sm" variant="ghost" onClick={() => setBulkCalendarMonth((cur) => new Date(cur.getFullYear(), cur.getMonth() + 1, 1))}>
                            ›
                          </Button>
                        </div>
                        <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold text-text-3">
                          {CAL_WEEKDAY_LABELS.map((l) => (
                            <div key={l} className="py-1">{l}</div>
                          ))}
                        </div>
                        <div className="mt-1 grid grid-cols-7 gap-1">
                          {getMonthGridDays(bulkCalendarMonth).map((d) => {
                            const key = dateKey(d.getTime())
                            const selected = bulkSelectedDates.includes(key)
                            const inMonth = d.getMonth() === bulkCalendarMonth.getMonth()
                            return (
                              <button
                                key={key}
                                type="button"
                                onClick={() =>
                                  setBulkSelectedDates((cur) =>
                                    cur.includes(key) ? cur.filter((v) => v !== key) : [...cur, key].sort(),
                                  )
                                }
                                className={cn(
                                  'flex h-8 items-center justify-center rounded-lg border text-[12px] font-semibold transition-colors',
                                  selected
                                    ? 'border-accent bg-accent text-white'
                                    : inMonth
                                      ? 'border-transparent bg-transparent text-text-1 hover:bg-surface-2'
                                      : 'border-transparent bg-transparent text-text-3 opacity-40',
                                )}
                              >
                                {d.getDate()}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {bulkSelectedDates.map((d) => (
                          <button
                            key={d}
                            type="button"
                            onClick={() => setBulkSelectedDates((cur) => cur.filter((v) => v !== d))}
                            className="max-w-full rounded-full border border-line-1 bg-surface-0 px-2.5 py-1 text-[11px] font-semibold text-text-2 hover:border-surface-3 hover:text-text-1"
                          >
                            <span className="inline-block max-w-full truncate align-bottom">{d} ×</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="rounded-xl border border-line-1 bg-surface-2 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[13px] font-semibold text-text-1">预览 {bulkDates.length} 节课</div>
                        <div className="mt-1 text-[11px] text-text-2">提交时会自动跳过同一对象的冲突时段。</div>
                      </div>
                      <Badge variant={bulkDates.length > 0 ? 'success' : 'neutral'} className="shrink-0">
                        {bulkDates.length > 0 ? '可创建' : '待选择日期'}
                      </Badge>
                    </div>
                    {bulkDates.length > 0 && (
                      <div className="mt-3 max-h-40 space-y-1.5 overflow-y-auto pr-1">
                        {bulkDates.map((d) => (
                          <div
                            key={d}
                            className="grid min-w-0 gap-1 rounded-lg bg-surface-0 px-3 py-2 text-[12px] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                          >
                            <span className="min-w-0 truncate font-semibold text-text-1">{d}</span>
                            <span className="min-w-0 truncate text-text-2">{form.startTime}-{endTime}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}
