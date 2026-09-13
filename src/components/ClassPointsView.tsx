import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { format, startOfDay } from 'date-fns'
import {
  CheckCircle2,
  Coins,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Trophy,
  Users,
  XCircle,
  Zap,
} from 'lucide-react'
import { db, withSyncFields } from '@/lib/db'
import { Avatar } from '@/components/Avatar'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
} from '@/components/ui'
import { cn } from '@/lib/utils'
import type { PointBalance } from '@/lib/points'
import {
  addStudentsToActivity,
  awardedPoints,
  cloneDefaultClassRules,
  deleteClassActivity,
  describeRuleCondition,
  ensureTodayClassActivities,
  previewPassPoints,
  rankOf,
  setActivityStatus,
} from '@/lib/classPoints'
import type {
  ClassActivity,
  ClassActivityRecord,
  ClassActivityRule,
  ClassRuleCondition,
  Group,
  Student,
} from '@/lib/types'
import { CLASS_RULE_CONDITION_LABEL, conditionNeedsRank } from '@/lib/types'

/**
 * 课堂积分视图（v17）
 * ------------------------------------------------------------
 * 从独立页面合并进「打卡与积分」，作为第四个 Tab。
 * 相对旧版的改动：
 *  - 关联对象由「课程」改为「班课」（下拉展示班课名，不再是重复的科目名）
 *  - 修复「第一个过关额外加分」永不生效的计分 bug（名次恒为 0）
 *  - 学生列表按加入顺序稳定排列，已过关的原地标记名次，不跳动
 *  - 支持撤销/改判，撤销后名次自动前移、额外分补发给新的第一名
 *  - 按班课排课时间，当天自动生成活动（含学生名单与上次的规则）
 */
