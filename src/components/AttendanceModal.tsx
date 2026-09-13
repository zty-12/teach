import { useEffect, useMemo, useRef, useState } from 'react'
import { newId } from '@/lib/db'
import { Button, Modal } from '@/components/ui'
import {
  BILLING_RULE_LABEL,
  type Course,
  type CourseAttendance,
  type Group,
  type GroupMember,
  type Student,
} from '@/lib/types'
import { cn, formatMoney, initialOf, subjectColorVar } from '@/lib/utils'
import { calculateCompletion, type CompletionBreakdown } from '@/lib/courseCompletion'

/**
 * 出席设置弹窗（班课全员 / 1对1 单人）
 *
 * 供「课表」与「首页」共用：
 *  - 标记完成课程前必先在这里勾选「哪位学生出席 / 请假」；
 *  - 实时预览出席人数与本节课酬，确认后再「保存 + 标记完成」。
 */
export function AttendanceModal({
  course,
  students,
  groupMembers,
  groups,
  attendances,
  onClose,
  onSave,
  onComplete,
  batchCount = 1,
}: {
  course: Course | null
  students: Student[]
  groupMembers: GroupMember[]
  groups: Group[]
  attendances: CourseAttendance[]
  onClose: () => void
  onSave: (courseId: string, atts: CourseAttendance[]) => Promise<void>
  onComplete: (course: Course) => Promise<void>
  /**
   * 批量模式：同一次出席选择将套用到 N 节课（这些课同属一个学生 / 班课）。
   * 默认 1（单节）。>1 时会显示批量提示，并隐藏「仅保存」（批量只保存一节没意义）。
   */
  batchCount?: number
}) {
  const [draft, setDraft] = useState<CourseAttendance[]>([])
  const [error, setError] = useState('')
  /** 提交中锁：避免连点「保存 + 标记完成」触发重复结算（会二次扣课时） */
  const [busy, setBusy] = useState(false)

  // 包一层 useMemo：否则每次渲染都会新建 Map / 新数组，
  // 使下面课酬预览的 useMemo 依赖恒变、memo 完全失效。
  const studentById = useMemo(() => new Map(students.map((s) => [s.id, s])), [students])
  const courseGroup = useMemo(
    () => (course?.groupId ? groups.find((g) => g.id === course.groupId) ?? null : null),
    [course, groups],
  )
  const courseMembers = useMemo(
    () => groupMembers.filter((m) => m.groupId === course?.groupId),
    [groupMembers, course],
  )

  // 草稿初始化：只在该弹窗「首次为某节课」初始化时吸收出席记录。
  // 旧实现把 attendances 放进依赖且每次变化都 setDraft —— 弹窗打开期间任何外部写入
  // （后台同步拉取、另一个标签页的操作）都会重置老师尚未保存的勾选（v24 审查：P4）。
  const initCourseRef = useRef<string | null>(null)
  /** 当前草稿是否只是「默认全员出席」占位（尚无真实出席记录）——真实记录到达时可安全替换 */
  const seededRef = useRef(false)

  useEffect(() => {
    if (!course) {
      initCourseRef.current = null
      seededRef.current = false
      return
    }
    const current = attendances.filter((a) => a.courseId === course.id)
    const sameCourse = initCourseRef.current === course.id

    if (current.length > 0) {
      // 有真实出席记录：换课程、或当前仅占位名单（老师尚未手动改动）→ 采用真实记录
      if (!sameCourse || seededRef.current) {
        initCourseRef.current = course.id
        seededRef.current = false
        setDraft(current)
      }
      return
    }
    if (sameCourse) return
    // 首次打开且尚无出席记录 → 预填默认（全员出席）
    const expected: string[] = []
    if (course.groupId) {
      for (const m of groupMembers) {
        if (m.groupId === course.groupId) expected.push(m.studentId)
      }
    } else if (course.studentId) {
      expected.push(course.studentId)
    }
    const now = Date.now()
    const seed = expected.map((sid) => ({
      id: newId(),
      courseId: course.id,
      studentId: sid,
      present: true,
      attendAt: now,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      dirty: 1 as const,
    }))
    initCourseRef.current = course.id
    seededRef.current = true
    setDraft(seed)
  }, [course, attendances, groupMembers])

  // 课酬预览（**必须无条件调用**：本组件常驻挂载，course 会在 null 与真实值间切换，
  // 若在此处上方 return 会造成 hooks 数量不稳定 → React 崩溃白屏）
  const breakdown = useMemo<CompletionBreakdown>(() => {
    if (!course) {
      return { present: [], absent: [], feeCents: 0, unitCents: 0, deductions: [], lowBalance: [] }
    }
    const stubStudent = course.studentId ? studentById.get(course.studentId) ?? null : null
    return calculateCompletion({
      course,
      attendances: draft,
      student: stubStudent,
      group: courseGroup,
      groupMembers: courseMembers,
      allStudents: Array.from(studentById.values()),
    })
  }, [course, draft, studentById, courseMembers, courseGroup])

  if (!course) return null

  const presentCount = draft.filter((a) => a.present).length

  function toggle(studentId: string) {
    // 老师已手动改动 → 之后到达的「真实出席记录」不再自动覆盖草稿
    seededRef.current = false
    setDraft((arr) =>
      arr.map((a) =>
        a.studentId === studentId
          ? { ...a, present: !a.present, updatedAt: Date.now() }
          : a,
      ),
    )
  }

  async function handleSave() {
    if (!course || busy) return
    setBusy(true)
    setError('')
    try {
      await onSave(course.id, draft)
      onClose()
    } catch (e) {
      setError(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  async function handleComplete() {
    if (!course || busy) return
    // 已完成过的课：再次「保存 + 完成」会重算并覆盖既有结算。
    // 注意：重算用的是**本节课首次完成时固定的单价基准**（course.feeUnitCents 快照），
    // 不会因为之后改了班课 / 学生单价而改变金额 —— 这里只把「旧金额 → 新金额」讲清楚。
    if (course.status === 'done') {
      const ok = window.confirm(
        `这节课已完成结算（原课酬 ${formatMoney(course.feeCents)}）。\n` +
          `继续将按本节课的定价基准（${formatMoney(breakdown.unitCents)}）重算为 ` +
          `${formatMoney(breakdown.feeCents)} 并覆盖原结算。\n` +
          `定价基准在首次完成时固定，之后改动班课 / 学生单价不会影响这节课的课酬。\n\n` +
          `若只想修正出席、不改动金额，请改用「仅保存」。是否继续？`,
      )
      if (!ok) return
    }
    setBusy(true)
    setError('')
    try {
      // 保存出席后再结算；期间按钮禁用 + busy 锁，双击不会触发两次结算
      await onSave(course.id, draft)
      await onComplete(course)
    } catch (e) {
      setError(`完成失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={!!course}
      onClose={onClose}
      title={`出席 · ${course.subject}`}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          {batchCount <= 1 && (
            <Button variant="secondary" onClick={() => void handleSave()} disabled={busy}>
              仅保存
            </Button>
          )}
          <Button variant="primary" onClick={() => void handleComplete()} disabled={busy}>
            {busy
              ? '处理中…'
              : batchCount > 1
                ? `保存 + 完成 ${batchCount} 节`
                : course.status === 'done'
                  ? '重算并保存'
                  : '保存 + 标记完成'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && (
          <div className="rounded-lg bg-leave-soft px-3 py-2 text-[13px] text-leave">
            {error}
          </div>
        )}

        {course.status === 'done' && (
          <div className="rounded-lg bg-pending-soft px-3 py-2 text-[13px] text-pending">
            本课已完成结算（原课酬 {formatMoney(course.feeCents)}，定价基准{' '}
            {formatMoney(breakdown.unitCents)}）。
            「重算并保存」按本节课的定价基准重算并覆盖原金额，只随出席人数变化，不受班课 / 学生单价变更影响；
            只想修正出席请用「仅保存」。
          </div>
        )}

        {batchCount > 1 && (
          <div className="rounded-lg bg-accent-soft px-3 py-2 text-[13px] text-accent-text">
            批量完成：本次的出席选择将套用到 <span className="font-semibold">{batchCount}</span> 节课
            （同属一个学生 / 班课）。下方只预览第 1 节，确认后其余课节按同一出席一并结算。
          </div>
        )}

        <div className="rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-text-2">
          预计出席 <span className="font-medium text-text-1">{presentCount}</span> / {draft.length} 人
          {breakdown.feeCents > 0 && (
            <>
              {' · '}本节课酬约 <span className="font-medium text-text-1">{formatMoney(breakdown.feeCents)}</span>
            </>
          )}
          {breakdown.feeCents === 0 && draft.length > 0 && (
            <p className="mt-0.5 text-text-3">
              本节课酬为 0（未设单价或均为试听/后付，可到班课或学生档案设置）
            </p>
          )}
          {breakdown.lowBalance.length > 0 && (
            <p className="mt-1 text-leave">
              ⚠ {breakdown.lowBalance.map((l) => l.student.name).join('、')} 课时余额不足，请提醒续费
            </p>
          )}
        </div>

        <p className="text-[12px] text-text-3">
          勾选 = 出席并计课酬 / 扣课时；取消勾选 = 该生请假，不计课酬、不扣课时。
        </p>

        {draft.length === 0 ? (
          <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-[13px] text-text-3">
            这节课没有关联学生。请在课程表单中先选择「学生」或「班课」。
          </p>
        ) : (
          <ul className="space-y-1.5">
            {draft.map((a) => {
              const s = studentById.get(a.studentId)
              if (!s) return null
              return (
                <li
                  key={a.studentId}
                  className="flex items-center gap-2.5 rounded-lg border border-line-1 px-3 py-2"
                >
                  <button
                    type="button"
                    onClick={() => toggle(a.studentId)}
                    disabled={busy}
                    aria-pressed={a.present}
                    className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 text-white',
                      a.present
                        ? 'border-done bg-done'
                        : 'border-line-1 bg-surface-1',
                    )}
                  >
                    {a.present ? '✓' : ''}
                  </button>
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-medium text-white"
                    style={{ background: subjectColorVar(s.colorSlot) }}
                  >
                    {initialOf(s.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-text-1">{s.name}</p>
                    <p className="text-[11px] text-text-3">
                      {BILLING_RULE_LABEL[s.billingRule]}
                      {s.billingRule === 'prepaid' && ` · 余 ${s.remainingHours} 课时`}
                      {s.isTrial && ' · 试听'}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
                      a.present ? 'bg-done-soft text-done' : 'bg-surface-2 text-text-3',
                    )}
                  >
                    {a.present ? '出席' : '请假'}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}
