/**
 * 财务统一计算
 *
 * 语义约定（关键，避免把「预付完课课酬」误当成「学生欠费」）：
 *  - 预付课时（billingRule='prepaid'）：家长已把学费交给机构，学生不欠机构钱。
 *    每上一次完课，老师产生一笔「课酬待结算」——由机构按约定（通常按月）结算给老师。
 *  - 按次后付（billingRule='postpaid'）：每上一次完课，学生欠机构一笔课时费（应收）。
 *    学生缴费后冲抵，仍未缴清的部分即为「欠费」。
 *
 * 付款方语义（Payment.payer）：
 *  - 'student'：学生/家长向机构交费（充值或补缴）——冲抵后付应收。
 *  - 'institution'：机构向老师结算课酬——冲抵预付完课产生的「待结算课酬」。
 *
 * 因此财务页要把两者分开：
 *  - 待结算课酬（settlementPendingCents）= 预付学生完课课酬合计 − 累计机构结清额（机构欠老师）
 *  - 欠费（arrears）= 仅后付学生，应收 − 实收 > 0（实收仅统计 student payer）
 */
import { endOfMonth, startOfMonth, subMonths } from 'date-fns'
import type { Course, CourseAttendance, Group, GroupMember, Payment, Student } from './types'

export type LedgerType = '课酬' | '应收' | '收款' | '结清'

export interface LedgerEntry {
  id: string
  date: number
  type: LedgerType
  who: string
  subject: string
  amountCents: number
  note: string
  kind: 'course' | 'payment'
  refId?: string
  studentId?: string | null
  groupId?: string | null
  payer?: 'student' | 'institution'
}

export interface FinanceMetrics {
  /** 本月实收（含学生付款 + 机构结清，单位：分） */
  monthIncome: number
  /** 累计收款（含学生付款 + 机构结清，单位：分） */
  totalPaid: number
  /** 待结算课酬（预付完课合计 − 累计机构结清，机构欠老师） */
  settlementPendingCents: number
  /** 后付应收总额（分） */
  receivableCents: number
  /** 累计机构结清额（分）—— 用于趋势卡 chip 与透明度展示 */
  institutionSettledCents: number
  /** 欠费学生（仅后付，应收 − 实收 > 0） */
  arrears: Array<{ student: Student; outstanding: number }>
  /** 台账（课酬 / 应收 / 收款 / 结清） */
  ledger: LedgerEntry[]
  /** 近 6 月收款趋势（含 student + institution，单位：元） */
  trend: Array<{ label: string; 收入: number }>
  /** 近 6 月机构结清趋势（仅 institution，单位：元） */
  settleTrend: Array<{ label: string; 结清: number }>
}

export interface FinanceInput {
  courses: Course[]
  payments: Payment[]
  students: Student[]
  groups: Group[]
  members: GroupMember[]
  attendances?: CourseAttendance[]
  now?: number
}

