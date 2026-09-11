/**
 * 学生详情侧拉 Sheet
 *
 * 参照 lessonledger `StudentDetailShell` 多 Tab 设计：从右侧滑入，
 * 包含 5 个 Tab —— 基础信息 / 排课记录 / 支付流水 / 财务概览 / 学习标签。
 *
 * 用法：
 *   <StudentDetailSheet
 *     studentId={openId}
 *     onClose={() => setOpenId(null)}
 *     onEdit={(s) => openEditModal(s)}
 *   />
 */
import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { X } from 'lucide-react'
import { db } from '@/lib/db'
import { Avatar } from '@/components/Avatar'
import { StudentStatusBadge } from '@/components/StudentStatusBadge'
import { Button } from '@/components/ui'
import {
  BILLING_RULE_LABEL,
  type Course,
  type CourseAttendance,
  type Group,
  type GroupMember,
  type LearningTag,
  type Payment,
  type Student,
  type StudentTag,
} from '@/lib/types'
import { maskPhone } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { BasicsTab } from './tabs/BasicsTab'
import { CoursesTab } from './tabs/CoursesTab'
import { PaymentsTab } from './tabs/PaymentsTab'
import { FinanceTab } from './tabs/FinanceTab'
import { TagsTab } from './tabs/TagsTab'

export type StudentDetailTabKey =
  | 'basics'
  | 'courses'
  | 'payments'
  | 'finance'
  | 'tags'

const TAB_LABEL: Record<StudentDetailTabKey, string> = {
  basics: '基础信息',
  courses: '排课记录',
  payments: '支付流水',
  finance: '财务概览',
  tags: '学习标签',
}

const TAB_ORDER: StudentDetailTabKey[] = [
  'basics',
  'courses',
  'payments',
  'finance',
  'tags',
]

export interface StudentDetailSheetProps {
  studentId: string | null
  onClose: () => void
  /** 跳到"编辑学生"弹窗的回调 */
  onEdit?: (student: Student) => void
}

