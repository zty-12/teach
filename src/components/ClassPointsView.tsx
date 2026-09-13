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
  buildSnapshotForRuleIds,
  defaultClassRuleIds,
  deleteClassActivity,
  ensureTodayClassActivities,
  previewPassPoints,
  rankOf,
  resolveClassRules,
  setActivityOutcome,
  setActivityTierOutcome,
  tierRules,
  type ResolvedClassRule,
} from '@/lib/classPoints'
import type {
  ClassActivity,
  ClassActivityRecord,
  Group,
  PointRule,
  Student,
} from '@/lib/types'
import { describeClassRuleCondition, RULE_MODE_LABEL } from '@/lib/types'
import { RulePicker } from '@/components/RulePicker'

/**
 * 课堂积分视图（v20）
 * ------------------------------------------------------------
 * 从独立页面合并进「打卡与积分」，作为「课堂积分」Tab。
 * 相对旧版的改动：
 *  - 计分规则全部集中在「积分规则 → 课堂规则」页维护，活动只通过 ruleIds 引用；
 *    新建活动不再内嵌可编辑的规则表单，改为引用规则库（可多选）。
 *  - 规则支持两种模式并存：
 *      · auto（自动累加）：过关/未过关/名次达标的学生自动加分
 *      · tier（手动档位）：逐人判档，如「背诵熟练 +1 / 不熟练 +0.5」
 *  - 学生行为恒定三态按钮（v30）：过关 / 档位（如「不熟练 +0.5」）/ 未过关，
 *    当前态高亮；档位是介于过关与未过关之间的独立第三态，只加档位分。
 *  - 名次仅用于展示与名次类规则，不再作为唯一计分依据。
 *  - 按班课排课时间，当天自动生成活动（沿用当前启用的课堂规则）。
 */
