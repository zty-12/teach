import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { endOfDay, endOfMonth, format, startOfDay, startOfMonth, startOfWeek } from 'date-fns'
import {
  AlertCircle,
  ArrowRight,
  Check,
  CircleAlert,
  Clock,
  Plus,
  Timer,
  X,
} from 'lucide-react'
import { db, touch } from '@/lib/db'
import { AttendanceModal } from '@/components/AttendanceModal'
import { BarChart, type BarDatum } from '@/components/BarChart'
import { useSettings } from '@/store/useSettings'
import { Button, Card, PageHeader } from '@/components/ui'
import {
  cn,
  courseDurationMin,
  courseEnd,
  formatMoneyShort,
  formatTime,
} from '@/lib/utils'
import {
  type Course,
  type Group,
  type Student,
} from '@/lib/types'
import { completeCourseWithAttendance, persistAttendance } from './schedule-helpers'
import { revertCompletion, summarizeRevert } from '@/lib/courseCompletion'
import { computeFinanceMetrics } from '@/lib/finance'

// ============================================================
// 课程时间状态
// ============================================================

type CourseTimeState =
  | 'overdue'
  | 'ongoing'
  | 'upcoming'
  | 'later'
  | 'completed'
  | 'canceled'
  | 'leave'

function getCourseTimeState(
  status: Course['status'],
  startAt: number,
  endAt: number,
  now: number,
): CourseTimeState {
  if (status === 'done') return 'completed'
  if (status === 'cancelled') return 'canceled'
  if (status === 'leave') return 'leave'

  if (now > endAt) return 'overdue'
  if (now >= startAt && now <= endAt) return 'ongoing'
  if (startAt - now <= 30 * 60_000) return 'upcoming'
  return 'later'
}

/** 距离开始/结束的文案 */
function timeHintText(state: CourseTimeState, now: number, startAt: number, endAt: number): string {
  const mins = (diff: number) => {
    const abs = Math.abs(diff) / 60_000
    if (abs < 1) return '刚刚'
    const h = Math.floor(abs / 60)
    const m = Math.round(abs % 60)
    return h > 0 ? `${abs >= 60 ? `${h} 小时 ` : ''}${m} 分钟`.trim() : `${m} 分钟`
  }
  switch (state) {
    case 'overdue':
      return `已结束 ${mins(now - endAt)}`
    case 'ongoing':
      return `距离结束 ${mins(endAt - now)}`
    case 'upcoming':
    case 'later':
      return `${mins(startAt - now)}后开始`
    case 'completed':
      return '已确认完成'
    case 'canceled':
      return '本节已取消'
    case 'leave':
      return '本节记为请假'
  }
}

interface TimeStateMeta {
  row: string
  rail: string
  badge: string
  badgeText: string
  hint: string
  statusClass: string
  icon: typeof Clock
  action: string | null
}

