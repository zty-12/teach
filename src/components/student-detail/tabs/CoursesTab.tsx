/**
 * 学生详情 - 排课记录 Tab
 *
 * 该学生的全部排课（包含作为班课成员参与的部分），按时间倒序。
 * 每行展示日期 / 课程类型 / 科目 / 时长 / 状态 / 课酬。
 */
import { useMemo } from 'react'
import {
  COURSE_STATUS_LABEL,
  type Course,
  type CourseAttendance,
  type Group,
} from '@/lib/types'
import { cn, formatMoney } from '@/lib/utils'

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-pending-soft text-pending',
  done: 'bg-done-soft text-done',
  cancelled: 'bg-surface-3 text-text-2',
  leave: 'bg-leave-soft text-leave',
}

export function CoursesTab({
  studentId,
  courses,
  attendances,
  groups,
}: {
  studentId: string
  courses: Course[]
  attendances: CourseAttendance[]
  groups: Group[]
}) {
  const groupMap = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])
  const myAttendByCourse = useMemo(() => {
    const map = new Map<string, CourseAttendance>()
    for (const a of attendances) {
      if (a.studentId === studentId) map.set(a.courseId, a)
    }
    return map
  }, [attendances, studentId])

  const doneCount = courses.filter((c) => c.status === 'done').length
  const totalMin = courses
    .filter((c) => c.status === 'done')
    .reduce((s, c) => s + c.durationMin, 0)
  const makeupCount = courses.filter((c) => c.isMakeup).length

  if (courses.length === 0) {
    return (
      <div className="p-8 text-center text-[13px] text-text-3">
        还没有排课记录
      </div>
    )
  }

  return (
    <div className="p-4">
      {/* 汇总 */}
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Stat label="总课次" value={String(courses.length)} />
        <Stat label="已完成" value={`${doneCount} 课时`} />
        <Stat label="补课时" value={String(makeupCount)} tone={makeupCount > 0 ? 'accent' : 'default'} />
      </div>

      <div className="text-[11px] text-text-3">
        累计时长：{Math.floor(totalMin / 60)} 小时 {totalMin % 60 > 0 ? `${totalMin % 60} 分` : ''}
      </div>

      {/* 列表 */}
      <ul className="mt-3 space-y-1.5">
        {courses.map((c) => {
          const group = c.groupId ? groupMap.get(c.groupId) : null
          const att = myAttendByCourse.get(c.id)
          const present = att?.present
          return (
            <li
              key={c.id}
              className="rounded-lg border border-line-1 bg-surface-0 p-3 transition-colors hover:bg-surface-1"
            >
              <div className="flex items-start gap-2.5">
                {/* 日期块 */}
                <div className="flex w-12 shrink-0 flex-col items-center justify-center rounded-md bg-surface-2 py-1 text-text-1">
                  <span className="text-[16px] font-semibold leading-none tabular-nums">
                    {new Date(c.startAt).getDate()}
                  </span>
                  <span className="mt-0.5 text-[10px] text-text-3">
                    {`${new Date(c.startAt).getMonth() + 1}月`}
                  </span>
                </div>

                {/* 内容 */}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-semibold text-text-1">{c.subject}</span>
                    {group && (
                      <span className="inline-flex items-center rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-text-2">
                        {group.name}
                      </span>
                    )}
                    {c.isMakeup && (
                      <span className="inline-flex items-center rounded-md bg-pending-soft px-1.5 py-0.5 text-[10px] font-medium text-pending">
                        补课
                      </span>
                    )}
                    <span
                      className={cn(
                        'inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium',
                        STATUS_CLASS[c.status],
                      )}
                    >
                      {COURSE_STATUS_LABEL[c.status]}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12px] text-text-2">
                    {formatTime(c.startAt)} · {c.durationMin} 分钟
                    {c.location && ` · ${c.location}`}
                  </p>
                  {att && (
                    <p
                      className={cn(
                        'mt-0.5 text-[11px]',
                        present ? 'text-done' : 'text-leave',
                      )}
                    >
                      {present ? '✓ 已出席' : '✗ 请假'}
                    </p>
                  )}
                  {c.status === 'done' && c.feeCents > 0 && (
                    <p className="mt-0.5 text-[11px] text-money-in">
                      课酬 {formatMoney(c.feeCents)}
                    </p>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string
  tone?: 'default' | 'accent'
}) {
  return (
    <div className="rounded-lg border border-line-1 bg-surface-0 px-3 py-2 text-center">
      <p className="text-[11px] text-text-3">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-[16px] font-semibold tabular-nums',
          tone === 'accent' ? 'text-accent-text' : 'text-text-1',
        )}
      >
        {value}
      </p>
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}