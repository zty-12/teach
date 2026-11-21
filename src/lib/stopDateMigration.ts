/**
 * v31.41 一次性历史数据修正：补录学生的「停课起始日」。
 *
 * 背景：吴书林实际 2026-10-02 起已停课，但归档操作办得较晚，
 * 旧的 v31.40 口径按「移出班课时间」截断会把 10-02 ~ 归档日之间的课
 * 错误算进出席名单。这里按真实停课日补一个日期，之后用户可在
 * 「学生 → 编辑 → 停课起始日」随时自行修改。
 *
 * 幂等：只对名单里还没有该日期的学生写入；已填写（含用户手改）一律不覆盖。
 * 仅影响出勤名单，不改课酬 / 课时 / 结算，也不改出席记录本身。
 * 这段常量只服务于本次历史补录，后续可清理。
 */
import { db, touch } from './db'

const LEGACY_STOP_DATES: Array<{ name: string; date: string }> = [
  { name: '吴书林', date: '2026-10-02' },
]

export async function applyLegacyStopDates(): Promise<void> {
  try {
    const students = await db.students.toArray()
    for (const s of students) {
      if (s.deletedAt) continue
      if (s.attendanceStopFrom) continue
      const hit = LEGACY_STOP_DATES.find((x) => x.name === s.name)
      if (!hit) continue
      await db.students.put(touch({ ...s, attendanceStopFrom: hit.date }))
    }
  } catch {
    // 启动钩子不阻断应用；失败时用户仍可在学生详情手动填写该日期。
  }
}
