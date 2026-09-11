import 'fake-indexeddb/auto'
import { db, withSyncFields } from '@/lib/db'
import {
  createCheckInTask,
  updateCheckInRecord,
  recomputeTaskPoints,
} from '@/lib/points'
import type { Student, PointRule, CheckInRecord } from '@/lib/types'

let pass = 0
let fail = 0
function ok(cond: boolean, msg: string) {
  if (cond) {
    pass++
    console.log('  ✅', msg)
  } else {
    fail++
    console.log('  ❌', msg)
  }
}

async function reseed() {
  await db.delete()
  await db.open()
}

async function main() {
  const now = Date.now()
  await reseed()

  // 两个在读学生
  const mkS = (name: string): Student =>
    withSyncFields<Student>({
      name,
      grade: '',
      phone: '',
      note: '',
      status: 'active',
      academicLevel: '',
      colorSlot: 1,
      createdAt: now,
    })
  const s1 = mkS('小明')
  const s2 = mkS('小红')
  await db.students.bulkPut([s1, s2])

  // 一条基础分规则
  await db.pointRules.put(
    withSyncFields<PointRule>({
      name: '基础分',
      kind: 'base',
      points: 1,
      enabled: true,
      order: 1,
      condition: null,
      createdAt: now,
    }),
  )

  // —— 场景 1：单次任务 ——
  console.log('\n[单次打卡任务]')
  const singleDay = new Date(now).setHours(0, 0, 0, 0)
  const t1 = await createCheckInTask({
    courseId: null,
    groupId: null,
    title: '课后打卡',
    dueAt: singleDay,
    scope: 'all',
    note: '',
    cadenceLabel: '单次打卡',
    memberIds: [],
    days: [singleDay],
    activeStudents: [s1, s2],
  })
  ok(t1.created === 2, `单次任务生成 2 条记录，实际 ${t1.created}`)

  let recs = (await db.checkInRecords.toArray()).filter((r) => r.taskId === t1.task.id)
  ok(recs.length === 2, `存在 2 条记录，实际 ${recs.length}`)

  // 点击「完成」
  const r1 = recs.find((r) => r.studentId === s1.id)!
  await updateCheckInRecord(r1, { status: 'done' })
  recs = (await db.checkInRecords.toArray()).filter((r) => r.taskId === t1.task.id)
  const r1b = recs.find((r) => r.studentId === s1.id)!
  ok(r1b.status === 'done', `点击完成后状态变为 done，实际 ${r1b.status}`)
  ok(r1b.checkedAt != null, `checkedAt 已记录，${r1b.checkedAt}`)

  const led1 = (await db.pointLedgers.toArray()).filter((l) => l.taskId === t1.task.id)
  ok(led1.some((l) => l.studentId === s1.id && l.delta === 1), `完成者获得 1 基础分`)

  // —— 场景 2：周期任务（多天） ——
  console.log('\n[周期打卡任务·多天]')
  const day1 = singleDay - 86400000 * 2
  const day2 = singleDay - 86400000
  const t2 = await createCheckInTask({
    courseId: null,
    groupId: null,
    title: '单词每日打卡',
    dueAt: null,
    scope: 'all',
    note: '',
    cadenceLabel: '每天打卡 · 2 天',
    memberIds: [],
    days: [day1, day2],
    activeStudents: [s1, s2],
  })
  ok(t2.created === 4, `2 天 × 2 人 = 4 条记录，实际 ${t2.created}`)

  let recs2 = (await db.checkInRecords.toArray()).filter((r) => r.taskId === t2.task.id)
  ok(recs2.length === 4, `存在 4 条记录，实际 ${recs2.length}`)
  ok(recs2.every((r) => r.dayAt != null), `周期记录都有 dayAt`)

  // 小明两天都点完成
  for (const rec of recs2.filter((r) => r.studentId === s1.id)) {
    await updateCheckInRecord(rec, { status: 'done' })
  }
  recs2 = (await db.checkInRecords.toArray()).filter((r) => r.taskId === t2.task.id)
  const s1done = recs2.filter((r) => r.studentId === s1.id && r.status === 'done').length
  ok(s1done === 2, `小明两天都记为 done，实际 ${s1done}`)
  const led2 = (await db.pointLedgers.toArray()).filter((l) => l.taskId === t2.task.id && l.studentId === s1.id)
  ok(led2.filter((l) => l.delta === 1).length === 2, `小明因 2 天打卡获得 2 条基础分`)

  // 补卡：小红补第 1 天
  const rS2d1 = recs2.find((r) => r.studentId === s2.id && r.dayAt === day1)!
  await updateCheckInRecord(rS2d1, { status: 'done' })
  const rS2d1b = (await db.checkInRecords.get(rS2d1.id))!
  ok(rS2d1b.status === 'done', `补卡后小红第1天也为 done`)

  // —— 场景 3：矩阵循环 + 每日备注 ——
  console.log('\n[矩阵循环 · 每日备注]')
  // 1. 模拟 CheckInMatrix 的循环 pending → done → missed → pending
  const STATUS_CYCLE = ['pending', 'done', 'missed'] as const
  const rMatrix = recs2.find((r) => r.studentId === s1.id && r.dayAt === day2)!
  const startStatus = rMatrix.status
  let s = startStatus
  // 循环长度 3：跑 3 次回到原状态；跑 6 次也回到原状态
  for (let i = 0; i < 3; i++) {
    const idx = STATUS_CYCLE.indexOf(s as (typeof STATUS_CYCLE)[number])
    s = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length]!
    await updateCheckInRecord({ ...rMatrix, status: s }, { status: s })
  }
  const rMatrixAfter = (await db.checkInRecords.get(rMatrix.id))!
  ok(
    rMatrixAfter.status === startStatus,
    `循环 3 次后回到原状态（start=${startStatus}, end=${rMatrixAfter.status}）`,
  )

  // 2. 模拟 CheckInMatrix 的每日备注编辑：单击格子 → 打开备注抽屉 → 输入 note
  await updateCheckInRecord(rMatrixAfter, { status: 'done' })
  const NOTE = '第 2 天朗读「er」音节不稳，建议家长示范 3 次跟读。'
  await updateCheckInRecord(
    { ...(await db.checkInRecords.get(rMatrix.id))! },
    { note: NOTE },
  )
  const rMatrixNote = (await db.checkInRecords.get(rMatrix.id))!
  ok(rMatrixNote.status === 'done', `格子切到 done 且备注保存后状态仍为 done（实际 ${rMatrixNote.status}）`)
  ok(rMatrixNote.note === NOTE, `每日备注写入成功：${rMatrixNote.note}`)

  // 3. 验证备注更新不影响积分（仅改 note，积分不变）
  const ledBefore = (await db.pointLedgers.toArray()).filter(
    (l) => l.taskId === t2.task.id && l.studentId === s1.id && l.delta === 1,
  ).length
  await updateCheckInRecord(
    { ...rMatrixNote },
    { note: NOTE + ' 追加一句：节奏稍快。' },
  )
  const ledAfter = (await db.pointLedgers.toArray()).filter(
    (l) => l.taskId === t2.task.id && l.studentId === s1.id && l.delta === 1,
  ).length
  ok(ledBefore === ledAfter, `仅改备注不触发积分重写（before=${ledBefore}, after=${ledAfter}）`)
  ok(
    (await db.checkInRecords.get(rMatrix.id))!.note === NOTE + ' 追加一句：节奏稍快。',
    '备注更新被持久化',
  )

  console.log(`\n==== 结果：✅ ${pass} · ❌ ${fail} ====`)
  if (fail > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('测试异常：', e)
  process.exitCode = 1
})
