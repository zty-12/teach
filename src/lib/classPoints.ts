/**
 * 课堂积分业务逻辑（v17）
 * ------------------------------------------------------------
 * 场景：课上检查背诵/听写等，教师点「过关 / 未过关」，按自定义规则自动计分。
 *
 * 设计要点：
 *  1) 计分复用 pointLedgers 流水（与打卡积分同一账户体系），
 *     每条课堂加分都记下 ledgerId，撤销/改判时精确冲销，不留残分。
 *  2) 名次与积分「整体重算」：任何一次标记/改判/撤销后，
 *     调用 resettleActivity 按过关时间升序重排名次并重算所有人得分，
 *     保证「第一个过关额外加分」始终落在真正的第一名身上。
 *  3) 自动生成：班课按每周固定时段（Group.weekday/startTimeMin）或当天已排课程，
 *     在当天首次进入课堂积分页时自动建好活动与学生名单。
 */
import { startOfDay } from 'date-fns'
import { db, markDeleted, touch, withSyncFields } from './db'
import { adjustPoints } from './points'
import type {
  ClassActivity,
  ClassActivityRecord,
  ClassActivityRule,
} from './types'

/** 新建课堂活动时的默认计分规则：过关 +1，第一个过关再 +1 */
export const DEFAULT_CLASS_RULES: ClassActivityRule[] = [
  { name: '过关', points: 1, condition: 'pass', enabled: true },
  { name: '第一个额外', points: 1, condition: 'first', enabled: true },
]

export function cloneDefaultClassRules(): ClassActivityRule[] {
  return DEFAULT_CLASS_RULES.map((r) => ({ ...r }))
}

// ============================================================
// 计分核心
// ============================================================

/**
 * 计算某名次应得积分。
 * @param rank 过关名次，从 1 开始（1 = 第一个过关）；0 或负数表示未过关
 */
export function awardedPoints(rules: ClassActivityRule[], rank: number): number {
  if (rank < 1) return 0
  let total = 0
  for (const r of rules) {
    if (!r.enabled) continue
    if (r.condition === 'pass') total += r.points
    else if (r.condition === 'first' && rank === 1) total += r.points
  }
  return total
}

/** 已过关记录按「过关时间升序」排列：index 0 即第一个过关的学生 */
export function passedOrder(records: ClassActivityRecord[]): ClassActivityRecord[] {
  return records
    .filter((r) => r.status === 'pass')
    .sort((a, b) => (a.checkedAt ?? 0) - (b.checkedAt ?? 0))
}

/** 学生在活动中当前的名次（1 起）；未过关返回 0 */
export function rankOf(records: ClassActivityRecord[], studentId: string): number {
  const idx = passedOrder(records).findIndex((r) => r.studentId === studentId)
  return idx < 0 ? 0 : idx + 1
}

/**
 * 预览：若此刻把某学生标为「过关」，他能拿多少分。
 * 用于学生行上的「+N 分」提示，避免老师误判规则。
 */
export function previewPassPoints(
  activity: ClassActivity,
  records: ClassActivityRecord[],
  studentId: string,
): number {
  const siblings = records.filter(
    (r) => r.activityId === activity.id && !r.deletedAt && r.studentId !== studentId,
  )
  return awardedPoints(activity.rules, passedOrder(siblings).length + 1)
}

// ============================================================
// 写入：标记 / 撤销 / 重算
// ============================================================

/** 冲销一条积分流水（软删，随同步传播） */
async function revokeLedger(ledgerId: string | null | undefined): Promise<void> {
  if (!ledgerId) return
  const l = await db.pointLedgers.get(ledgerId)
  if (!l || l.deletedAt) return
  await db.pointLedgers.put(markDeleted(l))
}

/**
 * 重算整个活动：按过关时间升序重排名次、重算每人得分，
 * 先冲销旧流水再按新结果写入（幂等）。
 *
 * @param allRecords 该活动的最新记录集合（调用方负责含刚写入的那条）
 */
export async function resettleActivity(
  activity: ClassActivity,
  allRecords: ClassActivityRecord[],
): Promise<void> {
  const siblings = allRecords.filter(
    (r) => r.activityId === activity.id && !r.deletedAt,
  )
  const rankMap = new Map(
    passedOrder(siblings).map((r, i) => [r.studentId, i + 1]),
  )

  const updates: ClassActivityRecord[] = []
  for (const rec of siblings) {
    const rank = rankMap.get(rec.studentId) ?? 0
    const expected = rank > 0 ? awardedPoints(activity.rules, rank) : 0
    const hasLedger = Boolean(rec.ledgerId)
    // 结果未变化则跳过，避免每次标记都产生新流水
    if (expected === (rec.pointsAwarded ?? 0) && (expected > 0) === hasLedger) continue

    await revokeLedger(rec.ledgerId)
    const ledgerId =
      expected > 0
        ? await adjustPoints(
            rec.studentId,
            expected,
            `课堂积分 · ${activity.title}`,
          )
        : null
    updates.push(touch({ ...rec, pointsAwarded: expected, ledgerId }))
  }
  if (updates.length > 0) await db.classActivityRecords.bulkPut(updates)
}

/**
 * 设置某学生的状态（过关 / 未过关 / 待检查），随后整体重算名次与积分。
 * 撤销（→ pending）后，后面学生的名次会自动前移，第一名额外分补发给新的第一名。
 */
export async function setActivityStatus(
  activity: ClassActivity,
  record: ClassActivityRecord,
  status: 'pending' | 'pass' | 'fail',
  allRecords: ClassActivityRecord[],
): Promise<void> {
  const updated: ClassActivityRecord = {
    ...record,
    status,
    // 过关时间决定名次：非过关清空，过关刷新为当下
    checkedAt: status === 'pending' ? null : Date.now(),
  }
  await db.classActivityRecords.put(touch(updated))

  const merged = [
    ...allRecords.filter((r) => r.id !== record.id && !r.deletedAt),
    updated,
  ]
  await resettleActivity(activity, merged)
}

