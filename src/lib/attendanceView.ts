/**
 * 课表「出勤」视图 + 学生详情「排课记录」共用的出席状态口径（v31.29，纯只读计算）。
 *
 * 口径定义（与项目既有统计保持一致，切勿各算一遍）：
 *  - **请假** = 该课该生存在存活出席记录且 `present === false`
 *    （AttendanceModal 里「取消勾选 = 请假」）。无记录不等于请假。
 *  - **已补上** = 存在 Course：`isMakeup && makeupSourceCourseId === 原课.id && studentId === 该生.id`。
 *    v31.28 同堂补课正是「每生一条独立课、共享补的原课 id」，故可精确匹配。
 *    ⚠️ 不做「同学生 + 同科目 + 日期在后」的模糊猜测 —— 一个学生补多次会串错。
 *  - **分两级**：补课课 `status='done'` → 「{日期} 已补上」；否则 → 「{日期} 已排补课（待上）」。
 *  - **名单以该课出席记录为准**（点名事实，天然含已归档学生），
 *    避免 v31.23 修过的「只按存活成员过滤 → 归档生历史实到漏算」。
 *    完全没有出席记录的课回退「当前存活成员」（与 finance.ts attribution 的 fallback 一致），
 *    不按「曾有过成员」回退 —— 否则早已归档的学生会被塞进他停课之后的课里。
 *    未完成课额外排除 archived（与 v31.27「待完成课名单排除归档生」一致）。
 *  - v31.41：学生级「停课起始日」优先于 v31.40 的班课移出时间（用于归档办迟了的情况）；
 *    该日及之后的所有课（含未完成课）从名单剔除，更早的历史课照常保留。
 *  - **未完成课不把排课预置的 `present:true` 当成出席**，统一显示「待点名」。
 *
 * 本模块不写库、不改课酬 / 课时 / 结算，也不需要任何数据模型或云端列变更。
 */
import { format, startOfDay } from 'date-fns'
import { uniqueMemberStudentIds } from './db'
import type { Course, CourseAttendance, Group, GroupMember, Student } from './types'

export type AttendanceState =
  | 'present'
  | 'leave-madeup'
  | 'leave-planned'
  | 'leave'
  | 'pending'
  | 'unrecorded'
  | 'course-leave'

export interface MakeupLink {
  courseId: string
  startAt: number
  /** 补课课是否已完成（区分「已排待上」与「已补上」） */
  done: boolean
}

/** 「原课 id::学生 id」 → 该生补这节课的那条补课记录 */
export type MakeupIndex = Map<string, MakeupLink>

/** 由全量课程构建补课关联索引（多条时优先已完成、其次日期最早） */
export function buildMakeupIndex(courses: ReadonlyArray<Course>): MakeupIndex {
  const buckets = new Map<string, MakeupLink[]>()
  for (const c of courses) {
    if (c.deletedAt) continue
    if (!c.isMakeup || !c.makeupSourceCourseId || !c.studentId) continue
    if (c.status === 'cancelled') continue
    const key = makeupKey(c.makeupSourceCourseId, c.studentId)
    const arr = buckets.get(key) ?? []
    arr.push({ courseId: c.id, startAt: c.startAt, done: c.status === 'done' })
    buckets.set(key, arr)
  }
  const out: MakeupIndex = new Map()
  for (const [key, arr] of buckets) {
    arr.sort((a, b) => (a.done === b.done ? a.startAt - b.startAt : a.done ? -1 : 1))
    if (arr[0]) out.set(key, arr[0])
  }
  return out
}

export function makeupKey(sourceCourseId: string, studentId: string): string {
  return `${sourceCourseId}::${studentId}`
}

export function findMakeup(
  index: MakeupIndex,
  sourceCourseId: string,
  studentId: string,
): MakeupLink | undefined {
  return index.get(makeupKey(sourceCourseId, studentId))
}

/** 补课日期文案：11.14（按补课课的实际日期自动格式化，不手工录入） */
export function formatMakeupDate(ts: number): string {
  return format(new Date(ts), 'M.d')
}