export default function ClassPointsView() {
  const activities = useLiveQuery(() => db.classActivities.toArray(), [])
  const records = useLiveQuery(() => db.classActivityRecords.toArray(), [])
  const students = useLiveQuery(() => db.students.toArray(), [])
  const groups = useLiveQuery(() => db.groups.toArray(), [])
  const groupMembers = useLiveQuery(() => db.groupMembers.toArray(), [])
  const ledgers = useLiveQuery(() => db.pointLedgers.toArray(), [])

  const [showCreate, setShowCreate] = useState(false)
  const autoRan = useRef(false)

  // 进入页面时，按班课排课补齐「今天」的课堂活动（幂等，一次挂载只跑一次）
  useEffect(() => {
    if (autoRan.current) return
    autoRan.current = true
    void ensureTodayClassActivities()
  }, [])

  const liveActivities = useMemo(
    () =>
      (activities ?? [])
        .filter((a) => !a.deletedAt)
        .sort((a, b) => b.createdAt - a.createdAt),
    [activities],
  )
  const liveRecords = useMemo(
    () => (records ?? []).filter((r) => !r.deletedAt),
    [records],
  )
  const liveStudents = useMemo(
    () =>
      (students ?? []).filter((s) => !s.deletedAt && s.status !== 'archived'),
    [students],
  )
  const liveGroups = useMemo(
    () => (groups ?? []).filter((g) => !g.deletedAt),
    [groups],
  )

  const studentMap = useMemo(
    () => new Map(liveStudents.map((s) => [s.id, s])),
    [liveStudents],
  )
  const groupMap = useMemo(
    () => new Map(liveGroups.map((g) => [g.id, g])),
    [liveGroups],
  )
  const membersByGroup = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const m of groupMembers ?? []) {
      if (m.deletedAt) continue
      const list = map.get(m.groupId) ?? []
      list.push(m.studentId)
      map.set(m.groupId, list)
    }
    return map
  }, [groupMembers])

  // 积分余额：直接由流水汇总，避免逐学生异步查询
  const balances = useMemo(() => {
    const map = new Map<string, PointBalance>()
    for (const l of ledgers ?? []) {
      if (l.deletedAt) continue
      let b = map.get(l.studentId)
      if (!b) {
        b = { studentId: l.studentId, balance: 0, earned: 0, spent: 0 }
        map.set(l.studentId, b)
      }
      if (l.delta >= 0) b.earned += l.delta
      else b.spent += -l.delta
      b.balance = b.earned - b.spent
    }
    return map
  }, [ledgers])

  const todayStart = startOfDay(new Date()).getTime()

  const recordsOf = (activityId: string) =>
    liveRecords
      .filter((r) => r.activityId === activityId)
      .sort((a, b) => a.createdAt - b.createdAt)

  function memberIdsOf(activity: ClassActivity): string[] {
    if (activity.groupId) return membersByGroup.get(activity.groupId) ?? []
    return liveStudents.map((s) => s.id)
  }

  async function handleStatus(
    activity: ClassActivity,
    record: ClassActivityRecord,
    status: 'pending' | 'pass' | 'fail',
  ) {
    await setActivityStatus(activity, record, status, liveRecords)
  }

  async function handleAddStudents(activity: ClassActivity) {
    const ids = memberIdsOf(activity)
    const added = await addStudentsToActivity(activity, ids, liveRecords)
    if (added === 0) {
      alert(
        activity.groupId
          ? '该班课学生都已在此活动中'
          : '所有在读学生都已在此活动中',
      )
    }
  }

  async function handleDelete(activity: ClassActivity) {
    if (
      !confirm(
        `确定删除「${activity.title}」？\n已发放的课堂积分会一并冲销，学生积分余额将回退。`,
      )
    )
      return
    await deleteClassActivity(activity, liveRecords)
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="课堂积分"
          subtitle="课上检查背诵等场景，按自定义规则记录积分"
          action={
            <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
              <Plus size={13} /> 新建活动
            </Button>
          }
        />
        <div className="px-4 pb-3 text-[12px] text-text-3 flex items-center gap-1.5">
          <Zap size={12} className="text-accent" />
          班课有排课时会按当天自动生成活动（沿用该班课上一次的计分规则），也可手动新建
        </div>
      </Card>

      {liveActivities.length === 0 ? (
        <EmptyState
          icon={<Trophy size={22} />}
          title="还没有课堂活动"
          description="点击「新建活动」创建背诵检查等活动；若班课今天有课，打开本页会自动生成"
        />
      ) : (
        liveActivities.map((activity) => (
          <ActivityCard
            key={activity.id}
            activity={activity}
            records={recordsOf(activity.id)}
            studentMap={studentMap}
            groupMap={groupMap}
            balances={balances}
            isToday={activity.activityDate === todayStart}
            onStatus={handleStatus}
            onAddStudents={handleAddStudents}
            onDelete={handleDelete}
          />
        ))
      )}

      <CreateActivityModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        groups={liveGroups}
        memberIdsOf={(gid) => membersByGroup.get(gid) ?? []}
      />
    </div>
  )
}

// ============================================================
// 活动卡片
// ============================================================

