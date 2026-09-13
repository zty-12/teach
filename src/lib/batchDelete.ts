/**
 * 级联批量删除工具（彻底删除）
 *
 * 语义：
 *  - 协调同步：对每条记录做软删标记（deletedAt + dirty=1），让同步引擎能在推送阶段
 *    把删除传播到云端；随后由 sync.ts 的 pushAll 在确认推送成功后物理清除本地墓碑。
 *  - **本函数不再物理删除**：否则墓碑在推送前就被抹掉，云端仍保留激活记录，
 *    下次拉取会把已删数据「复活」（即用户反馈的"删了又出现"问题）。
 *    纯本地模式（未配置云端）的墓碑堆积，由 App 启动时的 purgeTombstones 统一回收。
 *  - 级联清理：删除学生时，连带清掉其 1对1 课程、出席、结算、反馈、支付、
 *    标签关联、班课成员关系；删除课程时，连带清掉该课的出席、结算、反馈、
 *    知识点关联（courseKnowledges），以及该课自动生成的课后打卡任务与课堂积分活动（含其记录与积分流水）。
 *
 * ⚠️ 所有读取路径都已过滤 `!deletedAt`，保留墓碑不会影响任何 UI。
 */
import { db } from './db'
import type { Table } from 'dexie'
import { deleteCheckInTask } from './points'
import { deleteClassActivity } from './classPoints'
import { softDeleteCourseKnowledgesForCourses } from './courseKnowledge'

/**
 * 对一张表：软删（标记 deletedAt + dirty=1 以传播同步），保留墓碑等待推送。
 * 由 sync.ts 在推送成功后物理清除（PushAll 的 tombstone 清理），
 * 因此本函数**不做** bulkDelete —— 否则删除永远到不了云端。
 */
async function softDeleteThenPurge<T extends { id: string; deletedAt: number | null }>(
  table: Table<T, string>,
  ids: string[],
): Promise<void> {
  const unique = Array.from(new Set(ids))
  if (unique.length === 0) return
  const originals = await table.where('id').anyOf(unique).toArray()
  if (originals.length === 0) return
  const now = Date.now()
  const purged = originals.map((o) => ({
    ...o,
    deletedAt: now,
    updatedAt: now,
    dirty: 1 as const,
  }))
  await table.bulkPut(purged)
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

  // 7) 积分流水 / 打卡记录 / 课堂积分记录 / 学生画像 / 兑换记录
  //    这几张表都以 studentId 关联，且都属于「该生的个人数据」；
  //    不清理会在库里留下指向已删学生的孤儿行（积分余额、画像、兑换记录等）。
  const allLedgers = await db.pointLedgers.toArray()
  await softDeleteThenPurge(
    db.pointLedgers,
    allLedgers.filter((l) => ids.includes(l.studentId)).map((l) => l.id),
  )

  const allCheckInRecords = await db.checkInRecords.toArray()
  await softDeleteThenPurge(
    db.checkInRecords,
    allCheckInRecords.filter((r) => ids.includes(r.studentId)).map((r) => r.id),
  )

  const allClassRecords = await db.classActivityRecords.toArray()
  await softDeleteThenPurge(
    db.classActivityRecords,
    allClassRecords.filter((r) => ids.includes(r.studentId)).map((r) => r.id),
  )

  const allProfiles = await db.studentProfiles.toArray()
  await softDeleteThenPurge(
    db.studentProfiles,
    allProfiles.filter((p) => ids.includes(p.studentId)).map((p) => p.id),
  )

  const allRedemptions = await db.redemptions.toArray()
  await softDeleteThenPurge(
    db.redemptions,
    allRedemptions.filter((r) => ids.includes(r.studentId)).map((r) => r.id),
  )

  // 8) 删除学生本体
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

  // 删除该课程的知识点关联。
  // 不清理的后果：反馈页保存知识点时建的 courseKnowledges 行会变成孤儿，
  // 永久留在本地与云端（消费方按活课程取用，所以不会算错数字，但会一直同步、永不回收）。
  await softDeleteCourseKnowledgesForCourses(ids)

  // 删除该课程「自动生成」的课后打卡任务与课堂积分活动。
  // 不清理的后果（v24 遗留）：课程已删，这些任务仍留在打卡页 / 课堂积分页，
  // 成为指向已删课程的孤儿；课程列表里再也找不到它们，老师无从回收。
  await purgeCourseAutoArtifacts(ids)

  // 删除课程本体
  await softDeleteThenPurge(db.courses, ids)
}

/**
 * 清理若干课程「自动生成」的课后打卡任务与课堂积分活动。
 *
 * 所有「删除课程」的入口都必须调用它 —— 否则课程没了，派生的任务/活动仍留在
 * 打卡页 / 课堂积分页，成为指向已删课程的孤儿（v24 遗留问题）。
 *  - `deleteCheckInTask` 会连带软删该任务的记录与积分流水；
 *  - `deleteClassActivity` 会连带撤销该活动的记录与已发积分。
 *
 * @param courseIds 被删除的课程 id
 * @param opts.reason 默认 'manual'（老师主动删除）→ 完成后 ensureAuto* 不会重建；
 *                    `revertCompletion` 走自己的回收链路（reason='revert'），不经过这里。
 */
export async function purgeCourseAutoArtifacts(
  courseIds: string[],
  opts?: { reason?: 'manual' | 'revert' },
): Promise<{ tasks: number; activities: number }> {
  const ids = Array.from(new Set(courseIds))
  if (ids.length === 0) return { tasks: 0, activities: 0 }
  const reason = opts?.reason ?? 'manual'

  const tasks = (await db.checkInTasks.toArray()).filter(
    (t) => !t.deletedAt && !!t.courseId && ids.includes(t.courseId),
  )
  for (const t of tasks) await deleteCheckInTask(t.id, { reason })

  const allClassRecords = await db.classActivityRecords.toArray()
  const activities = (await db.classActivities.toArray()).filter(
    (a) =>
      !a.deletedAt && a.auto === true && !!a.sourceCourseId && ids.includes(a.sourceCourseId),
  )
  for (const a of activities) await deleteClassActivity(a, allClassRecords, { reason })

  return { tasks: tasks.length, activities: activities.length }
}
