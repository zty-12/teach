/**
 * 课程完成与计酬业务逻辑
 *
 * 规则：
 *  - 1对1：fee = hourlyFeeCents × 1（出席则计 1）
 *  - 班课：fee = perStudentFeeCents × 出席人数
 *  - 预付学生：每次出席扣 1 课时，扣至 0 停止
 *  - 完成时自动写一条 Settlement
 */
import { db, markDeleted, touch, withSyncFields } from './db'
import { deleteCheckInTask } from './points'
import { deleteClassActivity } from './classPoints'
import type {
  CheckInTask,
  Course,
  CourseAttendance,
  Group,
  GroupMember,
  Settlement,
  Student,
} from './types'

export interface CompletionInput {
  course: Course
  /** 出席记录（与该课关联的所有 CourseAttendance） */
  attendances: CourseAttendance[]
  /** 1对1时为该学生；班课时为 null */
  student: Student | null
  /** 班课 Group；1对1时为 null */
  group: Group | null
  /** 班课的所有成员 */
  groupMembers: GroupMember[]
  /**
   * 班课成员的完整学生对象集合（用于把 member.studentId 解析成 Student）。
   * 若缺省，calculateCompletion / applyCompletion 会尝试按需从本地 db 补齐。
   */
  allStudents?: Student[]
}

export interface CompletionBreakdown {
  /** 出席学生 */
  present: Array<{ student: Student; attend: CourseAttendance }>
  /** 缺席学生（仅班课） */
  absent: Array<{ student: Student }>
  /** 总课酬（分） */
  feeCents: number
  /** 课时扣减 */
  deductions: Array<{ studentId: string; before: number; after: number }>
  /** 余量预警名单 */
  lowBalance: Array<{ student: Student; remaining: number }>
}

/**
 * 纯计算：根据当前出勤情况计算课酬、扣减与预警。
 * 不写库 —— 调用方决定是否落库。
 */
export function calculateCompletion(input: CompletionInput): CompletionBreakdown {
  const { course, attendances, student, group, groupMembers, allStudents } = input

  const studentById = new Map<string, Student>()

  if (course.studentId && student) {
    studentById.set(student.id, student)
  }
  // 班课：把成员 student 对象解析进 studentById（1对1 时为 null，无成员）
  if (allStudents) {
    for (const s of allStudents) studentById.set(s.id, s)
  }

  const present: CompletionBreakdown['present'] = []
  const absent: CompletionBreakdown['absent'] = []

  if (course.groupId) {
    // 班课：以 GroupMember 为全集
    const memberIds = groupMembers.map((m) => m.studentId)
    const attendByStudent = new Map(attendances.map((a) => [a.studentId, a]))
    for (const sid of memberIds) {
      const att = attendByStudent.get(sid)
      if (att && att.present) {
        const s = studentById.get(sid)
        if (s) present.push({ student: s, attend: att })
      } else {
        const s = studentById.get(sid)
        if (s) absent.push({ student: s })
      }
    }
    // 注意：上面 studentById 还未填所有成员，下面要补齐
  }

  // 课酬
  let feeCents = 0
  if (course.groupId && group) {
    feeCents = group.perStudentFeeCents * present.length
  } else if (course.studentId && student) {
    // 1对1：出席则计 1 课时课酬（先判定出席，再据出席算 fee）
    const attended = attendances.some(
      (a) => a.studentId === student.id && a.present,
    )
    if (attended && !present.some((p) => p.student.id === student.id)) {
      present.push({
        student,
        attend: attendances.find((a) => a.studentId === student.id)!,
      })
    }
    // 补课按「一课时」计：优先用排课时显式写入的 feeCents（＝原班课人均单价），
    // 否则回退到该学生的 1对1 单价 hourlyFeeCents。
    const unit =
      course.isMakeup && course.feeCents > 0
        ? course.feeCents
        : student.hourlyFeeCents
    feeCents = unit * (attended ? 1 : 0)
  }

  // 预付扣减
  const deductions: CompletionBreakdown['deductions'] = []
  const lowBalance: CompletionBreakdown['lowBalance'] = []
  for (const { student: s } of present) {
    if (s.billingRule === 'prepaid') {
      const before = s.remainingHours
      const after = Math.max(0, before - 1)
      deductions.push({ studentId: s.id, before, after })
      if (after <= s.remindHours && after < before) {
        lowBalance.push({ student: { ...s, remainingHours: after }, remaining: after })
      }
    }
  }

  return { present, absent, feeCents, deductions, lowBalance }
}

