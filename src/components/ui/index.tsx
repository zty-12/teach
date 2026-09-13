import {
  createContext,
  useContext,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CourseStatus } from '@/lib/types'
import { COURSE_STATUS_LABEL } from '@/lib/types'

// ============================================================
// Button
// ============================================================

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg'

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover',
  secondary: 'bg-surface-2 text-text-1 hover:bg-surface-3',
  ghost: 'bg-transparent text-text-2 hover:bg-surface-2 hover:text-text-1',
  danger: 'bg-money-out text-white hover:opacity-90',
}

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-5 text-[15px]',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  block?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  block = false,
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        BUTTON_VARIANT[variant],
        BUTTON_SIZE[size],
        block && 'w-full',
        className,
      )}
      {...props}
    />
  )
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
}

export function IconButton({ label, className, ...props }: IconButtonProps) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-2 transition-colors',
        'hover:bg-surface-2 hover:text-text-1 disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

// ============================================================
// Card
// ============================================================

export function Card({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={cn('card', className)}>{children}</div>
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line-1 px-4 py-3">
      <div className="min-w-0">
        <h3 className="truncate text-[15px] font-medium text-text-1">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-text-2">{subtitle}</p>}
      </div>
      {/* ⚠ 必须 shrink-0：Button 自身是 shrink-0，若这里不锁宽，窄屏（390px）下本容器会被压到
          103px 而两个按钮需要 155px → 按钮溢出卡片、被视口裁掉（移动端打卡页「关闭」实测溢出 19px）。
          与 PageHeader 的写法保持一致。 */}
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  )
}

// ============================================================
// PageHeader
// ============================================================

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-medium text-text-1">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-text-2">{subtitle}</p>}
      </div>
      {action && <div className="flex shrink-0 gap-2">{action}</div>}
    </div>
  )
}

// ============================================================
// EmptyState
// ============================================================

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 text-text-3">{icon}</div>}
      <p className="text-[15px] font-medium text-text-1">{title}</p>
      {description && <p className="mt-1 max-w-xs text-sm text-text-2">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

// ============================================================
// Modal —— PC 居中弹窗 / 移动端底部抽屉
// ============================================================

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  header,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  /** 弹窗宽度：md=默认，xl=宽两栏（排课） */
  size?: 'md' | 'xl'
  /** 自定义头部（优先于 title 的默认头部） */
  header?: ReactNode
}) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'relative flex max-h-[92vh] w-full flex-col bg-surface-0',
          'rounded-t-2xl sm:rounded-2xl',
          size === 'xl' ? 'sm:max-w-4xl' : 'sm:max-w-lg',
          'animate-in-view',
        )}
      >
        {header ? (
          header
        ) : (
          <div className="flex items-center justify-between border-b border-line-1 px-4 py-3">
            <h2 className="text-[15px] font-medium text-text-1">{title}</h2>
            <IconButton label="关闭" onClick={onClose}>
              <X size={18} />
            </IconButton>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>

        {footer && (
          <div className="flex justify-end gap-2 border-t border-line-1 px-4 py-3 pb-safe">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================
// Badge / 状态标签
// ============================================================

const COURSE_STATUS_STYLE: Record<CourseStatus, string> = {
  pending: 'bg-pending-soft text-pending',
  done: 'bg-done-soft text-done',
  cancelled: 'bg-cancel-soft text-cancel',
  leave: 'bg-leave-soft text-leave',
}

export function StatusBadge({ status }: { status: CourseStatus }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium',
        COURSE_STATUS_STYLE[status],
      )}
    >
      {COURSE_STATUS_LABEL[status]}
    </span>
  )
}

type BadgeVariant = 'neutral' | 'success' | 'primary' | 'warning' | 'danger'

const BADGE_VARIANT: Record<BadgeVariant, string> = {
  neutral: 'bg-surface-2 text-text-2',
  success: 'bg-done-soft text-done',
  primary: 'bg-accent-soft text-accent-text',
  warning: 'bg-pending-soft text-pending',
  danger: 'bg-leave-soft text-leave',
}

export function Badge({
  children,
  className,
  variant = 'neutral',
}: {
  children: ReactNode
  className?: string
  variant?: BadgeVariant
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium',
        BADGE_VARIANT[variant],
        className,
      )}
    >
      {children}
    </span>
  )
}

// ============================================================
// 表单控件
// ============================================================

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-medium text-text-1">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 block text-xs text-money-out">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-text-3">{hint}</span>
      ) : null}
    </label>
  )
}

const CONTROL_BASE =
  'w-full rounded-lg border border-line-1 bg-surface-0 px-3 py-2 text-sm text-text-1 ' +
  'placeholder:text-text-3 focus:border-accent focus:outline-none'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(CONTROL_BASE, 'h-10', className)} {...props} />
}

