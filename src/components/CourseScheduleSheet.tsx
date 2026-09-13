/**
 * 单个课程「一键查看」侧拉 Sheet
 *
 * 点击课表课程块后打开：展示与该节课同属一个对象（该学生 / 该班课）的
 * 全部排课情况（全时段倒序），可：
 *  - 月份 / 状态 筛选 + 分页加载更多
 *  - 多选（含「全选当前结果 / 全不选 / 反选」）→ 批量标记状态或彻底删除
 *  - 逐行「编辑」→ 回到 CourseScheduleModal
 *  - 顶部「排新课」→ 预填该学生 / 班课
 *
 * 依赖父层传入的 studentMap / groupMap（避免重复 live 查询），课程列表在本组件内查询并过滤。
 */
import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { CalendarPlus, ChevronDown, ChevronLeft, ChevronRight, Filter, Pencil, Plus, Trash2, X } from 'lucide-react'
import { format, parse } from 'date-fns'
import { db } from '@/lib/db'
import { hardDeleteCourses } from '@/lib/batchDelete'
import { Badge, Button, StatusBadge } from '@/components/ui'
import {
  COURSE_STATUS_LABEL,
  type Course,
  type CourseStatus,
  type Group,
  type Student,
} from '@/lib/types'
import { cn, formatCourseRange, subjectColorVar } from '@/lib/utils'
import { courseTitle } from '@/pages/schedule-helpers'
import { revertCompletion, summarizeRevert, type RevertResult } from '@/lib/courseCompletion'

/** 每页显示多少条 */
const PAGE_SIZE = 20

export interface CourseScheduleSheetProps {
  /** 点击的课程；null 表示关闭 */
  course: Course | null
  studentMap: Map<string, Student>
  groupMap: Map<string, Group>
  onClose: () => void
  /** 打开某节课的编辑弹窗 */
  onEdit: (c: Course) => void
  /** 为该对象排新课（预填学生或班课） */
  onCreate: (studentId: string | null, groupId: string | null) => void
  /** 快速标记完成（先选出席） */
  onToggleDone: (c: Course) => void
  /**
   * 批量「标为完成」：把这些课交给上层弹一次「出席选择」再统一结算。
   * （本组件不自行结算，避免绕过出席选择）
   */
  onBatchComplete: (courses: Course[]) => void
  /** 打开班课详情（仅班课范围可用；学生范围可忽略） */
  onOpenGroup?: (groupId: string) => void
}

const STATUS_ACTIONS: { status: CourseStatus; label: string }[] = [
  { status: 'done', label: '完成' },
  { status: 'pending', label: '待上' },
  { status: 'cancelled', label: '取消' },
  { status: 'leave', label: '请假' },
]

const STATUS_FILTERS: { value: 'all' | CourseStatus; label: string }[] = [
  { value: 'all', label: '全部状态' },
  { value: 'pending', label: COURSE_STATUS_LABEL.pending },
  { value: 'done', label: COURSE_STATUS_LABEL.done },
  { value: 'cancelled', label: COURSE_STATUS_LABEL.cancelled },
  { value: 'leave', label: COURSE_STATUS_LABEL.leave },
]

/** 把 ts 转成 yyyy-MM */
function ymKey(ts: number): string {
  return format(new Date(ts), 'yyyy-MM')
}

