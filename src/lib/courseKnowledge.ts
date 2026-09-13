/**
 * 课程 ↔ 知识点关联（CourseKnowledge）的读写。
 *
 * 从 Feedback.tsx 抽出，原因有两个：
 *  1. 这段逻辑踩过坑（曾用 bulkDelete 物理删 → 删除推不到云端 → 换设备「复活」），
 *     放在组件里无法被回归脚本覆盖；
 *  2. 「取消勾选」与「新增勾选」必须做差分，避免每次保存都堆一批墓碑 / 重复行。
 *
 * 约定：**所有删除都软删（markDeleted，留墓碑 + dirty=1）**，
 * 由 sync.ts 推送成功后清理墓碑（纯本地模式由 App 启动时 purgeTombstones 清理）。
 */
import { db, markDeleted, withSyncFields } from './db'
import type { CourseKnowledge } from './types'

/**
 * 覆盖式设置某课程关联的知识点：
 *  - 本次未勾选、但库里仍是活行的 → 软删（留墓碑，让删除能同步到云端）
 *  - 本次勾选、但库里没有活行的 → 新建
 *  - 已存在的活行 → 保持不动（不产生无谓的 dirty）
 *
 * @returns { removed, added } 软删 / 新增的条数（便于调用方提示与断言）
 */
export async function setCourseKnowledges(
  courseId: string,
  knowledgePointIds: Iterable<string>,
): Promise<{ removed: number; added: number }> {
  const wanted = new Set(knowledgePointIds)
  const all = await db.courseKnowledges.toArray()
  const mine = all.filter((k) => k.courseId === courseId)
  const liveByKp = new Map(
    mine.filter((k) => !k.deletedAt).map((k) => [k.knowledgePointId, k] as const),
  )

  // 1) 取消勾选的 → 软删
  let removed = 0
  for (const row of mine) {
    if (row.deletedAt || wanted.has(row.knowledgePointId)) continue
    await db.courseKnowledges.put(markDeleted(row))
    removed++
  }

  // 2) 新勾选的 → 建行（已有活行则跳过）
  const now = Date.now()
  const toAdd: CourseKnowledge[] = []
  for (const kpId of wanted) {
    if (liveByKp.has(kpId)) continue
    toAdd.push(
      withSyncFields<CourseKnowledge>({
        courseId,
        knowledgePointId: kpId,
        createdAt: now,
      }),
    )
  }
  if (toAdd.length > 0) await db.courseKnowledges.bulkPut(toAdd)

  return { removed, added: toAdd.length }
}

/**
 * 软删某课程的全部知识点关联（删除课后反馈时调用）。
 * ⚠ 不要改成 bulkDelete —— 那是 v26 审查实证过的 P1（删除无法传播、下一轮同步复活）。
 */
export async function softDeleteCourseKnowledges(courseId: string): Promise<number> {
  return softDeleteCourseKnowledgesForCourses([courseId])
}

/**
 * 软删若干课程的全部知识点关联（删除课程 / 删学生级联时调用）。
 *
 * 为什么不复用「逐课调用」：每次调用都会 `toArray()` 全表扫描一遍，
 * 批量删课时会退化成 N 次全表扫描。
 */
export async function softDeleteCourseKnowledgesForCourses(
  courseIds: string[],
): Promise<number> {
  const want = new Set(courseIds)
  if (want.size === 0) return 0
  const all = await db.courseKnowledges.toArray()
  const rows = all.filter((k) => !k.deletedAt && want.has(k.courseId))
  for (const row of rows) await db.courseKnowledges.put(markDeleted(row))
  return rows.length
}

/** 读取某课程当前关联的知识点 id（只取活行） */
export async function getCourseKnowledgeIds(courseId: string): Promise<string[]> {
  const all = await db.courseKnowledges.toArray()
  return all
    .filter((k) => !k.deletedAt && k.courseId === courseId)
    .map((k) => k.knowledgePointId)
}
