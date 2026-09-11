/**
 * 共享柱状图
 *
 * 设计目标：把工作台"本周概览"与财务页"近 6 月收款趋势"中重复的
 * 刻度轴 / 虚线网格 / 自适应高度逻辑合并到一处。两种用法：
 *
 *  - 工作台：7 个数据点，今天高亮（`active`），hover 显示该日课节明细
 *  - 财务页：6 个数据点，统一主色，hover 显示该月金额
 */
import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'

export interface BarDatum {
  /** x 轴标签 */
  label: string
  /** y 轴数值 */
  value: number
  /** 是否高亮（今天/特殊日） */
  active?: boolean
  /** bar 上方数值的小字（如"节"或"元"） */
  suffix?: string
}

export interface BarChartProps {
  data: BarDatum[]
  /** 自定义最大值；不传则按 data 最大值自适应 */
  maxValue?: number
  /** y 轴刻度数量（含 0 和顶部） */
  ticks?: number
  /** 柱体配色 */
  variant?: 'accent' | 'money-in' | 'pending'
  className?: string
  /** hover 某根柱时回调；离开所有柱时传 null */
  onHoverChange?: (index: number | null) => void
}

// 总高度 = 柱体图区 92px + 上下内边距（top 12 / label 24）+ 1px border
const PLOT_H = 92
const TOP_PAD = 12
const LABEL_H = 24
const TOTAL_H = PLOT_H + TOP_PAD + LABEL_H + 2

/** 顶端预留 4px，避免满值时柱体顶部被裁切 */
const HEIGHT_PADDING = 4

const VARIANT_BAR_ACTIVE: Record<NonNullable<BarChartProps['variant']>, string> = {
  accent: 'bg-gradient-to-b from-accent to-accent-hover shadow-lg',
  'money-in': 'bg-gradient-to-b from-money-in to-money-in/70',
  pending: 'bg-gradient-to-b from-pending to-pending/70',
}
const VARIANT_BAR_IDLE = 'bg-surface-3'
const VARIANT_VALUE_ACTIVE = 'text-accent'
const VARIANT_LABEL_ACTIVE = 'text-accent'

export function BarChart({
  data,
  maxValue,
  ticks = 6,
  variant = 'accent',
  className,
  onHoverChange,
}: BarChartProps) {
  const [hovered, setHovered] = useState<number | null>(null)

  const max = useMemo(
    () => Math.max(1, maxValue ?? Math.max(...data.map((d) => d.value), 1)),
    [data, maxValue],
  )

  return (
    <div className={cn('grid grid-cols-[28px_minmax(0,1fr)] gap-3', className)}>
      {/* y 轴刻度 */}
      <div className="relative" style={{ height: `${TOTAL_H}px` }}>
        {Array.from({ length: ticks }, (_, i) => ticks - i).map((tick) => {
          const ratio = max > 0 ? tick / ticks : 0
          // 顶端对应 max，留 HEIGHT_PADDING 余地；底部留 LABEL_H
          const bottom = ratio * PLOT_H + LABEL_H - HEIGHT_PADDING * ratio
          return (
            <span
              key={tick}
              className="absolute right-0 translate-y-1/2 text-[10px] font-medium tabular-nums text-text-2"
              style={{ bottom: `${bottom}px` }}
            >
              {tick}
            </span>
          )
        })}
      </div>

      {/* 绘图区 */}
      <div
        className="relative rounded-xl border border-line-1 pt-3"
        style={{ height: `${TOTAL_H}px`, paddingBottom: `${LABEL_H}px` }}
      >
        {/* 水平虚线 */}
        {Array.from({ length: ticks }, (_, i) => ticks - i).map((tick) => {
          const ratio = max > 0 ? tick / ticks : 0
          const bottom = ratio * PLOT_H + LABEL_H - HEIGHT_PADDING * ratio
          return (
            <div
              key={tick}
              className="absolute inset-x-1.5 border-t border-dashed border-line-1"
              style={{ bottom: `${bottom}px` }}
            />
          )
        })}

        {/* 柱体 */}
        <div
          className="absolute left-1.5 right-1.5 top-3"
          style={{ height: `${PLOT_H - HEIGHT_PADDING}px` }}
        >
          <div
            className="grid h-full items-end gap-1.5"
            style={{ gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))` }}
          >
            {data.map((d, i) => (
              <div
                key={`${d.label}-${i}`}
                className="group relative flex min-w-0 flex-col items-center justify-end gap-1.5"
                onMouseEnter={() => {
                  setHovered(i)
                  onHoverChange?.(i)
                }}
                onMouseLeave={() => {
                  setHovered((cur) => (cur === i ? null : cur))
                  onHoverChange?.(null)
                }}
              >
                <span
                  className={cn(
                    'text-[10px] font-semibold tabular-nums transition-colors',
                    d.active ? VARIANT_VALUE_ACTIVE : 'text-text-2',
                  )}
                >
                  {d.value}
                  {d.suffix ? ` ${d.suffix}` : ''}
                </span>
                <div
                  className={cn(
                    'w-full rounded-t-lg rounded-b-[3px] transition-all',
                    d.active ? VARIANT_BAR_ACTIVE[variant] : VARIANT_BAR_IDLE,
                    hovered === i && !d.active && 'opacity-90',
                  )}
                  style={{
                    height: `${Math.max(4, (d.value / max) * (PLOT_H - HEIGHT_PADDING))}px`,
                  }}
                />
              </div>
            ))}
          </div>
        </div>

        {/* x 轴标签 */}
        <div
          className="absolute bottom-0 left-1.5 right-1.5 flex items-end"
          style={{ height: `${LABEL_H}px` }}
        >
          <div
            className="grid w-full gap-1.5"
            style={{ gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))` }}
          >
            {data.map((d, i) => (
              <div key={`${d.label}-label-${i}`} className="flex min-w-0 justify-center">
                <span
                  className={cn(
                    'text-[10px] font-medium leading-none',
                    d.active ? VARIANT_LABEL_ACTIVE : 'text-text-2',
                  )}
                >
                  {d.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 当前柱图总高度，供外层布局容器计算预留空间 */
export const BAR_CHART_HEIGHT = TOTAL_H