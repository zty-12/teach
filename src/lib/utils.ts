import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import {
  addDays,
  endOfDay,
  format,
  isSameDay,
  startOfDay,
  startOfWeek,
} from 'date-fns'
import type { Course, Group } from './types'

/** 合并 Tailwind 类名，后面的覆盖前面的 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

// ============================================================
// 金额
// ============================================================

/** 分 → ¥1,234.56 */
export function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const yuan = Math.floor(abs / 100)
  const fen = abs % 100
  return `${sign}¥${yuan.toLocaleString('zh-CN')}.${String(fen).padStart(2, '0')}`
}

/** 分 → 简短金额（用于指标卡，如 ¥24k） */
export function formatMoneyShort(cents: number): string {
  const abs = Math.abs(cents)
  const sign = cents < 0 ? '-' : ''
  if (abs >= 1_000_00) {
    return `${sign}¥${(abs / 100_000).toFixed(1)}w`
  }
  if (abs >= 1_000_00 / 10) {
    return `${sign}¥${(abs / 100).toFixed(1)}k`
  }
  return `${sign}¥${(abs / 100).toFixed(0)}`
}

// ============================================================
// 时间
// ============================================================

/** 毫秒时间戳 → HH:mm */
export function formatTime(ts: number): string {
  return format(new Date(ts), 'HH:mm')
}

/** 毫秒时间戳 → M月d日 */
export function formatDate(ts: number): string {
  return format(new Date(ts), 'M月d日')
}

/** 毫秒时间戳 → M月d日 HH:mm */
export function formatDateTime(ts: number): string {
  return format(new Date(ts), 'M月d日 HH:mm')
}

/** 毫秒时间戳 → 周几 */
export function formatWeekday(ts: number): string {
  return format(new Date(ts), 'EEEEEE')
}

/** 周一为一周起点，返回该周 7 天的起始时间戳 */
export function getWeekDays(anchor: number | Date): number[] {
  const d = typeof anchor === 'number' ? new Date(anchor) : anchor
  const monday = startOfWeek(d, { weekStartsOn: 1 })
  return Array.from({ length: 7 }, (_, i) => startOfDay(addDays(monday, i)).getTime())
}

/**
 * 课程有效时长（分钟）。
 * 对班课关联课程，优先采用班课「每周固定时段」的时间窗跨度，
 * 保证「改班课时间窗，已排课程在所有视图都跟着变」；
 * 否则 fallback 到课程自身 durationMin / 班课 defaultDurationMin。
 */
export function courseDurationMin(course: Course, groupMap?: Map<string, Group>): number {
  if (!course.groupId || !groupMap) return course.durationMin
  const g = groupMap.get(course.groupId)
  if (!g) return course.durationMin
  if (
    typeof g.startTimeMin === 'number' && g.startTimeMin >= 0 &&
    typeof g.endTimeMin === 'number' && g.endTimeMin > g.startTimeMin
  ) {
    return g.endTimeMin - g.startTimeMin
  }
  return course.durationMin > 0 ? course.durationMin : (g.defaultDurationMin ?? course.durationMin)
}

/** 课程结束时间戳 */
export function courseEnd(course: Course, groupMap?: Map<string, Group>): number {
  return course.startAt + courseDurationMin(course, groupMap) * 60_000
}

/** 格式化课程时间区间，如「09:00 - 10:00」 */
export function formatCourseRange(course: Course, groupMap?: Map<string, Group>): string {
  return `${formatTime(course.startAt)} - ${formatTime(courseEnd(course, groupMap))}`
}

export { isSameDay, startOfDay, endOfDay, startOfWeek, addDays, format }

// ============================================================
// 排课冲突检测
// ============================================================

/**
 * 检测新课程与已有课程是否时间重叠。
 * 规则：同一教师同一时间段只能上一节课（班课也占教师时间），
 * 因此只要时间区间相交即视为冲突。
 */
export function findConflicts(
  candidate: { startAt: number; durationMin: number; id?: string },
  existing: Course[],
  groupMap?: Map<string, Group>,
): Course[] {
  const start = candidate.startAt
  const end = start + candidate.durationMin * 60_000
  return existing.filter((c) => {
    if (c.deletedAt) return false
    if (c.status === 'cancelled') return false
    if (candidate.id && c.id === candidate.id) return false
    const cStart = c.startAt
    const cEnd = courseEnd(c, groupMap)
    return start < cEnd && cStart < end
  })
}

// ============================================================
// 配色
// ============================================================

/** 取科目配色槽（1-8）对应的 CSS 变量名 */
export function subjectColorVar(slot: number): string {
  const s = ((Math.floor(slot) - 1) % 8 + 8) % 8 + 1
  return `var(--subject-${s})`
}

/** 取科目配色槽对应的 Tailwind 颜色工具类 */
export function subjectColorClass(slot: number): string {
  const s = ((Math.floor(slot) - 1) % 8 + 8) % 8 + 1
  return `bg-subject-${s}`
}

/** 根据字符串稳定地分配一个配色槽（1-8），用于科目名散列 */
export function slotFromString(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i)
    hash |= 0
  }
  return (Math.abs(hash) % 8) + 1
}

// ============================================================
// 其它
// ============================================================

/** 手机号脱敏：138****1234 */
export function maskPhone(phone: string): string {
  const p = phone.trim()
  if (p.length !== 11) return p
  return `${p.slice(0, 3)}****${p.slice(7)}`
}

/** 姓名取首字（用于头像） */
export function initialOf(name: string): string {
  const n = name.trim()
  if (!n) return '?'
  // 中文取最后一个字（更接近「名」），英文取首字母
  if (/[\u4e00-\u9fa5]/.test(n)) return n.slice(-1)
  return n[0]!.toUpperCase()
}