/**
 * 把 CompletionBreakdown 落库：
 *  1. 更新 Course.feeCents / status='done'
 *  2. 写一条 Settlement（首次完成时）
 *  3. 更新每个预付学生的 remainingHours
 *
 * 设计为幂等：若 course.status 已为 done，仍允许更新 fee / 重写出席/扣减。
 * 若已存在同 courseId 的未软删 Settlement，则跳过重复创建。
 */
export async function applyCompletion(
  input: CompletionInput,
): Promise<CompletionBreakdown> {
  // 自动补齐班课成员的 student 对象（调用方无需传 allStudents）
  let { allStudents } = input
  if (!allStudents && input.course.groupId && input.groupMembers.length > 0) {
    const ids = input.groupMembers.map((m) => m.studentId)
    const found = await db.students.bulkGet(ids)
    allStudents = found.filter((s): s is Student => !!s && !s.deletedAt)
  }

  const breakdown = calculateCompletion({ ...input, allStudents })

  // 1) 更新 Course.feeCents + status='done'
  //    注意：status 一并置为 done，避免调用方再用旧 course 对象覆盖掉刚算好的课酬。
  //    v21：同时写入「实际扣减快照」，供「取消完成」精确返还课时。
  await db.courses.put(
    touch({
      ...input.course,
      feeCents: breakdown.feeCents,
      status: 'done',
      deductedHours: breakdown.deductions
        .map((d) => ({ studentId: d.studentId, hours: Math.max(0, d.before - d.after) }))
        .filter((d) => d.hours > 0),
    }),
  )

  // 2) 课时扣减
  for (const d of breakdown.deductions) {
    const s = await db.students.get(d.studentId)
    if (!s) continue
    await db.students.put(touch({ ...s, remainingHours: d.after }))
  }

  // 3) 写 Settlement（仅当 feeCents > 0 且不存在）
  if (breakdown.feeCents > 0) {
    const existing = (await db.settlements.toArray()).find(
      (s) => s.courseId === input.course.id && !s.deletedAt,
    )
    if (!existing) {
      const settlement = withSyncFields<Settlement>({
        courseId: input.course.id,
        studentId: input.course.studentId,
        groupId: input.course.groupId,
        amountCents: breakdown.feeCents,
        settledAt: Date.now(),
        note: `出席 ${breakdown.present.length} 人`,
        createdAt: Date.now(),
      })
      await db.settlements.put(settlement)
    } else {
      // 已存在则更新金额（保持幂等）
      await db.settlements.put(
        touch({
          ...existing,
          amountCents: breakdown.feeCents,
          note: `出席 ${breakdown.present.length} 人`,
        }),
      )
    }
  }

  return breakdown
}

export interface RevertResult {
  /** 归还的课时数 */
  restoredHours: number
  /** 撤销的结算条数 */
  removedSettlements: number
  /** 取消的「自动生成」打卡任务数 */
  removedCheckInTasks: number
  /** 取消的「自动生成」课堂活动数 */
  removedClassActivities: number
}

/** 把撤销结果整理成一句可展示的提示（无实际变更时返回 ''） */
export function summarizeRevert(r: RevertResult): string {
  const parts: string[] = []
  if (r.restoredHours > 0) parts.push(`返还 ${r.restoredHours} 课时`)
  if (r.removedSettlements > 0) parts.push(`撤销 ${r.removedSettlements} 笔结算`)
  if (r.removedCheckInTasks > 0) parts.push(`取消 ${r.removedCheckInTasks} 个自动打卡`)
  if (r.removedClassActivities > 0) parts.push(`取消 ${r.removedClassActivities} 个自动课堂活动`)
  return parts.length > 0 ? `已取消完成：${parts.join('，')}。` : ''
}

