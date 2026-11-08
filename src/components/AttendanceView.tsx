/**
 * 课表页「出勤」视图（v31.29）。
 *
 * 按课分组展示每节课的逐生出席情况，可查询；请假的自动关联后续补课并显示
 * 「请假，11.14 已补上」。计算口径统一走 lib/attendanceView.ts（纯只读）。
 * 只读展示，不写库、不影响课酬 / 课时 / 结算。
 */
import { useMemo, useState } from 'react'
import { format } from 'date-fns'
import { ArrowLeft, CalendarCheck, Search } from 'lucide-react'
import { Button, Card, Input, Select } from '@/components/ui'
import {
  buildCourseAttendanceCards,
  type AttendanceState,
  type CourseAttendanceCard,
  type AttendanceViewInput,
} from '@/lib/attendanceView'
import { cn } from '@/lib/utils'

type StatusFilter = 'all' | 'leave' | 'madeup' | 'pending'

const STATE_CLASS: Record<AttendanceState, string> = {
  present: 'bg-done-soft text-done',
  'leave-madeup': 'bg-accent-soft text-accent-text',
  'leave-planned': 'bg-pending-soft text-pending',
  leave: 'bg-leave-soft text-leave',
  pending: 'bg-surface-2 text-text-3',
  unrecorded: 'bg-surface-2 text-text-3',
  'course-leave': 'bg-leave-soft text-leave',
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

function dateLabel(ts: number): string {
  const d = new Date(ts)
  return `${format(d, 'yyyy-MM-dd')} 周${WEEKDAY[d.getDay()]} ${format(d, 'HH:mm')}`
}

export function AttendanceView({
  courses,
  students,
  groups,
  members,
  attendances,
  onBack,
}: AttendanceViewInput & { onBack: () => void }) {
  const [studentFilter, setStudentFilter] = useState('all')
  const [groupFilter, setGroupFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [keyword, setKeyword] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const cards = useMemo(
    () => buildCourseAttendanceCards({ courses, students, groups, members, attendances }),
    [courses, students, groups, members, attendances],
  )

  const filtered = useMemo<CourseAttendanceCard[]>(() => {
    const fromTs = from ? new Date(`${from}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY
    const toTs = to ? new Date(`${to}T23:59:59`).getTime() : Number.POSITIVE_INFINITY
    const kw = keyword.trim().toLowerCase()
    const out: CourseAttendanceCard[] = []
    for (const card of cards) {
      if (card.course.startAt < fromTs || card.course.startAt > toTs) continue
      if (groupFilter !== 'all' && card.course.groupId !== groupFilter) continue
      if (
        kw &&
        !`${card.title} ${card.targetLabel} ${card.rows.map((r) => r.name).join(' ')}`
          .toLowerCase()
          .includes(kw)
      ) {
        continue
      }
      let rows = card.rows
      if (studentFilter !== 'all') rows = rows.filter((r) => r.studentId === studentFilter)
      if (statusFilter === 'leave') rows = rows.filter((r) => r.state.startsWith('leave'))
      if (statusFilter === 'madeup') {
        rows = rows.filter((r) => r.state === 'leave-madeup' || r.state === 'leave-planned')
      }
      if (statusFilter === 'pending') {
        rows = rows.filter((r) => r.state === 'pending' || r.state === 'unrecorded')
      }
      if (rows.length === 0) continue
      out.push({
        ...card,
        rows,
        presentCount: rows.filter((r) => r.state === 'present').length,
        expectedCount: rows.length,
        leaveCount: rows.filter((r) => r.state.startsWith('leave')).length,
      })
    }
    return out
  }, [cards, from, to, groupFilter, studentFilter, statusFilter, keyword])

  const stats = useMemo(() => {
    let expected = 0
    let present = 0
    let leave = 0
    let madeup = 0
    let pendingMakeup = 0
    for (const card of filtered) {
      expected += card.expectedCount
      present += card.presentCount
      for (const r of card.rows) {
        if (r.state.startsWith('leave')) leave++
        if (r.state === 'leave-madeup') madeup++
        if (r.state === 'leave') pendingMakeup++
      }
    }
    return { lessons: filtered.length, expected, present, leave, madeup, pendingMakeup }
  }, [filtered])

  const resetFilters = () => {
    setStudentFilter('all')
    setGroupFilter('all')
    setStatusFilter('all')
    setKeyword('')
    setFrom('')
    setTo('')
  }

  return (
    <div className="space-y-3">
      {/* 标题 + 返回课表 */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-1 px-4 py-3">
          <div className="flex items-center gap-2">
            <CalendarCheck size={18} className="text-accent-text" />
            <h2 className="text-[15px] font-semibold text-text-1">上课出勤记录</h2>
            <span className="text-[12px] text-text-3">按课查询 · 请假自动关联后续补课</span>
          </div>
          <Button size="sm" variant="ghost" onClick={onBack}>
            <ArrowLeft size={15} /> 返回课表
          </Button>
        </div>

        {/* 查询条 */}
        <div className="grid grid-cols-2 gap-2 px-4 py-3 md:grid-cols-4 lg:grid-cols-6">
          <label className="col-span-1">
            <span className="mb-1 block text-[11px] text-text-3">学生</span>
            <Select value={studentFilter} onChange={(e) => setStudentFilter(e.target.value)}>
              <option value="all">全部学生</option>
              {students
                .filter((s) => !s.deletedAt)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.status === 'archived' ? '（已归档）' : ''}
                  </option>
                ))}
            </Select>
          </label>
          <label className="col-span-1">
            <span className="mb-1 block text-[11px] text-text-3">班课</span>
            <Select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
              <option value="all">全部班课</option>
              {groups
                .filter((g) => !g.deletedAt)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </Select>
          </label>
          <label className="col-span-1">
            <span className="mb-1 block text-[11px] text-text-3">状态</span>
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
              <option value="all">全部状态</option>
              <option value="leave">请假（含已补）</option>
              <option value="madeup">已排 / 已补上</option>
              <option value="pending">待点名 / 未记录</option>
            </Select>
          </label>
          <label className="col-span-1">
            <span className="mb-1 block text-[11px] text-text-3">开始日期</span>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="col-span-1">
            <span className="mb-1 block text-[11px] text-text-3">结束日期</span>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label className="col-span-2 md:col-span-1">
            <span className="mb-1 block text-[11px] text-text-3">关键词</span>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-3" />
              <Input
                className="pl-8"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="科目 / 姓名"
              />
            </div>
          </label>
        </div>

        {/* 统计条 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line-1 bg-surface-2/50 px-4 py-2.5 text-[12px] text-text-2">
          <span>
            共 <b className="text-text-1 tabular-nums">{stats.lessons}</b> 节课
          </span>
          <span>
            应到 <b className="text-text-1 tabular-nums">{stats.expected}</b>
          </span>
          <span>
            实到 <b className="text-done tabular-nums">{stats.present}</b>
          </span>
          <span>
            请假 <b className="text-leave tabular-nums">{stats.leave}</b>
          </span>
          <span>
            已补上 <b className="text-accent-text tabular-nums">{stats.madeup}</b>
          </span>
          <span>
            待补 <b className="text-leave tabular-nums">{stats.pendingMakeup}</b>
          </span>
          <button
            type="button"
            onClick={resetFilters}
            className="ml-auto text-[12px] text-accent-text hover:underline"
          >
            清空筛选
          </button>
        </div>
      </Card>

      {/* 按课分组卡片 */}
      {filtered.length === 0 ? (
        <Card className="px-4 py-10 text-center text-[13px] text-text-3">
          没有符合条件的出勤记录。可清空筛选，或先完成上课点名后再查询。
        </Card>
      ) : (
        <div className="space-y-2.5">
          {filtered.map((card) => (
            <Card key={card.course.id} className="overflow-hidden">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line-1 bg-surface-2/40 px-4 py-2.5">
                <span className="text-[13px] font-semibold tabular-nums text-text-1">
                  {dateLabel(card.course.startAt)}
                </span>
                <span className="text-[13px] font-medium text-text-1">{card.title}</span>
                <span className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] text-text-2">
                  {card.targetLabel}
                </span>
                <span className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] text-text-2">
                  {card.typeLabel}
                </span>
                <span className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] text-text-2">
                  {card.statusLabel}
                </span>
                <span className="ml-auto text-[11px] text-text-3">
                  实到 {card.presentCount} / 应到 {card.expectedCount}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1.5 px-4 py-3 sm:grid-cols-3 lg:grid-cols-4">
                {card.rows.map((r) => (
                  <div
                    key={r.studentId}
                    className="flex min-w-0 items-center gap-1.5 rounded-lg border border-line-1 bg-surface-0 px-2 py-1.5"
                  >
                    <span className="truncate text-[12px] font-medium text-text-1" title={r.name}>
                      {r.name}
                    </span>
                    {r.archived && (
                      <span className="shrink-0 text-[10px] text-text-3">已归档</span>
                    )}
                    <span
                      className={cn(
                        'ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                        STATE_CLASS[r.state],
                      )}
                    >
                      {r.label}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