/** 状态 → 展示文案。用户示例：11/7 请假、11/14 补上 → 「请假，11.14 已补上」 */
export function attendanceLabel(state: AttendanceState, makeup?: MakeupLink): string {
  switch (state) {
    case 'present':
      return '出席'
    case 'leave-madeup':
      return makeup ? `请假，${formatMakeupDate(makeup.startAt)} 已补上` : '请假，未补'
    case 'leave-planned':
      return makeup ? `请假，${formatMakeupDate(makeup.startAt)} 已排补课（待上）` : '请假，未补'
    case 'leave':
      return '请假，未补'
    case 'pending':
      return '待点名'
    case 'unrecorded':
      return '未记录'
    case 'course-leave':
      return '整节请假'
  }
}

export interface StudentAttendanceRow {
  studentId: string
  name: string
  state: AttendanceState
  label: string
  makeup?: MakeupLink
  archived: boolean
}

export interface CourseAttendanceCard {
  course: Course
  /** 科目 */
  title: string
  /** 排课对象：班课名 / 学生名 */
  targetLabel: string
  /** 班课 / 一对一 / 补课 */
  typeLabel: string
  statusLabel: string
  rows: StudentAttendanceRow[]
  presentCount: number
  expectedCount: number
  leaveCount: number
  /** 是否含已补上的记录（供筛选） */
  hasMadeup: boolean
}

const STATUS_TEXT: Record<string, string> = {
  pending: '待上',
  done: '已完成',
  cancelled: '已取消',
  leave: '请假',
}

/** 'yyyy-MM-dd' → 本地当天 00:00 的时间戳；格式非法返回 undefined（按未设置处理） */
function dateOnlyTs(value?: string | null): number | undefined {
  if (!value) return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!m) return undefined
  const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  return Number.isFinite(ts) ? ts : undefined
}

export interface AttendanceViewInput {
  courses: ReadonlyArray<Course>
  students: ReadonlyArray<Student>
  groups: ReadonlyArray<Group>
  members: ReadonlyArray<GroupMember>
  attendances: ReadonlyArray<CourseAttendance>
}

/**
 * 生成「按课分组」的出席卡片（日期倒序）。
 * 已取消的课不展示（没有出席意义）；整节请假的课保留并标注。
 */
