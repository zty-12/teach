import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Archive,
  CalendarPlus,
  Check,
  Download,
  Eye,
  Plus,
  Search,
  Trash2,
  Users,
} from 'lucide-react'
import { db, ensureGroupMember, newId, touch, withSyncFields } from '@/lib/db'
import { hardDeleteStudents } from '@/lib/batchDelete'
import { useBreakpoint } from '@/hooks/useBreakpoint'
import {
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  SegmentedControl,
  Select,
} from '@/components/ui'
import { Avatar } from '@/components/Avatar'
import { ColorPicker } from '@/components/ColorPicker'
import { StudentStatusBadge } from '@/components/StudentStatusBadge'
import { TagBadgeList } from '@/components/TagBadge'
import { ModalFooter } from '@/components/ModalFooter'
import { StudentDetailSheet } from '@/components/student-detail/StudentDetailSheet'
import { CourseScheduleModal } from '@/components/CourseScheduleModal'
import {
  STUDENT_STATUS_LABEL,
  type BillingRule,
  type Course,
  type Group,
  type GroupMember,
  type LearningTag,
  type Student,
  type StudentStatus,
  type StudentTag,
} from '@/lib/types'
import { cn, maskPhone, subjectColorVar } from '@/lib/utils'
import { exportStudents } from '@/lib/exporters'

type StatusFilter = StudentStatus | 'all'

const FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'active', label: '在读' },
  { value: 'paused', label: '暂停' },
  { value: 'finished', label: '结课' },
  { value: 'archived', label: '归档' },
  { value: 'all', label: '全部' },
]

type ViewMode = 'card' | 'list'

/** 学生卡片所需的派生信息 */
interface StudentCardInfo {
  /** 最近一次（含未来最近）排课，用于"下次课"展示 */
  nextCourse?: Course
  /** 已完成课次 */
  doneCount: number
  /** 该生已上的累计课时（完成课次数） */
  coursesTotal: number
}

