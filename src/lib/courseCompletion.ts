/**
 * 课程完成与计酬业务逻辑
 *
 * 规则：
 *  - 1对1：fee = hourlyFeeCents × 1（出席则计 1）
 *  - 班课：fee = perStudentFeeCents × 出席人数
 *  - 预付学生：每次出席扣 1 课时，扣至 0 停止
 *  - 完成时自动写一条 Settlement
 */
import { db, markDeleted, touch, uniqueMemberStudentIds, withSyncFields } from './db'
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
  /**
   * 本次结算使用的「单位课酬基准」（分）：
   *  - 班课 = 人均课酬；1对1 = 每课时单价。
   *  该值优先取 `course.feeUnitCents` 快照，缺省才回退当前单价。
   *  applyCompletion 会把它固化回课程，作为这节课的定价基准（不再随单价变更漂移）。
   */
  unitCents: number
  /** 课时扣减 */
  deductions: Array<{ studentId: string; before: number; after: number }>
  /** 余量预警名单 */
  lowBalance: Array<{ student: Student; remaining: number }>
}

/**
 * 读取课程上的「单位课酬基准」快照。
 * 返回 null 表示无有效快照（旧数据 / 未结算过）→ 调用方回退到当前单价。
 * 0 是合法值（单价 0 元），与 undefined 语义不同，故用 typeof + isFinite 判定。
 */
