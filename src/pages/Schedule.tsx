import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { addDays, format, startOfDay } from 'date-fns'
import {
  CalendarPlus,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Inbox,
  Trash2,
  Users,
} from 'lucide-react'
import { db } from '@/lib/db'
import { hardDeleteCourses } from '@/lib/batchDelete'
import { AttendanceModal } from '@/components/AttendanceModal'
import { CourseScheduleModal } from '@/components/CourseScheduleModal'
import { CourseScheduleSheet } from '@/components/CourseScheduleSheet'
import { GroupDetailSheet } from '@/components/GroupDetailSheet'
import { StudentDetailSheet } from '@/components/student-detail/StudentDetailSheet'
import { useBreakpoint } from '@/hooks/useBreakpoint'
import { useSettings } from '@/store/useSettings'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  SegmentedControl,
  StatusBadge,
} from '@/components/ui'
import {
  type Course,
  type Group,
  type Student,
} from '@/lib/types'
import {
  cn,
  courseDurationMin,
  courseEnd,
  formatTime,
  getWeekDays,
  subjectBorderVar,
  subjectColorVar,
  subjectTintVar,
} from '@/lib/utils'
import { exportSchedule } from '@/lib/exporters'
import { revertCompletion } from '@/lib/courseCompletion'
import {
  completeCourseWithAttendance,
  computePlannedGroupSlots,
  courseTitle,
  materializeGroupSlot,
  persistAttendance,
  type PlannedGroupSlot,
} from './schedule-helpers'

/** 一小时对应的像素高度 */
const HOUR_H = 56

// ============================================================
// 单击 / 双击 消歧
// ============================================================
// 课程块「单击=查看全部排课（Sheet）」「双击=快速完成」是经典冲突：
// 双击会先触发两次单击（Sheet 被打开），再触发 dblclick（出席弹窗叠在上面）。
// 解法：单击延迟 CLICK_DELAY 才执行；期间若收到双击则取消该定时器。
// 用模块级 Map 按课程 id 存定时器（不能放 .map() 里用 useRef —— 会违反 hooks 规则）。
const CLICK_DELAY = 240
const clickTimers = new Map<string, number>()

/** 延迟触发单击动作；同一 id 的重复单击只保留最后一个 */
function scheduleSingleClick(id: string, run: () => void): void {
  const t = clickTimers.get(id)
  if (t) window.clearTimeout(t)
  clickTimers.set(
    id,
    window.setTimeout(() => {
      clickTimers.delete(id)
      run()
    }, CLICK_DELAY),
  )
}

/** 双击时取消尚未执行的单击，返回是否取消了 */
function cancelSingleClick(id: string): boolean {
  const t = clickTimers.get(id)
  if (!t) return false
  window.clearTimeout(t)
  clickTimers.delete(id)
  return true
}

type MethodFilter = 'all' | 'online' | 'offline'
type ScheduleView = 'day' | 'week' | 'agenda'

