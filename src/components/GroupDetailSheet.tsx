/**
 * 班课详情侧拉 Sheet
 *
 * 同 CourseScheduleSheet 同款容器。展示某个班课的：
 *  - 概览（成员数、总课次、完成 / 待上 / 课酬合计）
 *  - 排课（全部班课课程，倒序；每行可编辑、可跳转一键查看 Sheet）
 *  - 成员（学生列表，每行可打开学生详情 Sheet）
 *
 * 数据通过 props 注入，避免重复 live query。
 */
import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { format } from 'date-fns'
import {
  CalendarPlus,
  ChevronRight,
  Eye,
  Pencil,
  UserMinus,
  Users,
  X,
} from 'lucide-react'
import { Badge, Button, Input, Select, StatusBadge } from '@/components/ui'
import { Avatar } from '@/components/Avatar'
import { db, touch } from '@/lib/db'
import {
  COURSE_STATUS_LABEL,
  type Course,
  type CourseAttendance,
  type Group,
  type GroupMember,
  type Student,
} from '@/lib/types'
import { cn, formatCourseRange, subjectColorVar } from '@/lib/utils'

type Tab = 'overview' | 'courses' | 'members' | 'checkin'

const TAB_LABEL: Record<Tab, string> = {
  overview: '概览',
  courses: '排课',
  members: '成员',
  checkin: '打卡',
}

export interface GroupDetailSheetProps {
  groupId: string | null
  studentMap: Map<string, Student>
  onViewCourse: (c: Course) => void
  /** 调父层为该班课排新课 */
  onCreateCourse: (groupId: string) => void
  /** 调父层打开学生详情 Sheet */
  onViewStudent: (studentId: string) => void
  /** 调父层打开班课编辑弹窗（CourseScheduleModal 的班课模式） */
  onEditGroup?: (group: Group) => void
  onClose: () => void
}

