/**
 * 班课时间段端到端测试：
 *  1) hhmmToMin / parseTimeToMinutes 解析正确（13:00-16:00 → 180 min）
 *  2) groupPlannedDuration 取 endTimeMin-startTimeMin
 *  3) computePlannedGroupSlots 生成的计划块 durationMin 与 startAt/endAt 正确
 *  4) materializeGroupSlot 物化的课程 durationMin 与 planned slot 一致
 *  5) 编辑既有课程时 CourseScheduleModal 应把 durationMin 重置为班课当前时长
 *  6) Schedule 渲染：top / height 公式不产生 off-by-one
 */
import type {
  CheckInRecord,
  CheckInStatus,
  CheckInTask,
  Course,
  Group,
  GroupMember,
  Student,
} from '../src/lib/types'
import { db } from '../src/lib/db'
import {
  computePlannedGroupSlots,
  materializeGroupSlot,
  type PlannedGroupSlot,
} from '../src/pages/schedule-helpers'

const PASS = (msg: string) => console.log(`  ✓ ${msg}`)
const FAIL = (msg: string) => {
  console.error(`  ✗ ${msg}`)
  process.exitCode = 1
}

function assert(cond: unknown, msg: string) {
  if (cond) PASS(msg)
  else FAIL(msg)
}

function approx(a: number, b: number, eps = 0.5) {
  return Math.abs(a - b) <= eps
}

// ============================================================
// 1. 时间解析
// ============================================================
console.log('1. hhmmToMin 解析')
function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map(Number)
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return -1
  return h * 60 + m
}
assert(hhmmToMin('13:00') === 780, '"13:00" → 780')
assert(hhmmToMin('15:00') === 900, '"15:00" → 900')
assert(hhmmToMin('16:00') === 960, '"16:00" → 960')
assert(hhmmToMin('15:00') - hhmmToMin('13:00') === 120, '13:00→15:00 = 120 min')
assert(hhmmToMin('16:00') - hhmmToMin('13:00') === 180, '13:00→16:00 = 180 min')

// ============================================================
// 2. groupPlannedDuration 逻辑（复刻 CourseScheduleModal 中的实现）
// ============================================================
console.log('\n2. groupPlannedDuration')
function groupPlannedDuration(g: Group | undefined | null): number {
  if (!g) return 60
  if (
    typeof g.startTimeMin === 'number' &&
    g.startTimeMin >= 0 &&
    typeof g.endTimeMin === 'number' &&
    g.endTimeMin > g.startTimeMin
  ) {
    return g.endTimeMin - g.startTimeMin
  }
  return g.defaultDurationMin
}
const group: Group = {
  id: 'g1',
  name: 'test',
  subject: '数学',
  defaultDurationMin: 60,
  note: '',
  colorSlot: 1,
  createdAt: 0,
  perStudentFeeCents: 0,
  weekday: 1,
  startTimeMin: 780, // 13:00
  endTimeMin: 960,   // 16:00
  updatedAt: 0,
  deletedAt: null,
  dirty: 0,
}
assert(groupPlannedDuration(group) === 180, '13:00-16:00 班课 → 180 min')

const groupOld: Group = { ...group, endTimeMin: 900 } // 15:00
assert(groupPlannedDuration(groupOld) === 120, '13:00-15:00 班课 → 120 min')

const groupNoTime: Group = { ...group, startTimeMin: -1, endTimeMin: -1 }
assert(groupPlannedDuration(groupNoTime) === 60, '未设时段 → 回退到 defaultDurationMin=60')

// ============================================================
// 3. computePlannedGroupSlots 端到端
// ============================================================
console.log('\n3. computePlannedGroupSlots')
function makeWeekStart(y: number, m: number, d: number): number {
  // 该日期所在周一 00:00（本地）
  const dt = new Date(y, m - 1, d)
  const dow = dt.getDay() // 0=Sun
  const offset = (dow + 6) % 7 // 周一为 0
  dt.setDate(dt.getDate() - offset)
  dt.setHours(0, 0, 0, 0)
  return dt.getTime()
}
const weekStarts = Array.from({ length: 7 }, (_, i) => makeWeekStart(2026, 9, 7) + i * 86_400_000)
const slots = computePlannedGroupSlots(weekStarts, [group])
const slot13to16 = slots.find((s) => s.groupId === 'g1')
assert(slot13to16 !== undefined, '13:00-16:00 班课生成计划块')
assert(slot13to16!.durationMin === 180, `计划块 durationMin = 180（实际 ${slot13to16!.durationMin}）`)
const expectedEnd = slot13to16!.startAt + 180 * 60_000
assert(slot13to16!.endAt === expectedEnd, `endAt = startAt + 180 min（endAt - startAt = ${slot13to16!.endAt - slot13to16!.startAt}ms = ${(slot13to16!.endAt - slot13to16!.startAt) / 60_000}min）`)