export default function SchedulePage() {
  const bp = useBreakpoint()
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()).getTime())
  const [editing, setEditing] = useState<Course | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [defaultStart, setDefaultStart] = useState<number | null>(null)
  const [attendanceFor, setAttendanceFor] = useState<Course | null>(null)

  // 单个课程「一键查看」侧拉 Sheet
  const [courseViewFor, setCourseViewFor] = useState<Course | null>(null)

  // 班课详情 Sheet
  const [groupDetailFor, setGroupDetailFor] = useState<string | null>(null)

  // 学生详情 Sheet（由 GroupDetailSheet 内部跳转时弹出）
  const [studentDetailFor, setStudentDetailFor] = useState<string | null>(null)

  // 新建课程时的预填对象（学生 / 班课）
  const [createPrefill, setCreatePrefill] = useState<{
    studentId: string | null
    groupId: string | null
  }>({ studentId: null, groupId: null })

  // 多选批量删除
  const [selectMode, setSelectMode] = useState(false)
  const [selectedCourseIds, setSelectedCourseIds] = useState<Set<string>>(new Set())

  // 授课方式筛选 + 视图切换
  const [methodFilter, setMethodFilter] = useState<MethodFilter>('all')
  const [view, setView] = useState<ScheduleView>('week')

  const courses = useLiveQuery(() => db.courses.toArray(), [])
  const students = useLiveQuery(() => db.students.toArray(), [])
  const groups = useLiveQuery(() => db.groups.toArray(), [])
  const members = useLiveQuery(() => db.groupMembers.toArray(), [])
  const attendances = useLiveQuery(() => db.courseAttendances.toArray(), [])

  const liveCourses = useMemo(
    () => (courses ?? []).filter((c) => !c.deletedAt),
    [courses],
  )
  const studentMap = useMemo(
    () => new Map((students ?? []).filter((s) => !s.deletedAt).map((s) => [s.id, s])),
    [students],
  )
  const groupMap = useMemo(
    () => new Map((groups ?? []).filter((g) => !g.deletedAt).map((g) => [g.id, g])),
    [groups],
  )
  const liveMembers = useMemo(
    () => (members ?? []).filter((m) => !m.deletedAt),
    [members],
  )
  const liveAttendances = useMemo(
    () => (attendances ?? []).filter((a) => !a.deletedAt),
    [attendances],
  )

  // 授课方式筛选
  const filteredCourses = useMemo(
    () =>
      methodFilter === 'all'
        ? liveCourses
        : liveCourses.filter((c) => c.method === methodFilter),
    [liveCourses, methodFilter],
  )

  // 本周总排课数（受筛选影响）
  const weekDays = useMemo(() => getWeekDays(anchor), [anchor])
  const weekCount = useMemo(
    () =>
      filteredCourses.filter((c) => weekDays.some((d) => startOfDay(c.startAt).getTime() === d))
        .length,
    [filteredCourses, weekDays],
  )

  function openCreate(
    startAt?: number,
    prefill?: { studentId: string | null; groupId: string | null },
  ) {
    setEditing(null)
    setDefaultStart(startAt ?? null)
    setCreatePrefill(prefill ?? { studentId: null, groupId: null })
    setModalOpen(true)
  }

  function openEdit(course: Course) {
    setEditing(course)
    setDefaultStart(null)
    setCreatePrefill({ studentId: null, groupId: null })
    setModalOpen(true)
  }

  /** 打开单个课程「一键查看」侧拉 Sheet */
  function openCourseView(course: Course) {
    setCourseViewFor(course)
  }

  /** 快速标记完成：完成前先弹出「出席选择」，确认后再按实际出席结算 */
  function toggleDone(course: Course) {
    if (course.status === 'done') {
      // 撤销完成：归还课时 + 撤销结算（不能只改状态）
      void revertCompletion(course.id)
    } else {
      // 完成：先选出席 + 预览课酬，再结算
      setAttendanceFor(course)
    }
  }

  async function completeCourse(course: Course) {
    // 完成：按用户已在弹窗中确认的出席记录重新读取并结算（幂等）
    await completeCourseWithAttendance(course, liveMembers, studentMap, groupMap)
  }

  /**
   * 点击课表上的班课「计划块」→ 单节物化成真实课程（不自动同步整周）。
   * 若该时段已有真实课程则直接打开编辑。
   */
  async function handleMaterializeSlot(slot: PlannedGroupSlot) {
    const g = groupMap.get(slot.groupId)
    if (!g) return
    const existing = liveCourses.find(
      (c) => c.groupId === slot.groupId && c.startAt === slot.startAt,
    )
    if (existing) {
      openEdit(existing)
      return
    }
    const label = `${format(new Date(slot.startAt), 'M月d日 HH:mm')} · ${g.name}`
    if (!confirm(`把这一节班课计划生成为真实课程吗？\n\n${label}\n\n生成后即可进行出席、完成与结算。`)) {
      return
    }
    const { course } = await materializeGroupSlot(slot, g, liveMembers)
    // 生成后直接打开编辑，方便立即调整
    openEdit(course)
  }

  // ---------------- 多选批量删除 ----------------
  function toggleSelectMode() {
    setSelectMode((v) => {
      const next = !v
      if (!next) setSelectedCourseIds(new Set())
      return next
    })
  }

  function toggleSelectCourse(id: string) {
    setSelectedCourseIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleBatchDeleteCourses() {
    const ids = Array.from(selectedCourseIds)
    if (ids.length === 0) return
    const labels = liveCourses
      .filter((c) => ids.includes(c.id))
      .map((c) => `${format(new Date(c.startAt), 'M/d HH:mm')} ${courseTitle(c, studentMap, groupMap)}`)
      .join('\n')
    if (
      !confirm(
        `确定彻底删除 ${ids.length} 节课吗？\n${labels}\n\n将连同其出席、结算、反馈记录一并删除，且不可恢复！`,
      )
    ) {
      return
    }
    await hardDeleteCourses(ids)
    setSelectedCourseIds(new Set())
    setSelectMode(false)
  }

  // 说明：原先「班课设了每周固定时段 → 自动物化成真实课程」的联动已按需求移除。
  // 现在班课时段只作为「计划块」虚拟渲染在课表上（不写库），
  // 需要真实课程时由老师点击计划块单节生成。

  const shared = {
    courses: filteredCourses,
    studentMap,
    groupMap,
    onEdit: openEdit,
    onToggleDone: toggleDone,
    onOpenAttendance: (c: Course) => setAttendanceFor(c),
    onView: openCourseView,
    selectMode,
    selectedCourseIds,
    onToggleSelectMode: toggleSelectMode,
    onToggleSelectCourse: toggleSelectCourse,
  }

  // 班课「计划块」：按班课每周固定时段虚拟渲染（不写库）
  const plannedSlots = useMemo(
    () => computePlannedGroupSlots(weekDays, Array.from(groupMap.values())),
    [weekDays, groupMap],
  )
  // 已有真实课程的时段不再重复显示计划块
  const takenSlotKeys = useMemo(() => {
    const s = new Set<string>()
    for (const c of liveCourses) {
      if (!c.groupId) continue
      s.add(`${c.groupId}::${c.startAt}`)
    }
    return s
  }, [liveCourses])
  const visiblePlannedSlots = useMemo(
    () =>
      plannedSlots.filter(
        (p) =>
          !takenSlotKeys.has(p.key) &&
          (methodFilter === 'all' || methodFilter === 'offline'),
      ),
    [plannedSlots, takenSlotKeys, methodFilter],
  )

  return (
    <div>
      <PageHeader
        title="智能排课总表"
        subtitle="支持排课冲突检测、按授课方式筛选与时间轴视图的排课大厅"
        action={
          <>
            <Button
              variant="secondary"
              onClick={() => exportSchedule(liveCourses, studentMap, groupMap)}
            >
              <Download size={16} />
              {bp === 'desktop' ? '导课表' : ''}
            </Button>
            <Button variant="primary" onClick={() => openCreate()}>
              <CalendarPlus size={16} />
              {bp === 'desktop' ? '排新课' : '排课'}
            </Button>
          </>
        }
      />

      {bp === 'desktop' ? (
        <Card className="overflow-hidden">
          {/* 顶部工具条：周导航 + 本周统计 + 方式筛选 + 视图切换 */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-1 px-4 py-2.5">
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => setAnchor(addDays(anchor, -7).getTime())}>
                <ChevronLeft size={15} />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAnchor(startOfDay(new Date()).getTime())}>
                本周
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAnchor(addDays(anchor, 7).getTime())}>
                <ChevronRight size={15} />
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-sm text-text-2">
                {format(weekDays[0]!, 'yyyy年M月d日')} – {format(weekDays[6]!, 'M月d日')}
              </span>
              <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[12px] font-medium text-accent-text">
                本周总排课 {weekCount} 节
              </span>
            </div>

            <div className="flex items-center gap-2">
              <SegmentedControl
                value={methodFilter}
                onChange={(v) => setMethodFilter(v as MethodFilter)}
                variant="toggle"
                size="sm"
                options={[
                  { value: 'all', label: '全部方式' },
                  { value: 'online', label: '线上' },
                  { value: 'offline', label: '线下' },
                ]}
              />
              <SegmentedControl
                value={view}
                onChange={(v) => setView(v as ScheduleView)}
                variant="strong"
                size="sm"
                options={[
                  { value: 'day', label: '日视图' },
                  { value: 'week', label: '周视图' },
                  { value: 'agenda', label: '日程表' },
                ]}
              />
              <Button
                size="sm"
                variant={selectMode ? 'primary' : 'ghost'}
                onClick={toggleSelectMode}
              >
                多选
              </Button>
            </div>
          </div>

          {view === 'week' ? (
            <WeekView
              anchor={anchor}
              courses={filteredCourses}
              plannedSlots={visiblePlannedSlots}
              studentMap={studentMap}
              groupMap={groupMap}
              onToggleDone={toggleDone}
              onView={openCourseView}
              onCreate={(startAt) => openCreate(startAt)}
              onMaterializeSlot={(slot) => void handleMaterializeSlot(slot)}
              selectMode={selectMode}
              selectedCourseIds={selectedCourseIds}
              onToggleSelectCourse={toggleSelectCourse}
            />
          ) : view === 'day' ? (
            <DayViewDesktop
              anchor={anchor}
              setAnchor={setAnchor}
              courses={filteredCourses}
              plannedSlots={visiblePlannedSlots}
              studentMap={studentMap}
              groupMap={groupMap}
              onToggleDone={toggleDone}
              onView={openCourseView}
              onCreate={(startAt) => openCreate(startAt)}
              onMaterializeSlot={(slot) => void handleMaterializeSlot(slot)}
              selectMode={selectMode}
              selectedCourseIds={selectedCourseIds}
              onToggleSelectCourse={toggleSelectCourse}
            />
          ) : (
            <AgendaView
              anchor={anchor}
              courses={filteredCourses}
              studentMap={studentMap}
              groupMap={groupMap}
              onEdit={openEdit}
              onView={openCourseView}
            />
          )}
        </Card>
      ) : (
        <DayView anchor={anchor} setAnchor={setAnchor} {...shared} />
      )}

      {/* 多选模式：底部浮动批量操作栏 */}
      {selectMode && selectedCourseIds.size > 0 && (
        <div className="fixed inset-x-0 bottom-4 z-40 sm:left-1/2 sm:max-w-xs sm:-translate-x-1/2">
          <div className="mx-4 flex items-center justify-between gap-3 rounded-xl bg-accent px-4 py-2.5 text-white shadow-lg">
            <span className="text-sm font-medium">已选 {selectedCourseIds.size} 节</span>
            <div className="flex gap-2">
              <button
                onClick={handleBatchDeleteCourses}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-white/25"
              >
                <Trash2 size={15} />
                删除
              </button>
              <button
                onClick={toggleSelectMode}
                className="inline-flex items-center rounded-lg bg-white/15 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-white/25"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      <CourseScheduleModal
        open={modalOpen}
        course={editing}
        defaultStart={defaultStart}
        existing={liveCourses}
        students={Array.from(studentMap.values())}
        groups={Array.from(groupMap.values())}
        onClose={() => setModalOpen(false)}
        onComplete={async (c) => {
          await completeCourse(c)
          setModalOpen(false)
        }}
        prefillStudentId={createPrefill.studentId}
        prefillGroupId={createPrefill.groupId}
      />

      {/* 单个课程「一键查看」侧拉 Sheet */}
      <CourseScheduleSheet
        course={courseViewFor}
        studentMap={studentMap}
        groupMap={groupMap}
        onClose={() => setCourseViewFor(null)}
        onEdit={(c) => openEdit(c)}
        onCreate={(studentId, groupId) => {
          const start = courseViewFor?.startAt
          openCreate(start, { studentId, groupId })
        }}
        onToggleDone={(c) => toggleDone(c)}
        onOpenGroup={(gid) => setGroupDetailFor(gid)}
      />

      {/* 班课详情 Sheet */}
      <GroupDetailSheet
        groupId={groupDetailFor}
        studentMap={studentMap}
        onClose={() => setGroupDetailFor(null)}
        onViewCourse={(c) => {
          setGroupDetailFor(null)
          // 下一帧再开 Sheet，避免互相覆盖导致关闭
          requestAnimationFrame(() => setCourseViewFor(c))
        }}
        onCreateCourse={(gid) => {
          setGroupDetailFor(null)
          requestAnimationFrame(() => openCreate(undefined, { studentId: null, groupId: gid }))
        }}
        onViewStudent={(sid) => {
          setStudentDetailFor(sid)
        }}
      />

      {/* 学生详情 Sheet（由 GroupDetailSheet 内部跳转打开） */}
      <StudentDetailSheet
        studentId={studentDetailFor}
        onClose={() => setStudentDetailFor(null)}
        onEdit={() => {
          /* 仅展示用，不在 Schedule 页内编辑 */
        }}
      />

      <AttendanceModal
        course={attendanceFor}
        students={Array.from(studentMap.values())}
        groupMembers={liveMembers}
        groups={Array.from(groupMap.values())}
        attendances={liveAttendances}
        onClose={() => setAttendanceFor(null)}
        onSave={async (courseId, atts) => {
          await persistAttendance(courseId, atts)
        }}
        onComplete={async (course) => {
          await completeCourse(course)
          setAttendanceFor(null)
        }}
      />
    </div>
  )
}

