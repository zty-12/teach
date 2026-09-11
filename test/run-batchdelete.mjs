import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { writeFileSync } from 'node:fs'

const root = resolve(process.cwd())
const entryPath = resolve(root, 'test/__batchdelete.test.entry.ts')
const outPath = resolve(root, 'test/__batchdelete.test.mjs')

const testSource = `
import 'fake-indexeddb/auto'
import { db, withSyncFields, touch } from '@/lib/db'
import { hardDeleteStudents, hardDeleteCourses } from '@/lib/batchDelete'
import { applyCompletion } from '@/lib/courseCompletion'
import type { Student, Group, GroupMember, Course, CourseAttendance, Payment, Settlement, StudentTag } from '@/lib/types'

let pass = 0, fail = 0
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; console.log('  ✅', msg) }
  else { fail++; console.log('  ❌', msg) }
}

async function reseed() { await db.delete(); await db.open() }

function mkStudent(name: string, bp: Partial<Student>): Student {
  const now = Date.now()
  return withSyncFields<Student>({
    name, grade:'', phone:'', note:'', status:'active',
    academicLevel:'', colorSlot:1, createdAt:now,
    billingRule:'prepaid', hourlyFeeCents:3000, paidHours:10,
    remainingHours:4, remindHours:2, isTrial:false, trialAt:null,
    ...bp,
  })
}

async function main() {
  console.log('=== 场景 A：删除学生 ⇒ 级联清掉其 1对1 课程/出席/结算 ===')
  {
    await reseed()
    const now = Date.now()
    const s = mkStudent('阿强', { billingRule:'prepaid', remainingHours:3 })
    await db.students.put(s)
    const c: Course = withSyncFields<Course>({
      studentId: s.id, groupId: null, subject:'英语', startAt:now,
      durationMin:60, method:'offline', location:'', note:'',
      status:'pending', colorSlot:1, feeCents:0, createdAt:now,
    })
    await db.courses.put(c)
    const att: CourseAttendance = withSyncFields<CourseAttendance>({
      courseId: c.id, studentId: s.id, present:true, attendAt:now, createdAt:now,
    })
    await db.courseAttendances.put(att)
    // 完成并生成结算
    await applyCompletion({ course: c, attendances:[att], student:s, group:null, groupMembers:[] })
    // 支付 + 标签关联
    await db.payments.put(withSyncFields<Payment>({
      studentId:s.id, amountCents:30000, method:'现金', paidAt:now, note:'', createdAt:now,
    }))
    await db.studentTags.put(withSyncFields<StudentTag>({
      studentId:s.id, tagId:'tag-1', assignedAt:now, createdAt:now,
    }))

    await hardDeleteStudents([s.id])

    ok((await db.students.get(s.id)) === undefined, '学生本体已被物理删除')
    ok((await db.courses.get(c.id)) === undefined, '该生 1对1 课程被级联删除')
    ok((await db.courseAttendances.get(att.id)) === undefined, '该生课程出席被级联删除')
    const settle = await db.settlements.toArray()
    ok(settle.every(x => x.deletedAt !== null), '该生结算被软删标记（预留同步传播）')
    const pay = await db.payments.toArray()
    ok(pay.length === 0, '该生支付被清除')
    const tagRel = await db.studentTags.toArray()
    ok(tagRel.length === 0, '该生标签关联被清除')
  }

  console.log('=== 场景 B：删除课程 ⇒ 级联清掉出席/结算 ===')
  {
    await reseed()
    const now = Date.now()
    const s1 = mkStudent('张一', {})
    const s2 = mkStudent('李二', {})
    await db.students.bulkPut([s1, s2])
    const g: Group = withSyncFields<Group>({
      name:'周五班', subject:'数学', defaultDurationMin:60, note:'', colorSlot:1,
      perStudentFeeCents:2000, weekday:5, startTimeMin:9*60, endTimeMin:10*60, createdAt:now,
    })
    await db.groups.put(g)
    const gm: GroupMember[] = [s1, s2].map(st => withSyncFields<GroupMember>({
      groupId:g.id, studentId:st.id, joinedAt:now, createdAt:now,
    }))
    await db.groupMembers.bulkPut(gm)
    const c: Course = withSyncFields<Course>({
      studentId:null, groupId:g.id, subject:'数学', startAt:now+86400000,
      durationMin:60, method:'offline', location:'', note:'',
      status:'pending', colorSlot:1, feeCents:0, createdAt:now,
    })
    await db.courses.put(c)
    const atts: CourseAttendance[] = [s1, s2].map(st => withSyncFields<CourseAttendance>({
      courseId:c.id, studentId:st.id, present:true, attendAt:now, createdAt:now,
    }))
    await db.courseAttendances.bulkPut(atts)

    await hardDeleteCourses([c.id])

    ok((await db.courses.get(c.id)) === undefined, '课程本体被物理删除')
    const attLeft = await db.courseAttendances.toArray()
    ok(attLeft.length === 0, '课程出席被清除')
    // 班课与成员应保留（不级联删班课）
    ok((await db.groups.get(g.id)) !== undefined, '班课本身保留')
    ok((await db.groupMembers.toArray()).length === 2, '班课成员关系保留')
    ok((await db.students.get(s1.id)) !== undefined, '学生保留')
  }

  console.log(\`\\n结果：通过 \${pass} 项，失败 \${fail} 项\`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error('测试异常：', e); process.exit(1) })
`

writeFileSync(entryPath, testSource)

console.log('打包 batchDelete 测试入口……')
await build({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outPath,
  alias: { '@' : resolve(root, 'src'), '@lib': resolve(root, 'src/lib') },
  logLevel: 'error',
})
console.log('打包完成，执行断言……\n')

const child = spawn(process.execPath, [outPath], { stdio: 'inherit', cwd: root })
child.on('exit', (code) => process.exit(code ?? 1))
