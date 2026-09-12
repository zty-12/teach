/**
 * 级联批量删除工具（彻底删除）
 *
 * 语义：
 *  - 协调同步：对每条记录做软删标记（deletedAt + dirty=1），让同步引擎能在推送阶段
 *    把删除传播到云端；随后由 sync.ts 的 pushAll 在确认推送成功后物理清除本地墓碑。
 *  - 之所以不在本函数里立刻 bulkDelete：否则墓碑在推送前就被抹掉，云端仍保留激活记录，
 *    下次拉取会把已删数据「复活」（即用户反馈的"删了又出现"问题）。
 *  - 级联清理：删除学生时，连带清掉其 1对1 课程、出席、结算、反馈、支付、
 *    标签关联、班课成员关系；删除课程时，连带清掉该课的出席、结算、反馈。
 *
 * ⚠️ 软删后由同步负责物理清除；如需立刻本地清空请在 UI 层用 confirm 二次确认。
 */
import { db } from './db'
import type { Table } from 'dexie'

/**
 * 对一张表：先软删（标记 deletedAt + dirty=1 以传播同步），再物理删除本地行。
 * 这样本地彻底清除、云端也同步到删除标记，避免拉取复活。
 */
async function softDeleteThenPurge<T extends { id: string; deletedAt: number | null }>(
  table: Table<T, string>,
  ids: string[],
): Promise<void> {
  const unique = Array.from(new Set(ids))
  if (unique.length === 0) return
  const originals = await table.where('id').anyOf(unique).toArray()
  if (originals.length > 0) {
    const now = Date.now()
    const purged = originals.map((o) => ({
      ...o,
      deletedAt: now,
      updatedAt: now,
      dirty: 1 as const,
    }))
    await table.bulkPut(purged)
  }
  // 物理删除本地行（不可找回）
  await table.bulkDelete(unique)
}

/** 彻底删除一名/多名学生及其全部关联记录 */
export async function hardDeleteStudents(studentIds: string[]): Promise<void> {
  const ids = Array.from(new Set(studentIds))
  if (ids.length === 0) return

  // 1) 收集该生的 1对1 课程 → 这些课程也要级联删除
  const allCourses = await db.courses.toArray()
  const ownedCourseIds = allCourses
    .filter((c) => c.studentId && ids.includes(c.studentId))
    .map((c) => c.id)

  // 2) 级联删除课程（含其出席/结算/反馈）
  await hardDeleteCourses(ownedCourseIds)

  // 3) 删除该生作为成员的班课成员关系（保留班课本身）
  const allMembers = await db.groupMembers.toArray()
  const memberIds = allMembers
    .filter((m) => ids.includes(m.studentId))
    .map((m) => m.id)
  await softDeleteThenPurge(db.groupMembers, memberIds)

  // 4) 删除该生的支付记录
  const allPayments = await db.payments.toArray()
  const paymentIds = allPayments
    .filter((p) => p.studentId && ids.includes(p.studentId))
    .map((p) => p.id)
  await softDeleteThenPurge(db.payments, paymentIds)

  // 5) 删除该生的标签关联
  const allStudentTags = await db.studentTags.toArray()
  const tagRelIds = allStudentTags
    .filter((st) => ids.includes(st.studentId))
    .map((st) => st.id)
  await softDeleteThenPurge(db.studentTags, tagRelIds)

  // 6) 删除该生的学习报告
  const allReports = await db.learningReports.toArray()
  const reportIds = allReports
    .filter((r) => ids.includes(r.studentId))
    .map((r) => r.id)
  await softDeleteThenPurge(db.learningReports, reportIds)

  // 7) 删除学生本体
  await softDeleteThenPurge(db.students, ids)
}

/** 彻底删除一门/多门课程及其关联记录 */
export async function hardDeleteCourses(courseIds: string[]): Promise<void> {
  const ids = Array.from(new Set(courseIds))
  if (ids.length === 0) return

  // 删除该课程的出席记录
  const allAtt = await db.courseAttendances.toArray()
  const attIds = allAtt.filter((a) => ids.includes(a.courseId)).map((a) => a.id)
  await softDeleteThenPurge(db.courseAttendances, attIds)

  // 删除该课程的结算记录
  const allSettle = await db.settlements.toArray()
  const settleIds = allSettle.filter((s) => ids.includes(s.courseId)).map((s) => s.id)
  await softDeleteThenPurge(db.settlements, settleIds)

  // 删除该课程的课后反馈
  const allFeedback = await db.courseFeedbacks.toArray()
  const feedbackIds = allFeedback.filter((f) => ids.includes(f.courseId)).map((f) => f.id)
  await softDeleteThenPurge(db.courseFeedbacks, feedbackIds)

  // 删除课程本体
  await softDeleteThenPurge(db.courses, ids)
}
