
import 'fake-indexeddb/auto'
import { db, withSyncFields, touch } from '@/lib/db'
import { applyCompletion, materializeWeekFromGroups } from '@/lib/courseCompletion'
import type { Student, Group, GroupMember, Course, CourseAttendance } from '@/lib/types'

let pass = 0, fail = 0
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; console.log('  ✅', msg) }
  else { fail++; console.log('  ❌', msg) }
}

async function reseed() {
  await db.delete()
  await db.open()
}

async function seedGroupCourse() {
  await reseed()
  const now = Date.now()
  const group: Group = withSyncFields<Group>({
    name: '周六奥数班', subject: '数学', defaultDurationMin: 90,
    note: '', colorSlot: 1, perStudentFeeCents: 2000,
    weekday: 6, startTimeMin: 9 * 60, endTimeMin: 10 * 60 + 30,
    createdAt: now,
  })
  await db.groups.put(group)
  const mkS = (name: string, bp: Partial<Student>): Student =>
    withSyncFields<Student>({
      name, grade:'', phone:'', note:'', status:'active',
      academicLevel:'', colorSlot:1, createdAt:now,
      billingRule:'postpaid', hourlyFeeCents:0, paidHours:0,
      remainingHours:0, remindHours:2, isTrial:false, trialAt:null,
      ...bp,
    })
  const s1 = mkS('小明', { billingRule:'prepaid', hourlyFeeCents:3000, paidHours:10, remainingHours:4 })
  const s2 = mkS('小红', {})
  const s3 = mkS('小刚', { billingRule:'prepaid', remainingHours:1 })
  await db.students.bulkPut([s1, s2, s3])
  const gm: GroupMember[] = [s1, s2, s3].map(st => withSyncFields<GroupMember>({
    groupId: group.id, studentId: st.id, joinedAt: now, createdAt: now,
  }))
  await db.groupMembers.bulkPut(gm)
  return { group, students: [s1, s2, s3], members: gm }
}

function thisMonday() {
  const d = new Date(); const day = d.getDay()
  const off = day === 0 ? -6 : 1 - day
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + off, 0, 0, 0, 0).getTime()
}