export function buildCourseAttendanceCards(input: AttendanceViewInput): CourseAttendanceCard[] {
  const { courses, students, groups, members, attendances } = input
  const studentById = new Map(students.filter((s) => !s.deletedAt).map((s) => [s.id, s]))
  const groupById = new Map(groups.filter((g) => !g.deletedAt).map((g) => [g.id, g]))
  const liveByIds = new Map<string, string[]>()
  for (const c of courses) {
    if (!c.groupId || liveByIds.has(c.groupId)) continue
    liveByIds.set(c.groupId, uniqueMemberStudentIds(members, c.groupId))
  }

  // v31.40：班课学员的「停课起点」= 被移出该班课的那天（按自然日比较，
  // 避免「当天 13:00 上课、当天下午才办归档」漏掉当天那节）。
  // 只对「当前已无存活成员关系」的组合生效：若后来复活（ensureGroupMember 清掉
  // deletedAt），历史与新课都照常计入，不因旧墓碑误删。
  const memberKey = (studentId: string, groupId: string) => `${studentId}::${groupId}`
  const livePairs = new Set<string>()
  const leftGroupFrom = new Map<string, number>()
  for (const m of members) {
    const k = memberKey(m.studentId, m.groupId)
    if (!m.deletedAt) {
      livePairs.add(k)
      continue
    }
    const day = startOfDay(m.deletedAt).getTime()
    const prev = leftGroupFrom.get(k)
    if (prev === undefined || day < prev) leftGroupFrom.set(k, day)
  }
  for (const k of livePairs) leftGroupFrom.delete(k)

  // courseId → 存活出席行（同课同生多行时 present=true 优先，与 attendanceIndexForStudent 一致）
  const attByCourse = new Map<string, Map<string, boolean>>()
  for (const a of attendances) {
    if (a.deletedAt) continue
    let m = attByCourse.get(a.courseId)
    if (!m) {
      m = new Map()
      attByCourse.set(a.courseId, m)
    }
    if (m.get(a.studentId) === true) continue
    m.set(a.studentId, a.present !== false)
  }

  const makeup = buildMakeupIndex(courses)
  const out: CourseAttendanceCard[] = []

  for (const c of courses) {
    if (c.deletedAt || c.status === 'cancelled') continue
    const attMap = attByCourse.get(c.id)
    let rosterIds: string[]
    if (attMap && attMap.size > 0) {
      // 点过名：出席记录就是当时的应到名单（含已归档学生，历史事实）
      rosterIds = Array.from(attMap.keys())
    } else if (c.groupId) {
      rosterIds = (liveByIds.get(c.groupId) ?? []).slice()
    } else {
      rosterIds = c.studentId ? [c.studentId] : []
    }
    // v31.41：学生级「停课起始日」优先（归档办迟了也能按真实停课日截断）——
    //   该日及之后的课（含未完成课）一律剔除；更早的历史课保留（v31.23 口径）。
    // v31.40 兜底：班课学员若在该课当天或之后才被移出，同样不再列入名单。
    // 应到数随名单自动减少；一对一课不受班课移出影响。
    rosterIds = rosterIds.filter((id) => {
      const st = studentById.get(id)
      const stopFrom = dateOnlyTs(st?.attendanceStopFrom)
      const day = startOfDay(c.startAt).getTime()
      if (stopFrom !== undefined && day >= stopFrom) return false
      if (c.status !== 'done') return st?.status !== 'archived'
      const cutoff = c.groupId ? leftGroupFrom.get(memberKey(id, c.groupId)) : undefined
      return cutoff === undefined || day < cutoff
    })

    const rows: StudentAttendanceRow[] = rosterIds.map((sid) => {
      const st = studentById.get(sid)
      const present = attMap?.get(sid)
      let state: AttendanceState
      let link: MakeupLink | undefined
      if (c.status === 'leave') {
        state = 'course-leave'
      } else if (c.status !== 'done') {
        state = 'pending'
      } else if (present === true) {
        state = 'present'
      } else if (present === false) {
        link = findMakeup(makeup, c.id, sid)
        state = link ? (link.done ? 'leave-madeup' : 'leave-planned') : 'leave'
      } else {
        state = 'unrecorded'
      }
      return {
        studentId: sid,
        name: st?.name ?? '学生(已删)',
        state,
        label: attendanceLabel(state, link),
        makeup: link,
        archived: st?.status === 'archived',
      }
    })

    // 请假 / 异常排前面，其余按姓名，便于一眼看出谁没到
    rows.sort((a, b) => {
      const rank = (s: AttendanceState) =>
        s === 'present' ? 2 : s === 'unrecorded' || s === 'pending' ? 1 : 0
      return rank(a.state) - rank(b.state) || a.name.localeCompare(b.name, 'zh-CN')
    })

    const targetLabel = c.groupId
      ? (groupById.get(c.groupId)?.name ?? '班课(已删)')
      : c.studentId
        ? (studentById.get(c.studentId)?.name ?? '学生(已删)')
        : '—'

    out.push({
      course: c,
      title: c.subject || '未命名课程',
      targetLabel,
      typeLabel: c.isMakeup ? '补课' : c.groupId ? '班课' : '一对一',
      statusLabel: STATUS_TEXT[c.status] ?? c.status,
      rows,
      presentCount: rows.filter((r) => r.state === 'present').length,
      expectedCount: rows.length,
      leaveCount: rows.filter((r) => r.state.startsWith('leave')).length,
      hasMadeup: rows.some((r) => r.state === 'leave-madeup'),
    })
  }

  return out.sort((a, b) => b.course.startAt - a.course.startAt)
}

/** 学生详情用：该生在某节原课上请假时的补课文案（无请假返回 null） */
export function studentLeaveLabel(
  index: MakeupIndex,
  sourceCourseId: string,
  studentId: string,
): string | null {
  const link = findMakeup(index, sourceCourseId, studentId)
  return attendanceLabel(link ? (link.done ? 'leave-madeup' : 'leave-planned') : 'leave', link)
}