export default function StudentsPage() {
  const bp = useBreakpoint()
  const isDesktop = bp === 'desktop'

  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active')
  const [view, setView] = useState<ViewMode>('card')
  const [editing, setEditing] = useState<Student | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  // 批量选择
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // 从卡片发起排课
  const [scheduleFor, setScheduleFor] = useState<Student | null>(null)
  const [scheduleOpen, setScheduleOpen] = useState(false)

  const students = useLiveQuery(() => db.students.toArray(), [])
  const tags = useLiveQuery(() => db.learningTags.toArray(), [])
  const studentTags = useLiveQuery(() => db.studentTags.toArray(), [])
  const groups = useLiveQuery(() => db.groups.toArray(), [])
  const groupMembers = useLiveQuery(() => db.groupMembers.toArray(), [])
  const courses = useLiveQuery(() => db.courses.toArray(), [])

  // 有效标签 + 学生→标签名映射（含按标签名搜索）
  const tagMap = useMemo(() => {
    const live = (tags ?? []).filter((t) => !t.deletedAt)
    const st = (studentTags ?? []).filter((s) => !s.deletedAt)
    const byId = new Map(live.map((t) => [t.id, t]))
    const m = new Map<string, LearningTag[]>()
    for (const rel of st) {
      const t = byId.get(rel.tagId)
      if (!t) continue
      const arr = m.get(rel.studentId)
      if (arr) arr.push(t)
      else m.set(rel.studentId, [t])
    }
    return m
  }, [tags, studentTags])

  const liveCourses = (courses ?? []).filter((c) => !c.deletedAt)

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (students ?? [])
      .filter((s) => !s.deletedAt)
      .filter((s) => statusFilter === 'all' || s.status === statusFilter)
      .filter((s) => {
        if (!q) return true
        return (
          s.name.toLowerCase().includes(q) ||
          s.phone.includes(q) ||
          s.grade.toLowerCase().includes(q) ||
          (tagMap.get(s.id) ?? []).some((t) => t.name.toLowerCase().includes(q))
        )
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }, [students, query, statusFilter, tagMap])

  const activeCount = (students ?? []).filter(
    (s) => !s.deletedAt && s.status === 'active',
  ).length

  // 派生每张卡片信息：下次课 + 已完成课次
  const cardInfo = useMemo(() => {
    const now = Date.now()
    const groupMembersByStudent = new Map<string, GroupMember[]>()
    for (const m of groupMembers ?? []) {
      if (m.deletedAt) continue
      const arr = groupMembersByStudent.get(m.studentId) ?? []
      arr.push(m)
      groupMembersByStudent.set(m.studentId, arr)
    }
    const map = new Map<string, StudentCardInfo>()
    for (const s of students ?? []) {
      if (s.deletedAt) continue
      // 该生可参与的课程：1对1(studentId=该生) 或 班课(groupId ∈ 该生所属班课)
      const myGroupIds = new Set(
        (groupMembersByStudent.get(s.id) ?? []).map((m) => m.groupId),
      )
      const myCourses = liveCourses.filter(
        (c) => c.studentId === s.id || (c.groupId && myGroupIds.has(c.groupId)),
      )
      const doneCount = myCourses.filter((c) => c.status === 'done').length
      // 下次课：未来最近的一条（含待上课/请假）
      const nextCourse = myCourses
        .filter((c) => c.startAt >= now && c.status !== 'cancelled')
        .sort((a, b) => a.startAt - b.startAt)[0]
      map.set(s.id, { nextCourse, doneCount, coursesTotal: myCourses.length })
    }
    return map
  }, [students, groupMembers, liveCourses])

  function openCreate() {
    setEditing(null)
    setModalOpen(true)
  }

  function openEdit(s: Student) {
    setEditing(s)
    setModalOpen(true)
  }

  function openDetail(id: string) {
    setDetailId(id)
  }

  function handleEditFromDetail(s: Student) {
    setDetailId(null)
    openEdit(s)
  }

  async function handleArchive(s: Student) {
    if (!confirm(`确定归档「${s.name}」吗？归档后不再占用在读名额，可在「归档」筛选中找回。`)) {
      return
    }
    await db.students.put(touch({ ...s, status: 'archived' }))
  }

  function openScheduleFor(s: Student) {
    setScheduleFor(s)
    setScheduleOpen(true)
  }

  // ---------------- 批量选择 ----------------
  const allVisibleSelected =
    list.length > 0 && list.every((s) => selected.has(s.id))

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) {
        for (const s of list) next.delete(s.id)
      } else {
        for (const s of list) next.add(s.id)
      }
      return next
    })
  }

  async function handleBatchDelete() {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    const names = ids
      .map((id) => list.find((s) => s.id === id)?.name ?? '')
      .filter(Boolean)
      .join('、')
    if (
      !confirm(
        `确定彻底删除 ${ids.length} 名学生吗？\n${names}\n\n将连同其课程、出席、结算、支付、标签等关联记录一并删除，且不可恢复！`,
      )
    ) {
      return
    }
    await hardDeleteStudents(ids)
    setSelected(new Set())
  }

  async function handleBatchArchive() {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    const targets = (students ?? []).filter((s) => ids.includes(s.id))
    for (const s of targets) {
      await db.students.put(touch({ ...s, status: 'archived' }))
    }
    setSelected(new Set())
  }

  // 数据变更后清理不在当前列表中的选中项
  useEffect(() => {
    setSelected((prev) => {
      const valid = new Set<string>()
      for (const id of prev) if (list.some((s) => s.id === id)) valid.add(id)
      // 若大小一致，避免不必要的 setState
      return valid.size === prev.size ? prev : valid
    })
  }, [list])

  return (
    <div>
      <PageHeader
        title="学生"
        subtitle={`在读 ${activeCount} 人`}
        action={
          <>
            <Button variant="secondary" onClick={() => exportStudents(list)}>
              <Download size={16} />
              {isDesktop ? '导出' : ''}
            </Button>
            <Button variant="primary" onClick={openCreate}>
              <Plus size={16} />
              {isDesktop ? '新建学生' : '新建'}
            </Button>
          </>
        }
      />

      {/* 搜索与筛选 */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-3"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索姓名 / 电话 / 年级"
            className="pl-9"
          />
        </div>
        <div className="overflow-x-auto no-scrollbar">
          <SegmentedControl
            value={statusFilter}
            onChange={setStatusFilter}
            options={FILTER_OPTIONS}
          />
        </div>
        {isDesktop && (
          <div className="ml-auto">
            <SegmentedControl
              value={view}
              onChange={setView}
              options={[
                { value: 'card', label: '卡片' },
                { value: 'list', label: '列表' },
              ]}
            />
          </div>
        )}
      </div>

      {/* 批量操作栏（有选中时显示） */}
      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-accent-soft px-3 py-2">
          <span className="text-[13px] font-medium text-accent-text">
            已选 {selected.size} 人
          </span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="secondary" onClick={handleBatchArchive}>
              <Archive size={14} />
              批量归档
            </Button>
            <Button size="sm" variant="danger" onClick={handleBatchDelete}>
              <Trash2 size={14} />
              批量删除
            </Button>
          </div>
        </div>
      )}

      {/* 全选当前结果（列表视图工具条） */}
      {list.length > 0 && isDesktop && view === 'list' && (
        <div className="mb-2 flex items-center justify-between px-1 text-[13px] text-text-2">
          <button
            type="button"
            onClick={toggleSelectAll}
            className="inline-flex items-center gap-1.5 hover:text-text-1"
          >
            <span
              className={cn(
                'inline-flex h-4 w-4 items-center justify-center rounded border',
                allVisibleSelected
                  ? 'border-accent bg-accent text-white'
                  : 'border-line-2 bg-surface-0',
              )}
            >
              {allVisibleSelected && <Check size={12} />}
            </span>
            全选当前结果（{list.length}）
          </button>
        </div>
      )}

      {list.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Users size={30} />}
            title={query ? '没有匹配的学生' : '还没有学生'}
            description={
              query ? '换个关键词试试' : '点击右上角「新建学生」添加第一位学生'
            }
            action={
              !query ? (
                <Button variant="primary" onClick={openCreate}>
                  <Plus size={16} />
                  新建学生
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : isDesktop && view === 'list' ? (
        <DesktopTable
          list={list}
          tagMap={tagMap}
          selected={selected}
          onToggleSelect={toggleSelect}
          onToggleSelectAll={toggleSelectAll}
          allVisibleSelected={allVisibleSelected}
          onView={openDetail}
          onArchive={handleArchive}
        />
      ) : isDesktop ? (
        <CardGrid
          list={list}
          tagMap={tagMap}
          cardInfo={cardInfo}
          selected={selected}
          onToggleSelect={toggleSelect}
          onView={openDetail}
          onSchedule={openScheduleFor}
        />
      ) : (
        <MobileList
          list={list}
          tagMap={tagMap}
          selected={selected}
          onToggleSelect={toggleSelect}
          onView={openDetail}
        />
      )}

      <StudentModal
        open={modalOpen}
        student={editing}
        tagMap={tagMap}
        tags={(tags ?? []).filter((t) => !t.deletedAt)}
        groups={(groups ?? []).filter((g) => !g.deletedAt)}
        groupMembers={(groupMembers ?? []).filter((m) => !m.deletedAt)}
        onClose={() => setModalOpen(false)}
      />

      <StudentDetailSheet
        studentId={detailId}
        onClose={() => setDetailId(null)}
        onEdit={handleEditFromDetail}
      />

      {/* 从卡片发起排课 */}
      <CourseScheduleModal
        open={scheduleOpen}
        course={null}
        defaultStart={null}
        existing={liveCourses}
        students={(students ?? []).filter((s) => !s.deletedAt)}
        groups={(groups ?? []).filter((g) => !g.deletedAt)}
        onClose={() => setScheduleOpen(false)}
        prefillStudentId={scheduleFor?.id ?? null}
      />
    </div>
  )
}

