import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Coins, Pencil, Plus, Sparkles, Trash2, Wand2 } from 'lucide-react'
import { db, isRuleOrderSafe, markDeleted, touch, withSyncFields } from '@/lib/db'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Modal,
  SegmentedControl,
  Select,
} from '@/components/ui'
import { cn } from '@/lib/utils'
import type {
  ClassRuleCondition,
  ClassRuleConditionSpec,
  PointMetric,
  PointRule,
  PointRuleCondition,
  RuleMode,
  RuleScope,
} from '@/lib/types'
import {
  CLASS_RULE_CONDITION_LABEL,
  POINT_METRIC_LABEL,
  RULE_MODE_HINT,
  RULE_MODE_LABEL,
  RULE_SCOPE_HINT,
  RULE_SCOPE_LABEL,
  conditionNeedsRank,
  describeClassRuleCondition,
} from '@/lib/types'
import { ensureDefaultClassRules, nextRuleOrder } from '@/lib/classPoints'

/**
 * 积分规则（v20）
 * ------------------------------------------------------------
 * 所有规则集中在这里定义，分「打卡规则 / 课堂规则」两套：
 *  - 打卡规则：打卡任务引用它们计分
 *  - 课堂规则：课堂积分活动引用它们计分
 * 每条规则 = 名称 + 分值 + 计算方式 +（可选）条件；
 * 计算方式分「自动累加」（达标学生自动加）与「手动档位」（标记时逐人选一条）。
 * 活动里只做规则的引用增减，不再各自维护一份规则。
 */
