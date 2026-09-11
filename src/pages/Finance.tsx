import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { format } from 'date-fns'
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  ChevronRight,
  Plus,
  TrendingUp,
  Wallet,
} from 'lucide-react'
import { db, markDeleted, withSyncFields } from '@/lib/db'
import { useBreakpoint } from '@/hooks/useBreakpoint'
import { BarChart, type BarDatum } from '@/components/BarChart'
import {
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
} from '@/components/ui'
import type { Payment, Student } from '@/lib/types'
import { cn, formatMoney, formatMoneyShort } from '@/lib/utils'
import { exportFinance, type FinanceExportRow } from '@/lib/exporters'
import { computeFinanceMetrics, type LedgerEntry } from '@/lib/finance'

const PAY_METHODS = ['微信', '支付宝', '银行卡', '现金', '其他']

// ============================================================
// 台账类型徽章 / 金额色彩
// ============================================================
const TYPE_META: Record<
  LedgerEntry['type'],
  { chip: string; amount: string; sign: string }
> = {
  课酬: { chip: 'bg-accent-soft text-accent-text', amount: 'text-accent-text', sign: '' },
  应收: { chip: 'bg-leave-soft text-leave', amount: 'text-money-due', sign: '-' },
  收款: { chip: 'bg-done-soft text-done', amount: 'text-money-in', sign: '+' },
  结清: { chip: 'bg-done-soft text-done', amount: 'text-done', sign: '+' },
}