function getTimeStateMeta(state: CourseTimeState): TimeStateMeta {
  switch (state) {
    case 'overdue':
      return {
        row: 'bg-pending-soft/70 hover:bg-pending-soft',
        rail: 'bg-pending',
        badge: 'bg-pending-soft text-pending',
        badgeText: '待确认',
        hint: 'text-pending',
        statusClass: 'text-pending',
        icon: CircleAlert,
        action: '确认上课',
      }
    case 'ongoing':
      return {
        row: 'bg-accent-soft/70 hover:bg-accent-soft',
        rail: 'bg-accent',
        badge: 'bg-accent-soft text-accent-text',
        badgeText: '进行中',
        hint: 'text-accent-text',
        statusClass: 'text-accent-text',
        icon: Timer,
        action: '确认上课',
      }
    case 'upcoming':
      return {
        row: 'bg-accent-soft/40 hover:bg-accent-soft',
        rail: 'bg-accent',
        badge: 'bg-accent-soft text-accent-text',
        badgeText: '即将开始',
        hint: 'text-accent-text',
        statusClass: 'text-accent-text',
        icon: Clock,
        action: '取消课程',
      }
    case 'later':
      return {
        row: 'bg-surface-0 hover:bg-surface-2',
        rail: 'bg-surface-3',
        badge: 'bg-surface-2 text-text-2',
        badgeText: '稍后开始',
        hint: 'text-text-2',
        statusClass: 'text-text-2',
        icon: Clock,
        action: '取消课程',
      }
    case 'completed':
      return {
        row: 'bg-done-soft/60 hover:bg-done-soft',
        rail: 'bg-done',
        badge: 'bg-done-soft text-done',
        badgeText: '已上课',
        hint: 'text-done',
        statusClass: 'text-done',
        icon: Check,
        action: null,
      }
    case 'canceled':
      return {
        row: 'bg-surface-2/70',
        rail: 'bg-text-3',
        badge: 'bg-surface-3 text-text-2',
        badgeText: '已取消',
        hint: 'text-text-3',
        statusClass: 'text-text-3',
        icon: Clock,
        action: null,
      }
    case 'leave':
      return {
        row: 'bg-leave-soft/60 hover:bg-leave-soft',
        rail: 'bg-leave',
        badge: 'bg-leave-soft text-leave',
        badgeText: '请假',
        hint: 'text-leave',
        statusClass: 'text-leave',
        icon: AlertCircle,
        action: null,
      }
  }
}

// ============================================================
// 今日待处理：按「课程信息 / 学生信息」分组的列表项
// ============================================================

/** 待处理条目 */
type DashboardTodo = {
  id: string
  /** 归属栏：course = 课程信息（课后反馈等），student = 学生信息（课时/试听等） */
  group: 'course' | 'student'
  category: string
  categoryClass: string
  title: string
  detail: string
  actionLabel?: string
  tone: 'warning' | 'info'
  href: string
}

/** 单条待处理 */
function TodoRow({ todo }: { todo: DashboardTodo }) {
  const warn = todo.tone === 'warning'
  return (
    <div
      className={cn(
        'relative flex items-start justify-between gap-3 rounded-lg px-3 py-2.5 pl-4',
        warn ? 'border border-leave/30 bg-leave-soft/40' : 'border border-line-1 bg-surface-0',
      )}
    >
      <span className={cn('absolute bottom-3 left-0 top-3 w-0.5 rounded-full', warn ? 'bg-leave' : 'bg-accent')} />
      <div className="flex min-w-0 gap-2.5">
        <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', warn ? 'bg-leave' : 'bg-accent')} />
        <div className="min-w-0">
          <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold', todo.categoryClass)}>
            {todo.category}
          </span>
          <div className="mt-1 text-[13px] font-semibold leading-snug text-text-1">{todo.title}</div>
          <div className="mt-1 text-[11px] font-medium text-text-2">{todo.detail}</div>
        </div>
      </div>
      {todo.actionLabel ? (
        <Link
          to={todo.href}
          className={cn(
            'inline-flex h-7 shrink-0 items-center rounded-full px-2.5 text-[11px] font-semibold text-white',
            warn ? 'bg-leave' : 'bg-accent',
          )}
        >
          {todo.actionLabel}
        </Link>
      ) : null}
    </div>
  )
}