// ============================================================
// PC：周视图时间网格
// ============================================================

function WeekView({
  anchor,
  courses,
  plannedSlots,
  studentMap,
  groupMap,
  onToggleDone,
  onView,
  onCreate,
  onMaterializeSlot,
  selectMode,
  selectedCourseIds,
  onToggleSelectCourse,
}: {
  anchor: number
  courses: Course[]
  plannedSlots: PlannedGroupSlot[]
  studentMap: Map<string, Student>
  groupMap: Map<string, Group>
  onToggleDone: (c: Course) => void
  onView: (c: Course) => void
  onCreate: (startAt: number) => void
  onMaterializeSlot: (slot: PlannedGroupSlot) => void
  selectMode: boolean
  selectedCourseIds: Set<string>
  onToggleSelectCourse: (id: string) => void
}) {
  const startHour = useSettings((s) => s.settings.dayStartHour)
  const endHour = useSettings((s) => s.settings.dayEndHour)

  const days = useMemo(() => getWeekDays(anchor), [anchor])
  const hours = useMemo(
    () => Array.from({ length: Math.max(1, endHour - startHour) }, (_, i) => startHour + i),
    [startHour, endHour],
  )

  const today = startOfDay(new Date()).getTime()

  return (
    <>
      {/* 星期表头 */}
      <div className="grid border-b border-line-1 bg-surface-2" style={{ gridTemplateColumns: '56px repeat(7, 1fr)' }}>
        <div />
        {days.map((d) => {
          const isToday = today === d
          return (
            <div
              key={d}
              className={cn(
                'px-2 py-2 text-center',
                isToday ? 'text-accent' : 'text-text-2',
              )}
            >
              <div className="text-xs">周{format(d, 'EEEEE')}</div>
              <div
                className={cn(
                  'mx-auto mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-[13px] tabular-nums',
                  isToday && 'bg-accent font-medium text-white',
                )}
              >
                {format(d, 'd')}
              </div>
              <div className="mt-0.5 text-[10px] tabular-nums text-text-3">
                {courses.filter((c) => startOfDay(c.startAt).getTime() === d).length}节
              </div>
            </div>
          )
        })}
      </div>

      {/* 时间网格 */}
      <div className="relative max-h-[calc(100vh-300px)] overflow-y-auto">
        <div className="grid" style={{ gridTemplateColumns: '56px repeat(7, 1fr)' }}>
          {/* 时间轴（小时标签压在整点线上：行顶部对齐，避免「块明明排到 15:00 却看起来没到」的错觉） */}
          <div className="border-r border-line-1">
            {hours.map((h, i) => (
              <div
                key={h}
                className="relative border-b border-line-1 pr-2 text-right text-[11px] tabular-nums text-text-3"
                style={{ height: HOUR_H }}
              >
                <span
                  className="absolute right-2"
                  style={{
                    top: 0,
                    transform: i === 0 ? 'none' : 'translateY(-50%)',
                  }}
                >
                  {String(h).padStart(2, '0')}:00
                </span>
              </div>
            ))}
          </div>

          {/* 七天列 */}
          {days.map((day) => {
            const isToday = today === day
            const dayCourses = courses
              .filter((c) => startOfDay(c.startAt).getTime() === day)
              .sort((a, b) => a.startAt - b.startAt)
            return (
              <div
                key={day}
                className={cn(
                  'relative border-r border-line-1 last:border-r-0',
                  isToday && 'bg-accent-soft/40',
                )}
              >
                {/* 背景横线 + 点击空白排课 */}
                {hours.map((h) => (
                  <button
                    key={h}
                    onClick={() => onCreate(day + h * 3_600_000)}
                    aria-label={`${format(day, 'M月d日')} ${h}:00 排课`}
                    className="block w-full border-b border-line-1 transition-colors hover:bg-accent-soft/50"
                    style={{ height: HOUR_H }}
                  />
                ))}

                {/* 课程块 */}
                {dayCourses.map((c) => {
                  const top =
                    ((new Date(c.startAt).getHours() * 60 +
                      new Date(c.startAt).getMinutes() -
                      startHour * 60) /
                      60) *
                    HOUR_H
                  const dur = courseDurationMin(c, groupMap)
                  const height = Math.max((dur / 60) * HOUR_H - 2, 22)
                  const title = courseTitle(c, studentMap, groupMap)
                  const isSelected = selectedCourseIds.has(c.id)

                  return (
                    <div
                      key={c.id}
                      onClick={() => {
                        if (selectMode) {
                          onToggleSelectCourse(c.id)
                          return
                        }
                        scheduleSingleClick(c.id, () => onView(c))
                      }}
                      onDoubleClick={(e) => {
                        if (selectMode) return
                        e.stopPropagation()
                        cancelSingleClick(c.id)
                        void onToggleDone(c)
                      }}
                      title={selectMode ? '点击选择/取消' : '单击查看全部排课，双击快速完成'}
                      className={cn(
                        'absolute inset-x-1 overflow-hidden rounded-md border px-1.5 py-1 text-[11px] leading-tight shadow-sm',
                        selectMode ? 'cursor-pointer' : 'cursor-pointer transition-shadow hover:shadow-md',
                        c.status === 'cancelled' && 'opacity-50',
                        isSelected && 'ring-2 ring-[var(--accent)]',
                      )}
                      style={{
                        top: top + 1,
                        height,
                        // v15：明显但不刺眼——科目色浅底 + 4px 饱和色条 + 同色描边
                        // （旧写法 `${var}14` 是非法值会被当透明，见 utils.subjectTintVar 注释）
                        background: subjectTintVar(c.colorSlot, 22),
                        borderColor: subjectBorderVar(c.colorSlot, 50),
                        borderLeft: `4px solid ${subjectColorVar(c.colorSlot)}`,
                        color: 'var(--text-1)',
                      }}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="truncate font-medium">
                          {formatTime(c.startAt)}–{formatTime(c.startAt + dur * 60_000)} {title}
                        </span>
                        {selectMode ? (
                          <span
                            className={cn(
                              'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border bg-white/90',
                              isSelected ? 'border-transparent text-accent' : 'border-white/70 text-transparent',
                            )}
                          >
                            <Check size={11} />
                          </span>
                        ) : (
                          c.status === 'done' && (
                            <span className="shrink-0 text-[10px]">✓</span>
                          )
                        )}
                      </div>
                      {height > 30 && (
                        <div className="truncate opacity-90">{c.subject}{c.isMakeup ? ' · 补课' : ''}</div>
                      )}
                      {height > 46 && c.method === 'online' && (
                        <div className="absolute bottom-0.5 right-1 rounded bg-white/85 px-1 text-[9px] font-medium leading-tight text-accent-text">
                          线上
                        </div>
                      )}
                      {height > 52 && c.groupId && c.feeCents > 0 && (
                        <div className="truncate opacity-75">¥{Math.round(c.feeCents / 100)}</div>
                      )}
                    </div>
                  )
                })}

                {/* 班课计划块（按班课每周固定时段虚拟渲染，未落库） */}
                {!selectMode &&
                  plannedSlots
                    .filter((p) => startOfDay(p.startAt).getTime() === day)
                    .map((p) => {
                      const g = groupMap.get(p.groupId)
                      if (!g) return null
                      const top =
                        ((new Date(p.startAt).getHours() * 60 +
                          new Date(p.startAt).getMinutes() -
                          startHour * 60) /
                          60) *
                        HOUR_H
                      const height = Math.max((p.durationMin / 60) * HOUR_H - 2, 22)
                      return (
                        <button
                          key={p.key}
                          type="button"
                          onClick={() => onMaterializeSlot(p)}
                          title={`${g.name} 的固定时段（计划）\n${format(new Date(p.startAt), 'HH:mm')}–${format(new Date(p.endAt), 'HH:mm')}\n点击生成为真实课程`}
                          className="absolute inset-x-1 overflow-hidden rounded-md border border-dashed px-1.5 py-1 text-left text-[11px] leading-tight transition-colors hover:border-solid hover:shadow-md"
                          style={{
                            top: top + 1,
                            height,
                            borderColor: subjectBorderVar(g.colorSlot, 55),
                            background: subjectTintVar(g.colorSlot, 12),
                            color: 'var(--text-1)',
                          }}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="truncate font-medium">
                              {formatTime(p.startAt)}–{formatTime(p.endAt)} {g.name}
                            </span>
                            <span className="shrink-0 rounded bg-surface-0/80 px-1 text-[9px] text-text-3">
                              计划
                            </span>
                          </div>
                          {height > 30 && (
                            <div className="truncate text-text-3">
                              {g.subject}
                              {g.defaultDurationMin ? ` · ${p.durationMin} 分钟` : ''}
                            </div>
                          )}
                        </button>
                      )
                    })}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

// ============================================================
// PC：日视图（单日时间线）
// ============================================================

function DayViewDesktop({
  anchor,
  setAnchor,
  courses,
  plannedSlots,
  studentMap,
  groupMap,
  onToggleDone,
  onView,
  onCreate,
  onMaterializeSlot,
  selectMode,
  selectedCourseIds,
  onToggleSelectCourse,
}: {
  anchor: number
  setAnchor: (v: number) => void
  courses: Course[]
  plannedSlots: PlannedGroupSlot[]
  studentMap: Map<string, Student>
  groupMap: Map<string, Group>
  onToggleDone: (c: Course) => void
  onView: (c: Course) => void
  onCreate: (startAt: number) => void
  onMaterializeSlot: (slot: PlannedGroupSlot) => void
  selectMode: boolean
  selectedCourseIds: Set<string>
  onToggleSelectCourse: (id: string) => void
}) {
  const startHour = useSettings((s) => s.settings.dayStartHour)
  const endHour = useSettings((s) => s.settings.dayEndHour)
  const today = startOfDay(new Date()).getTime()
  const dayKey = startOfDay(new Date(anchor)).getTime()
  const isToday = dayKey === today

  const hours = useMemo(
    () => Array.from({ length: Math.max(1, endHour - startHour) }, (_, i) => startHour + i),
    [startHour, endHour],
  )

  const dayCourses = useMemo(
    () =>
      courses
        .filter((c) => startOfDay(c.startAt).getTime() === dayKey)
        .sort((a, b) => a.startAt - b.startAt),
    [courses, dayKey],
  )

  // 冲突分组（贪心链式）：同时间段重叠的课程分配到不同的横向列
  // 算法：按 startAt 升序遍历，每门放入当前组内第一个未占用的列；
  // 若当前所有列都被覆盖，则新开一组
  const layoutMap = useMemo(() => {
    const list = [...dayCourses]
    const cols = new Map<string, { colIndex: number; groupSize: number }>()
    if (list.length === 0) return cols
    // 用 group 表：每个 group 内有若干 column，每个 column 表示当前正在被哪些课程占用
    type Group = { endTimes: number[]; size: number }
    const groups: Group[] = []
    for (const c of list) {
      const end = courseEnd(c, groupMap)
      // 找一个已有的 group 能容纳 c（存在某列已结束）
      let placed = false
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi]!
        // 找到第一个 endAt <= c.startAt 的列
        let colIdx = -1
        for (let i = 0; i < g.endTimes.length; i++) {
          if ((g.endTimes[i] ?? 0) <= c.startAt) { colIdx = i; break }
        }
        if (colIdx >= 0) {
          g.endTimes[colIdx] = end
          if (g.endTimes.length > g.size) g.size = g.endTimes.length
          cols.set(c.id, { colIndex: colIdx, groupSize: g.size })
          placed = true
          break
        }
      }
      if (!placed) {
        // 新开一组
        const g: Group = { endTimes: [end], size: 1 }
        groups.push(g)
        cols.set(c.id, { colIndex: 0, groupSize: 1 })
      }
    }
    // 后处理：每组内若曾经列数变多了，需要把旧成员扩大为最大 size
    // 简化：保持原记录（视觉上，左侧小、右侧逐渐变窄——视觉简明即可）
    return cols
  }, [dayCourses])

  // 当日 summary
  const summary = useMemo(() => {
    let done = 0; let pending = 0
    for (const c of dayCourses) {
      if (c.status === 'done') done++
      else if (c.status !== 'cancelled') pending++
    }
    return { total: dayCourses.length, done, pending }
  }, [dayCourses])

  const now = new Date()
  const showNowLine = isToday && now.getHours() >= startHour && now.getHours() < endHour
  const nowTop =
    ((now.getHours() * 60 + now.getMinutes() - startHour * 60) / 60) * HOUR_H

  return (
    <div className="flex flex-col">
      {/* 头部：日期导航 + 当日 summary */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-1 bg-surface-1 px-4 py-2">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setAnchor(addDays(anchor, -1).getTime())}>
            <ChevronLeft size={15} />
          </Button>
          <Button
            size="sm"
            variant={isToday ? 'primary' : 'ghost'}
            onClick={() => setAnchor(startOfDay(new Date()).getTime())}
          >
            今日
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAnchor(addDays(anchor, 1).getTime())}>
            <ChevronRight size={15} />
          </Button>
        </div>
        <span className="text-[14px] font-medium text-text-1">
          {format(new Date(anchor), 'yyyy 年 M 月 d 日')} 周{format(new Date(anchor), 'EEEEE')}
        </span>
        <div className="flex items-center gap-2 text-[12px] text-text-2">
          <span className="rounded-full bg-accent-soft px-2.5 py-0.5 font-medium text-accent-text">
            本日 {summary.total} 节
          </span>
          {summary.done > 0 && <Badge variant="success">完成 {summary.done}</Badge>}
          {summary.pending > 0 && <Badge variant="warning">待上 {summary.pending}</Badge>}
        </div>
      </div>

      {/* 单日时间线 */}
      <div className="relative max-h-[calc(100vh-300px)] overflow-y-auto">
        <div className="grid" style={{ gridTemplateColumns: '56px 1fr' }}>
          {/* 左侧时间轴（小时标签压在整点线上，与周视图保持一致） */}
          <div className="border-r border-line-1">
            {hours.map((h, i) => (
              <div
                key={h}
                className="relative border-b border-line-1 pr-2 text-right text-[11px] tabular-nums text-text-3"
                style={{ height: HOUR_H }}
              >
                <span
                  className="absolute right-2"
                  style={{
                    top: 0,
                    transform: i === 0 ? 'none' : 'translateY(-50%)',
                  }}
                >
                  {String(h).padStart(2, '0')}:00
                </span>
              </div>
            ))}
          </div>

          {/* 单列 + 课程块 */}
          <div
            className={cn(
              'relative',
              isToday && 'bg-accent-soft/40',
            )}
          >
            {hours.map((h) => (
              <button
                key={h}
                onClick={() => onCreate(dayKey + h * 3_600_000)}
                aria-label={`${format(new Date(anchor), 'M月d日')} ${h}:00 排课`}
                className="block w-full border-b border-line-1 transition-colors hover:bg-accent-soft/50"
                style={{ height: HOUR_H }}
              />
            ))}

            {/* 课程块（支持冲突并列排版） */}
            {dayCourses.map((c) => {
              const top =
                ((new Date(c.startAt).getHours() * 60 +
                  new Date(c.startAt).getMinutes() -
                  startHour * 60) /
                  60) *
                HOUR_H
              const dur = courseDurationMin(c, groupMap)
              const height = Math.max((dur / 60) * HOUR_H - 2, 22)
              const title = courseTitle(c, studentMap, groupMap)
              const isSelected = selectedCourseIds.has(c.id)
              const layout = layoutMap.get(c.id) ?? { colIndex: 0, groupSize: 1 }
              const { colIndex, groupSize: size } = layout
              const insetX = 4
              const widthPct = 100 / Math.max(size, 1)
              const leftPct = colIndex * widthPct

              return (
                <div
                  key={c.id}
                  onClick={() => {
                    if (selectMode) {
                      onToggleSelectCourse(c.id)
                      return
                    }
                    scheduleSingleClick(c.id, () => onView(c))
                  }}
                  onDoubleClick={(e) => {
                    if (selectMode) return
                    e.stopPropagation()
                    cancelSingleClick(c.id)
                    void onToggleDone(c)
                  }}
                  title={selectMode ? '点击选择/取消' : '单击查看全部排课，双击快速完成'}
                  className={cn(
                    'absolute overflow-hidden rounded-md border px-1.5 py-1 text-[11px] leading-tight shadow-sm',
                    selectMode ? 'cursor-pointer' : 'cursor-pointer transition-shadow hover:shadow-md',
                    c.status === 'cancelled' && 'opacity-50',
                    isSelected && 'ring-2 ring-[var(--accent)]',
                  )}
                  style={{
                    top: top + 1,
                    height,
                    left: `calc(${insetX}px + ${leftPct}%)`,
                    width: `calc(${widthPct}% - 4px)`,
                    // v15：与「周视图」统一——科目色浅底 + 4px 饱和色条 + 同色描边
                    background: subjectTintVar(c.colorSlot, 22),
                    borderColor: subjectBorderVar(c.colorSlot, 50),
                    borderLeft: `4px solid ${subjectColorVar(c.colorSlot)}`,
                    color: 'var(--text-1)',
                  }}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate font-medium">
                      {formatTime(c.startAt)} {title}
                    </span>
                    {selectMode ? (
                      <span
                        className={cn(
                          'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border bg-white/90',
                          isSelected ? 'border-transparent text-accent' : 'border-white/70 text-transparent',
                        )}
                      >
                        <Check size={11} />
                      </span>
                    ) : (
                      c.status === 'done' && (
                        <span className="shrink-0 text-[10px]">✓</span>
                      )
                    )}
                  </div>
                  {height > 30 && (
                    <div className="truncate opacity-90">{c.subject}{c.isMakeup ? ' · 补课' : ''}</div>
                  )}
                  {height > 46 && c.method === 'online' && (
                    <div className="absolute bottom-0.5 right-1 rounded bg-white/85 px-1 text-[9px] font-medium leading-tight text-accent-text">
                      线上
                    </div>
                  )}
                  {height > 52 && c.groupId && c.feeCents > 0 && (
                    <div className="truncate opacity-75">¥{Math.round(c.feeCents / 100)}</div>
                  )}
                </div>
              )
            })}

            {/* 班课计划块（按班课每周固定时段虚拟渲染，未落库） */}
            {!selectMode &&
              plannedSlots
                .filter((p) => startOfDay(p.startAt).getTime() === dayKey)
                .map((p) => {
                  const g = groupMap.get(p.groupId)
                  if (!g) return null
                  const top =
                    ((new Date(p.startAt).getHours() * 60 +
                      new Date(p.startAt).getMinutes() -
                      startHour * 60) /
                      60) *
                    HOUR_H
                  const height = Math.max((p.durationMin / 60) * HOUR_H - 2, 22)
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => onMaterializeSlot(p)}
                      title={`${g.name} 的固定时段（计划）\n${format(new Date(p.startAt), 'HH:mm')}–${format(new Date(p.endAt), 'HH:mm')}\n点击生成为真实课程`}
                      className="absolute overflow-hidden rounded-md border border-dashed px-1.5 py-1 text-left text-[11px] leading-tight transition-colors hover:border-solid hover:shadow-md"
                      style={{
                        top: top + 1,
                        height,
                        left: '4px',
                        width: 'calc(100% - 8px)',
                        borderColor: subjectBorderVar(g.colorSlot, 55),
                        background: subjectTintVar(g.colorSlot, 12),
                        color: 'var(--text-1)',
                      }}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="truncate font-medium">
                          {formatTime(p.startAt)} {g.name}
                        </span>
                        <span className="shrink-0 rounded bg-surface-0/80 px-1 text-[9px] text-text-3">
                          计划
                        </span>
                      </div>
                      {height > 30 && (
                        <div className="truncate text-text-3">
                          {g.subject}
                          {p.durationMin ? ` · ${p.durationMin} 分钟` : ''}
                        </div>
                      )}
                    </button>
                  )
                })}

            {/* 「现在」指针 */}
            {showNowLine && (
              <div
                className="pointer-events-none absolute inset-x-0 z-10"
                style={{ top: nowTop }}
              >
                <div className="flex items-center">
                  <div className="h-2 w-2 rounded-full bg-accent shadow ring-2 ring-white" />
                  <div className="h-0.5 flex-1 bg-accent" />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// PC：日程表视图（本周课程按天分组的列表）
// ============================================================

function AgendaView({
  anchor,
  courses,
  studentMap,
  groupMap,
  onEdit,
  onView,
}: {
  anchor: number
  courses: Course[]
  studentMap: Map<string, Student>
  groupMap: Map<string, Group>
  onEdit: (c: Course) => void
  onView: (c: Course) => void
}) {
  const days = useMemo(() => getWeekDays(anchor), [anchor])
  const today = startOfDay(new Date()).getTime()

  const grouped = useMemo(
    () =>
      days
        .map((day) => ({
          day,
          list: courses
            .filter((c) => startOfDay(c.startAt).getTime() === day)
            .sort((a, b) => a.startAt - b.startAt),
        }))
        .filter((g) => g.list.length > 0),
    [courses, days],
  )

  if (grouped.length === 0) {
    return (
      <EmptyState
        icon={<Inbox size={28} />}
        title="本周暂无课程"
        description="点击右上角「排新课」安排课程，或切换授课方式筛选"
      />
    )
  }

  return (
    <div className="space-y-4 p-3">
      {grouped.map((g) => (
        <section key={g.day}>
          <div
            className={cn(
              'mb-2 flex items-center gap-2 px-1',
              today === g.day ? 'text-accent' : 'text-text-1',
            )}
          >
            <span className="text-[14px] font-semibold">周{format(g.day, 'EEEEE')}</span>
            <span className="text-[13px] tabular-nums text-text-2">
              {format(g.day, 'M月d日')}
            </span>
            <span className="ml-auto text-[11px] text-text-3">{g.list.length} 节</span>
          </div>
          <ul className="space-y-2">
            {g.list.map((c) => (
              <li
                key={c.id}
                onClick={() => onView(c)}
                className="flex cursor-pointer items-center gap-3 rounded-xl border border-line-1 bg-surface-0 p-3 transition-colors hover:bg-surface-1"
              >
                <div className="w-20 shrink-0">
                  <div className="text-[13px] font-medium tabular-nums text-text-1">
                    {formatTime(c.startAt)}-{formatTime(courseEnd(c, groupMap))}
                  </div>
                </div>
                <span
                  className="h-9 w-1 shrink-0 rounded-full"
                  style={{ background: subjectColorVar(c.colorSlot) }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-text-1">
                      {courseTitle(c, studentMap, groupMap)}
                    </span>
                    <span className="shrink-0 text-[12px] text-text-3">{c.subject}</span>
                    {c.isMakeup && <span className="shrink-0 text-[11px] text-pending">补课</span>}
                  </div>
                    <div className="mt-0.5 truncate text-[12px] text-text-2">
                      {courseDurationMin(c, groupMap)} 分钟{c.location ? ` · ${c.location}` : ''}
                      {c.method === 'online' ? ' · 线上' : ''}
                      {c.groupId && c.feeCents > 0 ? ` · ¥${Math.round(c.feeCents / 100)}` : ''}
                    </div>
                </div>
                <StatusBadge status={c.status} />
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onEdit(c)
                  }}
                  className="shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium text-text-2 hover:bg-surface-2 hover:text-text-1"
                >
                  编辑
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

// ============================================================
// 移动端：日视图卡片流（支持左右滑动切日期、左滑完成）
// ============================================================

function DayView({
  anchor,
  setAnchor,
  courses,
  studentMap,
  groupMap,
  onToggleDone,
  onOpenAttendance,
  onView,
  selectMode,
  selectedCourseIds,
  onToggleSelectMode,
  onToggleSelectCourse,
}: {
  anchor: number
  setAnchor: (v: number) => void
  courses: Course[]
  studentMap: Map<string, Student>
  groupMap: Map<string, Group>
  onToggleDone: (c: Course) => void
  onOpenAttendance: (c: Course) => void
  onView: (c: Course) => void
  selectMode: boolean
  selectedCourseIds: Set<string>
  onToggleSelectMode: () => void
  onToggleSelectCourse: (id: string) => void
}) {
  const dayCourses = useMemo(
    () =>
      courses
        .filter((c) => startOfDay(c.startAt).getTime() === anchor)
        .sort((a, b) => a.startAt - b.startAt),
    [courses, anchor],
  )

  // 左右滑动切换日期
  const [touchX, setTouchX] = useState<number | null>(null)

  return (
    <div
      onTouchStart={(e) => setTouchX(e.touches[0]!.clientX)}
      onTouchEnd={(e) => {
        if (touchX === null) return
        const dx = e.changedTouches[0]!.clientX - touchX
        if (Math.abs(dx) > 60) {
          setAnchor(addDays(anchor, dx < 0 ? 1 : -1).getTime())
        }
        setTouchX(null)
      }}
    >
      {/* 日期导航 */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <Button size="sm" variant="ghost" onClick={() => setAnchor(addDays(anchor, -1).getTime())}>
          <ChevronLeft size={18} />
        </Button>
        <button
          onClick={() => setAnchor(startOfDay(new Date()).getTime())}
          className="flex-1 text-center"
        >
          <div className="text-[15px] font-medium text-text-1">
            {format(anchor, 'M月d日')} 周{format(anchor, 'EEEEE')}
          </div>
          <div className="text-xs text-text-3">
            {dayCourses.length > 0 ? `${dayCourses.length} 节课 · 点「今天」返回` : '无课 · 点「今天」返回'}
          </div>
        </button>
        <Button size="sm" variant="ghost" onClick={() => setAnchor(addDays(anchor, 1).getTime())}>
          <ChevronRight size={18} />
        </Button>
      </div>

      {/* 多选开关 */}
      <div className="mb-3 flex justify-end">
        <Button
          size="sm"
          variant={selectMode ? 'primary' : 'ghost'}
          onClick={onToggleSelectMode}
        >
          {selectMode ? '退出多选' : '多选'}
        </Button>
      </div>

      {dayCourses.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Inbox size={28} />}
            title="这天没有课"
            description="左右滑动切换日期，或点击顶部排课"
          />
        </Card>
      ) : (
        <ul className="space-y-2">
          {dayCourses.map((c) => (
            <SwipeCourseCard
              key={c.id}
              course={c}
              groupMap={groupMap}
              title={courseTitle(c, studentMap, groupMap)}
              selectMode={selectMode}
              selected={selectedCourseIds.has(c.id)}
              onToggleSelect={() => onToggleSelectCourse(c.id)}
              onView={() => onView(c)}
              onToggleDone={() => void onToggleDone(c)}
              onOpenAttendance={() => onOpenAttendance(c)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

/** 移动端课程卡：左滑标记完成
 *  - 修复：取消完成文字透出 bug
 *    原：foreground card 用 opacity-70 / 50，导致背后的 swipe 文字透出。
 *    现：foreground 完全不透明，状态用左侧色条 + 状态徽章传达；swipe 动作文字仅在
 *        用户确实左滑露出时显示，未滑动时不外露。
 */
function SwipeCourseCard({
  course,
  groupMap,
  title,
  selectMode,
  selected,
  onToggleSelect,
  onView,
  onToggleDone,
  onOpenAttendance,
}: {
  course: Course
  groupMap: Map<string, Group>
  title: string
  selectMode: boolean
  selected: boolean
  onToggleSelect: () => void
  onView: () => void
  onToggleDone: () => void
  onOpenAttendance: () => void
}) {
  const [offsetX, setOffsetX] = useState(0)
  const [startX, setStartX] = useState<number | null>(null)
  const isSwiping = offsetX < -10
  const swipeLabel = course.status === 'done' ? '取消完成' : '标记完成'

  return (
    <li className="relative overflow-hidden rounded-xl">
      {/* 左滑露出的底色 */}
      <div
        className={cn(
          'absolute inset-0 flex items-center justify-end rounded-xl px-5 text-sm font-medium transition-opacity',
          course.status === 'done' ? 'bg-pending text-white' : 'bg-done text-white',
          isSwiping ? 'opacity-100' : 'opacity-0',
        )}
      >
        {swipeLabel}
      </div>

      <div
        onTouchStart={(e) => {
          if (selectMode) return
          setStartX(e.touches[0]!.clientX)
        }}
        onTouchMove={(e) => {
          if (selectMode || startX === null) return
          const dx = e.touches[0]!.clientX - startX
          setOffsetX(Math.max(-120, Math.min(0, dx)))
        }}
        onTouchEnd={() => {
          if (!selectMode && offsetX < -70) onToggleDone()
          setOffsetX(0)
          setStartX(null)
        }}
        onClick={() => (selectMode ? onToggleSelect() : onView())}
        className={cn(
          'relative flex items-center gap-3 rounded-xl border border-line-1 bg-surface-0 p-3 transition-transform',
          course.status === 'cancelled' && 'opacity-60',
          selected && 'border-accent ring-2 ring-accent',
        )}
        style={{ transform: `translateX(${offsetX}px)` }}
      >
        {/* 多选选择框 */}
        {selectMode && (
          <span
            className={cn(
              'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border',
              selected ? 'border-accent bg-accent text-white' : 'border-line-2 bg-surface-0',
            )}
          >
            {selected && <Check size={13} />}
          </span>
        )}
        {/* 时间 */}
        <div className="w-16 shrink-0 text-center">
          <div className="text-[15px] font-medium tabular-nums text-text-1">
            {formatTime(course.startAt)}
          </div>
          <div className="text-[11px] tabular-nums text-text-3">
            {formatTime(courseEnd(course, groupMap))}
          </div>
        </div>

        <span
          className="h-10 w-1 shrink-0 rounded-full"
          style={{ background: subjectColorVar(course.colorSlot) }}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-text-1">{title}</span>
            <span className="shrink-0 text-[11px] text-text-3">
              {course.subject}
              {course.isMakeup ? ' · 补课' : ''}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[13px] text-text-2">
            {courseDurationMin(course, groupMap)} 分钟
            {course.location ? ` · ${course.location}` : ''}
            {course.method === 'online' ? ' · 线上' : ''}
            {course.groupId && course.feeCents > 0
              ? ` · ¥${Math.round(course.feeCents / 100)}`
              : ''}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge status={course.status} />
          {!selectMode && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onOpenAttendance()
              }}
              className="rounded-md p-1 text-text-3 hover:bg-surface-2"
              aria-label="设置出席"
              title="设置出席"
            >
              <Users size={14} />
            </button>
          )}
        </div>
      </div>
    </li>
  )
}