function ActivityCard({
  activity,
  records,
  studentMap,
  groupMap,
  balances,
  isToday,
  onStatus,
  onAddStudents,
  onDelete,
}: {
  activity: ClassActivity
  records: ClassActivityRecord[]
  studentMap: Map<string, Student>
  groupMap: Map<string, Group>
  balances: Map<string, PointBalance>
  isToday: boolean
  onStatus: (
    activity: ClassActivity,
    record: ClassActivityRecord,
    status: 'pending' | 'pass' | 'fail',
  ) => void
  onAddStudents: (activity: ClassActivity) => void
  onDelete: (activity: ClassActivity) => void
}) {
  const group = activity.groupId ? groupMap.get(activity.groupId) : null
  const passed = records.filter((r) => r.status === 'pass')
  const totalAwarded = records.reduce((s, r) => s + (r.pointsAwarded || 0), 0)

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 border-b border-line-1 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Trophy size={15} className="text-amber-500" />
            <h3 className="text-[15px] font-medium text-text-1">{activity.title}</h3>
            {group && <Badge variant="primary">{group.name}</Badge>}
            {activity.auto && (
              <Badge>
                <Zap size={10} /> 自动生成
              </Badge>
            )}
            {isToday && <Badge variant="success">今天</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-[12px] text-text-3">
            <span>{format(activity.createdAt, 'M月d日 HH:mm')}</span>
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 size={11} className="text-done" />
              {passed.length} 人过关
            </span>
            <span className="inline-flex items-center gap-1 text-amber-600">
              <Coins size={11} /> 共 +{totalAwarded} 分
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => onAddStudents(activity)}>
            <Users size={13} /> 补齐学生
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onDelete(activity)}>
            <Trash2 size={13} />
          </Button>
        </div>
      </div>

      {/* 计分规则 */}
      <div className="px-4 pb-3">
        <div className="rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/30 p-3">
          <div className="mb-2 flex items-center gap-1.5">
            <Sparkles size={12} className="text-amber-600" />
            <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
              计分规则
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {activity.rules.map((rule, i) => (
              <div
                key={i}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium',
                  rule.enabled
                    ? 'border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-800/40 dark:bg-amber-900/30 dark:text-amber-300'
                    : 'border-line-1 bg-surface-2 text-text-3 line-through',
                )}
              >
                <span>{rule.name}</span>
                <span className="text-amber-600 dark:text-amber-400">
                  {rule.points}分
                </span>
                <span className="text-amber-500/70">
                  · {describeRuleCondition(rule)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 学生列表 */}
      <div className="border-t border-line-1 px-4 py-3">
        <div className="mb-2.5 flex items-center justify-between">
          <span className="text-[12px] font-medium text-text-2">
            参与学生（{records.length}）
          </span>
        </div>

        {records.length === 0 ? (
          <div className="py-4 text-center text-[13px] text-text-3">
            还没有学生参与，点击右上「补齐学生」
          </div>
        ) : (
          <div className="space-y-1.5">
            {records.map((rec) => {
              const student = studentMap.get(rec.studentId)
              if (!student) return null
              const bal = balances.get(rec.studentId)
              const isPass = rec.status === 'pass'
              const isFail = rec.status === 'fail'
              // 名次只看本活动的记录，避免跨活动同名次串味
              const rank = isPass ? rankOf(records, rec.studentId) : 0
              const preview =
                rec.status === 'pending'
                  ? previewPassPoints(activity, records, rec.studentId)
                  : 0

              return (
                <div
                  key={rec.id}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-lg border px-3 py-2',
                    isPass
                      ? 'border-done/30 bg-done/5 dark:bg-done/10'
                      : isFail
                        ? 'border-money-due/30 bg-money-due/5 dark:bg-money-due/10'
                        : 'border-line-1 bg-surface-0',
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Avatar name={student.name} colorSlot={student.colorSlot} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-medium text-text-1">
                          {student.name}
                        </span>
                        {isPass && rank === 1 && (
                          <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                            <Trophy size={9} /> 第 1 名
                          </span>
                        )}
                        {isPass && rank > 1 && (
                          <span className="shrink-0 text-[10px] text-text-3">
                            第 {rank} 名
                          </span>
                        )}
                      </div>
                      {bal && (
                        <div className="flex items-center gap-1.5 text-[11px] text-text-3">
                          <Coins size={10} />
                          当前 {bal.balance} 分
                          {rec.pointsAwarded > 0 && (
                            <span className="text-done">+{rec.pointsAwarded}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {rec.status === 'pending' && (
                      <>
                        {preview > 0 && (
                          <span className="hidden text-[11px] text-text-3 sm:inline">
                            过关 +{preview}
                          </span>
                        )}
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => onStatus(activity, rec, 'pass')}
                        >
                          <CheckCircle2 size={13} /> 过关
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => onStatus(activity, rec, 'fail')}
                        >
                          <XCircle size={13} /> 未过关
                        </Button>
                      </>
                    )}

                    {isPass && (
                      <>
                        <span className="flex items-center gap-1 text-[12px] font-medium text-done">
                          <CheckCircle2 size={13} /> +{rec.pointsAwarded} 分
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="撤销（分与名次会重算）"
                          onClick={() => onStatus(activity, rec, 'pending')}
                        >
                          <RotateCcw size={13} />
                        </Button>
                      </>
                    )}

                    {isFail && (
                      <>
                        <span className="flex items-center gap-1 text-[12px] text-money-due">
                          <XCircle size={13} /> 未过关
                          {rec.pointsAwarded > 0 && (
                            <span className="font-medium text-done">+{rec.pointsAwarded} 分</span>
                          )}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="改判为过关"
                          onClick={() => onStatus(activity, rec, 'pass')}
                        >
                          <CheckCircle2 size={13} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="重置为待检查"
                          onClick={() => onStatus(activity, rec, 'pending')}
                        >
                          <RotateCcw size={13} />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Card>
  )
}

// ============================================================
// 新建活动弹窗
// ============================================================

function CreateActivityModal({
  open,
  onClose,
  groups,
  memberIdsOf,
}: {
  open: boolean
  onClose: () => void
  groups: Group[]
  memberIdsOf: (groupId: string) => string[]
}) {
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [groupId, setGroupId] = useState('')
  const [rules, setRules] = useState<ClassActivityRule[]>(cloneDefaultClassRules())
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setTitle('')
    setNote('')
    setGroupId('')
    setRules(cloneDefaultClassRules())
  }, [open])

  // 选班课时，若还没填名称，自动带上班课名
  function handleGroupChange(gid: string) {
    setGroupId(gid)
    if (!title.trim() && gid) {
      const g = groups.find((x) => x.id === gid)
      if (g) setTitle(`课堂积分 · ${g.name}`)
    }
  }

  async function handleCreate() {
    if (!title.trim()) {
      alert('请填写活动名称')
      return
    }
    setSaving(true)
    try {
      const now = Date.now()
      const activity = withSyncFields<ClassActivity>({
        title: title.trim(),
        courseId: null,
        groupId: groupId || null,
        activityDate: startOfDay(new Date()).getTime(),
        auto: false,
        sourceCourseId: null,
        rules: rules
          .filter((r) => r.name.trim() && r.points > 0)
          .map((r) => ({ ...r, name: r.name.trim() })),
        note: note.trim(),
        createdAt: now,
      })
      await db.classActivities.put(activity)

      // 关联班课时自动带上班课学生
      const ids = groupId ? memberIdsOf(groupId) : []
      if (ids.length > 0) {
        await db.classActivityRecords.bulkPut(
          Array.from(new Set(ids)).map((sid) =>
            withSyncFields<ClassActivityRecord>({
              activityId: activity.id,
              studentId: sid,
              status: 'pending',
              pointsAwarded: 0,
              note: '',
              checkedAt: null,
              createdAt: now,
              ledgerId: null,
            }),
          ),
        )
      }
      onClose()
    } finally {
      setSaving(false)
    }
  }

  function addRule() {
    setRules([...rules, { name: '', points: 1, condition: 'pass', enabled: true }])
  }

  function removeRule(idx: number) {
    setRules(rules.filter((_, i) => i !== idx))
  }

  function updateRule(idx: number, field: keyof ClassActivityRule, value: unknown) {
    const next = [...rules]
    next[idx] = { ...next[idx]!, [field]: value } as ClassActivityRule
    setRules(next)
  }

  /** 切换条件时补齐名次参数的默认值，保证保存出的规则字段完整 */
  function changeCondition(idx: number, condition: ClassRuleCondition) {
    const next = [...rules]
    const rule = { ...next[idx]!, condition } as ClassActivityRule
    if (conditionNeedsRank(condition) === 'single') {
      rule.rankN = rule.rankN ?? 1
    } else if (conditionNeedsRank(condition) === 'range') {
      rule.rankFrom = rule.rankFrom ?? 1
      rule.rankTo = rule.rankTo ?? rule.rankFrom
    }
    next[idx] = rule
    setRules(next)
  }

  return (
    <Modal open={open} onClose={onClose} title="新建课堂活动" size="xl">
      <div className="space-y-4">
        <Field label="活动名称">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="如：背诵检查、单词听写、课文朗读"
            autoFocus
          />
        </Field>

        <Field label="关联班课（可选）">
          <Select value={groupId} onChange={(e) => handleGroupChange(e.target.value)}>
            <option value="">不关联（活动内可手动补齐学生）</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
                {g.subject ? ` · ${g.subject}` : ''}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="备注">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="可选，如：背诵第一单元课文"
            rows={2}
          />
        </Field>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[13px] font-medium text-text-1">计分规则</span>
            <Button variant="ghost" size="sm" onClick={addRule}>
              <Plus size={13} /> 添加规则
            </Button>
          </div>
          <div className="space-y-2">
            {rules.map((rule, idx) => (
              <div
                key={idx}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-line-1 bg-surface-0 p-2.5"
              >
                <button
                  type="button"
                  onClick={() => updateRule(idx, 'enabled', !rule.enabled)}
                  title={rule.enabled ? '已启用，点击停用' : '已停用，点击启用'}
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border',
                    rule.enabled
                      ? 'border-done/40 bg-done/10 text-done'
                      : 'border-line-1 bg-surface-1 text-text-3',
                  )}
                >
                  <CheckCircle2 size={13} />
                </button>
                <Input
                  value={rule.name}
                  onChange={(e) => updateRule(idx, 'name', e.target.value)}
                  placeholder="规则名称"
                  className={cn('min-w-[110px] flex-1', !rule.enabled && 'opacity-60')}
                />
                <div className="flex shrink-0 items-center gap-1">
                  <Input
                    type="number"
                    min={0}
                    value={rule.points}
                    onChange={(e) =>
                      updateRule(idx, 'points', Number(e.target.value))
                    }
                    className="w-16"
                  />
                  <span className="text-[12px] text-text-3">分</span>
                </div>
                <Select
                  value={rule.condition}
                  onChange={(e) => changeCondition(idx, e.target.value as ClassRuleCondition)}
                  className="w-36 shrink-0"
                >
                  {(Object.keys(CLASS_RULE_CONDITION_LABEL) as ClassRuleCondition[]).map((c) => (
                    <option key={c} value={c}>
                      {CLASS_RULE_CONDITION_LABEL[c]}
                    </option>
                  ))}
                </Select>
                {conditionNeedsRank(rule.condition) === 'single' && (
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="text-[12px] text-text-3">第</span>
                    <Input
                      type="number"
                      min={1}
                      value={rule.rankN ?? 1}
                      onChange={(e) =>
                        updateRule(idx, 'rankN', Math.max(1, Number(e.target.value) || 1))
                      }
                      className="w-14"
                    />
                    <span className="text-[12px] text-text-3">名</span>
                  </div>
                )}
                {conditionNeedsRank(rule.condition) === 'range' && (
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="text-[12px] text-text-3">第</span>
                    <Input
                      type="number"
                      min={1}
                      value={rule.rankFrom ?? 1}
                      onChange={(e) =>
                        updateRule(idx, 'rankFrom', Math.max(1, Number(e.target.value) || 1))
                      }
                      className="w-14"
                    />
                    <span className="text-[12px] text-text-3">~</span>
                    <Input
                      type="number"
                      min={1}
                      value={rule.rankTo ?? rule.rankFrom ?? 1}
                      onChange={(e) =>
                        updateRule(idx, 'rankTo', Math.max(1, Number(e.target.value) || 1))
                      }
                      className="w-14"
                    />
                    <span className="text-[12px] text-text-3">名</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removeRule(idx)}
                  className="shrink-0 text-text-3 hover:text-money-due"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2 space-y-0.5 text-[11px] text-text-3">
            <div>
              <span className="font-medium text-text-2">过关者都加</span>
              ：每个过关的学生都加（如「过关 +1」）
            </div>
            <div>
              <span className="font-medium text-text-2">未过关者加</span>
              ：未过关的学生也加（如「参与鼓励 +1」）
            </div>
            <div>
              <span className="font-medium text-text-2">按名次加</span>
              ：仅第一个 / 前 N 名 / 第 N 名 / 第 X~Y 名，名次可自定义
            </div>
            <div className="pt-0.5">
              示例：第 1 名过关合计{' '}
              <span className="font-medium text-text-2">{awardedPoints(rules, 1, 'pass')}</span> 分
              · 未过关合计{' '}
              <span className="font-medium text-text-2">{awardedPoints(rules, 0, 'fail')}</span> 分
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleCreate} disabled={saving || !title.trim()}>
            {saving ? '保存中…' : '创建活动'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