export function CourseScheduleSheet({
  course,
  studentMap,
  groupMap,
  onClose,
  onEdit,
  onCreate,
  onToggleDone,
  onBatchComplete,
  onOpenGroup,
}: CourseScheduleSheetProps) {
  const open = course !== null

  const allCourses = useLiveQuery<Course[]>(
    () => (open ? db.courses.toArray() : Promise.resolve([] as Course[])),
    [open],
  )

  // 多选 + 筛选 + 分页
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [monthFilter, setMonthFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | CourseStatus>('all')
  const [page, setPage] = useState(1)

  // 该课程所属范围：同学生 或 同班课
  const scope = useMemo(() => {
    if (!open || !course) return null
    const pid = course.studentId ?? course.groupId
    if (!pid) return null
    const isStudent = Boolean(course.studentId)
    const list = (allCourses ?? [])
      .filter((c) => !c.deletedAt && (isStudent ? c.studentId === pid : c.groupId === pid))
      .sort((a, b) => b.startAt - a.startAt)
    return { pid, isStudent, list }
  }, [open, course, allCourses])

  // 可用月份（从范围列表里抽出所有 YYYY-MM，倒序去重）
  const availableMonths = useMemo(() => {
    if (!scope) return [] as string[]
    const set = new Set<string>()
    for (const c of scope.list) set.add(ymKey(c.startAt))
    return Array.from(set).sort((a, b) => (a < b ? 1 : -1))
  }, [scope])

  // 切课程 / 关闭 → 重置筛选与多选
  useEffect(() => {
    setSelectMode(false)
    setSelected(new Set())
    setMonthFilter('all')
    setStatusFilter('all')
    setPage(1)
  }, [course?.id, open])

  // 选中条件下筛选后的列表（不含分页）
  const filteredList = useMemo(() => {
    if (!scope) return [] as Course[]
    return scope.list.filter((c) => {
      if (monthFilter !== 'all' && ymKey(c.startAt) !== monthFilter) return false
      if (statusFilter !== 'all' && c.status !== statusFilter) return false
      return true
    })
  }, [scope, monthFilter, statusFilter])

  // 分页
  const visibleList = useMemo(
    () => filteredList.slice(0, page * PAGE_SIZE),
    [filteredList, page],
  )
  const hasMore = visibleList.length < filteredList.length

  // 统计（基于全部 scope 列表，不受筛选影响，确保头部徽章始终有意义）
  const summary = useMemo(() => {
    if (!scope) return { total: 0, done: 0, pending: 0, cancelled: 0 }
    const total = scope.list.length
    const done = scope.list.filter((c) => c.status === 'done').length
    const pending = scope.list.filter((c) => c.status === 'pending' || c.status === 'leave').length
    const cancelled = scope.list.filter((c) => c.status === 'cancelled').length
    return { total, done, pending, cancelled }
  }, [scope])

  // 多选辅助：当前可见（已筛选 + 已分页）课程的 ID 集合
  const visibleIds = useMemo(() => new Set(visibleList.map((c) => c.id)), [visibleList])

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 在「当前过滤结果」上加入选中范围（不是全表） */
  function selectAllCurrent() {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of visibleIds) next.add(id)
      return next
    })
  }
  function deselectAll() {
    setSelected(new Set())
  }
  function invertCurrent() {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of visibleIds) {
        if (next.has(id)) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  /** 批量标记状态 */
  async function batchSetStatus(status: CourseStatus) {
    if (!scope || selected.size === 0) return
    const targets = scope.list.filter((c) => selected.has(c.id))

    // 1) 撤销完成（done → 非 done）：归还课时 / 撤销结算 / 回收自动生成的打卡与课堂活动
    //    （不能直接 bulkPut 覆盖，否则课时与自动任务不会回滚）
    const reverts = targets.filter((c) => c.status === 'done' && status !== 'done')
    const total: RevertResult = {
      restoredHours: 0,
      removedSettlements: 0,
      removedCheckInTasks: 0,
      removedClassActivities: 0,
    }
    for (const c of reverts) {
      const r = await revertCompletion(c.id)
      total.restoredHours += r.restoredHours
      total.removedSettlements += r.removedSettlements
      total.removedCheckInTasks += r.removedCheckInTasks
      total.removedClassActivities += r.removedClassActivities
    }

    // 2) 标记完成（非 done → done）：不在这里直接结算，而是交给上层
    //    弹一次「出席选择」，按实际出席统一结算（与单节完成同一套流程）
    const completions = status === 'done' ? targets.filter((c) => c.status !== 'done') : []

    // 3) 其余目标直接改状态（如 pending/cancelled/leave，或本来就已完成）
    const handled = new Set([...reverts, ...completions].map((c) => c.id))
    const rest = targets.filter((c) => !handled.has(c.id))
    if (rest.length > 0) {
      const now = Date.now()
      await db.courses.bulkPut(rest.map((c) => ({ ...c, status, updatedAt: now, dirty: 1 })))
    }

    setSelected(new Set())
    setSelectMode(false)

    // 先汇报「取消完成」的回滚结果（完成则交由出席弹窗确认，无需再弹提示）
    const msg = summarizeRevert(total)
    if (msg) window.alert(msg)

    if (completions.length > 0) onBatchComplete(completions)
  }

  /** 批量彻底删除 */
  async function batchDelete() {
    if (!scope || selected.size === 0) return
    const ids = Array.from(selected)
    const labels = scope.list
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
    setSelected(new Set())
    setSelectMode(false)
  }

  // ESC 关闭
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // 月份下拉显示标签
  function monthLabel(ym: string): string {
    const d = parse(ym, 'yyyy-MM', new Date())
    return format(d, 'yyyy 年 M 月')
  }

  if (!open || !course) return null

  const title = courseTitle(course, studentMap, groupMap)
  const sub = course.subject || (course.groupId ? '班课' : '课')

  return (
    <div className="fixed inset-0 z-50">
      {/* 背景遮罩 */}
      <button
        aria-label="关闭"
        onClick={onClose}
        className="absolute inset-0 bg-black/30 transition-opacity"
      />

      {/* 侧拉容器：右侧滑入 */}
      <aside
        className={cn(
          'absolute right-0 top-0 flex h-full w-full max-w-[640px] flex-col bg-surface-0 shadow-2xl transition-transform',
          'animate-slide-in-right',
        )}
        role="dialog"
        aria-modal="true"
        aria-label={`${title} 排课明细`}
      >
        {/* 头部 */}
        <header className="flex items-start justify-between gap-3 border-b border-line-1 px-4 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <button
              type="button"
              disabled={!scope?.isStudent ? false : true}
              onClick={() => {
                if (scope && !scope.isStudent && onOpenGroup) onOpenGroup(scope.pid!)
              }}
              className={cn(
                'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white',
                scope && !scope.isStudent && onOpenGroup && 'cursor-pointer hover:opacity-90',
              )}
              style={{ background: subjectColorVar(course.colorSlot) }}
              aria-label="班课详情"
              title={scope && !scope.isStudent && onOpenGroup ? '点击打开班课详情' : ''}
            >
              <span className="text-[15px] font-bold">{sub.slice(0, 1)}</span>
            </button>
            <div className="min-w-0">
              <h2 className="truncate text-[16px] font-semibold text-text-1">{title}</h2>
              <p className="mt-0.5 truncate text-[12px] text-text-2">
                {sub} · 共 {summary.total} 节 · 已完成 {summary.done} · 待上 {summary.pending}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge variant="neutral">{summary.total} 节</Badge>
                <Badge variant="success">完成 {summary.done}</Badge>
                <Badge variant="warning">待上 {summary.pending}</Badge>
                {summary.cancelled > 0 && <Badge variant="danger">取消 {summary.cancelled}</Badge>}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => onToggleDone(course)}>
              完成
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() =>
                onCreate(scope?.isStudent ? (scope.pid ?? null) : null, scope && !scope.isStudent ? (scope.pid ?? null) : null)
              }
            >
              <Plus size={14} />
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

        {/* 多选批量操作条 */}
        {selectMode && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-line-1 bg-surface-1 px-4 py-2.5">
            <span className="mr-1 text-[13px] font-medium text-text-1">
              {selected.size > 0 ? `已选 ${selected.size} 节` : '勾选课程'}
            </span>

            {/* 当前过滤结果的全选 / 反选 / 全不选 */}
            <span className="mx-1 h-4 w-px bg-line-2" />
            <button
              type="button"
              onClick={selectAllCurrent}
              disabled={visibleIds.size === 0}
              className="inline-flex items-center gap-1 rounded-lg bg-accent-soft px-2 py-1 text-[12px] font-medium text-accent-text hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              title="勾选当前筛选/分页下显示的全部课程"
            >
              全选当前结果 {visibleIds.size > 0 ? `(${visibleIds.size})` : ''}
            </button>
            <button
              type="button"
              onClick={invertCurrent}
              disabled={visibleIds.size === 0}
              className="rounded-lg bg-surface-2 px-2 py-1 text-[12px] font-medium text-text-2 hover:bg-surface-3 hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-40"
              title="在当前过滤结果上做反选"
            >
              反选当前
            </button>
            <button
              type="button"
              onClick={deselectAll}
              disabled={selected.size === 0}
              className="rounded-lg bg-surface-2 px-2 py-1 text-[12px] font-medium text-text-2 hover:bg-surface-3 hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-40"
            >
              全不选
            </button>

            <span className="mx-1 h-4 w-px bg-line-2" />
            {STATUS_ACTIONS.map((a) => (
              <button
                key={a.status}
                type="button"
                disabled={selected.size === 0}
                onClick={() => void batchSetStatus(a.status)}
                className={cn(
                  'rounded-lg px-2.5 py-1 text-[12px] font-medium transition-colors',
                  'bg-surface-2 text-text-2 hover:bg-surface-3 hover:text-text-1',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                )}
              >
                标为{a.label}
              </button>
            ))}
            <button
              type="button"
              disabled={selected.size === 0}
              onClick={() => void batchDelete()}
              className="inline-flex items-center gap-1 rounded-lg bg-money-out px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 size={13} />
              删除
            </button>
            <button
              type="button"
              onClick={() => setSelectMode(false)}
              className="ml-auto rounded-lg px-2.5 py-1 text-[12px] font-medium text-text-2 hover:bg-surface-2"
            >
              取消
            </button>
          </div>
        )}

        {/* 筛选条 */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line-1 px-4 py-2.5">
          <Filter size={14} className="text-text-3" />
          <span className="text-[12px] text-text-2">筛选：</span>

          {/* 月份下拉 */}
          <label className="flex items-center gap-1 rounded-lg bg-surface-1 px-2 py-1 text-[12px] text-text-2">
            月份
            <select
              value={monthFilter}
              onChange={(e) => {
                setMonthFilter(e.target.value)
                setPage(1)
              }}
              className="bg-transparent text-text-1 outline-none"
            >
              <option value="all">全部月份</option>
              {availableMonths.map((m) => (
                <option key={m} value={m}>
                  {monthLabel(m)}
                </option>
              ))}
            </select>
            <ChevronDown size={12} className="text-text-3" />
          </label>

          {/* 状态 chips */}
          <div className="flex flex-wrap items-center gap-1">
            {STATUS_FILTERS.map((s) => {
              const active = statusFilter === s.value
              return (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => {
                    setStatusFilter(s.value)
                    setPage(1)
                  }}
                  className={cn(
                    'rounded-full px-2.5 py-0.5 text-[11.5px] font-medium transition-colors',
                    active
                      ? 'bg-accent text-white'
                      : 'bg-surface-1 text-text-2 hover:bg-surface-2 hover:text-text-1',
                  )}
                >
                  {s.label}
                </button>
              )
            })}
          </div>

          <span className="ml-auto text-[12px] text-text-3">
            匹配 {filteredList.length} / {summary.total} 节
          </span>
        </div>

        {/* 课程列表 */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {filteredList.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-[15px] font-medium text-text-1">暂无匹配的排课记录</p>
              <p className="mt-1 text-sm text-text-2">调整筛选条件，或点击右上角「排新课」</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {visibleList.map((c) => {
                const isSelected = selected.has(c.id)
                const color = subjectColorVar(c.colorSlot)
                return (
                  <li
                    key={c.id}
                    className={cn(
                      'flex items-center gap-3 rounded-xl border border-line-1 bg-surface-0 p-3 transition-colors',
                      isSelected && 'border-accent ring-2 ring-accent',
                    )}
                  >
                    {/* 多选框 */}
                    {selectMode && (
                      <button
                        type="button"
                        onClick={() => toggleSelect(c.id)}
                        aria-label={isSelected ? '取消选择' : '选择'}
                        className={cn(
                          'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border',
                          isSelected
                            ? 'border-accent bg-accent text-white'
                            : 'border-line-2 bg-surface-0',
                        )}
                      >
                        {isSelected && <X size={12} />}
                      </button>
                    )}

                    {/* 日期块 */}
                    <div className="w-14 shrink-0 text-center">
                      <div className="text-[13px] font-semibold tabular-nums text-text-1">
                        {format(new Date(c.startAt), 'M/d')}
                      </div>
                      <div className="text-[11px] text-text-3">
                        {format(new Date(c.startAt), 'EEEEE')}
                      </div>
                    </div>

                    {/* 状态色条 */}
                    <span
                      className="h-9 w-1 shrink-0 rounded-full"
                      style={{ background: color }}
                    />

                    {/* 信息 */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium tabular-nums text-text-1">
                          {formatCourseRange(c, groupMap)}
                        </span>
                        <StatusBadge status={c.status} />
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 truncate text-[12px] text-text-2">
                        {c.subject}
                        {c.isMakeup && <Badge variant="warning">补课</Badge>}
                        {c.method === 'online' && <Badge variant="neutral">线上</Badge>}
                        {c.groupId && c.feeCents > 0 && (
                          <span className="tabular-nums">¥{Math.round(c.feeCents / 100)}</span>
                        )}
                      </div>
                    </div>

                    {/* 操作 */}
                    <div className="flex shrink-0 items-center gap-1">
                      {!selectMode && (
                        <button
                          type="button"
                          onClick={() => onEdit(c)}
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-text-2 hover:bg-surface-2 hover:text-text-1"
                        >
                          <Pencil size={13} />
                          编辑
                        </button>
                      )}
                      {selectMode && (
                        <button
                          type="button"
                          onClick={() => toggleSelect(c.id)}
                          aria-label="查看"
                          className="inline-flex h-7 items-center rounded-lg px-2 text-[12px] font-medium text-text-2 hover:bg-surface-2 hover:text-text-1"
                        >
                          {isSelected ? '取消' : '选择'}
                        </button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {/* 分页：加载更多 */}
          {hasMore && (
            <div className="mt-3 flex flex-col items-center gap-1">
              <button
                type="button"
                onClick={() => setPage((p) => p + 1)}
                className="inline-flex items-center gap-1 rounded-lg bg-surface-1 px-4 py-2 text-[13px] font-medium text-text-2 hover:bg-surface-2 hover:text-text-1"
              >
                <ChevronDown size={14} />
                加载更多 ({visibleList.length} / {filteredList.length})
              </button>
              <span className="text-[11px] text-text-3">
                每页 {PAGE_SIZE} 条，共 {Math.ceil(filteredList.length / PAGE_SIZE)} 页
              </span>
            </div>
          )}

          {/* 没有更多时给出尾部提示（仅在筛选后有结果但已加载完） */}
          {!hasMore && filteredList.length > PAGE_SIZE && (
            <div className="mt-2 flex items-center justify-center gap-1 text-[11px] text-text-3">
              <ChevronLeft size={12} />
              已显示全部 {filteredList.length} 节
              <ChevronRight size={12} />
            </div>
          )}
        </div>

        {/* 底部：进入/退出多选 + 提示 */}
        <footer className="border-t border-line-1 px-4 py-3 pb-safe">
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-text-3">
              {scope
                ? `该对象的全部排课 · ${summary.total} 节${monthFilter !== 'all' || statusFilter !== 'all' ? ` · 已筛 ${filteredList.length}` : ''}`
                : ''}
            </span>
            <Button
              size="sm"
              variant={selectMode ? 'primary' : 'ghost'}
              onClick={() => {
                setSelectMode((v) => !v)
                setSelected(new Set())
              }}
            >
              {selectMode ? '退出多选' : '批量操作'}
            </Button>
          </div>
          <p className="mt-1 flex items-center gap-1 text-[11px] text-text-3">
            <CalendarPlus size={11} />
            单击「编辑」进入单节修改；多选态支持「全选当前结果」「反选当前」。
          </p>
        </footer>
      </aside>
    </div>
  )
}
