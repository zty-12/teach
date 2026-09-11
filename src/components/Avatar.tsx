/**
 * 通用头像：圆形 + 配色 + 单字首字母。
 *
 * 统一替换原本散落在 Students / Groups / Reports / AttendanceModal 中
 * 6 处 "subjectColorVar(colorSlot) + initialOf(name)" 重复代码。
 */
import { cn, initialOf, subjectColorVar } from '@/lib/utils'

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

const SIZE_CLASS: Record<AvatarSize, string> = {
  xs: 'h-5 w-5 text-[10px]',
  sm: 'h-7 w-7 text-[12px]',
  md: 'h-9 w-9 text-[14px]',
  lg: 'h-12 w-12 text-[16px]',
  xl: 'h-16 w-16 text-[22px]',
}

export interface AvatarProps {
  /** 用于显示的姓名（取首字） */
  name: string
  /** 配色槽 1-8，对应 subjectColorVar */
  colorSlot: number
  size?: AvatarSize
  className?: string
  /** 自定义背景色（覆盖 colorSlot 调色盘） */
  customColor?: string
}

export function Avatar({
  name,
  colorSlot,
  size = 'sm',
  className,
  customColor,
}: AvatarProps) {
  const bg = customColor ?? subjectColorVar(colorSlot)
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white',
        SIZE_CLASS[size],
        className,
      )}
      style={{ background: bg }}
      aria-hidden
    >
      {initialOf(name)}
    </span>
  )
}