/** 分栏容器：一栏为一类信息，内部超高滚动 */
function TodoColumn({
  title,
  hint,
  items,
  divider = false,
}: {
  title: string
  hint: string
  items: DashboardTodo[]
  /** 桌面端在左缘加分隔线（用于第二栏） */
  divider?: boolean
}) {
  return (
    <div className={cn('flex min-w-0 flex-col', divider && 'md:border-l md:border-line-1 md:pl-5')}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          <span className="shrink-0 text-[12px] font-semibold text-text-1">{title}</span>
          <span className="truncate text-[11px] font-medium text-text-3">{hint}</span>
        </div>
        <span className="shrink-0 rounded-full border border-line-1 bg-surface-2/60 px-2 py-0.5 text-[10px] font-semibold text-text-2 tabular-nums">
          {items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line-1 bg-surface-2/30 px-3 py-6 text-center text-[12px] font-medium text-text-3">
          暂无
        </div>
      ) : (
        <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
          {items.map((t) => (
            <TodoRow key={t.id} todo={t} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function DashboardPage() {
  const teacherName = useSettings((s) => s.settings.teacherName)

  const students = useLiveQuery(() => db.students.toArray(), [])
  const courses = useLiveQuery(() => db.courses.toArray(), [])
  const payments = useLiveQuery(() => db.payments.toArray(), [])
  const feedbacks = useLiveQuery(() => db.courseFeedbacks.toArray(), [])
  const groups = useLiveQuery(() => db.groups.toArray(), [])
  const members = useLiveQuery(() => db.groupMembers.toArray(), [])
  const attendances = useLiveQuery(() => db.courseAttendances.toArray(), [])

  const [attendanceFor, setAttendanceFor] = useState<Course | null>(null)
  const [hoveredWeekBar, setHoveredWeekBar] = useState<number | null>(null)

  const studentMap = useMemo(
    () => new Map((students ?? []).filter((s) => !s.deletedAt).map((s) => [s.id, s])),
    [students],
  )
  const groupMap = useMemo(
    () => new Map((groups ?? []).filter((g) => !g.deletedAt).map((g) => [g.id, g])),
    [groups],
  )
  const liveMembers = useMemo(() => (members ?? []).filter((m) => !m.deletedAt), [members])
  const liveAttendances = useMemo(
    () => (attendances ?? []).filter((a) => !a.deletedAt),
    [attendances],
  )

  const data = useMemo(() => {
    const now = Date.now()
    const monthStart = startOfMonth(now).getTime()
    const monthEnd = endOfMonth(now).getTime()
    const todayStart = startOfDay(now).getTime()
    const todayEnd = endOfDay(now).getTime()
    const weekStart = startOfWeek(now, { weekStartsOn: 1 }).getTime()

    const liveStudents = (students ?? []).filter((s) => !s.deletedAt)
    const liveCourses = (courses ?? []).filter((c) => !c.deletedAt)
    const livePayments = (payments ?? []).filter((p) => !p.deletedAt)

    const monthIncome = livePayments
      .filter((p) => p.paidAt >= monthStart && p.paidAt <= monthEnd)
      .reduce((s, p) => s + p.amountCents, 0)

    // 统一财务口径：待结算课酬（预付，机构欠老师）/ 欠费（仅后付学生）
    const fin = computeFinanceMetrics({
      courses: liveCourses,
      payments: livePayments,
      students: liveStudents,
      groups: (groups ?? []).filter((g) => !g.deletedAt),
      members: liveMembers,
      attendances: liveAttendances,
    })
    const arrearsCents = fin.arrears.reduce((s, a) => s + a.outstanding, 0)

    const todayCourses = liveCourses
      .filter((c) => c.startAt >= todayStart && c.startAt <= todayEnd)
      .sort((a, b) => a.startAt - b.startAt)

    const weekDays = Array.from({ length: 7 }, (_, i) => weekStart + i * 86_400_000)
    const weeklyBars = weekDays.map((d, i) => {
      const dayCourses = liveCourses.filter(
        (c) => c.status !== 'cancelled' && startOfDay(c.startAt).getTime() === d,
      )
      return {
        date: d,
        day: ['一', '二', '三', '四', '五', '六', '日'][i],
        count: dayCourses.length,
        active: d === todayStart,
        labels: dayCourses
          .sort((a, b) => a.startAt - b.startAt)
          .map((c) => `${formatTime(c.startAt)} ${courseTitle(c, studentMap, groupMap)}`),
      }
    })
    const weeklyCourseCount = weeklyBars.reduce((s, b) => s + b.count, 0)

    // 低余额 / 试听超时 -> 今日待处理
    const lowBalance = liveStudents.filter(
      (s) => s.billingRule === 'prepaid' && s.remainingHours <= s.remindHours && s.status === 'active',
    )
    const trialOverdue = liveStudents.filter(
      (s) => s.isTrial && s.trialAt && now - s.trialAt >= 5 * 86_400_000,
    )
    const feedbackCourseIds = new Set(
      (feedbacks ?? []).filter((f) => !f.deletedAt).map((f) => f.courseId),
    )
    const pendingFeedback = liveCourses
      .filter((c) => c.status === 'done' && !feedbackCourseIds.has(c.id))
      .sort((a, b) => b.startAt - a.startAt)
      .slice(0, 5)

    return {
      now,
      todayStart,
      weekStart,
      monthIncome,
      settlementPendingCents: fin.settlementPendingCents,
      arrearsCount: fin.arrears.length,
      arrearsCents,
      todayCourses,
      weeklyBars,
      weeklyCourseCount,
      lowBalance,
      trialOverdue,
      pendingFeedback,
      liveStudents,
    }
  }, [students, courses, payments, feedbacks, groups, members, studentMap, groupMap])

  const { todayCourses, weeklyBars, weeklyCourseCount } = data

  async function quickComplete(c: Course) {
    if (c.status === 'done') {
      // 撤销完成：归还课时 + 撤销结算 + 回收自动生成的打卡/课堂活动（不能只改状态）
      const r = await revertCompletion(c.id)
      const msg = summarizeRevert(r)
      if (msg) window.alert(msg)
      return
    }
    setAttendanceFor(c)
  }

  function quickCancel(c: Course) {
    void db.courses.put(touch({ ...c, status: 'cancelled' }))
  }

  // 今日待处理列表（分类 + 详情 + 动作；group 决定落在哪一栏）
  const todos = useMemo(() => {
    const list: DashboardTodo[] = []
    data.lowBalance.forEach((s) => {
      list.push({
        id: `lb-${s.id}`,
        group: 'student',
        category: '财务',
        categoryClass: 'bg-leave-soft text-leave',
        title: `${s.name} 课时即将耗尽`,
        detail: `剩余 ${s.remainingHours} 次 · 建议尽快续费`,
        actionLabel: '去处理',
        tone: 'warning',
        href: '/finance',
      })
    })
    data.trialOverdue.forEach((s) => {
      list.push({
        id: `trial-${s.id}`,
        group: 'student',
        category: '学生',
        categoryClass: 'bg-pending-soft text-pending',
        title: `${s.name} 试听已超时`,
        detail: `已试听 ≥5 天 · 请确认是否转正`,
        actionLabel: '去处理',
        tone: 'warning',
        href: '/students',
      })
    })
    data.pendingFeedback.forEach((c) => {
      list.push({
        id: `fb-${c.id}`,
        group: 'course',
        category: '反馈',
        categoryClass: 'bg-accent-soft text-accent-text',
        title: `待补课后反馈 · ${courseTitle(c, studentMap, groupMap)}`,
        detail: `${format(c.startAt, 'M月d日 HH:mm')} · ${c.subject}`,
        actionLabel: '去填写',
        tone: 'info',
        href: '/feedback',
      })
    })
    return list
  }, [data.lowBalance, data.trialOverdue, data.pendingFeedback, studentMap, groupMap])

  const courseTodos = useMemo(() => todos.filter((t) => t.group === 'course'), [todos])
  const studentTodos = useMemo(() => todos.filter((t) => t.group === 'student'), [todos])

  const riskCount = data.lowBalance.length + data.trialOverdue.length

  const dateLabel = `${format(Date.now(), 'yyyy年M月d日')} ${format(Date.now(), 'EEEE')}`

  return (
    <div className="space-y-5">
      <PageHeader
        title={teacherName ? `您好，${teacherName}，今天有 ${todayCourses.length} 节课` : `今天有 ${todayCourses.length} 节课`}
        subtitle={dateLabel}
        action={
          <>
            <Link to="/students">
              <Button variant="secondary" size="sm">新建学生</Button>
            </Link>
            <Link to="/schedule">
              <Button variant="secondary" size="sm">去排课</Button>
            </Link>
            <Link to="/finance">
              <Button variant="primary" size="sm">
                <Plus size={15} /> 记录收款
              </Button>
            </Link>
          </>
        }
      />

      {/* 统计卡 */}
      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Link to="/schedule" className="group">
              <Card className="h-full p-4 transition-all hover:border-accent/30 hover:shadow-lg">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-[12px] font-medium text-text-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-accent" /> 本周课程
                  </div>
                  <ArrowRight className="h-3.5 w-3.5 text-text-3 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
                </div>
                <div className="text-[28px] font-semibold leading-none text-text-1 tabular-nums">
                  {weeklyCourseCount} <span className="text-sm font-medium text-text-2">节</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center rounded-full border border-line-1 bg-surface-2/60 px-2.5 py-1 text-[11px] font-medium text-text-2">本周{weeklyCourseCount}节</span>
                  <span className="inline-flex items-center rounded-full border border-line-1 bg-surface-2/60 px-2.5 py-1 text-[11px] font-medium text-text-2">班课{todayCourses.filter((c) => c.groupId).length}节</span>
                </div>
              </Card>
            </Link>

            <Link to="/finance" className="group">
              <Card className="h-full p-4 transition-all hover:border-money-in/30 hover:shadow-lg">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-[12px] font-medium text-text-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-money-in" /> 本月实收
                  </div>
                  <ArrowRight className="h-3.5 w-3.5 text-text-3 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
                </div>
                <div className="text-[28px] font-semibold leading-none text-text-1 tabular-nums">
                  {formatMoneyShort(data.monthIncome)}
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center rounded-full border border-line-1 bg-surface-2/60 px-2.5 py-1 text-[11px] font-medium text-text-2">待结算 {formatMoneyShort(data.settlementPendingCents)}</span>
                  <span className="inline-flex items-center rounded-full border border-line-1 bg-surface-2/60 px-2.5 py-1 text-[11px] font-medium text-text-2">欠费 {data.arrearsCount} 人</span>
                </div>
              </Card>
            </Link>

            <Link to="/finance" className="group">
              <Card className={cn('h-full p-4 transition-all hover:shadow-lg', riskCount > 0 ? 'border-leave/30' : 'hover:border-line-1')}>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-[12px] font-medium text-text-2">
                    <span className={cn('h-1.5 w-1.5 rounded-full', riskCount > 0 ? 'bg-leave' : 'bg-text-3')} /> 账户风险
                  </div>
                  <ArrowRight className="h-3.5 w-3.5 text-text-3 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
                </div>
                <div className={cn('text-[28px] font-semibold leading-none tabular-nums', riskCount > 0 ? 'text-leave' : 'text-text-1')}>
                  {riskCount} <span className="text-sm font-medium text-text-2">人</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center rounded-full border border-line-1 bg-surface-2/60 px-2.5 py-1 text-[11px] font-medium text-text-2">余额 {data.lowBalance.length} 人</span>
                  <span className="inline-flex items-center rounded-full border border-line-1 bg-surface-2/60 px-2.5 py-1 text-[11px] font-medium text-text-2">续费 {data.trialOverdue.length} 人</span>
                </div>
              </Card>
            </Link>
          </section>

      {/* 今日课程：保持整行通栏显示 */}
      <section className="card p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-text-1">今日课程</h2>
            <p className="mt-1 text-[12px] leading-5 text-text-2">
              按当前系统时间区分待确认、进行中、即将开始与稍后开始；点击可原地确认或编辑。
            </p>
          </div>
          <span className="shrink-0 text-[12px] font-medium text-text-2">
            {todayCourses.length === 0 ? '今天没有课' : `共 ${todayCourses.length} 节`}
          </span>
        </div>

        {todayCourses.length === 0 ? (
          <div className="rounded-lg border border-line-1 bg-surface-2/40 px-5 py-10 text-center">
            <div className="text-[14px] font-semibold text-text-1">今天还没有排课</div>
            <div className="mt-1 text-[12px] leading-5 text-text-2">系统已按当前日期加载今日课程，新增课程后这里会自动按时间前后区分显示。</div>
          </div>
        ) : (
          <div className="space-y-3">
                {todayCourses.map((course) => {
                  const start = course.startAt
                  const end = courseEnd(course, groupMap)
                  const state = getCourseTimeState(course.status, start, end, data.now)
                  const meta = getTimeStateMeta(state)
                  const Icon = meta.icon
                  const title = courseTitle(course, studentMap, groupMap)
                  const subject = course.subject
                  const methodLabel = course.method === 'online' ? '线上授课' : '线下授课'
                  const billing = billingMeta(course, studentMap, groupMap)
                  const isPending = course.status === 'pending'
                  const showAction = isPending && meta.action
                  const actionIsCancel = meta.action === '取消课程'

                  return (
                    <div
                      key={course.id}
                      className={cn(
                        'relative grid grid-cols-[54px_1fr] gap-x-3 gap-y-2 overflow-hidden rounded-xl border border-line-1 px-3.5 py-3 shadow-sm transition-all hover:border-surface-3 hover:shadow-md md:flex md:flex-row md:items-center md:gap-4 md:px-5 md:py-4',
                        meta.row,
                      )}
                    >
                      <div className={cn('absolute bottom-0 left-0 top-0 w-1', meta.rail)} />

                      <div className="row-span-2 flex flex-col justify-center pl-0.5 tabular-nums md:row-span-1 md:w-24 md:justify-start md:pl-0">
                        <div className="text-[15px] font-semibold leading-none text-text-1 md:text-[17px]">{formatTime(start)}</div>
                        <div className="mt-1 text-[12px] font-medium text-text-2 md:text-[13px]">{formatTime(end)}</div>
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="mb-0.5 flex flex-wrap items-center gap-1.5 md:mb-1.5 md:gap-2.5">
                          <span className="min-w-0 text-[14px] font-semibold leading-5 text-text-1 md:text-[15px] md:leading-6">{title}</span>
                          <span className="inline-flex items-center rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent-text md:text-[11px]">{subject}</span>
                          {course.isMakeup && (
                            <span className="inline-flex items-center rounded-md bg-pending-soft px-1.5 py-0.5 text-[10px] font-medium text-pending md:text-[11px]">补课时</span>
                          )}
                          <span className="inline-flex items-center rounded-md border border-line-1 bg-surface-0 px-1.5 py-0.5 text-[10px] text-text-2 md:text-[11px]">{methodLabel}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] font-medium text-text-2 md:gap-x-2 md:text-[13px]">
                          <span>{courseDurationMin(course, groupMap)}分钟</span>
                          <span className="text-text-3">•</span>
                          <span>{billing}</span>
                          <span className="text-text-3">•</span>
                          <span className={meta.hint}>{timeHintText(state, data.now, start, end)}</span>
                        </div>
                      </div>

                      <div className="flex shrink-0 flex-wrap items-center gap-2 md:justify-end md:gap-3">
                        <span className={cn('inline-flex min-w-[64px] items-center gap-1 text-[12px] font-semibold md:min-w-[70px] md:gap-1.5 md:text-[13px]', meta.statusClass)}>
                          <Icon size={14} className="md:size-4" /> {meta.badgeText}
                        </span>
                        {showAction ? (
                          <button
                            type="button"
                            onClick={() => (actionIsCancel ? quickCancel(course) : quickComplete(course))}
                            className={cn(
                              'inline-flex h-7 items-center gap-1 rounded-full px-3 text-[11px] font-semibold transition-opacity md:h-8 md:px-4 md:text-[12px]',
                              actionIsCancel
                                ? 'border border-line-1 bg-surface-0 text-text-1 hover:bg-surface-2'
                                : 'bg-accent text-white hover:bg-accent-hover',
                            )}
                          >
                            {actionIsCancel ? <X size={11} /> : <Check size={11} />}
                            {meta.action}
                          </button>
                        ) : null}
                        <Link to="/schedule" className="inline-flex h-7 items-center rounded-full border border-line-1 bg-surface-0 px-3 text-[11px] font-medium text-text-2 hover:bg-surface-2 md:h-8 md:px-4 md:text-[12px]">
                          编辑
                        </Link>
                      </div>
                    </div>
                  )
                })}
          </div>
        )}
      </section>

      {/* 今日待处理：整行通栏，内部按「课程信息 / 学生信息」分两栏 */}
      <Card className="p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-text-1">今日待处理</h2>
            <p className="mt-1 text-[12px] leading-5 text-text-2">
              左栏为课后反馈等课程信息，右栏为学生课时等学生信息；滚动可查看全部。
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent-text">
            {todos.length === 0 ? '已清空' : `共 ${todos.length} 条`}
          </span>
        </div>

        {todos.length === 0 ? (
          <div className="rounded-lg border border-line-1 bg-surface-2/40 px-5 py-10 text-center">
            <div className="text-[14px] font-semibold text-text-1">今天没有待处理事项</div>
            <div className="mt-1 text-[12px] leading-5 text-text-2">课程、沟通、反馈和财务动作都会在这里统一提醒。</div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-2">
            <TodoColumn title="课程信息" hint="课后反馈 · 待补录" items={courseTodos} />
            <TodoColumn title="学生信息" hint="课时余额 · 试听跟进" items={studentTodos} divider />
          </div>
        )}
      </Card>

      {/* 本周概览 */}
      <Card className="p-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-[15px] font-semibold text-text-1">本周概览</h2>
              <span className="text-[12px] font-medium text-text-2">{weeklyCourseCount} 节</span>
            </div>

            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <div className="text-[12px] font-medium text-text-2">本周课时</div>
                <div className="mt-1 text-[22px] font-semibold leading-none text-text-1 tabular-nums">{weeklyCourseCount}</div>
              </div>
              <div className="text-right">
                <div className="text-[12px] font-medium text-text-2">
                  {hoveredWeekBar != null ? (weeklyBars[hoveredWeekBar]?.active ? '今天' : `周${weeklyBars[hoveredWeekBar]?.day}`) : '本周'}
                </div>
                <div className="mt-1 text-[14px] font-semibold text-text-1">
                  {hoveredWeekBar != null ? `${weeklyBars[hoveredWeekBar]?.count ?? 0} 节课` : '本周排课'}
                </div>
              </div>
            </div>

            <BarChart
              data={weeklyBars.map<BarDatum>((bar) => ({
                label: bar.active ? '今天' : `周${bar.day}`,
                value: bar.count,
                active: bar.active,
                suffix: '节',
              }))}
              variant="accent"
              onHoverChange={setHoveredWeekBar}
            />
      </Card>

      <AttendanceModal
        course={attendanceFor}
        students={Array.from(studentMap.values())}
        groupMembers={liveMembers}
        groups={Array.from(groupMap.values())}
        attendances={liveAttendances}
        onClose={() => setAttendanceFor(null)}
        onSave={async (courseId, atts) => persistAttendance(courseId, atts)}
        onComplete={async (course) => {
          await completeCourseWithAttendance(course, liveMembers, studentMap, groupMap)
          setAttendanceFor(null)
        }}
      />
    </div>
  )
}

/** 课程标题：优先学生名，其次班课名 */
function courseTitle(
  course: Course,
  studentMap: Map<string, Student>,
  groupMap: Map<string, Group>,
): string {
  if (course.studentId && studentMap.get(course.studentId)) {
    return studentMap.get(course.studentId)!.name
  }
  if (course.groupId && groupMap.get(course.groupId)) {
    return groupMap.get(course.groupId)!.name
  }
  return course.groupId ? '班课' : '课程'
}

/** 结算/计费元信息 */
function billingMeta(
  course: Course,
  studentMap: Map<string, Student>,
  groupMap: Map<string, Group>,
): string {
  if (course.groupId) {
    const g = groupMap.get(course.groupId)
    const fee = g?.perStudentFeeCents ?? 0
    return `班课${fee > 0 ? ` · ¥${Math.round(fee / 100)}/人` : ''}`
  }
  const s = course.studentId ? studentMap.get(course.studentId) : null
  if (!s) return '—'
  if (s.isTrial) return '试听'
  if (s.billingRule === 'prepaid') return '预付 · 扣课时'
  const fee = course.feeCents
  return fee > 0 ? `后付 · ¥${Math.round(fee / 100)}` : '按次后付'
}
