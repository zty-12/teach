/**
 * 学习标签徽章：统一 Reports `TagChip`（表面）+ Students `TagChips`（圆点+透明底）
 * 两套样式。`variant` 控制：'surface' = Reports 列表；'filled' = Students 头像配色调；
 * 'chip' = Students 表格行窄样式。
 */
import { cn, subjectColorVar } from '@/lib/utils'
import type { LearningTag } from '@/lib/types'

export type TagBadgeVariant = 'surface' | 'filled' | 'chip'

export interface TagBadgeProps {
  tag: LearningTag
  variant?: TagBadgeVariant
  className?: string
}

const VARIANT_CLASS: Record<TagBadgeVariant, string> = {
  surface: 'bg-surface-2 text-text-2 px-2 py-0.5 text-xs gap-1.5',
  filled: 'px-2 py-0.5 text-[11px] font-medium gap-0',
  chip: 'border px-3 py-1.5 text-[13px] font-medium gap-1.5',
}

export function TagBadge({
  tag,
  variant = 'surface',
  className,
}: TagBadgeProps) {
  const dot = (
    <span
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: subjectColorVar(tag.colorSlot) }}
    />
  )

  if (variant === 'filled') {
    return (
      <span
        className={cn(
          'inline-flex items-center rounded-full text-text-1',
          VARIANT_CLASS.filled,
          className,
        )}
        style={{
          background: `${subjectColorVar(tag.colorSlot)}1f`,
          color: subjectColorVar(tag.colorSlot),
        }}
      >
        {tag.name}
      </span>
    )
  }

  if (variant === 'chip') {
    return (
      <span
        className={cn(
          'inline-flex items-center rounded-full border-line-1 bg-surface-1 text-text-2',
          VARIANT_CLASS.chip,
          className,
        )}
      >
        {dot}
        {tag.name}
      </span>
    )
  }

  // 默认 surface（Reports 列表风格）
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full',
        VARIANT_CLASS.surface,
        className,
      )}
    >
      {dot}
      {tag.name}
    </span>
  )
}

export interface TagBadgeListProps {
  tags: LearningTag[]
  variant?: TagBadgeVariant
  max?: number
  className?: string
}

/** 多个 TagBadge 容器：自动截断 + 溢出提示 */
export function TagBadgeList({
  tags,
  variant = 'surface',
  max,
  className,
}: TagBadgeListProps) {
  if (tags.length === 0) return null
  const visible = max ? tags.slice(0, max) : tags
  const overflow = max && tags.length > max ? tags.length - max : 0
  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {visible.map((t) => (
        <TagBadge key={t.id} tag={t} variant={variant} />
      ))}
      {overflow > 0 && (
        <span className="text-[11px] text-text-3">+{overflow}</span>
      )}
    </div>
  )
}