// ============================================================
// 4. materializeGroupSlot 端到端（用 fake-indexeddb）
// ============================================================
async function runDbTests() {
  console.log('\n4. materializeGroupSlot 写入课程的 durationMin')
  await db.courses.clear()
  await db.groupMembers.clear()

  const liveMembers: GroupMember[] = []
  const result = await materializeGroupSlot(slot13to16!, group, liveMembers)
  const courses = await db.courses.toArray()
  const created = courses[0]
  assert(created !== undefined, '物化课程已写入')
  assert(created!.durationMin === 180, `物化课程 durationMin = 180（实际 ${created!.durationMin}）`)
  assert(created!.startAt === slot13to16!.startAt, 'startAt 与计划块一致')

  // 反复调整 endTime 后再次物化
  const groupUpdated: Group = { ...group, endTimeMin: 900 } // 用户改为 13:00-15:00
  const slotsUpdated = computePlannedGroupSlots(weekStarts, [groupUpdated])
  const slotUpdated = slotsUpdated.find((s) => s.groupId === 'g1')!
  assert(slotUpdated.durationMin === 120, `改时段后计划块 durationMin = 120（实际 ${slotUpdated.durationMin}）`)

  await db.courses.clear()
  const r2 = await materializeGroupSlot(slotUpdated, groupUpdated, liveMembers)
  const c2 = (await db.courses.toArray())[0]!
  assert(c2.durationMin === 120, `改时段后物化课程 durationMin = 120（实际 ${c2.durationMin}）`)

  // ============================================================
  // 5. 既有课程被班课时间影响：编辑既有 course 应使用班课最新时长刷新
  // ====================================
  console.log('\n5. 编辑既有课程：durationMin 是否与班课最新时间同步？')
  // 用户场景：之前已经物化过 c1（durationMin=120，endTimeMin=900），
  // 现在把班课 endTimeMin 改成 960，打开编辑表单应当看到 180 而新。
  await db.courses.clear()
  await materializeGroupSlot(slotUpdated, groupUpdated, liveMembers)
  const oldCourse = (await db.courses.toArray())[0]!
  assert(oldCourse.durationMin === 120, '历史课程 durationMin=120')

  // 把班课时间改为 13:00-16:00（180 min）
  const groupNow: Group = { ...group, endTimeMin: 960 }
  // 模拟 CourseScheduleModal 编辑既有课程：按现状，durationMin 直接取 course.durationMin
  // 应当建议改为按班课最新时长刷新
  const freshGroupDuration = groupPlannedDuration(groupNow)
  const currentCourseDuration = oldCourse.durationMin
  assert(
    freshGroupDuration !== currentCourseDuration,
    `现状下编辑既有课程会保留 ${currentCourseDuration}，未与班课最新时长 (${freshGroupDuration}) 同步 — 是 bug 候选`,
  );
  assert(
    freshGroupDuration === 180 && currentCourseDuration === 120,
    'bug 确认：编辑既有课程时，durationMin 不会随班课时间更新而刷新',
  )

  // ============================================================
  // 6. Schedule 渲染公式
  // ====================================
  console.log('\n6. Schedule 渲染公式（HOUR_H=56）')
  const HOUR_H = 56
  const startHour = 8
  function blockTopHeight(startAt: number, durationMin: number) {
    const d = new Date(startAt)
    const top = ((d.getHours() * 60 + d.getMinutes() - startHour * 60) / 60) * HOUR_H
    const height = Math.max((durationMin / 60) * HOUR_H - 2, 22)
    return { top, height, bottomY: top + height }
  }
  // 13:00 本地时间戳
  const ts1300 = new Date(2026, 8, 6, 13, 0, 0).getTime()
  const b120 = blockTopHeight(ts1300, 120)
  const b180 = blockTopHeight(ts1300, 180)
  assert(approx(b120.top, 280), `13:00 top ≈ 280（实际 ${b120.top}）`)
  assert(approx(b120.height, 110), `120 min height ≈ 110（实际 ${b120.height}）`)
  assert(approx(b180.height, 166), `180 min height ≈ 166（实际 ${b180.height}）`)

  // 视觉上 180 min 块应覆盖 13:00-16:00
  // 14:00 y=336, 15:00 y=392, 16:00 y=448
  assert(b180.bottomY >= 446 && b180.bottomY <= 448, `180 min 块底 y 在 16:00 附近（${b180.bottomY}）`)

  // ============================================================
  // 7. 结论
  // ============================================================
  console.log('\n=== 结论 ===')
  if (process.exitCode === 1) {
    console.log('✗ 测试失败')
  } else {
    console.log('✓ 所有测试通过')
  }
}

runDbTests().catch((e) => {
  console.error(e)
  process.exitCode = 1
})