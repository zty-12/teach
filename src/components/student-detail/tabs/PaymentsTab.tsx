/**
 * 学生详情 - 支付流水 Tab
 *
 * 仅显示该学生的 payer='student' 支付流水（机构结清在 Finance Tab）。
 * 按时间倒序展示，并给出汇总。
 */
import { useMemo } from 'react'
import type { Payment } from '@/lib/types'
import { cn, formatMoney } from '@/lib/utils'

export function PaymentsTab({
  studentId: _studentId,
  payments,
}: {
  studentId: string
  payments: Payment[]
}) {
  const { paidTotal, refundedTotal, refundCount } = useMemo(() => {
    let paid = 0
    let refunded = 0
    let count = 0
    for (const p of payments) {
      if (p.amountCents > 0) paid += p.amountCents
      else {
        refunded += -p.amountCents
        count++
      }
    }
    return { paidTotal: paid, refundedTotal: refunded, refundCount: count }
  }, [payments])

  if (payments.length === 0) {
    return (
      <div className="p-8 text-center text-[13px] text-text-3">
        还没有支付记录
      </div>
    )
  }

  return (
    <div className="p-4">
      {/* 汇总 */}
      <div className="mb-3 grid grid-cols-2 gap-2">
        <Stat label="累计支付" value={formatMoney(paidTotal)} tone="money-in" />
        <Stat
          label="退款"
          value={formatMoney(refundedTotal)}
          hint={refundCount > 0 ? `${refundCount} 笔` : '无'}
          tone="money-out"
        />
      </div>

      {/* 列表 */}
      <ul className="space-y-1.5">
        {payments.map((p) => {
          const isRefund = p.amountCents < 0
          return (
            <li
              key={p.id}
              className="flex items-start gap-3 rounded-lg border border-line-1 bg-surface-0 p-3"
            >
              {/* 日期块 */}
              <div className="flex w-12 shrink-0 flex-col items-center justify-center rounded-md bg-surface-2 py-1 text-text-1">
                <span className="text-[16px] font-semibold leading-none tabular-nums">
                  {new Date(p.paidAt).getDate()}
                </span>
                <span className="mt-0.5 text-[10px] text-text-3">
                  {`${new Date(p.paidAt).getMonth() + 1}月`}
                </span>
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span
                    className={cn(
                      'text-[15px] font-semibold tabular-nums',
                      isRefund ? 'text-money-out' : 'text-money-in',
                    )}
                  >
                    {isRefund ? '-' : '+'}
                    {formatMoney(Math.abs(p.amountCents))}
                  </span>
                  <span className="text-[11px] text-text-3">{p.method}</span>
                </div>
                {p.note && (
                  <p className="mt-0.5 truncate text-[12px] text-text-2">{p.note}</p>
                )}
                <p className="mt-0.5 text-[10px] text-text-3">
                  {new Date(p.paidAt).toLocaleDateString('zh-CN')}{' '}
                  {new Date(p.paidAt).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </div>
            </li>
          )
        })}
      </ul>
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
  tone?: 'default' | 'money-in' | 'money-out'
}) {
  return (
    <div className="rounded-lg border border-line-1 bg-surface-0 px-3 py-2">
      <p className="text-[11px] text-text-3">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-[16px] font-semibold tabular-nums',
          tone === 'money-in' && 'text-money-in',
          tone === 'money-out' && 'text-money-out',
          tone === 'default' && 'text-text-1',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[10px] text-text-3">{hint}</p>}
    </div>
  )
}