export default function ClassPointsView() {
  const activities = useLiveQuery(() => db.classActivities.toArray(), [])
  const records = useLiveQuery(() => db.classActivityRecords.toArray(), [])
  const students = useLiveQuery(() => db.students.toArray(), [])
  const groups = useLiveQuery(() => db.groups.toArray(), [])
  const groupMembers = useLiveQuery(() => db.groupMembers.toArray(), [])
  const ledgers = useLiveQuery(() => db.pointLedgers.toArray(), [])
  const pointRules = useLiveQuery(() => db.pointRules.toArray(), [])

  const [showCreate, setShowCreate] = useState(false)
  const autoRan = useRef(false)
  // v29：正在处理中的活动 id（活动级提交锁，防并发改判导致名次错乱）
  const processingRef = useRef(new Set<string>())

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
  const liveRules: PointRule[] = useMemo(
    () => (pointRules ?? []).filter((r) => !r.deletedAt),
    [pointRules],
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

  // 每个活动解析出的规则（库规则引用 or 旧版内嵌规则），供计分与展示共用
  const ruleMap = useMemo(() => {
    const m = new Map<string, ResolvedClassRule[]>()
    for (const a of liveActivities) m.set(a.id, resolveClassRules(a, liveRules))
    return m
  }, [liveActivities, liveRules])

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

  async function handleOutcome(
    activity: ClassActivity,
    record: ClassActivityRecord,
    status: 'pending' | 'pass' | 'fail',
  ) {
    // v29：活动级提交锁 —— 快速连点时丢弃后续调用，配合数据层「从库重读」根治并发名次错乱
    if (processingRef.current.has(activity.id)) return
    processingRef.current.add(activity.id)
    try {
      // v30 三态互斥：落状态时清掉残留档位，避免「过关/未过关 + 旧档位」半吊子状态
      await setActivityOutcome(activity, record, status, ruleMap.get(activity.id) ?? [])
    } finally {
      processingRef.current.delete(activity.id)
    }
  }

  async function handleTier(
    activity: ClassActivity,
    record: ClassActivityRecord,
    tierId: string,
  ) {
    if (processingRef.current.has(activity.id)) return
    processingRef.current.add(activity.id)
    try {
      // v30 档位是独立第三态：只加档位分（如「不熟练 +0.5」），不叠加过关/未过关规则
      await setActivityTierOutcome(activity, record, tierId, ruleMap.get(activity.id) ?? [])
    } finally {
      processingRef.current.delete(activity.id)
    }
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
          subtitle="课上检查背诵等场景，按「积分规则 → 课堂规则」记录积分"
          action={
            <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
              <Plus size={13} /> 新建活动
            </Button>
          }
        />
        <div className="px-4 pb-3 text-[12px] text-text-3 flex items-center gap-1.5">
          <Zap size={12} className="text-accent" />
          班课有排课时会按当天自动生成活动（沿用当前启用的课堂规则），也可手动新建
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
            rules={ruleMap.get(activity.id) ?? []}
            studentMap={studentMap}
            groupMap={groupMap}
            balances={balances}
            isToday={activity.activityDate === todayStart}
            onStatus={handleOutcome}
            onTier={handleTier}
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
  rules,
  studentMap,
  groupMap,
  balances,
  isToday,
  onStatus,
  onTier,
  onAddStudents,
  onDelete,
}: {
  activity: ClassActivity
  records: ClassActivityRecord[]
  rules: ResolvedClassRule[]
  studentMap: Map<string, Student>
  groupMap: Map<string, Group>
  balances: Map<string, PointBalance>
  isToday: boolean
  onStatus: (
    activity: ClassActivity,
    record: ClassActivityRecord,
    status: 'pending' | 'pass' | 'fail',
  ) => void
  onTier: (
    activity: ClassActivity,
    record: ClassActivityRecord,
    tierId: string,
  ) => void
  onAddStudents: (activity: ClassActivity) => void
  onDelete: (activity: ClassActivity) => void
}) {
  const group = activity.groupId ? groupMap.get(activity.groupId) : null
  const passed = records.filter((r) => r.status === 'pass')
  const totalAwarded = records.reduce((s, r) => s + (r.pointsAwarded || 0), 0)
  const tiers = tierRules(rules)

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

      {/* 计分规则（来自规则库引用） */}
      <div className="px-4 pb-3">
        <div className="rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/30 p-3">
          <div className="mb-2 flex items-center gap-1.5">
            <Sparkles size={12} className="text-amber-600" />
            <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
              计分规则（引用「积分规则 → 课堂规则」）
            </span>
          </div>
          {rules.length === 0 ? (
            <p className="text-[11px] text-text-3">
              未引用任何规则，请到「积分规则」页新建课堂规则，或在编辑/新建活动处引用。
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {rules.map((r) => (
                <div
                  key={r.id}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium',
                    r.enabled
                      ? 'border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-800/40 dark:bg-amber-900/30 dark:text-amber-300'
                      : 'border-line-1 bg-surface-2 text-text-3 line-through',
                  )}
                  title={RULE_MODE_LABEL[r.mode ?? 'auto']}
                >
                  <span>{r.name}</span>
                  <span className="text-amber-600 dark:text-amber-400">{r.points}分</span>
                  <span className="text-amber-500/70">
                    · {describeClassRuleCondition({
                      condition: r.condition ?? 'pass',
                      rankN: r.rankN,
                      rankFrom: r.rankFrom,
                      rankTo: r.rankTo,
                    })}
                  </span>
                  {r.mode === 'tier' && (
                    <span className="rounded bg-amber-200 px-1 text-[9px] text-amber-800 dark:bg-amber-800/50 dark:text-amber-200">
                      档位
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {/* v30：档位规则缺失时的可见提示 —— 常见误配是把「不熟练」建成自动累加模式，
              导致学生行永远出不了档位按钮（用户实测反馈） */}
          {rules.some((r) => r.enabled) && tiers.length === 0 && (
            <p className="mt-2 text-[11px] text-text-3">
              提示：要在学生行逐人标记档位（如「不熟练」），需在「积分规则 → 课堂规则」里把该规则的
              计算方式设为「手动档位」；当前引用的规则均为自动累加，不会出现档位按钮。
            </p>
          )}
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
              // v30：档位态 = fail + 选中档位规则（独立第三态，只加档位分）
              const activeTier =
                isFail && rec.selectedRuleId
                  ? tiers.find((t) => t.id === rec.selectedRuleId) ?? null
                  : null
              // 名次只看本活动的记录，避免跨活动同名次串味
              const rank = isPass ? rankOf(records, rec.studentId) : 0
              const preview =
                rec.status === 'pending'
                  ? previewPassPoints(activity, rules, records, rec.studentId)
                  : 0

              return (
                <div
                  key={rec.id}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-lg border px-3 py-2',
                    isPass
                      ? 'border-done/30 bg-done/5 dark:bg-done/10'
                      : activeTier
                        ? 'border-amber-300/60 bg-amber-50 dark:border-amber-700/40 dark:bg-amber-950/20'
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

                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    {/* v30 三态按钮：过关 / 档位（不熟练） / 未过关 —— 恒定显示，当前态高亮 */}
                    {rec.status === 'pending' && preview > 0 && (
                      <span className="hidden text-[11px] text-text-3 sm:inline">
                        过关 +{preview}
                      </span>
                    )}
                    <Button
                      variant={isPass ? 'primary' : 'secondary'}
                      size="sm"
                      title={isPass ? '当前：过关' : '标记为过关'}
                      onClick={() => onStatus(activity, rec, 'pass')}
                    >
                      <CheckCircle2 size={13} /> 过关
                    </Button>
                    {tiers.map((t) => {
                      const active = activeTier?.id === t.id
                      return (
                        <Button
                          key={t.id}
                          variant={active ? 'primary' : 'secondary'}
                          size="sm"
                          title={
                            active
                              ? `当前：${t.name}（只加档位分）`
                              : `标记为「${t.name}」（介于过关与未过关，只加档位分 +${t.points}）`
                          }
                          onClick={() => onTier(activity, rec, t.id)}
                        >
                          <Sparkles size={13} /> {t.name} +{t.points}
                        </Button>
                      )
                    })}
                    <Button
                      variant={isFail && !activeTier ? 'primary' : 'secondary'}
                      size="sm"
                      title={isFail && !activeTier ? '当前：未过关' : '标记为未过关'}
                      onClick={() => onStatus(activity, rec, 'fail')}
                    >
                      <XCircle size={13} /> 未过关
                    </Button>

                    {/* 当前结果与积分 */}
                    {isPass && (
                      <span className="flex items-center gap-1 text-[12px] font-medium text-done">
                        +{rec.pointsAwarded} 分
                      </span>
                    )}
                    {activeTier && (
                      <span className="flex items-center gap-1 text-[12px] font-medium text-amber-600 dark:text-amber-400">
                        {activeTier.name} +{rec.pointsAwarded} 分
                      </span>
                    )}
                    {isFail && !activeTier && (
                      <span className="flex items-center gap-1 text-[12px] text-money-due">
                        未过关
                      </span>
                    )}
                    {rec.status !== 'pending' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        title="撤销（分与名次会重算）"
                        onClick={() => onStatus(activity, rec, 'pending')}
                      >
                        <RotateCcw size={13} />
                      </Button>
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
// 新建活动弹窗（v20：引用规则库，不再内嵌编辑规则）
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
  // v20：本活动引用的课堂规则（默认全选启用项）
  const [ruleIds, setRuleIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setTitle('')
    setNote('')
    setGroupId('')
    void defaultClassRuleIds().then(setRuleIds)
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
      // v29：手动新建也固化「当时选用的规则」快照，历史分值不随规则库后续编辑漂移
      const snapshot = await buildSnapshotForRuleIds(ruleIds)
      const activity = withSyncFields<ClassActivity>({
        title: title.trim(),
        courseId: null,
        groupId: groupId || null,
        activityDate: startOfDay(new Date()).getTime(),
        auto: false,
        sourceCourseId: null,
        // 新活动只引用规则库，不再内嵌可编辑规则
        ruleIds,
        rules: [],
        classRuleSnapshot: snapshot,
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
              selectedRuleId: null,
            }),
          ),
        )
      }
      onClose()
    } finally {
      setSaving(false)
    }
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

        <Field label="计分规则">
          <RulePicker scope="class" value={ruleIds} onChange={setRuleIds} />
          <p className="mt-1 text-[11px] text-text-3">
            规则统一在「积分规则 → 课堂规则」里维护，这里只做引用增减。
          </p>
        </Field>

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
