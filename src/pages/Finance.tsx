import { useEffect, useMemo, useState } from 'react'
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
import { db, markDeleted, touch, withSyncFields } from '@/lib/db'
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
import type { CourseAttendance, Payment, Settlement, Student } from '@/lib/types'
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

/** 课酬明细行：已完成课程的可调整课酬信息 */
interface FeeRow {
  courseId: string
  who: string
  subject: string
  typeLabel: string
  presentCount: number
  /** 出席学员各自的单人课酬（分）与姓名（同一节课各学员单价可能不同） */
  presentStudents: Array<{ studentId: string; name: string; unitCents: number }>
  /** 当前总课酬（分） */
  feeCents: number
  date: number
  isGroup: boolean
}

export default function FinancePage() {
  const bp = useBreakpoint()
  const isDesktop = bp === 'desktop'
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [settleOpen, setSettleOpen] = useState(false)
  const [feeAdjustOpen, setFeeAdjustOpen] = useState(false)
  const [feeAdjustTarget, setFeeAdjustTarget] = useState<FeeRow | null>(null)

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

  // 已完成课程的课酬明细（可逐课、逐学员调整「每人单次课酬」）。
  // 出席人数口径与 computeFinanceMetrics.attribution 保持一致：
  // 班课取「实际出席且在成员内」的学员（无出席记录时回退为全员）；1对1 看该生是否出席。
  const feeRows = useMemo<FeeRow[]>(() => {
    const liveCourses = (courses ?? []).filter((c) => !c.deletedAt && c.status === 'done')
    const studentMap = new Map(
      (students ?? []).filter((s) => !s.deletedAt).map((s) => [s.id, s]),
    )
    const groupMap = new Map(
      (groups ?? []).filter((g) => !g.deletedAt).map((g) => [g.id, g]),
    )
    const attByCourse = new Map<string, CourseAttendance[]>()
    for (const a of (attendances ?? []).filter((a) => !a.deletedAt)) {
      const arr = attByCourse.get(a.courseId) ?? []
      arr.push(a)
      attByCourse.set(a.courseId, arr)
    }
    const memberIdsByGroup = new Map<string, string[]>()
    for (const m of (members ?? []).filter((m) => !m.deletedAt)) {
      const arr = memberIdsByGroup.get(m.groupId) ?? []
      arr.push(m.studentId)
      memberIdsByGroup.set(m.groupId, arr)
    }
    // 课程已存的「逐学员单价」映射（优先采用，未设置则回退）
    const perStudentOf = (c: (typeof liveCourses)[number]) =>
      c.feePerStudent && c.feePerStudent.length
        ? new Map(c.feePerStudent.map((p) => [p.studentId, p.unitCents]))
        : null

    const rows: FeeRow[] = []
    for (const c of liveCourses) {
      const perMap = perStudentOf(c)
      let presentIds: string[] = []
      if (c.groupId) {
        const mids = memberIdsByGroup.get(c.groupId) ?? []
        const atts = attByCourse.get(c.id) ?? []
        presentIds = atts.length
          ? atts
              .filter((a) => a.present)
              .map((a) => a.studentId)
              .filter((id) => mids.includes(id))
          : mids
      } else if (c.studentId) {
        const atts = attByCourse.get(c.id) ?? []
        if (atts.some((a) => a.studentId === c.studentId && a.present)) presentIds = [c.studentId]
      }
      const presentStudents = presentIds
        .map((sid) => {
          // 回退单价：已存逐学员 > 课程单价快照 > 均摊总课酬
          const fallback =
            (typeof c.feeUnitCents === 'number' && c.feeUnitCents >= 0
              ? c.feeUnitCents
              : presentIds.length > 0
                ? c.feeCents
                : 0) / (presentIds.length || 1)
          return {
            studentId: sid,
            name: studentMap.get(sid)?.name ?? '学生(已删)',
            unitCents: perMap?.get(sid) ?? Math.round(fallback),
          }
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      rows.push({
        courseId: c.id,
        who: c.studentId
          ? studentMap.get(c.studentId)?.name ?? '学生(已删)'
          : groupMap.get(c.groupId ?? '')?.name ?? '班课(已删)',
        subject: c.subject,
        typeLabel: c.isMakeup ? '补课' : c.groupId ? '班课' : '1对1',
        presentCount: presentStudents.length,
        presentStudents,
        feeCents: c.feeCents,
        date: c.startAt,
        isGroup: !!c.groupId,
      })
    }
    rows.sort((a, b) => b.date - a.date)
    return rows
  }, [courses, students, groups, members, attendances])

  /**
   * 保存某节已完成课程的「逐学员单人课酬」：
   *  - rates 为出席学员各自的单价（分），总课酬 = 各单价之和，写回 Course.feePerStudent / feeCents。
   *  - 全员单价相同时顺带回写 feeUnitCents（保留单价快照语义）；不同时保留旧值。
   *  - 同步更新对应的 Settlement.amountCents（保持云端记录一致）。
   *  - 不动课时扣减、学员名单、其它课程；仅改本节课历史课酬口径。
   */
  async function saveCourseFees(
    courseId: string,
    rates: Array<{ studentId: string; unitCents: number }>,
  ) {
    const course = await db.courses.get(courseId)
    if (!course || course.status !== 'done') return
    const clean = rates.map((r) => ({ studentId: r.studentId, unitCents: Math.max(0, Math.round(r.unitCents)) }))
    const total = clean.reduce((s, r) => s + r.unitCents, 0)
    const allSame =
      clean.length > 0 && clean.every((r) => r.unitCents === clean[0]!.unitCents)
    await db.courses.put(
      touch({
        ...course,
        feePerStudent: clean,
        feeUnitCents:
          allSame && clean.length > 0
            ? clean[0]!.unitCents
            : typeof course.feeUnitCents === 'number'
              ? course.feeUnitCents
              : null,
        feeCents: total,
      }),
    )
    const existing = (await db.settlements.toArray()).find(
      (s) => s.courseId === course.id && !s.deletedAt,
    )
    if (total > 0) {
      if (existing) {
        await db.settlements.put(touch({ ...existing, amountCents: total, note: '手动调整课酬' }))
      } else {
        await db.settlements.put(
          withSyncFields<Settlement>({
            courseId: course.id,
            studentId: course.studentId,
            groupId: course.groupId,
            amountCents: total,
            settledAt: Date.now(),
            note: '手动调整课酬',
            createdAt: Date.now(),
          }),
        )
      }
    } else if (existing) {
      await db.settlements.put(markDeleted(existing))
    }
  }

  const arrearsTotal = data.arrears.reduce((s, a) => s + a.outstanding, 0)

  const exportRows: FinanceExportRow[] = data.ledger.map((r) => ({
    日期: format(r.date, 'yyyy-MM-dd'),
    类型: r.type,
    学生或班课: r.who,
    科目: r.subject,
    // 保留角分（与 exportSchedule 的 Number((cents/100).toFixed(2)) 口径一致）；
    // Math.round 会把 ¥123.45 抹成 ¥123，导出对不上账（v26 审查：P4）
    金额元: Number((r.amountCents / 100).toFixed(2)),
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

      {/* 课酬明细（可逐课调整每人单次课酬） */}
      <Card>
        <div className="flex items-start justify-between gap-3 border-b border-line-1 px-4 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold text-text-1">课酬明细（可调整）</h2>
            <p className="mt-1 text-[12px] leading-5 text-text-2">
              {feeRows.length ? `已完成课程 ${feeRows.length} 节，可逐学员设置每人单次课酬（同一节课各学员单价可不同）` : '暂无已完成课程'}
            </p>
          </div>
        </div>

        {feeRows.length === 0 ? (
          <div className="px-4 py-6 text-center text-[13px] text-text-3">
            标记课程完成后，这里会列出每节课的课酬，可点击「调整」单独修改
          </div>
        ) : isDesktop ? (
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line-1 bg-surface-2 text-left text-[13px] text-text-2">
                  <th className="px-4 py-2.5 font-medium">日期</th>
                  <th className="px-4 py-2.5 font-medium">对象</th>
                  <th className="px-4 py-2.5 font-medium">科目</th>
                  <th className="px-4 py-2.5 font-medium">类型</th>
                  <th className="px-4 py-2.5 text-right font-medium">实到</th>
                  <th className="px-4 py-2.5 text-right font-medium">合计(¥)</th>
                  <th className="px-4 py-2.5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-1">
                {feeRows.map((r) => (
                  <tr key={r.courseId} className="transition-colors hover:bg-surface-1">
                    <td className="px-4 py-2.5 tabular-nums text-text-2">{format(r.date, 'yyyy-MM-dd')}</td>
                    <td className="px-4 py-2.5 text-text-1">{r.who}</td>
                    <td className="px-4 py-2.5 text-text-2">{r.subject || '—'}</td>
                    <td className="px-4 py-2.5 text-text-2">{r.typeLabel}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-text-2">{r.presentCount}</td>
                    <td className="px-4 py-2.5 text-right font-medium tabular-nums text-accent-text">
                      {formatMoney(r.feeCents)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setFeeAdjustTarget(r)
                          setFeeAdjustOpen(true)
                        }}
                      >
                        调整
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ul className="max-h-[480px] divide-y divide-line-1 overflow-auto">
            {feeRows.map((r) => (
              <li key={r.courseId} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text-1">{r.who}</p>
                  <p className="mt-0.5 text-xs text-text-3">
                    {format(r.date, 'yyyy-MM-dd')}
                    {r.subject ? ` · ${r.subject}` : ''} · {r.typeLabel} · 实到 {r.presentCount}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[13px] font-semibold tabular-nums text-accent-text">
                    {formatMoney(r.feeCents)}
                  </p>
                  <p className="text-[11px] tabular-nums text-text-3">{r.presentCount} 人</p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setFeeAdjustTarget(r)
                    setFeeAdjustOpen(true)
                  }}
                >
                  调整
                </Button>
              </li>
            ))}
          </ul>
        )}
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

      <FeeAdjustModal
        open={feeAdjustOpen}
        target={feeAdjustTarget}
        onClose={() => setFeeAdjustOpen(false)}
        onSave={(rates) => {
          if (feeAdjustTarget) void saveCourseFees(feeAdjustTarget.courseId, rates)
        }}
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

// ============================================================
// 逐学员调整单课课酬（财务界面）
// ============================================================

function FeeAdjustModal({
  open,
  target,
  onClose,
  onSave,
}: {
  open: boolean
  target: FeeRow | null
  onClose: () => void
  /** 回调：传入各出席学员的单价（分），由父级落库 */
  onSave: (rates: Array<{ studentId: string; unitCents: number }>) => Promise<void> | void
}) {
  const [rates, setRates] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // 打开时预填当前各学员单价（元）
  useEffect(() => {
    if (open && target) {
      const init: Record<string, string> = {}
      for (const p of target.presentStudents) init[p.studentId] = (p.unitCents / 100).toFixed(2)
      setRates(init)
      setError('')
    }
  }, [open, target])

  if (!target) return null

  const parsed = target.presentStudents.map((p) => ({
    studentId: p.studentId,
    unitCents: Math.max(0, Math.round((Number(rates[p.studentId] ?? '0') || 0) * 100)),
  }))
  const total = parsed.reduce((s, r) => s + r.unitCents, 0)
  const anyInvalid = target.presentStudents.some((p) => {
    const v = Number(rates[p.studentId] ?? '')
    return !Number.isFinite(v) || v < 0
  })

  async function handleSave() {
    if (anyInvalid) {
      setError('请填写有效的每人单次课酬（≥0）')
      return
    }
    setSaving(true)
    try {
      await onSave(parsed)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="调整单课课酬（逐学员）"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="rounded-xl border border-line-1 bg-surface-2/50 p-3 text-[12px] text-text-2">
          <div className="flex justify-between">
            <span>对象</span>
            <span className="text-text-1">{target.who}</span>
          </div>
          <div className="mt-1 flex justify-between">
            <span>科目 / 类型</span>
            <span className="text-text-1">
              {target.subject || '—'} · {target.typeLabel}
            </span>
          </div>
          <div className="mt-1 flex justify-between">
            <span>实到人数</span>
            <span className="text-text-1">{target.presentCount} 人</span>
          </div>
          <div className="mt-1 flex justify-between">
            <span>当前合计</span>
            <span className="text-text-1">{formatMoney(target.feeCents)}</span>
          </div>
        </div>

        <div>
          <p className="mb-2 text-[12px] font-medium text-text-2">逐学员单人课酬（元）</p>
          <div className="max-h-[300px] space-y-2 overflow-auto">
            {target.presentStudents.map((p) => (
              <div key={p.studentId} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-text-1">{p.name}</span>
                <div className="w-28 shrink-0">
                  <Input
                    type="number"
                    step="0.5"
                    value={rates[p.studentId] ?? ''}
                    onChange={(e) => {
                      setRates((prev) => ({ ...prev, [p.studentId]: e.target.value }))
                      setError('')
                    }}
                    placeholder="0"
                    inputMode="decimal"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl bg-accent-soft/40 p-3 text-[12px]">
          <p>
            新课酬合计 ={' '}
            <span className="font-semibold text-accent-text">{formatMoney(total)}</span>
            （{target.presentCount} 人单人课酬之和）
          </p>
          <p className="mt-1 text-text-3">
            仅修改本节课历史课酬，不影响其它课程、课时与学员记录。
          </p>
        </div>
        {error && <p className="text-[12px] text-leave">{error}</p>}
      </div>
    </Modal>
  )
}