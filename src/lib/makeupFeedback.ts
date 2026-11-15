import { db, markDeleted } from '@/lib/db'
import { softDeleteCourseKnowledgesForCourses } from '@/lib/courseKnowledge'

/**
 * v31.37 清理历史：软删「补课课程」的课后反馈（幂等，可重复调用）。
 *
 * 背景：课后反馈不是完成时自动生成的记录，而是
 *   「已完成课程(status=done) − 已有 courseFeedbacks = 待写反馈」。
 * 因此 v31.37 之前完成补课后会出现在「待写反馈」与工作台待办里。
 * 用户口径「补课也不需要课后反馈」+「启动自动软删历史」，故在 App 启动后跑一次幂等补偿。
 *
 * 严格限定范围，避免误伤：
 *  - 只认 Course.isMakeup === true 的课程（含已软删的补课，其反馈同样是孤儿）；
 *  - 只处理仍存活的 courseFeedbacks；老师手动删过的（已有墓碑）不会重复写；
 *  - markDeleted 会同时刷 deletedAt / updatedAt / dirty=1，软删可推云端、换设备不复活；
 *  - 顺带软删这些补课课程的知识点关联，与「手动删除反馈」行为一致
 *    （见 Feedback.tsx handleDelete → softDeleteCourseKnowledges）。
 *
 * 每次启动都会跑：若首次启动时云端数据尚未同步完整，第二次启动会补清。
 *
 * @returns 本次清理的反馈条数
 */
export async function purgeMakeupCourseFeedbacks(): Promise<number> {
  const [courses, feedbacks] = await Promise.all([
    db.courses.toArray(),
    db.courseFeedbacks.toArray(),
  ])
  const makeupIds = new Set(
    courses.filter((c) => c.isMakeup === true).map((c) => c.id),
  )
  if (makeupIds.size === 0) return 0
  const targets = feedbacks.filter(
    (f) => !f.deletedAt && makeupIds.has(f.courseId),
  )
  if (targets.length === 0) return 0
  for (const f of targets) {
    await db.courseFeedbacks.put(markDeleted(f))
  }
  await softDeleteCourseKnowledgesForCourses(
    Array.from(new Set(targets.map((f) => f.courseId))),
  )
  return targets.length
}
