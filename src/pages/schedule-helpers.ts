/**
 * Schedule 共享的小工具：被 Dashboard 和 Schedule 共用。
 * 这里只放确实跨页面复用的纯函数，避免循环依赖。
 */
import { db, touch, withSyncFields } from '../lib/db'
import type { Course, CourseAttendance, Group, GroupMember, Student } from '../lib/types'
import { courseDurationMin } from '../lib/utils'
import { applyCompletion } from '../lib/courseCompletion'
import { ensureAutoCheckInTask } from '../lib/points'
import { ensureAutoClassActivityForCourse } from '../lib/classPoints'

/**
 * 课程标题：优先学生名，其次班课名（被 Schedule / CourseScheduleSheet 共用的纯函数）。
 */
export function courseTitle(
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

/**
 * 有效时长：
 *  1) 班课设置了「每周时间窗」（startTimeMin/endTimeMin）→ 用时间窗跨度，
 *     保证「改班课时间窗，已排的课跟着变」；
 *  2) 未设时间窗 → 用课程自身 durationMin（与日程表/日视图的 courseEnd 同源，
 *     修复「课程 13:00-15:00（120 分钟）在周视图只画出 1 小时」——
 *     旧逻辑此处回退到 g.defaultDurationMin(60)，无视了课程真实的 120 分钟）；
 *  3) 都没有 → 班课默认时长，最后兜底 course.durationMin。
 */
export function effectiveDurationMin(
  course: Course,
  groupMap: Map<string, Group>,
): number {
  return courseDurationMin(course, groupMap)
}

// ============================================================
// 班课「计划块」：按班课每周固定时段虚拟渲染，不写库
// ============================================================

/** 一个班课在某个具体时刻的计划时段（未落库的虚拟课程块） */
export interface PlannedGroupSlot {
  /** 稳定 key：groupId + startAt */
  key: string
  groupId: string
  startAt: number
  endAt: number
  durationMin: number
}

/**
 * 计算某段日期区间内的班课计划块。
 *
 * 只取设置了「每周固定时段」的班课（weekday >= 0 且 startTimeMin >= 0），
 * 按 group.weekday（0=周日..6=周六）落到区间内对应日期。
 *
 * @param dayStarts 区间内每天的 00:00 时间戳数组（通常来自 getWeekDays）
 */
export function computePlannedGroupSlots(
  dayStarts: number[],
  groups: Group[],
): PlannedGroupSlot[] {
  const slots: PlannedGroupSlot[] = []
  for (const g of groups) {
    if (g.deletedAt) continue
    if (g.weekday < 0 || g.startTimeMin < 0) continue
    for (const dayStart of dayStarts) {
      const d = new Date(dayStart)
      // JS: getDay() 0=周日..6=周六，与 Group.weekday 约定一致
      if (d.getDay() !== g.weekday) continue
      const startAt = dayStart + g.startTimeMin * 60_000
      const durationMin =
        g.endTimeMin > g.startTimeMin ? g.endTimeMin - g.startTimeMin : g.defaultDurationMin
      if (durationMin <= 0) continue
      slots.push({
        key: `${g.id}::${startAt}`,
        groupId: g.id,
        startAt,
        endAt: startAt + durationMin * 60_000,
        durationMin,
      })
    }
  }
  return slots.sort((a, b) => a.startAt - b.startAt)
}

/**
 * 把某个计划块物化成真实课程（老师点击计划块时调用）。
 * 幂等：若同 groupId + startAt 已存在未软删课程，直接返回该课程。
 */
export async function materializeGroupSlot(
  slot: PlannedGroupSlot,
  group: Group,
  liveMembers: GroupMember[],
): Promise<{ course: Course; created: boolean }> {
  const existing = (await db.courses.toArray()).find(
    (c) => !c.deletedAt && c.groupId === slot.groupId && c.startAt === slot.startAt,
  )
  if (existing) return { course: existing, created: false }

  const course = withSyncFields<Course>({
    studentId: null,
    groupId: group.id,
    subject: group.subject,
    startAt: slot.startAt,
    durationMin: slot.durationMin,
    method: 'offline',
    location: '',
    note: '',
    status: 'pending',
    colorSlot: group.colorSlot,
    feeCents: 0, // 完成时按出席人数计算
    createdAt: Date.now(),
  })
  await db.courses.put(course)

  // 预创建所有成员的出席记录（默认 present=true）
  const memberIds = liveMembers
    .filter((m) => !m.deletedAt && m.groupId === group.id)
    .map((m) => m.studentId)
  if (memberIds.length > 0) {
    await db.courseAttendances.bulkPut(
      memberIds.map((sid) =>
        withSyncFields<CourseAttendance>({
          courseId: course.id,
          studentId: sid,
          present: true,
          attendAt: null,
          createdAt: Date.now(),
        }),
      ),
    )
  }
  return { course, created: true }
}

/**
 * 当课程首次进入完成流程时，按预期学生预创建出席记录（默认 present=true）。
 * 已有出席记录则跳过。
 */
export async function ensureAttendanceDefaults(
  course: { id: string; groupId: string | null; studentId: string | null },
  liveMembers: GroupMember[],
  _studentMap: Map<string, Student>,
): Promise<void> {
  const existing = (await db.courseAttendances.toArray()).filter(
    (a: CourseAttendance) => !a.deletedAt && a.courseId === course.id,
  )
  if (existing.length > 0) return

  if (course.groupId) {
    const memberIds = liveMembers
      .filter((m) => m.groupId === course.groupId)
      .map((m) => m.studentId)
    for (const sid of memberIds) {
      await db.courseAttendances.put(
        withSyncFields<CourseAttendance>({
          courseId: course.id,
          studentId: sid,
          present: true,
          attendAt: null,
          createdAt: Date.now(),
        }),
      )
    }
  } else if (course.studentId) {
    await db.courseAttendances.put(
      withSyncFields<CourseAttendance>({
        courseId: course.id,
        studentId: course.studentId,
        present: true,
        attendAt: null,
        createdAt: Date.now(),
      }),
    )
  }
}

/**
 * 持久化一组出席记录（覆盖式）：软删不在列表内的旧记录，写入/更新本次的选择。
 */
export async function persistAttendance(
  courseId: string,
  atts: CourseAttendance[],
): Promise<void> {
  const existing = (await db.courseAttendances.toArray()).filter(
    (a) => !a.deletedAt && a.courseId === courseId,
  )
  const keepIds = new Set(atts.map((a) => a.id))
  for (const old of existing) {
    if (!keepIds.has(old.id)) {
      await db.courseAttendances.put(touch({ ...old, deletedAt: Date.now() }))
    }
  }
  for (const a of atts) {
    await db.courseAttendances.put(touch(a))
  }
}

/**
 * 按「已保存的出席记录」完成课程：
 *  - 重新读取最新出席（用户已在弹窗里勾选），据此计算课酬、扣减预付课时；
 *  - applyCompletion 内部会写入 feeCents 并把课程状态置为 done；
 *  - 完成后再按班课配置，自动生成「课后打卡」与「课堂积分活动」
 *    （两者都可在「取消完成」时被精确回收）。
 */
export async function completeCourseWithAttendance(
  course: Course,
  liveMembers: GroupMember[],
  studentMap: Map<string, Student>,
  groupMap: Map<string, Group>,
): Promise<void> {
  const allAtts = (await db.courseAttendances.toArray()).filter(
    (a) => !a.deletedAt && a.courseId === course.id,
  )
  const student = course.studentId ? studentMap.get(course.studentId) ?? null : null
  const group = course.groupId ? groupMap.get(course.groupId) ?? null : null
  const groupMems = liveMembers.filter((m) => m.groupId === course.groupId)
  await applyCompletion({ course, attendances: allAtts, student, group, groupMembers: groupMems })

  // 完成后自动创建「课后打卡」周期任务（幂等：每门课只建一次；失败不阻塞完成流程）
  try {
    const presentIds = allAtts.filter((a) => a.present).map((a) => a.studentId)
    const fallbackIds = course.groupId
      ? groupMems.map((m) => m.studentId)
      : course.studentId
        ? [course.studentId]
        : []
    await ensureAutoCheckInTask({
      courseId: course.id,
      groupId: course.groupId,
      courseEndAt: course.startAt + effectiveDurationMin(course, groupMap) * 60_000,
      title: courseTitle(course, studentMap, groupMap),
      presentStudentIds: presentIds,
      fallbackStudentIds: fallbackIds,
    })
  } catch {
    // 打卡任务创建失败不影响课程完成
  }

  // v21：完成后自动生成当天的「课堂积分活动」（仅班课；受班课 classActivityAuto 控制）
  try {
    if (course.groupId) {
      const presentIds = allAtts.filter((a) => a.present).map((a) => a.studentId)
      const memberIds = groupMems.map((m) => m.studentId)
      await ensureAutoClassActivityForCourse({
        courseId: course.id,
        groupId: course.groupId,
        activityDate: course.startAt,
        studentIds: presentIds.length > 0 ? presentIds : memberIds,
        title: courseTitle(course, studentMap, groupMap),
      })
    }
  } catch (e) {
    // 课堂活动创建失败不影响课程完成，但需可见以便排查
    console.warn('[completeCourse] 课堂活动自动生成失败（不影响课程完成）：', e)
  }
}

/**
 * 批量完成：把「同一次出席选择」套用到多节课，并逐节做完整结算。
 *
 * 适用前提：这些课属于同一学生或同一班课（侧拉 Sheet 的批量标记即满足），
 * 因此出席名单一致 —— 老师在出席弹窗里勾一次，即可套用到全部所选课节。
 *
 * 每节课都会：
 *  1. 按本次选择落库出席（保留既有记录 id，仅翻转 present）；
 *  2. 走 completeCourseWithAttendance（扣课时 + 写结算 + 自动打卡 + 自动课堂活动）。
 *
 * @param presentByStudent studentId → 是否出席；名单中未出现的按「出席」处理
 * @returns 实际完成并结算的课节数
 */
export async function completeCoursesWithAttendance(
  courses: Course[],
  presentByStudent: Map<string, boolean>,
  liveMembers: GroupMember[],
  studentMap: Map<string, Student>,
  groupMap: Map<string, Group>,
): Promise<number> {
  let done = 0
  for (const c of courses) {
    const rosterIds = c.groupId
      ? liveMembers.filter((m) => m.groupId === c.groupId).map((m) => m.studentId)
      : c.studentId
        ? [c.studentId]
        : []
    const existing = (await db.courseAttendances.toArray()).filter(
      (a) => !a.deletedAt && a.courseId === c.id,
    )
    const byStudent = new Map(existing.map((a) => [a.studentId, a]))
    const atts: CourseAttendance[] = rosterIds.map((sid) => {
      const present = presentByStudent.get(sid) ?? true
      const prev = byStudent.get(sid)
      return prev
        ? touch({ ...prev, present })
        : withSyncFields<CourseAttendance>({
            courseId: c.id,
            studentId: sid,
            present,
            attendAt: null,
            createdAt: Date.now(),
          })
    })
    if (atts.length > 0) await persistAttendance(c.id, atts)
    await completeCourseWithAttendance(c, liveMembers, studentMap, groupMap)
    done++
  }
  return done
}