export function GroupDetailSheet({
  groupId,
  studentMap,
  onViewCourse,
  onCreateCourse,
  onViewStudent,
  onEditGroup,
  onClose,
}: GroupDetailSheetProps) {
  const open = groupId !== null

  // 同步取班课详情
  const group = useLiveQuery<Group | null>(
    () => (groupId ? (db.groups.get(groupId) as Promise<Group | null>) : Promise.resolve(null)),
    [groupId],
  )

  // 排课列表
  const allCourses = useLiveQuery<Course[]>(
    () => (groupId ? db.courses.toArray() : Promise.resolve([] as Course[])),
    [groupId],
  )

  // 出席列表（用于统计）
  const allAttendances = useLiveQuery<CourseAttendance[]>(
    () => (groupId ? db.courseAttendances.toArray() : Promise.resolve([] as CourseAttendance[])),
    [groupId],
  )

  // 成员列表
  const allMembers = useLiveQuery<GroupMember[]>(
    () => (groupId ? db.groupMembers.toArray() : Promise.resolve([] as GroupMember[])),
    [groupId],
  )

  // 该班课的课程（按时间倒序）
  const courses = useMemo(() => {
    if (!open || !groupId) return [] as Course[]
    return (allCourses ?? [])
      .filter((c) => !c.deletedAt && c.groupId === groupId)
      .sort((a, b) => b.startAt - a.startAt)
  }, [allCourses, open, groupId])

  // 该班课的成员关系（live）+ 其 Student 详情（来自 props.map）
  const members = useMemo(() => {
    if (!open || !groupId) return [] as GroupMember[]
    return (allMembers ?? [])
      .filter((m) => !m.deletedAt && m.groupId === groupId)
      .sort((a, b) => a.joinedAt - b.joinedAt)
  }, [allMembers, open, groupId])

  const studentsInGroup = useMemo(
    () => members.map((m) => studentMap.get(m.studentId)).filter((s): s is Student => Boolean(s)),
    [members, studentMap],
  )

  // 统计
  const stats = useMemo(() => {
    let total = courses.length
    let done = 0
    let pending = 0
    let cancelled = 0
    let totalFeeCents = 0
    let doneFeeCents = 0
    const memberIds = new Set(members.map((m) => m.studentId))
    for (const c of courses) {
      if (c.status === 'done') done++
      else if (c.status === 'cancelled') cancelled++
      else pending++
      if (c.feeCents) {
        totalFeeCents += c.feeCents
        if (c.status === 'done') doneFeeCents += c.feeCents
      }
    }
    // 实际出席数 = done 课程的出席里属于本班成员的人数
    const attendances = allAttendances ?? []
    const doneAttended = attendances.filter(
      (a) =>
        a.present &&
        memberIds.has(a.studentId) &&
        courses.some((c) => c.id === a.courseId && c.status === 'done'),
    ).length
    return {
      total,
      done,
      pending,
      cancelled,
      totalFeeCents,
      doneFeeCents,
      doneAttended,
    }
  }, [courses, allAttendances, members])

  const groupMap = useMemo(
    () => (group ? new Map<string, Group>([[group.id, group]]) : new Map<string, Group>()),
    [group],
  )

  const [tab, setTab] = useState<Tab>('overview')

  // v8：班课「课后自动打卡」配置（可在「打卡」Tab 编辑）
  const [checkInAuto, setCheckInAuto] = useState(true)
  const [checkInDays, setCheckInDays] = useState(7)
  const [checkInStartOffset, setCheckInStartOffset] = useState(1)
  const [checkInSaved, setCheckInSaved] = useState(false)

  // 班课切换 / 配置变化时同步到本地表单
  useEffect(() => {
    if (!group) return
    setCheckInAuto(group.checkInAuto !== false)
    setCheckInDays(group.checkInDays ?? 7)
    setCheckInStartOffset(group.checkInStartOffset ?? 1)
    setCheckInSaved(false)
  }, [group?.id, group?.checkInAuto, group?.checkInDays, group?.checkInStartOffset])

  async function handleSaveCheckIn() {
    if (!group) return
    await db.groups.put(
      touch({
        ...group,
        checkInAuto,
        checkInDays: Math.max(1, Math.min(30, Math.floor(checkInDays) || 7)),
        checkInStartOffset: Math.max(
          0,
          Math.min(30, Math.floor(checkInStartOffset) || 0),
        ),
      }),
    )
    setCheckInSaved(true)
  }

  // 重置
  useEffect(() => {
    if (open) setTab('overview')
  }, [groupId, open])

  // ESC 关闭
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  // 无 group 时（理论上 live query 不应返回 undefined）
  if (group === undefined || group === null) {
    return (
      <div className="fixed inset-0 z-50">
        <button
          aria-label="关闭"
          onClick={onClose}
          className="absolute inset-0 bg-black/30"
        />
        <aside
          className={cn(
            'absolute right-0 top-0 flex h-full w-full max-w-[640px] flex-col bg-surface-0 shadow-2xl',
            'animate-slide-in-right',
          )}
          role="dialog"
        >
          <div className="flex flex-1 items-center justify-center text-sm text-text-3">
            {group === undefined ? '加载中…' : '该班课已不存在'}
          </div>
          <button
            aria-label="关闭"
            onClick={onClose}
            className="absolute right-3 top-3 rounded-md p-1.5 text-text-3 hover:bg-surface-2"
          >
            <X size={16} />
          </button>
        </aside>
      </div>
    )
  }

  const weekdayText =
    group.weekday >= 0
      ? `每周${'日一二三四五六'[group.weekday] ?? '?'}`
      : '手动排课'
  const timeText =
    group.startTimeMin >= 0 && group.endTimeMin > group.startTimeMin
      ? ` ${String(Math.floor(group.startTimeMin / 60)).padStart(2, '0')}:${String(group.startTimeMin % 60).padStart(2, '0')} – ${String(Math.floor(group.endTimeMin / 60)).padStart(2, '0')}:${String(group.endTimeMin % 60).padStart(2, '0')}`
      : ''

  const title = group.name || `班课 ${group.id.slice(0, 6)}`
  const sub = group.subject

  return (
    <div className="fixed inset-0 z-50">
      {/* 背景遮罩 */}
      <button aria-label="关闭" onClick={onClose} className="absolute inset-0 bg-black/30" />

      <aside
        className={cn(
          'absolute right-0 top-0 flex h-full w-full max-w-[640px] flex-col bg-surface-0 shadow-2xl',
          'animate-slide-in-right',
        )}
        role="dialog"
        aria-modal="true"
        aria-label={`${title} 班课详情`}
      >
        {/* 头部 */}
        <header className="flex items-start justify-between gap-3 border-b border-line-1 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-white"
              style={{ background: subjectColorVar(group.colorSlot) }}
            >
              <Users size={22} />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-[18px] font-semibold leading-tight text-text-1">
                {title}
              </h2>
              <p className="mt-1 truncate text-[12px] text-text-2">
                {sub} · {weekdayText}{timeText} · 单次 {group.defaultDurationMin} 分钟
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge variant="neutral">{stats.total} 节</Badge>
                <Badge variant="success">完成 {stats.done}</Badge>
                <Badge variant="warning">待上 {stats.pending}</Badge>
                {stats.cancelled > 0 && <Badge variant="danger">取消 {stats.cancelled}</Badge>}
                <Badge variant="neutral">
                  {studentsInGroup.length} 名成员
                </Badge>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {onEditGroup && (
              <Button size="sm" variant="ghost" onClick={() => onEditGroup(group)}>
                <Pencil size={13} />
                编辑
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={() => onCreateCourse(group.id)}>
              <CalendarPlus size={14} />
              排新课
            </Button>
            <button
              aria-label="关闭"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text-1"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        {/* Tab 栏 */}
        <div className="flex shrink-0 gap-1 border-b border-line-1 bg-surface-0 px-3">
          {(Object.keys(TAB_LABEL) as Tab[]).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={cn(
                'relative -mb-px px-3 py-2.5 text-[13px] font-medium transition-colors',
                tab === k ? 'text-accent-text' : 'text-text-2 hover:text-text-1',
              )}
            >
              {TAB_LABEL[k]}
              {tab === k && (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />
              )}
            </button>
          ))}
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto">
          {tab === 'overview' && (
            <div className="space-y-4 px-5 py-4">
              {/* 概览数字 */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard label="总课次" value={stats.total} />
                <StatCard label="已完成" value={stats.done} tone="success" />
                <StatCard label="待上 / 请假" value={stats.pending} tone="warning" />
                <StatCard label="已取消" value={stats.cancelled} tone="danger" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <StatCard
                  label="本期课酬合计"
                  value={`¥${Math.round(stats.totalFeeCents / 100)}`}
                  sub={`已完成 ¥${Math.round(stats.doneFeeCents / 100)}`}
                  tone="accent"
                />
                <StatCard
                  label="累计出席人次"
                  value={stats.doneAttended}
                  sub="已完成课程的成员出席数"
                  tone="accent"
                />
              </div>

              {/* 班课信息 */}
              <section className="rounded-xl border border-line-1 bg-surface-0 p-3">
                <div className="mb-2 text-[12px] font-medium text-text-3">班课信息</div>
                <dl className="grid grid-cols-2 gap-y-2 text-[13px]">
                  <dt className="text-text-3">科目</dt>
                  <dd className="text-text-1">{group.subject || '—'}</dd>
                  <dt className="text-text-3">每周开课</dt>
                  <dd className="text-text-1">{weekdayText}{timeText || ' 未设时间'}</dd>
                  <dt className="text-text-3">单次时长</dt>
                  <dd className="text-text-1">{group.defaultDurationMin} 分钟</dd>
                  <dt className="text-text-3">单次课酬</dt>
                  <dd className="text-text-1">
                    ¥{Math.round((group.perStudentFeeCents ?? 0) / 100)} / 学员
                  </dd>
                  <dt className="text-text-3">创建时间</dt>
                  <dd className="text-text-1">
                    {format(new Date(group.createdAt), 'yyyy-MM-dd HH:mm')}
                  </dd>
                  {group.note && (
                    <>
                      <dt className="text-text-3">备注</dt>
                      <dd className="text-text-1 whitespace-pre-wrap">{group.note}</dd>
                    </>
                  )}
                </dl>
              </section>
            </div>
          )}

          {tab === 'courses' && (
            <div className="px-4 py-3">
              {courses.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <p className="text-[15px] font-medium text-text-1">暂无该班课的排课记录</p>
                  <p className="mt-1 text-sm text-text-2">
                    点击右上角「排新课」为该班课安排课程
                  </p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {courses.map((c) => {
                    const memberCount = allMembers?.filter(
                      (m) => !m.deletedAt && m.groupId === groupId && studentsInGroup.some((s) => s.id === m.studentId),
                    ).length ?? 0
                    return (
                      <li
                        key={c.id}
                        className="flex items-center gap-3 rounded-xl border border-line-1 bg-surface-0 p-3"
                      >
                        {/* 日期块 */}
                        <div className="w-14 shrink-0 text-center">
                          <div className="text-[13px] font-semibold tabular-nums text-text-1">
                            {format(new Date(c.startAt), 'M/d')}
                          </div>
                          <div className="text-[11px] text-text-3">
                            {format(new Date(c.startAt), 'EEEEE')}
                          </div>
                        </div>
                        {/* 色条 */}
                        <span
                          className="h-9 w-1 shrink-0 rounded-full"
                          style={{ background: subjectColorVar(c.colorSlot) }}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-medium tabular-nums text-text-1">
                              {formatCourseRange(c, groupMap)}
                            </span>
                            <StatusBadge status={c.status} />
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 truncate text-[12px] text-text-2">
                            {c.subject}
                            {c.isMakeup && <Badge variant="warning">补课</Badge>}
                            {c.method === 'online' && <Badge variant="neutral">线上</Badge>}
                            <span className="tabular-nums">
                              {memberCount} 名学员 · ¥{Math.round(c.feeCents / 100)}
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => onViewCourse(c)}
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-text-2 hover:bg-surface-2 hover:text-text-1"
                        >
                          <Eye size={13} />
                          查看
                          <ChevronRight size={13} />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}

          {tab === 'checkin' && (
            <div className="px-5 py-4">
              <section className="rounded-xl border border-line-1 bg-surface-0 p-3">
                <div className="mb-3 text-[12px] font-medium text-text-3">课后自动打卡</div>

                <label className="flex items-start gap-2 text-[13px] text-text-1">
                  <input
                    type="checkbox"
                    checked={checkInAuto}
                    onChange={(e) => setCheckInAuto(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 accent-accent"
                  />
                  <span>
                    本班每次课完成后，自动为出勤学员生成周期打卡
                    <span className="block text-[11px] text-text-3">
                      关闭后需到「打卡」页手动创建任务。
                    </span>
                  </span>
                </label>

                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <span className="text-[12px] font-medium text-text-2">打卡天数</span>
                    <Input
                      type="number"
                      min={1}
                      max={30}
                      value={checkInDays}
                      disabled={!checkInAuto}
                      onChange={(e) => setCheckInDays(Number(e.target.value))}
                    />
                    <span className="block text-[11px] text-text-3">1 ~ 30 天</span>
                  </div>
                  <div className="space-y-1">
                    <span className="text-[12px] font-medium text-text-2">起始日</span>
                    <Select
                      value={String(checkInStartOffset)}
                      disabled={!checkInAuto}
                      onChange={(e) => setCheckInStartOffset(Number(e.target.value))}
                    >
                      <option value="0">下课当天开始</option>
                      <option value="1">次日起（默认）</option>
                      <option value="2">第 3 天起</option>
                      <option value="6">一周后起</option>
                    </Select>
                    <span className="block text-[11px] text-text-3">
                      从下课日往后推
                    </span>
                  </div>
                </div>

                <div className="mt-3 rounded-lg bg-surface-2 p-2.5 text-[12px] text-text-3">
                  当前设置：
                  {checkInAuto
                    ? `完成课程后生成 ${checkInDays} 天打卡，${
                        checkInStartOffset === 0
                          ? '下课当天'
                          : `第 ${checkInStartOffset + 1} 天`
                      }开始`
                    : '已关闭自动打卡'}
                </div>

                <div className="mt-3 flex items-center gap-2">
                  <Button size="sm" variant="primary" onClick={() => void handleSaveCheckIn()}>
                    保存打卡设置
                  </Button>
                  {checkInSaved && (
                    <span className="text-[12px] text-accent">已保存</span>
                  )}
                </div>
                <p className="mt-2 text-[11px] text-text-3">
                  设置只对之后完成的课程生效；已生成的打卡任务仍可在「打卡」页改日期。
                </p>
              </section>
            </div>
          )}

          {tab === 'members' && (
            <div className="px-4 py-3">
              {studentsInGroup.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <p className="text-[15px] font-medium text-text-1">本班暂无成员</p>
                  <p className="mt-1 text-sm text-text-2">去「班课」管理页为该班课添加学生</p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {studentsInGroup.map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center gap-3 rounded-xl border border-line-1 bg-surface-0 p-3"
                    >
                      <Avatar name={s.name} colorSlot={s.colorSlot} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[14px] font-medium text-text-1">
                            {s.name}
                          </span>
                          {s.isTrial && (
                            <Badge variant="warning">试听</Badge>
                          )}
                        </div>
                        <div className="mt-0.5 truncate text-[12px] text-text-2">
                          {[s.grade, s.academicLevel].filter(Boolean).join(' · ') || '未填年级'}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => onViewStudent(s.id)}
                        className="inline-flex items-center gap-1 rounded-lg bg-surface-1 px-2.5 py-1.5 text-[12px] font-medium text-text-2 hover:bg-surface-2 hover:text-text-1"
                      >
                        详情
                        <ChevronRight size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* 底部状态汇总 */}
        <footer className="border-t border-line-1 px-4 py-3 pb-safe">
          <div className="flex items-center justify-between gap-2 text-[11px] text-text-3">
            <span>
              {COURSE_STATUS_LABEL.done} {stats.done} · {COURSE_STATUS_LABEL.pending}{' '}
              {stats.pending} · 学员 {studentsInGroup.length}
            </span>
            <span>共计 {stats.total} 节</span>
          </div>
        </footer>
      </aside>
    </div>
  )
}

/** 内部小组件：概览数字块 */
function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string | number
  sub?: string
  tone?: 'success' | 'warning' | 'danger' | 'accent'
}) {
  const accent =
    tone === 'success'
      ? 'border-money-in/20 bg-money-in-soft/20'
      : tone === 'warning'
      ? 'border-pending/20 bg-pending-soft/30'
      : tone === 'danger'
      ? 'border-money-out/20 bg-money-out-soft/30'
      : tone === 'accent'
      ? 'border-accent/20 bg-accent-soft/40'
      : 'border-line-1 bg-surface-0'
  return (
    <div className={cn('rounded-xl border p-3', accent)}>
      <div className="text-[11px] text-text-3">{label}</div>
      <div className="mt-1 text-[20px] font-semibold tabular-nums text-text-1">{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-text-3">{sub}</div>}
    </div>
  )
}

// Unused in some trees
void subjectColorVar
void UserMinus