/** 判定某打卡任务是否为「完成课程时自动生成」（v21 有 auto 标记；旧数据按备注前缀兜底） */
function isAutoCheckInTask(t: CheckInTask): boolean {
  return t.auto === true || t.note.startsWith('课程完成后自动创建')
}

/**
 * 撤销「完成上课」——applyCompletion 的逆操作：
 *  1. 归还该课扣减的课时（优先用完成时写入的 deductedHours 快照精确返还）；
 *  2. 软删除该课未结清的 Settlement（撤销课酬结算）；
 *  3. 清理完成时自动生成的打卡任务与课堂积分活动（不误伤老师手动建的）；
 *  4. 课程状态回 pending、feeCents 归零、快照清空。
 *
 * 幂等：未完成的课调用无副作用。
 */
export async function revertCompletion(courseId: string): Promise<RevertResult> {
  const empty: RevertResult = {
    restoredHours: 0,
    removedSettlements: 0,
    removedCheckInTasks: 0,
    removedClassActivities: 0,
  }
  const course = await db.courses.get(courseId)
  if (!course) return empty

  // ---------- 1) 归还课时 ----------
  let restoredHours = 0
  const snapshot = Array.isArray(course.deductedHours) ? course.deductedHours : null

  if (snapshot && snapshot.length > 0) {
    // 精确路径：按完成时记录的实际扣减量加回
    for (const d of snapshot) {
      if (!d || !d.studentId || !(d.hours > 0)) continue
      const s = await db.students.get(d.studentId)
      if (!s) continue
      await db.students.put(touch({ ...s, remainingHours: s.remainingHours + d.hours }))
      restoredHours += d.hours
    }
  } else {
    // 兼容旧数据（无快照）：按出席重算。
    // ⚠ 旧实现用 `before - max(0, before-1)` 求扣减量，会把「余额正好扣到 0」的课
    //   返还成 0 课时 —— 这正是「取消完成没返还课时」的根因。
    //   这里改为「每位出席的预付学生各返还 1 课时」，与扣减口径一致。
    const attendances = (await db.courseAttendances.toArray()).filter(
      (a) => !a.deletedAt && a.courseId === courseId,
    )
    const groupMembers = course.groupId
      ? (await db.groupMembers.toArray()).filter(
          (m) => !m.deletedAt && m.groupId === course.groupId,
        )
      : []
    const student = course.studentId
      ? (await db.students.get(course.studentId)) ?? null
      : null
    const group = course.groupId
      ? (await db.groups.get(course.groupId)) ?? null
      : null
    const allStudents = student
      ? [student]
      : (await db.students.bulkGet(groupMembers.map((m) => m.studentId))).filter(
          (s): s is Student => !!s && !s.deletedAt,
        )
    const breakdown = calculateCompletion({
      course,
      attendances,
      student,
      group,
      groupMembers,
      allStudents,
    })
    for (const d of breakdown.deductions) {
      const s = await db.students.get(d.studentId)
      if (!s) continue
      await db.students.put(touch({ ...s, remainingHours: s.remainingHours + 1 }))
      restoredHours += 1
    }
  }

  // ---------- 2) 撤销结算 ----------
  let removedSettlements = 0
  const settled = (await db.settlements.toArray()).filter(
    (s) => s.courseId === courseId && !s.deletedAt,
  )
  for (const st of settled) {
    await db.settlements.put(markDeleted(st))
    removedSettlements++
  }

  // ---------- 3) 取消「完成时自动生成」的打卡任务 ----------
  let removedCheckInTasks = 0
  const autoTasks = (await db.checkInTasks.toArray()).filter(
    (t) => !t.deletedAt && t.courseId === courseId && isAutoCheckInTask(t),
  )
  for (const t of autoTasks) {
    await deleteCheckInTask(t.id)
    removedCheckInTasks++
  }

  // ---------- 4) 取消自动生成的课堂积分活动 ----------
  let removedClassActivities = 0
  const allRecords = await db.classActivityRecords.toArray()
  const autoActivities = (await db.classActivities.toArray()).filter(
    (a) => !a.deletedAt && a.auto === true && a.sourceCourseId === courseId,
  )
  for (const a of autoActivities) {
    await deleteClassActivity(a, allRecords)
    removedClassActivities++
  }

  // ---------- 5) 状态回退（清空课酬与扣减快照） ----------
  await db.courses.put(
    touch({ ...course, status: 'pending', feeCents: 0, deductedHours: null }),
  )

  return {
    restoredHours,
    removedSettlements,
    removedCheckInTasks,
    removedClassActivities,
  }
}