/** 学生名单：把给定学生加入活动（已存在则跳过），返回新增条数 */
export async function addStudentsToActivity(
  activity: ClassActivity,
  studentIds: string[],
  allRecords: ClassActivityRecord[],
): Promise<number> {
  const existing = new Set(
    allRecords
      .filter((r) => r.activityId === activity.id)
      .map((r) => r.studentId),
  )
  const now = Date.now()
  const rows = Array.from(new Set(studentIds))
    .filter((sid) => sid && !existing.has(sid))
    .map((sid) =>
      withSyncFields<ClassActivityRecord>({
        activityId: activity.id,
        studentId: sid,
        status: 'pending',
        pointsAwarded: 0,
        note: '',
        checkedAt: null,
        createdAt: now,
        ledgerId: null,
      }),
    )
  if (rows.length > 0) await db.classActivityRecords.bulkPut(rows)
  return rows.length
}

/** 删除活动：软删活动与其记录，并冲销全部分数（避免积分残留） */
export async function deleteClassActivity(
  activity: ClassActivity,
  allRecords: ClassActivityRecord[],
): Promise<void> {
  const siblings = allRecords.filter(
    (r) => r.activityId === activity.id && !r.deletedAt,
  )
  for (const rec of siblings) await revokeLedger(rec.ledgerId)
  if (siblings.length > 0) {
    await db.classActivityRecords.bulkPut(
      siblings.map((r) =>
        markDeleted({ ...r, pointsAwarded: 0, ledgerId: null }),
      ),
    )
  }
  await db.classActivities.put(markDeleted(activity))
}

// ============================================================
// 按排课自动生成
// ============================================================

export interface EnsureClassActivityResult {
  /** 本次新建的活动数 */
  created: number
  /** 生成的活动标题（用于提示） */
  titles: string[]
}

/**
 * 为「今天有课的班课」自动生成课堂积分活动（幂等）。
 *
 * 判定今天有课：
 *  1) 已排课程：courses 中 startAt 落在今天、关联班课、状态非 cancelled；
 *  2) 兜底：班课设了每周固定时段且 weekday === 今天（课程还没物化时也能生成）。
 *
 * 去重：同一班课同一天只生成一次；被手动删除过的活动也不再重生
 * （软删记录仍保留 activityDate，作为「已处理」标记）。
 *
 * @param dayAt 以哪一天为准，默认今天
 */
export async function ensureTodayClassActivities(
  dayAt: number = Date.now(),
): Promise<EnsureClassActivityResult> {
  const dayStart = startOfDay(new Date(dayAt)).getTime()
  const [groups, members, activities, courses] = await Promise.all([
    db.groups.toArray(),
    db.groupMembers.toArray(),
    db.classActivities.toArray(),
    db.courses.toArray(),
  ])

  const liveGroups = groups.filter((g) => !g.deletedAt)
  const liveMembers = members.filter((m) => !m.deletedAt)
  const groupMap = new Map(liveGroups.map((g) => [g.id, g]))

  // 今天已排的班课课程（cancelled 视为不上课）
  const todayCourses = courses.filter(
    (c) =>
      !c.deletedAt &&
      !!c.groupId &&
      c.status !== 'cancelled' &&
      startOfDay(new Date(c.startAt)).getTime() === dayStart,
  )
  const courseByGroup = new Map(todayCourses.map((c) => [c.groupId!, c]))

  // 收集「今天有课」的班课 id：已排课程优先，未排课时用每周固定时段兜底
  const scheduled = new Set<string>(courseByGroup.keys())
  const weekdayToday = new Date(dayStart).getDay() // 0=周日..6=周六，与 Group.weekday 一致
  for (const g of liveGroups) {
    if (scheduled.has(g.id)) continue
    if (g.weekday === weekdayToday && g.startTimeMin >= 0) scheduled.add(g.id)
  }

  const titles: string[] = []
  for (const gid of scheduled) {
    const g = groupMap.get(gid)
    if (!g) continue
    // 该班课今天是否已有活动（含已删除 —— 删过就不再自动生成）
    const exists = activities.some(
      (a) => a.groupId === gid && a.activityDate === dayStart,
    )
    if (exists) continue

    const studentIds = liveMembers
      .filter((m) => m.groupId === gid)
      .map((m) => m.studentId)
    if (studentIds.length === 0) continue

    // 规则沿用该班课最近一次活动，确保老师的自定义规则不会被重置
    const last = activities
      .filter((a) => a.groupId === gid && !a.deletedAt && a.rules.length > 0)
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    const rules = last
      ? last.rules.map((r) => ({ ...r }))
      : cloneDefaultClassRules()

    const course = courseByGroup.get(gid)
    const now = Date.now()
    const activity = withSyncFields<ClassActivity>({
      title: `课堂积分 · ${g.name}`,
      courseId: course?.id ?? null,
      groupId: gid,
      activityDate: dayStart,
      auto: true,
      sourceCourseId: course?.id ?? null,
      rules,
      note: '',
      createdAt: now,
    })
    await db.classActivities.put(activity)
    await db.classActivityRecords.bulkPut(
      studentIds.map((sid) =>
        withSyncFields<ClassActivityRecord>({
          activityId: activity.id,
          studentId: sid,
          status: 'pending',
          pointsAwarded: 0,
          note: '',
          checkedAt: null,
          createdAt: now,
          ledgerId: null,
        }),
      ),
    )
    titles.push(activity.title)
  }

  return { created: titles.length, titles }
}