function readFeeUnitSnapshot(course: Course): number | null {
  const v = course.feeUnitCents
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
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
    // 班课：以 GroupMember 为全集。
    // ⚠ 必须去重：数据里可能存在同一学生的重复成员行（v31.6 反馈），
    //   按行遍历会把该生计两次 → 课酬多算一个人。
    const memberIds = uniqueMemberStudentIds(groupMembers)
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
  }

  // 课酬
  // 单位单价优先取「课程自身的快照」：保证历史课酬不随班课 / 学生单价后续变更而被追溯改写
  // （v24 审查 P2：已完成课程再结算会按当前单价静默覆盖历史结算）。
  let feeCents = 0
  let unitCents = 0
  const snapshotUnit = readFeeUnitSnapshot(course)
  if (course.groupId && group) {
    unitCents = snapshotUnit ?? group.perStudentFeeCents
    feeCents = unitCents * present.length
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
    // 单价优先序：课程快照 → 补课排课时写入的课酬（＝原班课人均单价）→ 该生的 1对1 单价。
    unitCents =
      snapshotUnit ??
      (course.isMakeup && course.feeCents > 0 ? course.feeCents : student.hourlyFeeCents)
    feeCents = unitCents * (attended ? 1 : 0)
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

  return { present, absent, feeCents, unitCents, deductions, lowBalance }
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
  // ---------- 幂等前置：先还原上一轮结算的课时扣减 ----------
  // 否则重复调用（双击「保存 + 标记完成」、响应式重放等）会二次扣减：
  // 10→9 后再次调用算出 8，而 deductedHours 快照被覆盖成 1 → 撤销时净丢 1 课时。
  // 先把上一轮快照加回去，本次计算即基于「未扣减」的余额，重复调用净额为 0。
  const prevRow = await db.courses.get(input.course.id)
  const prevSnapshot = Array.isArray(prevRow?.deductedHours) ? prevRow!.deductedHours! : []
  for (const d of prevSnapshot) {
    if (!d || !d.studentId || !(d.hours > 0)) continue
    const s = await db.students.get(d.studentId)
    if (s) await db.students.put(touch({ ...s, remainingHours: s.remainingHours + d.hours }))
  }

  // 自动补齐班课成员的 student 对象（调用方无需传 allStudents）
  let { allStudents, student } = input
  // 1对1：从库里取「最新」学生对象再算。
  // 调用方常传的是内存快照（如 useLiveQuery 的 studentMap），批量/连续结算时
  // 第 2 节起会拿到「上一节扣减前」的余额，导致课时只扣一次 —— 这里统一以库为准，
  // 与班课路径（下面 bulkGet 取最新）保持一致。
  if (student) {
    const fresh = await db.students.get(student.id)
    if (fresh) student = fresh
  }
  if (input.course.groupId && input.groupMembers.length > 0) {
    // 与上面 1对1 同理：统一以库为准。上面的「快照还原」刚改过余额，
    // 若沿用调用方传入的内存快照会拿到还原前的旧值，导致重复结算仍多扣。
    const ids = uniqueMemberStudentIds(input.groupMembers)
    const found = await db.students.bulkGet(ids)
    allStudents = found.filter((s): s is Student => !!s && !s.deletedAt)
  }

  const breakdown = calculateCompletion({ ...input, student, allStudents })

  // 1) 更新 Course.feeCents + status='done'
  //    注意：status 一并置为 done，避免调用方再用旧 course 对象覆盖掉刚算好的课酬。
  //    v21：同时写入「实际扣减快照」，供「取消完成」精确返还课时。
  await db.courses.put(
    touch({
      ...input.course,
      feeCents: breakdown.feeCents,
      status: 'done',
      // v26：固化「单位课酬基准」。breakdown.unitCents 本身已是「快照优先」的结果，
      // 因此重复结算写入相同值；首次结算则把当时的单价固定下来，
      // 之后班课 / 学生单价再变也不会改写这节课的历史课酬。
      feeUnitCents: breakdown.unitCents,
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
  const existingSettlement = (await db.settlements.toArray()).find(
    (s) => s.courseId === input.course.id && !s.deletedAt,
  )
  if (breakdown.feeCents > 0) {
    if (!existingSettlement) {
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
          ...existingSettlement,
          amountCents: breakdown.feeCents,
          note: `出席 ${breakdown.present.length} 人`,
        }),
      )
    }
  } else if (existingSettlement) {
    // 重算后课酬归 0（典型案例：已完成 → 重新打开把出席全部改判为请假）。
    // 此时必须撤销既有结算，否则财务仍按旧金额计入课酬（v24 实证：残留 2000 分）。
    await db.settlements.put(markDeleted(existingSettlement))
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
  // 并发重入守卫：同一节课的撤销正在执行时，第二次调用直接返回空结果。
  // 调用方（首页待办 / 课表）都是「读闭包里的 status → await revert」，本身没有锁，
  // 双击时两次都会读到 status='done'；这里在数据层兜住，保证只撤销一次。
  if (revertingCourses.has(courseId)) return empty
  revertingCourses.add(courseId)
  try {
    return await doRevert(courseId, empty)
  } finally {
    revertingCourses.delete(courseId)
  }
}

/** 正在撤销中的课程 id（见 revertCompletion 的重入守卫） */
const revertingCourses = new Set<string>()

async function doRevert(courseId: string, empty: RevertResult): Promise<RevertResult> {
  const course = await db.courses.get(courseId)
  if (!course) return empty
  // 幂等守卫：只有「已完成」的课才存在可撤销的结算。
  // 缺少这层守卫时，第二次「取消完成」会因为 deductedHours 已被清空（不再是数组）
  // 而落入「旧数据兜底」分支，按出席每人再返还 1 课时（实测 10 → 11）。
  if (course.status !== 'done') return empty

  // ---------- 1) 归还课时 ----------
  let restoredHours = 0
  // v21 起完成时会写入 deductedHours（可能是空数组：如余额已 0、无预付学生）。
  // 「字段存在」即代表该课由 v21 之后的逻辑结算过 —— 此时快照就是唯一事实，
  // 绝不能因为「快照为空」而误走旧数据兜底（否则余额 0 的学生会被白送 1 课时）。
  const deductionsSnapshot = course.deductedHours

  if (Array.isArray(deductionsSnapshot)) {
    // 精确路径：按完成时记录的实际扣减量加回（可能为 0）
    for (const d of deductionsSnapshot) {
      if (!d || !d.studentId || !(d.hours > 0)) continue
      const s = await db.students.get(d.studentId)
      if (!s) continue
      await db.students.put(touch({ ...s, remainingHours: s.remainingHours + d.hours }))
      restoredHours += d.hours
    }
  } else {
    // 兼容旧数据（无快照字段）：按出席重算。
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
        : (await db.students.bulkGet(uniqueMemberStudentIds(groupMembers))).filter(
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
    await deleteCheckInTask(t.id, { reason: 'revert' })
    removedCheckInTasks++
  }

  // ---------- 4) 取消自动生成的课堂积分活动 ----------
  let removedClassActivities = 0
  const allRecords = await db.classActivityRecords.toArray()
  const autoActivities = (await db.classActivities.toArray()).filter(
    (a) => !a.deletedAt && a.auto === true && a.sourceCourseId === courseId,
  )
  for (const a of autoActivities) {
    await deleteClassActivity(a, allRecords, { reason: 'revert' })
    removedClassActivities++
  }

  // ---------- 5) 状态回退（清空课酬与扣减快照） ----------
  //  deductedHours 写空数组而不是 null：
  //   - null / undefined 都是「旧数据（从未由 v21+ 结算过）」的标记；
  //     回滚后再写 null，会让下次调用重新走旧数据兜底分支（多返还课时）。
  //   - [] 明确表示「已由新逻辑结算过，且当次没有课时扣减」，语义唯一。
  //  ⚠ feeUnitCents（单价快照）**刻意保留**：它是「这节课的定价基准」，与是否完成无关。
  //     清空会让补课课程丢掉排课时写入的单价（feeCents 在这里被归零），
  //     也会让「取消完成 → 重新完成」凭空改用新单价、课酬无端变化。
  await db.courses.put(
    touch({ ...course, status: 'pending', feeCents: 0, deductedHours: [] }),
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