// ============================================================
// 卡片视图
// ============================================================

function CardGrid({
  list,
  tagMap,
  cardInfo,
  selected,
  onToggleSelect,
  onView,
  onSchedule,
}: {
  list: Student[]
  tagMap: Map<string, LearningTag[]>
  cardInfo: Map<string, StudentCardInfo>
  selected: Set<string>
  onToggleSelect: (id: string) => void
  onView: (id: string) => void
  onSchedule: (s: Student) => void
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {list.map((s) => {
        const info = cardInfo.get(s.id)
        const isSelected = selected.has(s.id)
        return (
          <div
            key={s.id}
            className={cn(
              'card relative p-4 transition-shadow hover:shadow-md',
              isSelected && 'ring-2 ring-accent',
            )}
          >
            {/* 多选框（卡片左上角） */}
            <button
              type="button"
              onClick={() => onToggleSelect(s.id)}
              aria-label={isSelected ? '取消选择' : '选择'}
              className={cn(
                'absolute right-3 top-3 inline-flex h-5 w-5 items-center justify-center rounded border',
                isSelected
                  ? 'border-accent bg-accent text-white'
                  : 'border-line-2 bg-surface-0',
              )}
            >
              {isSelected && <Check size={13} />}
            </button>

            {/* 头部：头像 + 姓名 + 状态 + 年级/科目 */}
            <div className="flex items-center gap-3">
              <Avatar name={s.name} colorSlot={s.colorSlot} size="lg" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-text-1">{s.name}</span>
                  <StudentStatusBadge status={s.status} />
                  {s.isTrial && (
                    <span className="shrink-0 rounded-md bg-pending-soft px-1.5 py-0.5 text-[11px] font-medium text-pending">
                      试听
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-[13px] text-text-2">
                  {[s.grade, s.academicLevel].filter(Boolean).join(' · ') || '未填年级'}
                </p>
              </div>
            </div>

            {/* 课次概览 */}
            <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-surface-2 p-2.5 text-center">
              <Cell value={`${info?.doneCount ?? 0}`} label="已上课" />
              <Cell
                value={
                  s.billingRule === 'prepaid'
                    ? `${s.remainingHours}`
                    : '按次'
                }
                label={s.billingRule === 'prepaid' ? '剩余课时' : '计费方式'}
              />
              <Cell
                value={info?.nextCourse ? '已排' : '未排'}
                label="下次课"
                tone={info?.nextCourse ? 'done' : 'pending'}
              />
            </div>

            {/* 下次课时间 */}
            <div className="mt-2 text-[12px] text-text-3">
              {info?.nextCourse ? (
                <span>
                  {new Date(info.nextCourse.startAt).toLocaleDateString('zh-CN', {
                    month: 'numeric',
                    day: 'numeric',
                  })}{' '}
                  {new Date(info.nextCourse.startAt).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  <span className="ml-1 text-text-2">{info.nextCourse.subject}</span>
                </span>
              ) : (
                <span>暂未排课</span>
              )}
            </div>

            {/* 学习标签 */}
            {tagMap.get(s.id) && tagMap.get(s.id)!.length > 0 && (
              <TagBadgeList
                tags={tagMap.get(s.id)!}
                variant="filled"
                max={2}
                className="mt-2"
              />
            )}

            {/* 底部操作 */}
            <div className="mt-3 flex gap-2 border-t border-line-1 pt-3">
              <Button size="sm" variant="primary" onClick={() => onSchedule(s)}>
                <CalendarPlus size={14} />
                排课
              </Button>
              <Button size="sm" variant="secondary" onClick={() => onView(s.id)}>
                <Eye size={14} />
                详情
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Cell({
  value,
  label,
  tone = 'default',
}: {
  value: string
  label: string
  tone?: 'default' | 'done' | 'pending'
}) {
  const toneClass =
    tone === 'done' ? 'text-done' : tone === 'pending' ? 'text-pending' : 'text-text-1'
  return (
    <div>
      <div className={cn('text-[15px] font-semibold tabular-nums', toneClass)}>{value}</div>
      <div className="text-[11px] text-text-3">{label}</div>
    </div>
  )
}

// ============================================================
// PC：表格视图（支持批量操作的信息密度）
// ============================================================

function DesktopTable({
  list,
  tagMap,
  selected,
  onToggleSelect,
  onToggleSelectAll,
  allVisibleSelected,
  onView,
  onArchive,
}: {
  list: Student[]
  tagMap: Map<string, LearningTag[]>
  selected: Set<string>
  onToggleSelect: (id: string) => void
  onToggleSelectAll: () => void
  allVisibleSelected: boolean
  onView: (id: string) => void
  onArchive: (s: Student) => void
}) {
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line-1 bg-surface-2 text-left text-[13px] text-text-2">
            <th className="w-10 px-4 py-2.5">
              <button
                type="button"
                onClick={onToggleSelectAll}
                aria-label="全选"
                className={cn(
                  'inline-flex h-4 w-4 items-center justify-center rounded border',
                  allVisibleSelected
                    ? 'border-accent bg-accent text-white'
                    : 'border-line-2 bg-surface-0',
                )}
              >
                {allVisibleSelected && <Check size={12} />}
              </button>
            </th>
            <th className="px-4 py-2.5 font-medium">学生</th>
            <th className="px-4 py-2.5 font-medium">年级</th>
            <th className="px-4 py-2.5 font-medium">学籍</th>
            <th className="px-4 py-2.5 font-medium">联系电话</th>
            <th className="px-4 py-2.5 font-medium">状态</th>
            <th className="px-4 py-2.5 font-medium">学习标签</th>
            <th className="px-4 py-2.5 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-1">
          {list.map((s) => {
            const isSelected = selected.has(s.id)
            return (
              <tr
                key={s.id}
                className={cn('transition-colors hover:bg-surface-1', isSelected && 'bg-accent-soft')}
              >
                <td className="px-4 py-2.5">
                  <button
                    type="button"
                    onClick={() => onToggleSelect(s.id)}
                    aria-label={isSelected ? '取消选择' : '选择'}
                    className={cn(
                      'inline-flex h-4 w-4 items-center justify-center rounded border',
                      isSelected
                        ? 'border-accent bg-accent text-white'
                        : 'border-line-2 bg-surface-0',
                    )}
                  >
                    {isSelected && <Check size={12} />}
                  </button>
                </td>
                <td className="px-4 py-2.5">
                  <button
                    type="button"
                    onClick={() => onView(s.id)}
                    className="flex items-center gap-2.5 text-left"
                  >
                    <Avatar name={s.name} colorSlot={s.colorSlot} />
                    <div className="min-w-0">
                      <span className="font-medium text-text-1">{s.name}</span>
                      {s.note && (
                        <span className="ml-2 truncate text-xs text-text-3">{s.note}</span>
                      )}
                    </div>
                  </button>
                </td>
                <td className="px-4 py-2.5 text-text-2">{s.grade || '—'}</td>
                <td className="px-4 py-2.5 text-text-2">{s.academicLevel || '—'}</td>
                <td className="px-4 py-2.5 tabular-nums text-text-2">
                  {s.phone ? maskPhone(s.phone) : '—'}
                </td>
                <td className="px-4 py-2.5">
                  <StudentStatusBadge status={s.status} />
                </td>
                <td className="px-4 py-2.5">
                  <TagBadgeList tags={tagMap.get(s.id) ?? []} variant="filled" max={2} />
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => onView(s.id)}>
                      <Eye size={14} />
                      详情
                    </Button>
                    {s.status !== 'archived' && (
                      <Button size="sm" variant="ghost" onClick={() => onArchive(s)}>
                        <Archive size={14} />
                        归档
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Card>
  )
}

// ============================================================
// 移动端：卡片列表（大触控目标 + 多选）
// ============================================================

function MobileList({
  list,
  tagMap,
  selected,
  onToggleSelect,
  onView,
}: {
  list: Student[]
  tagMap: Map<string, LearningTag[]>
  selected: Set<string>
  onToggleSelect: (id: string) => void
  onView: (id: string) => void
}) {
  return (
    <ul className="space-y-2">
      {list.map((s) => {
        const isSelected = selected.has(s.id)
        return (
          <li key={s.id}>
            <div
              className={cn(
                'card flex items-center gap-3 p-3',
                isSelected && 'ring-2 ring-accent',
              )}
            >
              <button
                type="button"
                onClick={() => onToggleSelect(s.id)}
                aria-label={isSelected ? '取消选择' : '选择'}
                className={cn(
                  'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border',
                  isSelected
                    ? 'border-accent bg-accent text-white'
                    : 'border-line-2 bg-surface-0',
                )}
              >
                {isSelected && <Check size={13} />}
              </button>
              <button
                onClick={() => onView(s.id)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left active:bg-surface-2"
              >
                <Avatar name={s.name} colorSlot={s.colorSlot} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-text-1">{s.name}</span>
                    <StudentStatusBadge status={s.status} />
                  </div>
                  <p className="mt-0.5 truncate text-[13px] text-text-2">
                    {[s.grade, s.academicLevel].filter(Boolean).join(' · ') || '未填年级'}
                  </p>
                  {s.phone && (
                    <p className="mt-0.5 text-xs tabular-nums text-text-3">
                      {maskPhone(s.phone)}
                    </p>
                  )}
                  <TagBadgeList
                    tags={tagMap.get(s.id) ?? []}
                    variant="filled"
                    max={3}
                    className="mt-1"
                  />
                </div>
              </button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

// ============================================================
// 新建 / 编辑弹窗
// ============================================================

function StudentModal({
  open,
  student,
  tagMap,
  tags,
  groups,
  groupMembers,
  onClose,
}: {
  open: boolean
  student: Student | null
  tagMap: Map<string, LearningTag[]>
  tags: LearningTag[]
  groups: Group[]
  groupMembers: GroupMember[]
  onClose: () => void
}) {
  const [form, setForm] = useState<StudentForm>(emptyForm)
  const [error, setError] = useState('')
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set())
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set())
  const [convertOpen, setConvertOpen] = useState(false)
  const [convertHours, setConvertHours] = useState('10')
  const [convertFee, setConvertFee] = useState('100')

  // 弹窗打开（或切换编辑对象）时填充表单
  useEffect(() => {
    if (!open) return
    setForm(student ? toForm(student) : emptyForm())
    setSelectedTagIds(
      new Set((tagMap.get(student?.id ?? '') ?? []).map((t) => t.id)),
    )
    setSelectedGroupIds(
      new Set(
        groupMembers.filter((m) => m.studentId === student?.id).map((m) => m.groupId),
      ),
    )
    setError('')
  }, [open, student, tagMap, groupMembers])

  const patch = (p: Partial<StudentForm>) => setForm((f) => ({ ...f, ...p }))

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) => {
      const next = new Set(prev)
      if (next.has(tagId)) next.delete(tagId)
      else next.add(tagId)
      return next
    })
  }

  function toggleGroup(groupId: string) {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  /** 试听学生：自 trialAt 起 5 天未转正 → 显示提醒 */
  const trialDays = useMemo(() => {
    if (!student?.isTrial || !student.trialAt) return 0
    return Math.floor((Date.now() - student.trialAt) / 86_400_000)
  }, [student])
  const trialOverdue = !!student?.isTrial && trialDays >= 5

  async function handleConvertFromTrial() {
    if (!student) return
    const hours = Math.max(0, Math.floor(Number(convertHours) || 0))
    const feeYuan = Number(convertFee) || 0
    const updates: Partial<Student> = {
      isTrial: false,
      billingRule: hours > 0 ? 'prepaid' : 'postpaid',
      paidHours: hours,
      remainingHours: hours,
      trialAt: null,
      hourlyFeeCents: Math.round(feeYuan * 100),
    }
    await db.students.put(touch({ ...student, ...updates }))
    // 若预付，写一笔收款记录
    if (hours > 0) {
      const paymentId = newId()
      await db.payments.put({
        id: paymentId,
        studentId: student.id,
        amountCents: hours * Math.round(feeYuan * 100),
        method: '试听转正',
        paidAt: Date.now(),
        note: `试听转正 · ${hours} 课时`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deletedAt: null,
        dirty: 1,
      })
    }
    setConvertOpen(false)
    onClose()
  }

  async function handleSave() {
    const trimmed = form.name.trim()
    if (!trimmed) {
      setError('请填写学生姓名')
      return
    }

    const payload = {
      name: trimmed,
      grade: form.grade.trim(),
      academicLevel: form.academicLevel.trim(),
      phone: form.phone.trim(),
      note: form.note.trim(),
      status: form.status,
      colorSlot: form.colorSlot,
      billingRule: form.billingRule,
      hourlyFeeCents: Math.round(Number(form.hourlyFeeYuan || 0) * 100),
      paidHours: Math.max(0, Math.floor(Number(form.paidHours || 0))),
      // 仅在输入框「确实为空」时才回退到已缴课时；不能用 falsy 判断，
      // 否则 remainingHours = 0（课时已上完）会被静默重置成已缴课时 → 凭空多出课时。
      remainingHours:
        form.remainingHours.trim() === ''
          ? Math.max(0, Math.floor(Number(form.paidHours || 0)))
          : Math.max(0, Math.floor(Number(form.remainingHours) || 0)),
      remindHours: Math.max(0, Math.floor(Number(form.remindHours || 0))),
      isTrial: form.isTrial,
      trialAt: form.isTrial ? (form.trialAt ?? Date.now()) : null,
    }

    let studentId: string
    if (student) {
      studentId = student.id
      await db.students.put(touch({ ...student, ...payload }))
    } else {
      studentId = newId()
      const now = Date.now()
      await db.students.put({
        id: studentId,
        ...payload,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        dirty: 1,
      })
    }

    // 同步学生-标签关联
    const existingTags = (await db.studentTags.toArray()).filter(
      (r) => r.studentId === studentId && !r.deletedAt,
    )
    const keepTags = new Set<string>()
    for (const rel of existingTags) {
      if (selectedTagIds.has(rel.tagId)) {
        keepTags.add(rel.tagId)
      } else {
        await db.studentTags.put(touch({ ...rel, deletedAt: Date.now() }))
      }
    }
    for (const tagId of selectedTagIds) {
      if (!keepTags.has(tagId)) {
        await db.studentTags.put(
          withSyncFields<StudentTag>({
            studentId,
            tagId,
            assignedAt: Date.now(),
          }),
        )
      }
    }

    // 同步学生-班课关联
    const existingGM = (await db.groupMembers.toArray()).filter(
      (r) => r.studentId === studentId && !r.deletedAt,
    )
    const keepGroups = new Set<string>()
    for (const rel of existingGM) {
      if (selectedGroupIds.has(rel.groupId)) {
        keepGroups.add(rel.groupId)
      } else {
        await db.groupMembers.put(touch({ ...rel, deletedAt: Date.now() }))
      }
    }
    for (const gid of selectedGroupIds) {
      // 幂等加入：已在班课则不新增（避免重复行让班课人数 / 课酬多算）
      if (!keepGroups.has(gid)) await ensureGroupMember(gid, studentId)
    }

    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={student ? '编辑学生' : '新建学生'}
      footer={
        <ModalFooter onCancel={onClose} onConfirm={handleSave} />
      }
    >
      <div className="space-y-3">
        {/* 试听超时提醒 */}
        {trialOverdue && (
          <div className="rounded-lg bg-pending-soft px-3 py-2 text-[13px] text-pending">
            <p>
              ⚠ 试听已 <span className="font-medium">{trialDays}</span> 天，请确认是否转正式。
            </p>
            <Button
              size="sm"
              variant="primary"
              className="mt-2"
              onClick={() => setConvertOpen(true)}
            >
              确认转正式
            </Button>
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-leave-soft px-3 py-2 text-[13px] text-leave">
            {error}
          </div>
        )}

        <Field label="姓名" error={error} hint="必填">
          <Input
            value={form.name}
            onChange={(e) => {
              patch({ name: e.target.value })
              setError('')
            }}
            placeholder="例如：小明"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="年级">
            <Input
              value={form.grade}
              onChange={(e) => patch({ grade: e.target.value })}
              placeholder="初三"
            />
          </Field>
          <Field label="学籍水平">
            <Input
              value={form.academicLevel}
              onChange={(e) => patch({ academicLevel: e.target.value })}
              placeholder="中等"
            />
          </Field>
        </div>

        <Field label="联系电话">
          <Input
            value={form.phone}
            onChange={(e) => patch({ phone: e.target.value })}
            placeholder="13800001234"
            inputMode="tel"
          />
        </Field>

        <Field label="状态">
          <Select
            value={form.status}
            onChange={(e) => patch({ status: e.target.value as StudentStatus })}
          >
            {(Object.keys(STUDENT_STATUS_LABEL) as StudentStatus[]).map((k) => (
              <option key={k} value={k}>
                {STUDENT_STATUS_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>

        {/* 计费区 */}
        <div className="rounded-lg bg-surface-2 p-3">
          <p className="mb-2 text-[13px] font-medium text-text-1">计费与课时</p>
          <Field label="收费规则">
            <SegmentedControl
              value={form.billingRule}
              onChange={(v) => patch({ billingRule: v as BillingRule })}
              options={[
                { value: 'prepaid', label: '预付课时' },
                { value: 'postpaid', label: '按次后付' },
              ]}
            />
          </Field>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Field label="单价（元/课）" hint="1对1 & 班课按出席计酬时用">
              <Input
                type="number"
                min={0}
                step={10}
                value={form.hourlyFeeYuan}
                onChange={(e) => patch({ hourlyFeeYuan: e.target.value })}
                placeholder="20"
                inputMode="decimal"
              />
            </Field>
            <Field label="提醒阈值（课时）" hint="余量 ≤ 该值时提醒">
              <Input
                type="number"
                min={0}
                step={1}
                value={form.remindHours}
                onChange={(e) => patch({ remindHours: e.target.value })}
                placeholder="2"
              />
            </Field>
          </div>
          {form.billingRule === 'prepaid' && (
            <div className="mt-2 grid grid-cols-2 gap-3">
              <Field label="已缴课时">
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={form.paidHours}
                  onChange={(e) => {
                    const v = e.target.value
                    patch({ paidHours: v, remainingHours: form.remainingHours || v })
                  }}
                  placeholder="0"
                />
              </Field>
              <Field label="剩余课时">
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={form.remainingHours}
                  onChange={(e) => patch({ remainingHours: e.target.value })}
                  placeholder="0"
                />
              </Field>
            </div>
          )}
          <div className="mt-2 flex items-center gap-2">
            <input
              type="checkbox"
              id="isTrial"
              checked={form.isTrial}
              onChange={(e) =>
                patch({
                  isTrial: e.target.checked,
                  trialAt: e.target.checked ? (form.trialAt ?? Date.now()) : null,
                })
              }
              className="h-4 w-4"
            />
            <label htmlFor="isTrial" className="text-[13px] text-text-1">
              试听学生
            </label>
            {form.isTrial && form.trialAt && (
              <span className="text-[11px] text-text-3">
                · 已 {Math.floor((Date.now() - form.trialAt) / 86_400_000)} 天
              </span>
            )}
          </div>
        </div>

        {/* 班课归属 */}
        <Field label="所在班课" hint="多选；只在新建/排课时用，可不选">
          {groups.length === 0 ? (
            <p className="text-xs text-text-3">
              暂无班课，请到「班课」页创建
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {groups.map((g) => {
                const active = selectedGroupIds.has(g.id)
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => toggleGroup(g.id)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors',
                      active
                        ? 'border-transparent text-white'
                        : 'border-line-1 bg-surface-1 text-text-2 hover:bg-surface-2',
                    )}
                    style={active ? { background: subjectColorVar(g.colorSlot) } : undefined}
                  >
                    {g.name}
                  </button>
                )
              })}
            </div>
          )}
        </Field>

        <Field label="备注">
          <Input
            value={form.note}
            onChange={(e) => patch({ note: e.target.value })}
            placeholder="学习特点、家长偏好等"
          />
        </Field>

        <Field label="学习标签" hint="先在「学习报告」页的标签库创建，可多选">
          {tags.length === 0 ? (
            <p className="text-xs text-text-3">
              暂无标签，请到「学习报告」页的标签库创建
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.map((t) => {
                const active = selectedTagIds.has(t.id)
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggleTag(t.id)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors',
                      active
                        ? 'border-transparent text-white'
                        : 'border-line-1 bg-surface-1 text-text-2 hover:bg-surface-2',
                    )}
                    style={active ? { background: subjectColorVar(t.colorSlot) } : undefined}
                  >
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{
                        background: active
                          ? 'rgba(255,255,255,0.9)'
                          : subjectColorVar(t.colorSlot),
                      }}
                    />
                    {t.name}
                  </button>
                )
              })}
            </div>
          )}
        </Field>

        <Field label="头像配色">
          <ColorPicker
            value={form.colorSlot}
            onChange={(slot) => patch({ colorSlot: slot })}
            ariaPrefix="头像配色"
          />
        </Field>
      </div>

      {/* 试听转正式 弹窗 */}
      <Modal
        open={convertOpen}
        onClose={() => setConvertOpen(false)}
        title="试听转正式"
        footer={
          <ModalFooter
            onCancel={() => setConvertOpen(false)}
            onConfirm={() => void handleConvertFromTrial()}
            confirmLabel="确认转正"
          />
        }
      >
        <div className="space-y-3">
          <p className="text-[13px] text-text-2">
            转正后将自动设置收费规则与剩余课时，并写一笔收款记录。
          </p>
          <Field label="预付课时数（0 = 按次后付）">
            <Input
              type="number"
              min={0}
              step={1}
              value={convertHours}
              onChange={(e) => setConvertHours(e.target.value)}
            />
          </Field>
          <Field label="课时单价（元）">
            <Input
              type="number"
              min={0}
              step={5}
              value={convertFee}
              onChange={(e) => setConvertFee(e.target.value)}
            />
          </Field>
        </div>
      </Modal>
    </Modal>
  )
}

interface StudentForm {
  name: string
  grade: string
  academicLevel: string
  phone: string
  note: string
  status: StudentStatus
  colorSlot: number
  billingRule: BillingRule
  hourlyFeeYuan: string
  paidHours: string
  remainingHours: string
  remindHours: string
  isTrial: boolean
  trialAt: number | null
}

const emptyForm = (): StudentForm => ({
  name: '',
  grade: '',
  academicLevel: '',
  phone: '',
  note: '',
  status: 'active',
  colorSlot: 1,
  billingRule: 'postpaid',
  hourlyFeeYuan: '',
  paidHours: '',
  remainingHours: '',
  remindHours: '2',
  isTrial: false,
  trialAt: null,
})

const toForm = (s: Student): StudentForm => ({
  name: s.name,
  grade: s.grade,
  academicLevel: s.academicLevel,
  phone: s.phone,
  note: s.note,
  status: s.status,
  colorSlot: s.colorSlot,
  billingRule: s.billingRule ?? 'postpaid',
  hourlyFeeYuan: s.hourlyFeeCents != null ? String(s.hourlyFeeCents / 100) : '',
  paidHours: s.paidHours != null ? String(s.paidHours) : '',
  remainingHours: s.remainingHours != null ? String(s.remainingHours) : '',
  remindHours: s.remindHours != null ? String(s.remindHours) : '2',
  isTrial: !!s.isTrial,
  trialAt: s.trialAt ?? null,
})