export function Textarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(CONTROL_BASE, 'min-h-20 resize-y', className)} {...props} />
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(CONTROL_BASE, 'h-10 pr-8', className)} {...props}>
      {children}
    </select>
  )
}

// ============================================================
// 分段控件（PC / 移动端用于切换视图模式）
// ============================================================

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  variant = 'default',
  layout = 'inline',
  size = 'md',
  className,
  disabled = false,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string; activeClassName?: string }[]
  /** 'default' 滑块式（浅底选中）；'strong' 选中即高亮实色背景；'toggle' 胶囊切换 */
  variant?: 'default' | 'strong' | 'toggle'
  /** 'inline' 内容自适应；'grid' 均分填满，配合 gridCols 使用 */
  layout?: 'inline' | 'grid'
  size?: 'sm' | 'md'
  className?: string
  disabled?: boolean
}) {
  const isGrid = layout === 'grid'
  return (
    <div
      className={cn(
        'inline-flex rounded-lg bg-surface-2 p-0.5',
        isGrid && 'grid w-full',
        className,
      )}
      style={isGrid ? { gridAutoFlow: 'column', gridAutoColumns: '1fr' } : undefined}
    >
      {options.map((opt) => {
        const active = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              'rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              size === 'sm' ? 'px-3 py-1.5 text-[13px]' : 'px-3 py-2 text-sm',
              // 默认滑块式：选中为白底浮起
              variant === 'default' &&
                (active
                  ? 'bg-surface-0 text-text-1 shadow-sm'
                  : 'text-text-2 hover:text-text-1'),
              // 强实底：选中为强调色填充
              variant === 'strong' &&
                (active
                  ? opt.activeClassName ?? 'bg-accent text-white shadow-sm'
                  : 'text-text-2 hover:text-text-1'),
              // 胶囊式：选中为描边高亮
              variant === 'toggle' &&
                (active
                  ? 'bg-accent-soft text-accent-text ring-1 ring-inset ring-accent/30'
                  : 'text-text-2 hover:text-text-1'),
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

// ============================================================
// Tabs（复刻 lessonledger 的「基本与结算设置 / 备注说明」切换）
// 通过 context 管理激活态，仅渲染当前 Tab 内容。
// ============================================================

const TabsContext = createContext<{ value: string; setValue: (v: string) => void }>({
  value: '',
  setValue: () => undefined,
})

export function Tabs<T extends string>({
  value,
  onValueChange,
  children,
  className,
}: {
  value: T
  onValueChange: (v: T) => void
  children: ReactNode
  className?: string
}) {
  const [internal, setInternal] = useState<T>(value)
  const active = value ?? internal
  return (
    <TabsContext.Provider
      value={{
        value: active,
        setValue: (v) => {
          setInternal(v as T)
          onValueChange(v as T)
        },
      }}
    >
      <div className={cn('w-full', className)}>{children}</div>
    </TabsContext.Provider>
  )
}

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('inline-flex w-full rounded-lg bg-surface-2 p-0.5', className)}>
      {children}
    </div>
  )
}

export function TabsTrigger<T extends string>({
  value,
  children,
  className,
}: {
  value: T
  children: ReactNode
  className?: string
}) {
  const ctx = useContext(TabsContext)
  const active = ctx.value === value
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => ctx.setValue(value)}
      className={cn(
        'flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
        active ? 'bg-surface-0 text-text-1 shadow-sm' : 'text-text-2 hover:text-text-1',
        className,
      )}
    >
      {children}
    </button>
  )
}

export function TabsContent<T extends string>({
  value,
  children,
  className,
}: {
  value: T
  children: ReactNode
  className?: string
}) {
  const ctx = useContext(TabsContext)
  if (ctx.value !== value) return null
  return <div className={cn('w-full', className)}>{children}</div>
}

// ============================================================
// 指标卡
// ============================================================

export function MetricCard({
  label,
  value,
  hint,
  tone = 'default',
  variant = 'card',
  onClick,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'accent' | 'done' | 'due' | 'out'
  variant?: 'card' | 'plain'
  onClick?: () => void
}) {
  const toneClass = {
    default: 'text-text-1',
    accent: 'text-accent',
    done: 'text-money-in',
    due: 'text-money-due',
    out: 'text-money-out',
  }[tone]

  const Comp = onClick ? 'button' : 'div'

  return (
    <Comp
      onClick={onClick}
      className={cn(
        'text-left',
        variant === 'card' && 'card px-4 py-3',
        variant === 'card' && onClick && 'transition-colors hover:bg-surface-1 active:bg-surface-2',
      )}
    >
      <div className="truncate text-xs text-text-2">{label}</div>
      <div className={cn('mt-1 text-xl font-medium tabular-nums', toneClass)}>
        {value}
      </div>
      {hint && <div className="mt-1 truncate text-[11px] text-text-3">{hint}</div>}
    </Comp>
  )
}
