/**
 * 学生详情 - 学习标签 Tab
 *
 * 复用 Reports 标签库：按类型分组，点击即可给该学生打/取消标签。
 * 标签管理（新建/删除）入口指向 Reports 页签。
 */
import { useMemo } from 'react'
import { markDeleted, touch, withSyncFields } from '@/lib/db'
import type { LearningTag, StudentTag } from '@/lib/types'
import { db } from '@/lib/db'
import { TagBadge } from '@/components/TagBadge'
import { cn } from '@/lib/utils'

export function TagsTab({
  studentId,
  tags,
  studentTags,
}: {
  studentId: string
  tags: LearningTag[]
  studentTags: StudentTag[]
}) {
  const assignedIds = useMemo(
    () => new Set(studentTags.map((t) => t.tagId)),
    [studentTags],
  )

  const grouped = useMemo(() => {
    const map = new Map<string, LearningTag[]>()
    for (const t of tags) {
      const key = t.type || '未分类'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(t)
    }
    return Array.from(map.entries())
  }, [tags])

  const myTags = tags.filter((t) => assignedIds.has(t.id))

  async function toggle(tagId: string) {
    const existing = studentTags.find(
      (st) => st.studentId === studentId && st.tagId === tagId && !st.deletedAt,
    )
    if (existing) {
      await db.studentTags.put(markDeleted(existing))
    } else {
      const stale = studentTags.find(
        (st) => st.studentId === studentId && st.tagId === tagId && st.deletedAt,
      )
      if (stale) {
        await db.studentTags.put(touch({ ...stale, deletedAt: null, assignedAt: Date.now() }))
      } else {
        await db.studentTags.put(
          withSyncFields<StudentTag>({
            studentId,
            tagId,
            assignedAt: Date.now(),
          }),
        )
      }
    }
  }

  if (tags.length === 0) {
    return (
      <div className="p-8 text-center text-[13px] text-text-3">
        标签库为空，请先到「学习报告 → 标签库」创建标签
      </div>
    )
  }

  return (
    <div className="p-4">
      {/* 当前已选 */}
      <div className="mb-3 rounded-lg border border-line-1 bg-surface-0 p-3">
        <p className="text-[13px] font-semibold text-text-1">
          已选 {myTags.length} 个标签
        </p>
        {myTags.length === 0 ? (
          <p className="mt-2 text-[12px] text-text-3">
            点击下方标签即可添加
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {myTags.map((t) => (
              <TagBadge key={t.id} tag={t} variant="filled" />
            ))}
          </div>
        )}
      </div>

      {/* 按类型分组 */}
      <div className="space-y-3">
        {grouped.map(([typeName, list]) => (
          <div key={typeName} className="rounded-lg border border-line-1 bg-surface-0 p-3">
            <p className="mb-2 text-[11px] font-medium text-text-3">{typeName}</p>
            <div className="flex flex-wrap gap-1.5">
              {list.map((t) => {
                const on = assignedIds.has(t.id)
                return (
                  <button
                    key={t.id}
                    onClick={() => void toggle(t.id)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] transition-colors',
                      on
                        ? 'border-accent bg-accent/10 text-accent-text'
                        : 'border-line-1 text-text-2 hover:bg-surface-1',
                    )}
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{
                        background: on ? 'currentColor' : undefined,
                      }}
                    />
                    {t.name}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ============================================================
// 顶部信息块（仅占位避免未使用导入警告）
// ============================================================
// (TAG_TYPES 已被分组动态复用，无需额外导入)