export function computeFinanceMetrics(input: FinanceInput): FinanceMetrics {
  const now = input.now ?? Date.now()
  const liveCourses = input.courses.filter((c) => !c.deletedAt)
  const livePayments = input.payments.filter((p) => !p.deletedAt)
  const students = input.students.filter((s) => !s.deletedAt)
  const groups = input.groups.filter((g) => !g.deletedAt)
  const members = input.members.filter((m) => !m.deletedAt)
  const attendances = (input.attendances ?? []).filter((a) => !a.deletedAt)

  const studentMap = new Map(students.map((s) => [s.id, s]))
  const groupMap = new Map(groups.map((g) => [g.id, g]))
  const membersByGroup = new Map<string, string[]>()
  for (const m of members) {
    const arr = membersByGroup.get(m.groupId) ?? []
    arr.push(m.studentId)
    membersByGroup.set(m.groupId, arr)
  }
  const attendanceByCourse = new Map<string, CourseAttendance[]>()
  for (const a of attendances) {
    const arr = attendanceByCourse.get(a.courseId) ?? []
    arr.push(a)
    attendanceByCourse.set(a.courseId, arr)
  }

  /**
   * 一节课的金额归属到学生（用于拆分预付/后付）。
   *  - 1对1：归属该学生，share = 课酬。
   *  - 班课：按出席人数均摊课酬；缺勤不摊（缺省无出席记录时回退为全员均摊）。
   */
  function attribution(
    course: Course,
  ): Array<{ sid: string; share: number; prepaid: boolean }> {
    if (course.studentId) {
      const s = studentMap.get(course.studentId)
      if (!s) return []
      return [{ sid: s.id, share: course.feeCents, prepaid: s.billingRule === 'prepaid' }]
    }
    const memberIds = membersByGroup.get(course.groupId ?? '') ?? []
    const atts = attendanceByCourse.get(course.id) ?? []
    const presentIds = atts.length
      ? atts
          .filter((a) => a.present)
          .map((a) => a.studentId)
          .filter((id) => memberIds.includes(id))
      : memberIds
    if (presentIds.length === 0 || course.feeCents === 0) return []
    const share = Math.round(course.feeCents / presentIds.length)
    return presentIds.map((sid) => ({
      sid,
      share,
      prepaid: studentMap.get(sid)?.billingRule === 'prepaid',
    }))
  }

  let totalPrepaidShare = 0
  let receivableCents = 0
  const receivableByStudent = new Map<string, number>()
  const doneCourses = liveCourses.filter((c) => c.status === 'done')
  const ledger: LedgerEntry[] = []

  for (const c of doneCourses) {
    const attrs = attribution(c)
    const groupName = c.groupId ? groupMap.get(c.groupId)?.name : undefined
    const studentName = c.studentId ? studentMap.get(c.studentId)?.name : undefined
    const who = c.studentId ? studentName ?? '学生(已删)' : groupName ?? '班课(已删)'

    let prepaidShare = 0
    let postpaidShare = 0
    for (const a of attrs) {
      if (a.prepaid) {
        totalPrepaidShare += a.share
        prepaidShare += a.share
      } else {
        receivableCents += a.share
        postpaidShare += a.share
        receivableByStudent.set(a.sid, (receivableByStudent.get(a.sid) ?? 0) + a.share)
      }
    }

    if (prepaidShare > 0) {
      ledger.push({
        id: `r-${c.id}-prepaid`,
        date: c.startAt,
        type: '课酬',
        who,
        subject: c.isMakeup ? `${c.subject}（补课）` : c.subject,
        amountCents: prepaidShare,
        note: c.isMakeup ? '补课 · 预付课酬 · 机构待结算' : '预付课酬 · 机构待结算',
        kind: 'course',
        refId: c.id,
        studentId: c.studentId,
        groupId: c.groupId,
      })
    }
    if (postpaidShare > 0) {
      ledger.push({
        id: `r-${c.id}-postpaid`,
        date: c.startAt,
        type: '应收',
        who,
        subject: c.isMakeup ? `${c.subject}（补课）` : c.subject,
        amountCents: postpaidShare,
        note: c.isMakeup ? '补课 · 课时费 · 待学生支付' : '课时费 · 待学生支付',
        kind: 'course',
        refId: c.id,
        studentId: c.studentId,
        groupId: c.groupId,
      })
    }
  }

  // 学生实付（仅 payer='student'）—— 用于欠费抵扣
  const paidByStudent = new Map<string, number>()
  let institutionSettledCents = 0
  for (const p of livePayments) {
    const payer: 'student' | 'institution' = p.payer ?? 'student'
    if (payer === 'institution') {
      institutionSettledCents += p.amountCents
      ledger.push({
        id: `p-${p.id}`,
        date: p.paidAt,
        type: '结清',
        who: '机构',
        subject: '',
        amountCents: p.amountCents,
        note: p.note || '机构结清课酬',
        kind: 'payment',
        refId: p.id,
        studentId: null,
        payer: 'institution',
      })
    } else {
      ledger.push({
        id: `p-${p.id}`,
        date: p.paidAt,
        type: '收款',
        who: p.studentId ? studentMap.get(p.studentId)?.name ?? '未指定' : '未指定',
        subject: '',
        amountCents: p.amountCents,
        note: p.note || '学生收款',
        kind: 'payment',
        refId: p.id,
        studentId: p.studentId,
        payer: 'student',
      })
      if (p.studentId) {
        paidByStudent.set(p.studentId, (paidByStudent.get(p.studentId) ?? 0) + p.amountCents)
      }
    }
  }
  ledger.sort((a, b) => b.date - a.date)

  // 欠费仅统计后付学生（实付仅统计 student payer）
  const arrears = students
    .filter((s) => s.billingRule === 'postpaid')
    .map((s) => {
      const rec = receivableByStudent.get(s.id) ?? 0
      const pay = paidByStudent.get(s.id) ?? 0
      return { student: s, outstanding: Math.max(0, rec - pay) }
    })
    .filter((x) => x.outstanding > 0)
    .sort((a, b) => b.outstanding - a.outstanding)

  // 待结算课酬：预付完课合计 - 累计机构结清，下限 0
  const settlementPendingCents = Math.max(0, totalPrepaidShare - institutionSettledCents)

  const monthStart = startOfMonth(now).getTime()
  const monthEnd = endOfMonth(now).getTime()
  const monthIncome = livePayments
    .filter((p) => p.paidAt >= monthStart && p.paidAt <= monthEnd)
    .reduce((s, p) => s + p.amountCents, 0)
  const totalPaid = livePayments.reduce((s, p) => s + p.amountCents, 0)

  const trend = Array.from({ length: 6 }, (_, i) => {
    const d = subMonths(now, 5 - i)
    const s = startOfMonth(d).getTime()
    const e = endOfMonth(d).getTime()
    const sum = livePayments
      .filter((p) => p.paidAt >= s && p.paidAt <= e)
      .reduce((acc, p) => acc + p.amountCents, 0)
    return { label: `${d.getMonth() + 1}月`, 收入: Math.round(sum / 100) }
  })
  const settleTrend = Array.from({ length: 6 }, (_, i) => {
    const d = subMonths(now, 5 - i)
    const s = startOfMonth(d).getTime()
    const e = endOfMonth(d).getTime()
    const sum = livePayments
      .filter((p) => (p.payer ?? 'student') === 'institution')
      .filter((p) => p.paidAt >= s && p.paidAt <= e)
      .reduce((acc, p) => acc + p.amountCents, 0)
    return { label: `${d.getMonth() + 1}月`, 结清: Math.round(sum / 100) }
  })

  return {
    monthIncome,
    totalPaid,
    settlementPendingCents,
    receivableCents,
    institutionSettledCents,
    arrears,
    ledger,
    trend,
    settleTrend,
  }
}