/**
 * 根据 Group 周几/时间 模板 + GroupMember，批量生成「本周」Course 记录。
 * 若已存在同 startAt + groupId 的课程，跳过。
 *
 * 返回：{ created, skipped }
 */
export async function materializeWeekFromGroups(
  weekStartMs: number,
  groups: Group[],
  allMembers: GroupMember[],
): Promise<{ created: number; skipped: number }> {
  const WEEK_MS = 7 * 86_400_000
  let created = 0
  let skipped = 0

  const existing = await db.courses.toArray()
  const existingKeys = new Set(
    existing
      .filter((c) => !c.deletedAt && c.groupId)
      .map((c) => `${c.groupId}::${c.startAt}`),
  )

  for (const g of groups) {
    if (g.deletedAt) continue
    if (g.weekday < 0 || g.startTimeMin < 0) continue
    if (g.defaultDurationMin <= 0) continue

    // 计算本周该 weekday 的日期
    const monday = new Date(weekStartMs)
    monday.setHours(0, 0, 0, 0)
    // weekStartsOn=1 (Monday) → monday is day 1; weekday 1=Mon..7=Sun
    // 我们约定 weekday 0=Sun..6=Sat
    const target = new Date(monday)
    // 把 monday 转成「周日=0」的偏移
    const dayOffset =
      g.weekday === 0 ? 6 : g.weekday - 1 // Mon=0, ..., Sat=5, Sun=6
    target.setDate(monday.getDate() + dayOffset)

    const startAt = target.getTime() + g.startTimeMin * 60_000

    // 只生成本周内的（避免跨周遗留）
    if (startAt < weekStartMs || startAt >= weekStartMs + WEEK_MS) continue

    const key = `${g.id}::${startAt}`
    if (existingKeys.has(key)) {
      skipped++
      continue
    }

    const course = withSyncFields<Course>({
      studentId: null,
      groupId: g.id,
      subject: g.subject,
      startAt,
      // 优先按每周时段窗口（endTimeMin - startTimeMin）决定课程时长，
      // 避免出现「时段设 13:00-15:00，课程却只画成 13:00-14:00」；
      // 未设结束时间时回退到 defaultDurationMin。
      durationMin:
        g.endTimeMin > g.startTimeMin
          ? g.endTimeMin - g.startTimeMin
          : g.defaultDurationMin,
      method: 'offline',
      location: '',
      note: '',
      status: 'pending',
      colorSlot: g.colorSlot,
      feeCents: 0, // 完成时按出席人数计算
      createdAt: Date.now(),
    })
    await db.courses.put(course)
    existingKeys.add(key)

    // 预创建所有成员的出席记录（默认 present=true）
    const memberIds = allMembers
      .filter((m) => !m.deletedAt && m.groupId === g.id)
      .map((m) => m.studentId)
    for (const sid of memberIds) {
      const att = withSyncFields<CourseAttendance>({
        courseId: course.id,
        studentId: sid,
        present: true,
        attendAt: null,
        createdAt: Date.now(),
      })
      await db.courseAttendances.put(att)
    }

    created++
  }

  return { created, skipped }
}