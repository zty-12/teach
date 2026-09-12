/**
 * 中国法定节假日 / 调休上班日。
 *
 * 数据来源：国务院办公厅《关于2026年部分节假日安排的通知》（2025-11-04 发布）。
 *  - holiday：法定放假（含调休连休）
 *  - workday：调休上班（周末补班）
 *
 * 维护说明：每年国务院发布新一年通知后更新本表；未收录的年份按「无数据」处理，
 * 不会误报（排课时对无数据的日期不提示）。
 */

export interface HolidayInfo {
  type: 'holiday' | 'workday'
  /** 所属节日名（元旦/春节/清明/劳动节/端午/中秋/国庆） */
  name: string
}

/** 放假区间（含首尾） */
const HOLIDAY_RANGES: Array<{ from: string; to: string; name: string }> = [
  { from: '2026-01-01', to: '2026-01-03', name: '元旦' },
  { from: '2026-02-15', to: '2026-02-23', name: '春节' },
  { from: '2026-04-04', to: '2026-04-06', name: '清明' },
  { from: '2026-05-01', to: '2026-05-05', name: '劳动节' },
  { from: '2026-06-19', to: '2026-06-21', name: '端午' },
  { from: '2026-09-25', to: '2026-09-27', name: '中秋' },
  { from: '2026-10-01', to: '2026-10-07', name: '国庆' },
]

/** 调休上班日（周末补班） */
const WORKDAY_DATES: Array<{ date: string; name: string }> = [
  { date: '2026-01-04', name: '元旦' },
  { date: '2026-02-14', name: '春节' },
  { date: '2026-02-28', name: '春节' },
  { date: '2026-05-09', name: '劳动节' },
  { date: '2026-09-20', name: '国庆' },
  { date: '2026-10-10', name: '国庆' },
]

function nextDayKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  const dt = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
  dt.setDate(dt.getDate() + 1)
  const yy = dt.getFullYear()
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

const INFO_MAP: Map<string, HolidayInfo> = (() => {
  const map = new Map<string, HolidayInfo>()
  for (const r of HOLIDAY_RANGES) {
    for (let k = r.from; k <= r.to; k = nextDayKey(k)) {
      map.set(k, { type: 'holiday', name: r.name })
    }
  }
  for (const w of WORKDAY_DATES) {
    map.set(w.date, { type: 'workday', name: w.name })
  }
  return map
})()

/** 查询某天（YYYY-MM-DD）是否为法定假期 / 调休上班日；无数据返回 null */
export function getHolidayInfo(dateKey: string): HolidayInfo | null {
  return INFO_MAP.get(dateKey) ?? null
}
