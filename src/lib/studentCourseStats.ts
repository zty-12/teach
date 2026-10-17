/**
 * 「某个学生的课程 / 课次统计」口径（v31.16）。
 *
 * 背景（真实症状）：老师上完班课只勾选了 6 位学生出席，扣课时也确实只扣了 6 人，
 * 但学生列表 / 财务页的「已上课」却对全部 9 人显示同样的数字 —— 看起来像 9 人都被扣了课时。
 *
 * 两个根因（本模块一并解决）：
 *  1. **课程匹配漏了班课**：多处只按 `c.studentId === student.id` 过滤。
 *     班课课程的 `studentId` 恒为 null（只有 groupId 有值），
 *     所以班课学生的课程集合恒为空 / 或统计口径失真。
 *  2. **「完成」不等于「该生出席」**：`c.status === 'done'` 只说明这节课上完了，
 *     不代表该生出勤。必须再看该课该生的 `CourseAttendance.present`。
 *     否则「这节课到课 6 人」会被算成「9 人都上了」。
 *
 * 口径定义（本模块唯一事实来源，各页面统一引用）：
 *  - 该生课程：1对1 按 studentId，班课按成员关系（去重，见 uniqueMemberStudentIds）
 *  - 完成课次：该生课程里 status='done' 的节数
 *  - 出席课次：该生课程里 status='done' **且** 该生出席记录 present=true 的节数
 *    （无出席记录的历史数据视为出席，避免旧数据凭空少算；仅明确 present=false 才算缺席）
 *  - v31.20：归档（课时结束）会把学生移出仍在进行的班课，`student.previousGroupIds`
 *    记录这些原班课。历史课次统计必须把它们算回来（仅纳入 status='done' 的课），
 *    否则「已上 4 课时」的学生归档后实到课次会显示 0。
 *
 * 抽成纯函数（不依赖 React / Dexie），既让页面逻辑更薄，也让回归脚本能直接断言。
 */
import { uniqueMemberStudentIds } from './db'
import type { GroupMember } from './types'

/** 参与计算的最小字段集（结构性类型，方便调用方直接传库里对象） */
export interface CourseLike {
  id: string
  studentId?: string | null
  groupId?: string | null
  status?: string
  startAt?: number
  deletedAt?: number | null
}

export interface AttendanceLike {
  courseId: string
  studentId: string
  present?: boolean | null
  deletedAt?: number | null
}

export interface MemberLike {
  groupId: string
  studentId: string
  deletedAt?: number | null
}