export default function RuleLibraryView() {
  const rules = useLiveQuery(() => db.pointRules.toArray(), [])
  const [scope, setScope] = useState<RuleScope>('checkin')
  const [editing, setEditing] = useState<PointRule | null>(null)
  const [open, setOpen] = useState(false)
  const [seeding, setSeeding] = useState(false)

  const live = useMemo(
    () => (rules ?? []).filter((r) => !r.deletedAt),
    [rules],
  )
  const counts = useMemo(() => {
    return {
      checkin: live.filter((r) => (r.scope ?? 'checkin') === 'checkin').length,
      class: live.filter((r) => (r.scope ?? 'checkin') === 'class').length,
    }
  }, [live])
  const list = useMemo(
    () =>
      live
        .filter((r) => (r.scope ?? 'checkin') === scope)
        .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt),
    [live, scope],
  )

  function openNew() {
    setEditing(null)
    setOpen(true)
  }
  function openEdit(r: PointRule) {
    setEditing(r)
    setOpen(true)
  }
  async function handleToggle(r: PointRule) {
    await db.pointRules.put(touch({ ...r, enabled: !r.enabled }))
  }
  async function handleDelete(r: PointRule) {
    if (!confirm(`删除规则「${r.name}」？已引用的活动将不再计算该规则。`)) return
    await db.pointRules.put(markDeleted(r))
  }
  async function handleSeedClass() {
    setSeeding(true)
    try {
      const n = await ensureDefaultClassRules()
      if (n === 0) alert('课堂规则已存在，无需补齐')
    } finally {
      setSeeding(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="积分规则"
          subtitle="规则集中在这里定义；打卡任务与课堂活动按需引用"
          action={
            <Button variant="primary" size="sm" onClick={openNew}>
              <Plus size={13} /> 新建规则
            </Button>
          }
        />
        <div className="px-4 pb-3">
          <SegmentedControl
            value={scope}
            onChange={(v) => setScope(v as RuleScope)}
            layout="grid"
            options={[
              { value: 'checkin', label: `打卡规则（${counts.checkin}）` },
              { value: 'class', label: `课堂规则（${counts.class}）` },
            ]}
          />
          <p className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-text-3">
            <Sparkles size={12} className="text-accent" />
            {RULE_SCOPE_HINT[scope]}
          </p>
        </div>
      </Card>

      {list.length === 0 ? (
        <EmptyState
          icon={<Coins size={22} />}
          title={scope === 'checkin' ? '还没有打卡规则' : '还没有课堂规则'}
          description={
            scope === 'checkin'
              ? '例：提交作业 +2、连续打卡 7 天 +5；打卡任务会按这些规则加分'
              : '例：过关 +1、第一个过关额外 +1、背诵熟练 +1 / 不熟练 +0.5'
          }
          action={
            <div className="flex items-center gap-2">
              <Button onClick={openNew}>
                <Plus size={13} /> 新建规则
              </Button>
              {scope === 'class' && (
                <Button variant="secondary" onClick={() => void handleSeedClass()} disabled={seeding}>
                  <Wand2 size={13} /> {seeding ? '补齐中…' : '补齐默认规则'}
                </Button>
              )}
            </div>
          }
        />
      ) : (
        <Card>
          <ul className="divide-y divide-line-1">
            {list.map((r) => (
              <li
                key={r.id}
                className={cn('group flex items-start gap-3 px-4 py-3', !r.enabled && 'opacity-60')}
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-accent">
                  <Coins size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-text-1">{r.name}</span>
                    <Badge variant={r.mode === 'tier' ? 'primary' : 'success'}>
                      {RULE_MODE_LABEL[r.mode ?? 'auto']}
                    </Badge>
                    <Badge variant={r.points < 0 ? 'danger' : 'neutral'}>
                      {r.points > 0 ? '+' : ''}
                      {r.points}
                    </Badge>
                    {!r.enabled && <Badge variant="warning">已停用</Badge>}
                  </div>
                  <p className="mt-1 text-[12px] text-text-2">{describeRule(r)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => void handleToggle(r)}>
                    {r.enabled ? '停用' : '启用'}
                  </Button>
                  <button
                    type="button"
                    onClick={() => openEdit(r)}
                    className="hidden h-7 w-7 items-center justify-center rounded-md text-text-3 hover:bg-surface-2 hover:text-text-1 group-hover:flex"
                    title="编辑"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(r)}
                    className="hidden h-7 w-7 items-center justify-center rounded-md text-text-3 hover:bg-money-out/10 hover:text-money-out group-hover:flex"
                    title="删除"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <RuleModal
        open={open}
        scope={scope}
        rule={editing}
        // 新建时的排序值：同范围最大 order + 1。
        // 这里必须传函数（在弹窗保存时求值），不能用 Date.now()
        // —— 云端该列是 int4，时间戳会溢出导致整张表推送失败（v30.5）。
        nextOrder={() => nextRuleOrder(live, scope)}
        onClose={() => setOpen(false)}
      />
    </div>
  )
}

// ============================================================
// 规则说明
// ============================================================

/** 把一条规则描述成中文短句（含条件与名次参数） */
export function describeRule(r: PointRule): string {
  const scope = r.scope ?? 'checkin'
  const mode = r.mode ?? 'auto'
  if (mode === 'tier') {
    return `标记学生时可选档位：选中「${r.name}」得 ${fmtPoints(r.points)} 分`
  }
  if (scope === 'class') {
    const spec = r.classCondition
    if (!spec) return `所有过关学生自动 ${fmtPoints(r.points)} 分`
    if (spec.condition === 'fail') {
      return `未过关的学生自动 ${fmtPoints(r.points)} 分`
    }
    if (spec.condition === 'custom') {
      return `手动点选「${spec.customText?.trim() || r.name}」→ ${fmtPoints(r.points)} 分（覆盖自动累加）`
    }
    return `当「${describeClassRuleCondition(spec)}」时自动 ${fmtPoints(r.points)} 分`
  }
  if (!r.condition) return `每次「已打卡」自动 ${fmtPoints(r.points)} 分`
  const opText = r.condition.operator === '>=' ? '≥' : r.condition.operator === '>' ? '>' : '='
  return `当「${POINT_METRIC_LABEL[r.condition.metric]} ${opText} ${r.condition.value}」时自动 ${fmtPoints(r.points)} 分`
}

function fmtPoints(p: number): string {
  return `${p > 0 ? '+' : ''}${p}`
}

// ============================================================
// 新建 / 编辑规则
// ============================================================

/** 课堂条件的界面键：none = 无条件（所有过关学生） */
type ClassCondKey = 'none' | Exclude<ClassRuleCondition, 'pass'>

const CLASS_COND_KEY_LABEL: Record<ClassCondKey, string> = {
  none: '所有过关学生（无附加条件）',
  fail: CLASS_RULE_CONDITION_LABEL.fail,
  all: CLASS_RULE_CONDITION_LABEL.all,
  first: CLASS_RULE_CONDITION_LABEL.first,
  topN: CLASS_RULE_CONDITION_LABEL.topN,
  rank: CLASS_RULE_CONDITION_LABEL.rank,
  range: CLASS_RULE_CONDITION_LABEL.range,
  custom: '自定义…（手动按钮，不自动累加）',
}

/** 打卡条件键：none = 无条件 */
type CheckinCondKey = 'none' | PointMetric

function RuleModal({
  open,
  scope,
  rule,
  nextOrder,
  onClose,
}: {
  open: boolean
  scope: RuleScope
  rule: PointRule | null
  /** 新建规则的排序值（同范围最大 order + 1） */
  nextOrder: () => number
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [points, setPoints] = useState('1')
  const [mode, setMode] = useState<RuleMode>('auto')
  const [classCond, setClassCond] = useState<ClassCondKey>('none')
  const [customText, setCustomText] = useState('')
  const [rankN, setRankN] = useState('3')
  const [rankFrom, setRankFrom] = useState('1')
  const [rankTo, setRankTo] = useState('3')
  const [checkinCond, setCheckinCond] = useState<CheckinCondKey>('none')
  const [op, setOp] = useState<PointRuleCondition['operator']>('>=')
  const [value, setValue] = useState('7')
  const [readyFor, setReadyFor] = useState<string | null>(null)

  // 打开时按传入规则初始化（用 key 判断避免重复初始化）
  const initKey = open ? `${rule?.id ?? 'new'}:${scope}` : null
  if (open && readyFor !== initKey) {
    setReadyFor(initKey)
    const r = rule
    setName(r?.name ?? '')
    setPoints(String(r?.points ?? 1))
    setMode(r?.mode ?? 'auto')
    // 课堂条件
    const spec = r?.classCondition
    if (spec && spec.condition !== 'pass') {
      setClassCond(spec.condition as ClassCondKey)
    } else {
      setClassCond('none')
    }
    setCustomText(spec?.customText ?? '')
    setRankN(String(spec?.rankN ?? 3))
    setRankFrom(String(spec?.rankFrom ?? 1))
    setRankTo(String(spec?.rankTo ?? spec?.rankFrom ?? 3))
    // 打卡条件
    if (r?.condition) {
      setCheckinCond(r.condition.metric)
      setOp(r.condition.operator)
      setValue(String(r.condition.value))
    } else {
      setCheckinCond('none')
      setOp('>=')
      setValue('7')
    }
  }

  const targetScope = rule ? (rule.scope ?? 'checkin') : scope

  async function handleSave() {
    const trimmed = name.trim()
    if (!trimmed) {
      alert('请填写规则名称')
      return
    }
    const pts = Number(points)
    if (!Number.isFinite(pts) || pts === 0) {
      alert('请填写有效的分值（可为小数，如 0.5）')
      return
    }

    let nextClassCond: ClassRuleConditionSpec | null = null
    if (targetScope === 'class' && mode === 'auto' && classCond !== 'none') {
      if (classCond === 'topN' || classCond === 'rank') {
        nextClassCond = { condition: classCond, rankN: Math.max(1, Number(rankN) || 1) }
      } else if (classCond === 'range') {
        const from = Math.max(1, Number(rankFrom) || 1)
        const to = Math.max(from, Number(rankTo) || from)
        nextClassCond = { condition: 'range', rankFrom: from, rankTo: to }
      } else if (classCond === 'custom') {
        const txt = customText.trim()
        if (!txt) {
          alert('请填写自定义加分条件（如「背得不熟练」）')
          return
        }
        nextClassCond = { condition: 'custom', customText: txt }
      } else {
        nextClassCond = { condition: classCond }
      }
    }

    let nextCondition: PointRuleCondition | null = null
    if (targetScope === 'checkin' && mode === 'auto' && checkinCond !== 'none') {
      nextCondition = {
        metric: checkinCond,
        operator: op,
        value: Number(value) || 0,
      }
    }

    const payload = {
      name: trimmed,
      points: pts,
      scope: targetScope,
      mode,
      condition: nextCondition,
      classCondition: nextClassCond,
      enabled: rule?.enabled ?? true,
      // 编辑时保留原排序值；原值非法（旧版时间戳脏数据 / NaN）则重新分配，避免脏值继续传播
      order: rule && isRuleOrderSafe(rule.order) ? rule.order : nextOrder(),
    }
    if (rule) {
      await db.pointRules.put(touch({ ...rule, ...payload }))
    } else {
      await db.pointRules.put(
        withSyncFields<PointRule>({ ...payload, createdAt: Date.now() }),
      )
    }
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={rule ? '编辑规则' : `新建${RULE_SCOPE_LABEL[targetScope]}`}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => void handleSave()}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="适用范围">
          <div className="flex items-center gap-2">
            <Badge variant="primary">{RULE_SCOPE_LABEL[targetScope]}</Badge>
            <span className="text-[12px] text-text-3">
              {rule ? '创建后不可跨套移动，可在另一套里新建' : RULE_SCOPE_HINT[targetScope]}
            </span>
          </div>
        </Field>

        <Field label="规则名称">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              targetScope === 'checkin' ? '如：提交作业 / 连续打卡 7 天' : '如：背诵熟练 / 第一个过关'
            }
            autoFocus
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="分值（可为小数）">
            <Input
              type="number"
              step="0.5"
              value={points}
              onChange={(e) => setPoints(e.target.value)}
            />
          </Field>
          <Field label="计算方式">
            <Select value={mode} onChange={(e) => setMode(e.target.value as RuleMode)}>
              {(Object.keys(RULE_MODE_LABEL) as RuleMode[]).map((m) => (
                <option key={m} value={m}>
                  {RULE_MODE_LABEL[m]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <p className="-mt-1 text-[11px] text-text-3">{RULE_MODE_HINT[mode]}</p>

        {mode === 'auto' && targetScope === 'class' && (
          <div className="space-y-2 rounded-lg border border-line-1 bg-surface-0 p-3">
            <Field label="加分条件">
              <Select
                value={classCond}
                onChange={(e) => setClassCond(e.target.value as ClassCondKey)}
              >
                {(Object.keys(CLASS_COND_KEY_LABEL) as ClassCondKey[]).map((k) => (
                  <option key={k} value={k}>
                    {CLASS_COND_KEY_LABEL[k]}
                  </option>
                ))}
              </Select>
            </Field>
            {conditionNeedsRank(classCond === 'none' ? 'pass' : classCond) === 'single' && (
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-text-3">第</span>
                <Input
                  type="number"
                  min={1}
                  value={rankN}
                  onChange={(e) => setRankN(e.target.value)}
                  className="w-20"
                />
                <span className="text-[12px] text-text-3">名过关</span>
              </div>
            )}
            {classCond === 'range' && (
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-text-3">第</span>
                <Input
                  type="number"
                  min={1}
                  value={rankFrom}
                  onChange={(e) => setRankFrom(e.target.value)}
                  className="w-20"
                />
                <span className="text-[12px] text-text-3">~</span>
                <Input
                  type="number"
                  min={1}
                  value={rankTo}
                  onChange={(e) => setRankTo(e.target.value)}
                  className="w-20"
                />
                <span className="text-[12px] text-text-3">名过关</span>
              </div>
            )}
            {classCond === 'custom' && (
              <Field label="自定义条件说明">
                <Input
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value)}
                  placeholder="如：背得不熟练 / 只完成一半 / 声音太小"
                />
              </Field>
            )}
            <p className="text-[11px] text-text-3">
              {classCond === 'custom'
                ? '自定义条件无法自动判断，因此这条规则会作为「手动按钮」——在活动页点选后该生得此分值，不参与自动累加。'
                : classCond === 'all'
                  ? '全部已检查的学生都会加分，不论过关与否（待检查的学生不计入）。'
                  : classCond === 'first'
                    ? '按「被点名的先后」取第 1 个被检查的学生（不论过关与否），加此分值；其余名次类规则仍按过关先后。'
                    : '名次按「过关先后」计算（第 1 名 = 最先过关的学生）。'}
            </p>
          </div>
        )}

        {mode === 'auto' && targetScope === 'checkin' && (
          <div className="space-y-2 rounded-lg border border-line-1 bg-surface-0 p-3">
            <Field label="加分条件">
              <Select
                value={checkinCond}
                onChange={(e) => setCheckinCond(e.target.value as CheckinCondKey)}
              >
                <option value="none">所有已打卡学生（无附加条件）</option>
                {(Object.keys(POINT_METRIC_LABEL) as PointMetric[]).map((m) => (
                  <option key={m} value={m}>
                    {POINT_METRIC_LABEL[m]}
                  </option>
                ))}
              </Select>
            </Field>
            {checkinCond !== 'none' && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="比较方式">
                  <Select
                    value={op}
                    onChange={(e) => setOp(e.target.value as PointRuleCondition['operator'])}
                  >
                    <option value=">=">≥</option>
                    <option value=">">&gt;</option>
                    <option value="==">=</option>
                  </Select>
                </Field>
                <Field label="阈值">
                  <Input
                    type="number"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                </Field>
              </div>
            )}
          </div>
        )}

        <div className="rounded-lg bg-surface-1 p-3 text-[12px] text-text-2">
          <span className="font-medium text-text-1">效果预览：</span>
          {describeDraft({
            name: name.trim() || '该规则',
            points: Number(points) || 0,
            scope: targetScope,
            mode,
            classCond,
            customText,
            rankN: Number(rankN) || 1,
            rankFrom: Number(rankFrom) || 1,
            rankTo: Number(rankTo) || 1,
            checkinCond,
            op,
            value: Number(value) || 0,
          })}
        </div>
      </div>
    </Modal>
  )
}

/** 根据弹窗内的草稿生成效果预览文案 */
function describeDraft(d: {
  name: string
  points: number
  scope: RuleScope
  mode: RuleMode
  classCond: ClassCondKey
  customText: string
  rankN: number
  rankFrom: number
  rankTo: number
  checkinCond: CheckinCondKey
  op: PointRuleCondition['operator']
  value: number
}): string {
  if (d.mode === 'tier') {
    return `标记学生时会出现「${d.name}」档位，选中后得 ${fmtPoints(d.points)} 分。`
  }
  if (d.scope === 'class') {
    if (d.classCond === 'none') return `每个过关的学生自动 ${fmtPoints(d.points)} 分。`
    if (d.classCond === 'fail') return `每个未过关的学生自动 ${fmtPoints(d.points)} 分。`
    if (d.classCond === 'custom') {
      const label = d.customText.trim() || d.name
      return `手动点选「${label}」按钮 → 该生得 ${fmtPoints(d.points)} 分（覆盖自动累加）。`
    }
    const text = describeClassRuleCondition({
      condition: d.classCond,
      rankN: d.rankN,
      rankFrom: d.rankFrom,
      rankTo: d.rankTo,
    })
    return `满足「${text}」的学生自动 ${fmtPoints(d.points)} 分。`
  }
  if (d.checkinCond === 'none') return `每次「已打卡」自动 ${fmtPoints(d.points)} 分。`
  const opText = d.op === '>=' ? '≥' : d.op === '>' ? '>' : '='
  return `当「${POINT_METRIC_LABEL[d.checkinCond]} ${opText} ${d.value}」时自动 ${fmtPoints(d.points)} 分。`
}

/*
 * ⚠ 已移除旧版 `nextOrder()`（返回 `Date.now()`）：
 *   云端 `pointRules."order"` 是 integer（int4，上限 2147483647），毫秒时间戳会溢出 →
 *   PostgREST 报 `value "1789311709042" is out of range for type integer` →
 *   **整张 pointRules 推送失败**（v30.5 修复）。
 *   现改为 `nextRuleOrder()`（classPoints.ts，同范围最大 order + 1），便于回归脚本测到同一份代码。
 */