export function StudentDetailSheet({
  studentId,
  onClose,
  onEdit,
}: StudentDetailSheetProps) {
  const open = studentId !== null

  const student = useLiveQuery(
    async () => (studentId ? (await db.students.get(studentId)) ?? null : null),
    [studentId],
  )

  // 依赖数据：open 为 false 时返回空数组，避免无意义查询
  const courses = useLiveQuery<Course[]>(
    () => (open ? db.courses.toArray() : Promise.resolve([] as Course[])),
    [open],
  )
  const attendances = useLiveQuery<CourseAttendance[]>(
    () => (open ? db.courseAttendances.toArray() : Promise.resolve([] as CourseAttendance[])),
    [open],
  )
  const groups = useLiveQuery<Group[]>(
    () => (open ? db.groups.toArray() : Promise.resolve([] as Group[])),
    [open],
  )
  const groupMembers = useLiveQuery<GroupMember[]>(
    () => (open ? db.groupMembers.toArray() : Promise.resolve([] as GroupMember[])),
    [open],
  )
  const payments = useLiveQuery<Payment[]>(
    () => (open ? db.payments.toArray() : Promise.resolve([] as Payment[])),
    [open],
  )
  const tags = useLiveQuery<LearningTag[]>(
    () => (open ? db.learningTags.toArray() : Promise.resolve([] as LearningTag[])),
    [open],
  )
  const studentTags = useLiveQuery<StudentTag[]>(
    () => (open ? db.studentTags.toArray() : Promise.resolve([] as StudentTag[])),
    [open],
  )

  // 该学生的有效数据
  const data = useMemo(() => {
    if (!student || !courses || !attendances || !groups || !groupMembers) return null
    const studentCourses: Course[] = courses
      .filter((c) => !c.deletedAt && c.studentId === student.id)
      .sort((a, b) => b.startAt - a.startAt)
    const studentAttendances: CourseAttendance[] = attendances.filter((a) => {
      if (a.deletedAt) return false
      return studentCourses.some((c) => c.id === a.courseId)
    })
    const liveGroups = groups.filter((g) => !g.deletedAt)
    const liveGroupMembers: GroupMember[] = groupMembers.filter(
      (m) => !m.deletedAt && m.studentId === student.id,
    )
    const studentPayments: Payment[] = (payments ?? [])
      .filter((p) => !p.deletedAt && p.studentId === student.id)
      .sort((a, b) => b.paidAt - a.paidAt)
    const liveTags: LearningTag[] = (tags ?? []).filter((t) => !t.deletedAt)
    const liveStudentTags: StudentTag[] = (studentTags ?? []).filter(
      (st) => !st.deletedAt && st.studentId === student.id,
    )
    return {
      courses: studentCourses,
      attendances: studentAttendances,
      groups: liveGroups,
      groupMembers: liveGroupMembers,
      payments: studentPayments,
      tags: liveTags,
      studentTags: liveStudentTags,
    }
  }, [student, courses, attendances, groups, groupMembers, payments, tags, studentTags])

  const [tab, setTab] = useState<StudentDetailTabKey>('basics')

  // 切换学生或关闭时回到基础信息 tab
  useEffect(() => {
    if (open) setTab('basics')
  }, [studentId, open])

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
      >
        {student && data ? (
          <>
            {/* Header */}
            <div className="flex shrink-0 items-start gap-3 border-b border-line-1 bg-surface-0 px-5 py-4">
              <Avatar name={student.name} colorSlot={student.colorSlot} size="lg" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-[18px] font-semibold leading-tight text-text-1">
                    {student.name}
                  </h2>
                  <StudentStatusBadge status={student.status} />
                  {student.isTrial && (
                    <span className="inline-flex items-center rounded-md bg-pending-soft px-1.5 py-0.5 text-[11px] font-medium text-pending">
                      试听
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[12px] text-text-3">
                  {[student.grade, student.academicLevel].filter(Boolean).join(' · ') ||
                    '未填年级'}
                  {student.phone && ` · ${maskPhone(student.phone)}`}
                </p>
                <p className="mt-0.5 text-[11px] text-text-3">
                  {BILLING_RULE_LABEL[student.billingRule]}
                  {student.billingRule === 'prepaid' &&
                    ` · 余 ${student.remainingHours}/${student.paidHours} 课时`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {onEdit && (
                  <Button variant="ghost" size="sm" onClick={() => onEdit(student)}>
                    编辑
                  </Button>
                )}
                <button
                  onClick={onClose}
                  aria-label="关闭"
                  className="rounded-md p-1.5 text-text-3 hover:bg-surface-2 hover:text-text-1"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Tab bar */}
            <div className="flex shrink-0 gap-1 border-b border-line-1 bg-surface-0 px-3">
              {TAB_ORDER.map((k) => (
                <button
                  key={k}
                  onClick={() => setTab(k)}
                  className={cn(
                    'relative -mb-px px-3 py-2.5 text-[13px] font-medium transition-colors',
                    tab === k
                      ? 'text-accent-text'
                      : 'text-text-2 hover:text-text-1',
                  )}
                >
                  {TAB_LABEL[k]}
                  {tab === k && (
                    <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />
                  )}
                </button>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
              {tab === 'basics' && (
                <BasicsTab
                  student={student}
                  groups={data.groups}
                  groupMembers={data.groupMembers}
                  tags={data.tags}
                  studentTags={data.studentTags}
                />
              )}
              {tab === 'courses' && (
                <CoursesTab
                  studentId={student.id}
                  courses={data.courses}
                  attendances={data.attendances}
                  groups={data.groups}
                />
              )}
              {tab === 'payments' && (
                <PaymentsTab studentId={student.id} payments={data.payments} />
              )}
              {tab === 'finance' && (
                <FinanceTab
                  student={student}
                  courses={data.courses}
                  attendances={data.attendances}
                  payments={data.payments}
                  groups={data.groups}
                />
              )}
              {tab === 'tags' && (
                <TagsTab
                  studentId={student.id}
                  tags={data.tags}
                  studentTags={data.studentTags}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-text-3">
            加载中…
          </div>
        )}
      </aside>
    </div>
  )
}