/** 该生所在班课 id 集合（成员关系去重；同一 (groupId,studentId) 可能有多条存活行） */
export function studentGroupIds(
  studentId: string,
  members: ReadonlyArray<MemberLike> | null | undefined,
): Set<string> {
  const out = new Set<string>()
  if (!studentId || !members) return out
  const seen = new Set<string>()
  for (const m of members) {
    if (m.deletedAt) continue
    if (m.studentId !== studentId) continue
    const key = `${m.groupId}::${m.studentId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.add(m.groupId)
  }
  return out
}

/**
 * 「该生曾经加入过、现在已经离开」的班课 id（v31.20）。
 *
 * 两个来源合并：
 *  1. `student.previousGroupIds` —— v31.19 起归档（课时结束）时显式记录的原班课；
 *  2. groupMembers 里的**墓碑行**（deletedAt 有值）—— 覆盖「在 v31.19 之前就被移出班课」
 *     或历史数据没写 previousGroupIds 的情况。
 *
 * 这些班课只用于**历史课次**统计（见 coursesForStudent），不参与排课/成员名单。
 */
export function historicalGroupIds(
  studentId: string,
  members: ReadonlyArray<MemberLike> | null | undefined,
  recorded?: ReadonlyArray<string | null | undefined> | null,
): string[] {
  const out = new Set<string>()
  for (const gid of recorded ?? []) {
    if (gid) out.add(gid)
  }
  if (studentId && members) {
    const live = studentGroupIds(studentId, members)
    for (const m of members) {
      if (m.studentId !== studentId) continue
      if (!m.deletedAt) continue
      if (live.has(m.groupId)) continue
      out.add(m.groupId)
    }
  }
  return Array.from(out)
}

/**
 * 取「该生可参与的课程」：1对1 按 studentId，班课按成员关系。
 * 已软删的课程自动排除。
 *
 * `previousGroupIds`（v31.20）：归档时为「课时结束」而移出的原班课 id。
 * 移出班课会软删 groupMembers，若只按存活成员关系匹配，该生历史班课课次会瞬间归零
 * （真实症状：已上 4 课时的学生归档后「实到课次」显示 0）。
 * 因此把「已离开的班课」也算进历史课程集合，但严格限制条件：
 *  - 只纳入已完成（status='done'）的课 —— 归档后不该再出现未来排课；
 *  - 传了 `attendances` 时，还要求该生在这节课上**存在存活出席记录** ——
 *    防止「当初误加进班课、随后移除」被凭空算成上过课。
 */
export function coursesForStudent(
  studentId: string,
  courses: ReadonlyArray<CourseLike> | null | undefined,
  members: ReadonlyArray<MemberLike> | null | undefined,
  previousGroupIds?: ReadonlyArray<string | null | undefined> | null,
  attendances?: ReadonlyArray<AttendanceLike> | null,
): CourseLike[] {
  if (!studentId || !courses) return []
  const gids = studentGroupIds(studentId, members)
  const prevGids = new Set<string>()
  for (const gid of previousGroupIds ?? []) {
    if (!gid) continue
    // 已在存活成员关系里的不用重复走历史分支
    if (gids.has(gid)) continue
    prevGids.add(gid)
  }
  const attMap = attendances ? attendanceIndexForStudent(studentId, attendances) : null
  return courses.filter((c) => {
    if (c.deletedAt) return false
    if (c.studentId === studentId) return true
    if (!c.groupId) return false
    if (gids.has(c.groupId)) return true
    if (!prevGids.has(c.groupId)) return false
    if (c.status !== 'done') return false
    if (attMap && !attMap.has(c.id)) return false
    return true
  })
}

/** 建「courseId → 该生出席记录」索引（只取存活行；同课多行时以 present=true 优先，避免误判缺席） */
export function attendanceIndexForStudent(
  studentId: string,
  attendances: ReadonlyArray<AttendanceLike> | null | undefined,
): Map<string, boolean> {
  const map = new Map<string, boolean>()
  if (!studentId || !attendances) return map
  for (const a of attendances) {
    if (a.deletedAt) continue
    if (a.studentId !== studentId) continue
    const prev = map.get(a.courseId)
    // 重复行：只要有一条 present=true 就算出席（与 courseCompletion 的取数方向一致）
    if (prev === true) continue
    map.set(a.courseId, a.present !== false)
  }
  return map
}

/** 该生是否出席某节课。无记录时返回 null（表示「无记录」，交由调用方决定口径）。 */
export function isPresentFor(
  attMap: Map<string, boolean>,
  courseId: string,
): boolean | null {
  const v = attMap.get(courseId)
  return v === undefined ? null : v
}

export interface StudentCourseStats {
  /** 该生可参与的课程（已排除软删） */
  courses: CourseLike[]
  /** 完成课次（该生参与的课里 status='done' 的节数） */
  doneCount: number
  /** 实际出席课次（完成 且 该生 present=true；无出席记录的历史课计为出席） */
  attendedCount: number
  /** 本月完成课次 */
  monthDoneCount: number
  /** 本月出席课次 */
  monthAttendedCount: number
  /** 下次课（未来最近一条，未取消） */
  nextCourse?: CourseLike
}

/**
 * 一次性算出某学生的全部课次统计（列表页 / 详情页共用）。
 * `now` 传入便于测试与确定性渲染。
 */
export function studentCourseStats(args: {
  studentId: string
  courses: ReadonlyArray<CourseLike> | null | undefined
  attendances: ReadonlyArray<AttendanceLike> | null | undefined
  members: ReadonlyArray<MemberLike> | null | undefined
  now?: number
  /** 月初时间戳；默认取传入 now 所在月的 1 日 0 点 */
  monthStart?: number
  /** 归档（课时结束）时移出的原班课 id，仅用于保留历史课次（v31.20） */
  previousGroupIds?: ReadonlyArray<string | null | undefined> | null
}): StudentCourseStats {
  const {
    studentId,
    courses,
    attendances,
    members,
    now = Date.now(),
    monthStart,
    previousGroupIds,
  } = args

  const mine = coursesForStudent(
    studentId,
    courses,
    members,
    previousGroupIds,
    attendances,
  )
  const attMap = attendanceIndexForStudent(studentId, attendances)

  const ms =
    monthStart ??
    (() => {
      const d = new Date(now)
      d.setDate(1)
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    })()

  let doneCount = 0
  let attendedCount = 0
  let monthDoneCount = 0
  let monthAttendedCount = 0

  for (const c of mine) {
    const att = isPresentFor(attMap, c.id)
    // 无出席记录的历史课按出席计（v31.16：只有明确 present=false 才算缺席）
    const attended = att !== false

    if (c.status !== 'done') {
      // 未完成的课不计入课次；但仍可能含 1对1 的 status='done' 之外的形态，故只在 done 分支统计
      continue
    }
    doneCount++
    if (attended) attendedCount++
    if ((c.startAt ?? 0) >= ms) {
      monthDoneCount++
      if (attended) monthAttendedCount++
    }
  }

  const nextCourse = mine
    .filter((c) => (c.startAt ?? 0) >= now && c.status !== 'cancelled')
    .sort((a, b) => (a.startAt ?? 0) - (b.startAt ?? 0))[0]

  return {
    courses: mine,
    doneCount,
    attendedCount,
    monthDoneCount,
    monthAttendedCount,
    nextCourse,
  }
}

/** 去重后的班课成员 id 列表（与 db.uniqueMemberStudentIds 同语义，便于本模块独立回归测试） */
export function memberIdsOf(
  members: ReadonlyArray<GroupMember> | null | undefined,
  groupId?: string | null,
): string[] {
  return uniqueMemberStudentIds(members ?? [], groupId ?? null)
}