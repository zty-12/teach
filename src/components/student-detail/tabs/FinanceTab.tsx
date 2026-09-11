/**
 * 学生详情 - 财务概览 Tab
 *
 * 给老师一个"该学生价值了多少 / 还欠多少 / 待收多少"的总览，
 * 数据从 finance.computeStudentFinance 派生。
 */
import { useMemo } from 'react'
import type { Course, CourseAttendance, Group, Payment, Student } from '@/lib/types'
import { cn, formatMoney } from '@/lib/utils'

interface StudentFinance {
  earnedTotal: number
  paidTotal: number
  /** 预付完课，机构待结算（仅当学生预付时） */
  pendingInstitution: number
  /** 后付完课未收款（学生欠机构） */
  outstanding: number
  /** 退款总额 */
  refunded: number
  /** 已上课时数 */
  doneCount: number
  /** 本月已上课时数 */
  monthDoneCount: number
}

/**
 * 单学生财务计算（精简版 finance.ts 中的 attribution）。
 */
function computeStudentFinance(args: {
  student: Student
  courses: Course[]
  attendances: CourseAttendance[]
  payments: Payment[]
}): StudentFinance {
  const { student, courses, attendances, payments } = args

  // 计算每个课程该学生的实际课酬（prepaid→待结算；postpaid→应收）
  const attMap = new Map<string, CourseAttendance>()
  for (const a of attendances) {
    if (a.studentId === student.id) attMap.set(a.courseId, a)
  }

  let earnedTotal = 0
  let pendingInstitution = 0
  let outstanding = 0
  let doneCount = 0
  let monthDoneCount = 0

  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const monthStartTs = monthStart.getTime()

  for (const c of courses) {
    if (c.status !== 'done') continue
    doneCount++
    if (c.startAt >= monthStartTs) monthDoneCount++

    let share = 0
    if (c.groupId) {
      // 班课：该学生出席则按人均单价计算
      const att = attMap.get(c.id)
      if (att?.present) share = c.feeCents
    } else if (c.studentId === student.id) {
      // 一对一：含补课
      share = c.feeCents > 0
        ? c.feeCents
        : student.hourlyFeeCents
    }
    earnedTotal += share
    if (student.billingRule === 'prepaid') pendingInstitution += share
    else outstanding += share
  }

  // 学生已付款 + 退款（仅 student payer）
  let paidTotal = 0
  let refunded = 0
  for (const p of payments) {
    if (p.amountCents > 0) paidTotal += p.amountCents
    else refunded += -p.amountCents
  }

  // 后付抵扣：已收款从 outstanding 中扣
  if (student.billingRule === 'postpaid') {
    outstanding = Math.max(0, outstanding - paidTotal)
  }

  return {
    earnedTotal,
    paidTotal,
    pendingInstitution,
    outstanding,
    refunded,
    doneCount,
    monthDoneCount,
  }
}

export function FinanceTab({
  student,
  courses,
  attendances,
  payments,
  groups: _groups,
}: {
  student: Student
  courses: Course[]
  attendances: CourseAttendance[]
  payments: Payment[]
  groups: Group[]
}) {
  const fin = useMemo(
    () => computeStudentFinance({ student, courses, attendances, payments }),
    [student, courses, attendances, payments],
  )

  const isPrepaid = student.billingRule === 'prepaid'

  return (
    <div className="p-4">
      {/* 总览 */}
      <div className="mb-3 grid grid-cols-2 gap-2">
        <Stat
          label="累计课酬"
          value={formatMoney(fin.earnedTotal)}
          hint={`${fin.doneCount} 节课（本月 ${fin.monthDoneCount}）`}
        />
        <Stat
          label="累计支付"
          value={formatMoney(fin.paidTotal)}
          tone="money-in"
        />
        {isPrepaid ? (
          <Stat
            label="待结算（机构→老师）"
            value={formatMoney(fin.pendingInstitution)}
            tone="pending"
            hint="预付学生，机构按月结清课酬"
          />
        ) : (
          <Stat
            label="欠费（学生→机构）"
            value={formatMoney(fin.outstanding)}
            tone={fin.outstanding > 0 ? 'pending' : 'money-in'}
            hint={fin.outstanding > 0 ? '尚未收取' : '已结清'}
          />
        )}
        <Stat
          label="退款"
          value={formatMoney(fin.refunded)}
          tone="money-out"
          hint={fin.refunded > 0 ? '含退款笔数' : '无'}
        />
      </div>

      {/* 语义说明 */}
      <div className="rounded-lg border border-line-1 bg-surface-1 p-3 text-[12px] text-text-2">
        <p className="font-medium text-text-1">计费口径</p>
        <ul className="mt-1.5 space-y-1 leading-relaxed">
          <li>
            · 计费规则：<span className="font-medium text-text-1">{isPrepaid ? '预付课时' : '按次后付'}</span>
          </li>
          <li>
            · 累计课酬 = 所有已完成课程的应得课酬合计（含补课与班课人均）
          </li>
          {isPrepaid ? (
            <>
              <li>
                · 预付学生学费已一次性收取，故「累计支付」为一次性购课金额
              </li>
              <li>
                · <span className="text-pending">待结算课酬</span> 表示机构欠老师，需按月结算
              </li>
            </>
          ) : (
            <>
              <li>
                · 已收款从累计应收中扣减，差额为「欠费」
              </li>
              <li>
                · <span className="text-pending">欠费</span> 表示学生/家长未付的课后课酬
              </li>
            </>
          )}
        </ul>
      </div>

      {/* 试听警告 */}
      {student.isTrial && (
        <div className="mt-3 rounded-lg bg-pending-soft px-3 py-2 text-[13px] text-pending">
          ⚠ 此学生仍为试听状态，正式付费前「待结算课酬」将保持为 0。
        </div>
      )}

      {/* 余量预警 */}
      {isPrepaid && student.remainingHours <= student.remindHours && (
        <div
          className={cn(
            'mt-3 rounded-lg px-3 py-2 text-[13px]',
            student.remainingHours === 0
              ? 'bg-leave-soft text-leave'
              : 'bg-pending-soft text-pending',
          )}
        >
          {student.remainingHours === 0
            ? `⚠ 课时已用完，建议提醒家长续费`
            : `⚠ 剩余 ${student.remainingHours} 课时，低于提醒阈值 ${student.remindHours} 课时`}
        </div>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'money-in' | 'money-out' | 'pending'
}) {
  return (
    <div className="rounded-lg border border-line-1 bg-surface-0 px-3 py-2">
      <p className="text-[11px] text-text-3">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-[16px] font-semibold tabular-nums',
          tone === 'money-in' && 'text-money-in',
          tone === 'money-out' && 'text-money-out',
          tone === 'pending' && 'text-pending',
          tone === 'default' && 'text-text-1',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[10px] text-text-3">{hint}</p>}
    </div>
  )
}