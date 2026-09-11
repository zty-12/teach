/**
 * 8 色调色盘：统一替换 Students 头像配色 / Reports 标签配色 / Groups 头像配色
 * 三处各写一份的 `Array.from({ length: 8 }, ...)` 重复代码。
 */
import { cn, subjectColorVar } from '@/lib/utils'

export interface ColorPickerProps {
  value: number
  onChange: (slot: number) => void
  /** 显示用的标签（如"头像配色"/"配色"） */
  ariaPrefix?: string
  className?: string
}

export function ColorPicker({
  value,
  onChange,
  ariaPrefix = '配色',
  className,
}: ColorPickerProps) {
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {Array.from({ length: 8 }, (_, i) => i + 1).map((slot) => {
        const active = value === slot
        return (
          <button
            key={slot}
            type="button"
            aria-label={`${ariaPrefix} ${slot}`}
            onClick={() => onChange(slot)}
            className={cn(
              'h-8 w-8 rounded-full transition-transform',
              active && 'ring-2 ring-accent ring-offset-2',
            )}
            style={{ background: subjectColorVar(slot) }}
          />
        )
      })}
    </div>
  )
}