export default function FinancePage() {
  const bp = useBreakpoint()
  const isDesktop = bp === 'desktop'
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [settleOpen, setSettleOpen] = useState(false)

  const payments = useLiveQuery(() => db.payments.toArray(), [])
  const students = useLiveQuery(() => db.students.toArray(), [])
  const courses = useLiveQuery(() => db.courses.toArray(), [])
  const groups = useLiveQuery(() => db.groups.toArray(), [])
  const members = useLiveQuery(() => db.groupMembers.toArray(), [])
  const attendances = useLiveQuery(() => db.courseAttendances.toArray(), [])

  const data = useMemo(
    () =>
      computeFinanceMetrics({
        courses: courses ?? [],
        payments: payments ?? [],
        students: students ?? [],
        groups: groups ?? [],
        members: members ?? [],
        attendances: attendances ?? [],
      }),
    [courses, payments, students, groups, members, attendances],
  )

  const arrearsTotal = data.arrears.reduce((s, a) => s + a.outstanding, 0)

  const exportRows: FinanceExportRow[] = data.ledger.map((r) => ({
    日期: format(r.date, 'yyyy-MM-dd'),
    类型: r.type,
    学生或班课: r.who,
    科目: r.subject,
    金额元: Math.round(r.amountCents / 100),
    备注: r.note,
  }))

  return (
    <div className="space-y-5">
      <PageHeader
        title="财务"
        subtitle="收款、课酬待结算与欠费一览"
        action={
          <>
            <Button variant="secondary" onClick={() => setSettleOpen(true)}>
              <Building2 size={16} />
              {isDesktop ? '记机构结清' : '结清'}
            </Button>
            <Button variant="secondary" onClick={() => exportFinance(exportRows)}>
              <Wallet size={16} />
              {isDesktop ? '导出台账' : ''}
            </Button>
            <Button variant="primary" onClick={() => setPaymentOpen(true)}>
              <Plus size={16} />
              {isDesktop ? '记一笔收款' : '记账'}
            </Button>
          </>
        }
      />

      {/* 指标卡（工作台同款样式） */}
      <section className={cn('grid gap-3', isDesktop ? 'grid-cols-4' : 'grid-cols-2')}>
        <Card className="p-4 transition-all hover:border-money-in/30 hover:shadow-lg">
          <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-text-2">
            <span className="h-1.5 w-1.5 rounded-full bg-money-in" /> 本月收入
          </div>
          <div className="text-[26px] font-semibold leading-none text-text-1 tabular-nums">
            {formatMoneyShort(data.monthIncome)}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <span className="inline-flex items-center rounded-full border border-line-1 bg-surface-2/60 px-2.5 py-1 text-[11px] font-medium text-text-2">本月实收</span>
          </div>
        </Card>

        <Card className="p-4 transition-all hover:border-line-1 hover:shadow-lg">
          <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-text-2">
            <span className="h-1.5 w-1.5 rounded-full bg-text-3" /> 累计收款
          </div>
          <div className="text-[26px] font-semibold leading-none text-text-1 tabular-nums">
            {formatMoneyShort(data.totalPaid)}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <span className="inline-flex items-center rounded-full border border-line-1 bg-surface-2/60 px-2.5 py-1 text-[11px] font-medium text-text-2">累计实收</span>
          </div>
        </Card>

        <Card className="p-4 transition-all hover:border-accent/30 hover:shadow-lg">
          <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-text-2">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" /> 待结算课酬
          </div>
          <div className="text-[26px] font-semibold leading-none text-text-1 tabular-nums">
            {formatMoneyShort(data.settlementPendingCents)}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <span className="inline-flex items-center rounded-full border border-line-1 bg-surface-2/60 px-2.5 py-1 text-[11px] font-medium text-text-2">预付课时</span>
            <span className="inline-flex items-center rounded-full border border-line-1 bg-surface-2/60 px-2.5 py-1 text-[11px] font-medium text-text-2">机构按月结算</span>
            {data.institutionSettledCents > 0 && (
              <span className="inline-flex items-center rounded-full border border-line-1 bg-done-soft px-2.5 py-1 text-[11px] font-medium text-done">
                已结清 {formatMoneyShort(data.institutionSettledCents)}
              </span>
            )}
          </div>
        </Card>

        <Link to="/students" className="group">
          <Card className={cn('h-full p-4 transition-all hover:shadow-lg', data.arrears.length > 0 ? 'border-leave/30' : 'hover:border-line-1')}>
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-[12px] font-medium text-text-2">
                <span className={cn('h-1.5 w-1.5 rounded-full', data.arrears.length > 0 ? 'bg-leave' : 'bg-text-3')} /> 欠费人数
              </div>
              <ArrowRight className="h-3.5 w-3.5 text-text-3 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
            </div>
            <div className={cn('text-[26px] font-semibold leading-none tabular-nums', data.arrears.length > 0 ? 'text-leave' : 'text-text-1')}>
              {data.arrears.length} <span className="text-sm font-medium text-text-2">人</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="inline-flex items-center rounded-full border border-line-1 bg-surface-2/60 px-2.5 py-1 text-[11px] font-medium text-text-2">后付未缴</span>
              <span className="inline-flex items-center rounded-full border border-line-1 bg-surface-2/60 px-2.5 py-1 text-[11px] font-medium text-text-2">{formatMoney(arrearsTotal)}</span>
            </div>
          </Card>
        </Link>
      </section>

      {/* 欠费预警（仅后付学生） */}
      {data.arrears.length > 0 && (
        <Card className="mb-4">
          <div className="flex items-start justify-between gap-3 border-b border-line-1 px-4 py-3.5">
            <div>
              <div className="flex items-center gap-2 text-[15px] font-semibold text-text-1">
                <AlertTriangle size={15} className="text-money-due" /> 欠费预警
              </div>
              <p className="mt-1 text-[12px] leading-5 text-text-2">
                {data.arrears.length} 名按次后付学生有待补课时费
              </p>
            </div>
            <Link to="/students">
              <Button variant="ghost" size="sm">
                去处理 <ChevronRight size={14} />
              </Button>
            </Link>
          </div>
          <ul className="divide-y divide-line-1">
            {data.arrears.map(({ student, outstanding }) => (
              <li key={student.id} className="flex items-center gap-3 px-4 py-3">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-money-due" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-1">
                  {student.name}
                </span>
                <span className="shrink-0 text-[12px] text-text-3">{student.academicLevel || '后付'}</span>
                <span className="shrink-0 font-medium tabular-nums text-money-due">
                  {formatMoney(outstanding)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* 近 6 月收款趋势（共享 BarChart） */}
      <Card className="mb-4 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-[15px] font-semibold text-text-1">近 6 月收款趋势</h2>
          <span className="text-[12px] font-medium text-text-2">{formatMoney(data.totalPaid)}</span>
        </div>
        <BarChart
          data={data.trend.map<BarDatum>((t) => ({
            label: t.label,
            value: t.收入,
            active: t.label === `${new Date().getMonth() + 1}月`,
            suffix: '元',
          }))}
          variant="money-in"
        />
      </Card>

      {/* 财务台账 */}
      <Card>
        <div className="flex items-start justify-between gap-3 border-b border-line-1 px-4 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold text-text-1">财务台账</h2>
            <p className="mt-1 text-[12px] leading-5 text-text-2">
              {data.ledger.length ? `${data.ledger.length} 条` : '暂无账目'}
            </p>
          </div>
          <span className="inline-flex items-center gap-1 text-[12px] text-text-3">
            <TrendingUp size={13} /> 课酬 + 应收 + 收款 + 结清
          </span>
        </div>

        {data.ledger.length === 0 ? (
          <EmptyState
            icon={<Wallet size={28} />}
            title="还没有账目"
            description="标记课程完成后会生成课酬/应收，记一笔收款后生成实收，记机构结清后会冲抵待结算课酬"
          />
        ) : isDesktop ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line-1 bg-surface-2 text-left text-[13px] text-text-2">
                <th className="px-4 py-2.5 font-medium">日期</th>
                <th className="px-4 py-2.5 font-medium">类型</th>
                <th className="px-4 py-2.5 font-medium">对象</th>
                <th className="px-4 py-2.5 font-medium">科目</th>
                <th className="px-4 py-2.5 text-right font-medium">金额</th>
                <th className="px-4 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-1">
              {data.ledger.map((r) => {
                const meta = TYPE_META[r.type]
                return (
                  <tr key={r.id} className="transition-colors hover:bg-surface-1">
                    <td className="px-4 py-2.5 tabular-nums text-text-2">{format(r.date, 'yyyy-MM-dd')}</td>
                    <td className="px-4 py-2.5">
                      <span className={cn('inline-flex rounded-md px-1.5 py-0.5 text-[11px] font-medium', meta.chip)}>{r.type}</span>
                    </td>
                    <td className="px-4 py-2.5 text-text-1">{r.who}</td>
                    <td className="px-4 py-2.5 text-text-2">{r.subject || '—'}</td>
                    <td className={cn('px-4 py-2.5 text-right font-medium tabular-nums', meta.amount)}>
                      <span className="mr-0.5 opacity-70">{meta.sign}</span>
                      {formatMoney(r.amountCents)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {r.kind === 'payment' && r.refId && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            const p = (payments ?? []).find((x) => x.id === r.refId)
                            if (p) void db.payments.put(markDeleted(p))
                          }}
                        >
                          删除
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <ul className="divide-y divide-line-1">
            {data.ledger.slice(0, 60).map((r) => {
              const meta = TYPE_META[r.type]
              return (
                <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                  <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium', meta.chip)}>{r.type}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-1">{r.who}</p>
                    <p className="mt-0.5 text-xs text-text-3">
                      {format(r.date, 'yyyy-MM-dd')}
                      {r.subject ? ` · ${r.subject}` : ''}
                    </p>
                  </div>
                  <span className={cn('shrink-0 font-medium tabular-nums', meta.amount)}>
                    <span className="mr-0.5 opacity-70">{meta.sign}</span>
                    {formatMoney(r.amountCents)}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <PaymentModal
        open={paymentOpen}
        students={(students ?? []).filter((s) => !s.deletedAt)}
        onClose={() => setPaymentOpen(false)}
      />

      <SettleWagesModal
        open={settleOpen}
        pending={data.settlementPendingCents / 100}
        onClose={() => setSettleOpen(false)}
      />
    </div>
  )
}

// ============================================================
// 记一笔收款（学生付款）
// ============================================================

function PaymentModal({
  open,
  students,
  onClose,
}: {
  open: boolean
  students: Student[]
  onClose: () => void
}) {
  const [studentId, setStudentId] = useState('')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState(PAY_METHODS[0]!)
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  async function handleSave() {
    const yuan = Number(amount)
    if (!Number.isFinite(yuan) || yuan === 0) {
      setError('请填写有效金额')
      return
    }
    const [y, m, d] = date.split('-').map(Number)
    const paidAt = new Date(y!, m! - 1, d!, 12, 0, 0, 0).getTime()

    await db.payments.put(
      withSyncFields<Payment>({
        studentId: studentId || null,
        payer: 'student',
        amountCents: Math.round(yuan * 100),
        method,
        paidAt,
        note: note.trim(),
        createdAt: Date.now(),
      }),
    )
    setAmount('')
    setNote('')
    setError('')
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="记一笔收款"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={handleSave}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="学生">
          <Select value={studentId} onChange={(e) => setStudentId(e.target.value)}>
            <option value="">（未指定）</option>
            {students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="金额（元）" error={error}>
            <Input
              type="number"
              step={10}
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value)
                setError('')
              }}
              placeholder="0"
              inputMode="decimal"
            />
          </Field>
          <Field label="方式">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              {PAY_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="收款日期">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>

        <Field label="备注">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="如：9月课时费"
          />
        </Field>
      </div>
    </Modal>
  )
}

// ============================================================
// 记一笔机构结清（机构 → 老师 结算课酬）
// ============================================================

function SettleWagesModal({
  open,
  pending,
  onClose,
}: {
  open: boolean
  /** 当前待结算课酬总额（元）。调用处已把分 / 100。用于顶部提示 + 一键填入。 */
  pending: number
  onClose: () => void
}) {
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState(PAY_METHODS[0]!)
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  function presetFull() {
    setAmount(pending > 0 ? String(pending.toFixed(2)) : '')
  }

  async function handleSave() {
    const yuan = Number(amount)
    if (!Number.isFinite(yuan) || yuan <= 0) {
      setError('请填写大于 0 的金额')
      return
    }
    const [y, m, d] = date.split('-').map(Number)
    const paidAt = new Date(y!, m! - 1, d!, 12, 0, 0, 0).getTime()

    await db.payments.put(
      withSyncFields<Payment>({
        studentId: null,
        payer: 'institution',
        amountCents: Math.round(yuan * 100),
        method,
        paidAt,
        note: note.trim() || '机构结清课酬',
        createdAt: Date.now(),
      }),
    )
    setAmount('')
    setNote('')
    setError('')
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="记一笔机构结清"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={handleSave}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {/* 顶部提示：当前待结算课酬 */}
        <div className="rounded-xl border border-line-1 bg-accent-soft/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[12px] font-medium text-text-2">当前待结算课酬</div>
              <div className="mt-0.5 text-[18px] font-semibold tabular-nums text-accent-text">
                ¥{pending.toFixed(2)}
              </div>
            </div>
            {pending > 0 && (
              <Button size="sm" variant="ghost" onClick={presetFull}>
                一键填入
              </Button>
            )}
          </div>
          <p className="mt-1 text-[11px] leading-5 text-text-3">
            填写本次机构结算的金额，将从待结算课酬中扣减（不足部分不影响已结清累计）。
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="金额（元）" error={error}>
            <Input
              type="number"
              step={10}
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value)
                setError('')
              }}
              placeholder="0"
              inputMode="decimal"
            />
          </Field>
          <Field label="方式">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              {PAY_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="结算日期">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>

        <Field label="备注">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="如：9月课酬结算"
          />
        </Field>
      </div>
    </Modal>
  )
}