async function main() {
  console.log('=== 场景 1：自动排课 materializeWeekFromGroups ===')
  {
    const { group, members } = await seedGroupCourse()
    const mondayMs = thisMonday()
    const res = await materializeWeekFromGroups(mondayMs, [group], members)
    ok(res.created === 1, '生成 1 节本周班课课程，实际=' + res.created)
    const courses = await db.courses.where('groupId').equals(group.id).toArray()
    ok(courses.length === 1, '课程记录数量=' + courses.length)
    if (courses.length === 1) {
      const c = courses[0]
      ok(new Date(c.startAt).getDay() === 6, '课程落在周六，getDay=' + new Date(c.startAt).getDay())
      const atts = await db.courseAttendances.where('courseId').equals(c.id).toArray()
      ok(atts.length === 3, '预创建 3 条出席，实际=' + atts.length)
      const res2 = await materializeWeekFromGroups(mondayMs, [group], members)
      ok(res2.created === 0, '重复运行被跳过（幂等），新增=' + res2.created)
    }
  }

  console.log('=== 场景 2：班课计酬 applyCompletion（3人中2人出席） ===')
  {
    const { group, students, members } = await seedGroupCourse()
    await materializeWeekFromGroups(thisMonday(), [group], members)
    const c = (await db.courses.where('groupId').equals(group.id).toArray())[0]
    const absent = (await db.courseAttendances.where('courseId').equals(c.id).toArray())
      .find(a => a.studentId === students[1].id)!
    await db.courseAttendances.put(touch({ ...absent, present: false }))
    const finalAtts = await db.courseAttendances.where('courseId').equals(c.id).toArray()

    await applyCompletion({ course: c, attendances: finalAtts, student: null, group, groupMembers: members })
    const settlement = (await db.settlements.toArray()).find(s => s.courseId === c.id && !s.deletedAt)
    ok(!!settlement, '写入了 Settlement')
    if (settlement) ok(settlement.amountCents === 4000, '课酬=2×2000=4000分，实际=' + settlement.amountCents)
    const xm = await db.students.get(students[0].id)
    const xg = await db.students.get(students[2].id)
    ok(xm!.remainingHours === 3, '小明预付剩余 4→3，实际=' + xm!.remainingHours)
    ok(xg!.remainingHours === 0, '小刚预付剩余 1→0，实际=' + xg!.remainingHours)
  }

  console.log('=== 场景 3：1对1 计酬 applyCompletion ===')
  {
    await reseed()
    const now = Date.now()
    const s: Student = withSyncFields<Student>({
      name:'阿强', grade:'', phone:'', note:'', status:'active',
      academicLevel:'', colorSlot:1, createdAt:now,
      billingRule:'prepaid', hourlyFeeCents:3000, paidHours:6,
      remainingHours:3, remindHours:2, isTrial:false, trialAt:null,
    })
    await db.students.put(s)
    const c: Course = withSyncFields<Course>({
      studentId: s.id, groupId: null, subject:'英语', startAt:now,
      durationMin:60, method:'offline', location:'', note:'',
      status:'pending', colorSlot:1, feeCents:0, createdAt:now,
    })
    await db.courses.put(c)
    const att: CourseAttendance = withSyncFields<CourseAttendance>({
      courseId: c.id, studentId: s.id, present: true, attendAt: now, createdAt: now,
    })
    await db.courseAttendances.put(att)
    await applyCompletion({ course: c, attendances: [att], student: s, group: null, groupMembers: [] })
    const set = (await db.settlements.toArray()).find(x => x.courseId === c.id && !x.deletedAt)
    ok(!!set && set!.amountCents === 3000, '1对1 课酬=3000分，实际=' + (set?.amountCents ?? '无'))
    const ss = await db.students.get(s.id)
    ok(ss!.remainingHours === 2, '1对1 预付剩余 3→2，实际=' + ss!.remainingHours)
  }

  console.log('=== 场景 4：班课时段时长取窗口（修复 13:00-15:00 只画成一小时） ===')
  {
    await reseed()
    const now = Date.now()
    const group: Group = withSyncFields<Group>({
      name:'周六概念课', subject:'数学', defaultDurationMin:60,
      note:'', colorSlot:1, perStudentFeeCents:2000,
      weekday:6, startTimeMin:13 * 60, endTimeMin:15 * 60,
      createdAt: now,
    })
    await db.groups.put(group)
    const st = withSyncFields<Student>({
      name:'学生A', grade:'', phone:'', note:'', status:'active',
      academicLevel:'', colorSlot:1, createdAt:now,
      billingRule:'postpaid', hourlyFeeCents:0, paidHours:0,
      remainingHours:0, remindHours:2, isTrial:false, trialAt:null,
    })
    await db.students.put(st)
    const gm: GroupMember = withSyncFields<GroupMember>({
      groupId: group.id, studentId: st.id, joinedAt: now, createdAt: now,
    })
    await db.groupMembers.put(gm)
    await materializeWeekFromGroups(thisMonday(), [group], [gm])
    const c = (await db.courses.where('groupId').equals(group.id).toArray())[0]
    ok(c.durationMin === 120, '课程时长=13:00-15:00 窗口 120 分钟，实际=' + c.durationMin)
  }

  console.log('=== 场景 5：applyCompletion 后课程 feeCents 不被旧对象覆盖（修复课酬归 0） ===')
  {
    const { group, members } = await seedGroupCourse()
    await materializeWeekFromGroups(thisMonday(), [group], members)
    const c = (await db.courses.where('groupId').equals(group.id).toArray())[0]
    await applyCompletion({
      course: c,
      attendances: await db.courseAttendances.where('courseId').equals(c.id).toArray(),
      student: null, group, groupMembers: members,
    })
    const after = await db.courses.get(c.id)
    ok(after!.feeCents === 6000, '完成后课程 feeCents=3×2000=6000（未被覆盖为 0），实际=' + after!.feeCents)
    ok(after!.status === 'done', '完成后课程 status=done，实际=' + after!.status)
  }

  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error('测试异常：', e); process.exit(1) })
