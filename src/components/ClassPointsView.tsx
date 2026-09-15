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
  isManualRule,
  manualIdsOf,
  rankOf,
  checkRankOf,
  resolveClassRules,
  ruleAppliesNow,
  setActivityRuleOutcome,
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
 *  - 学生行为以「规则按钮」呈现（v30.2「自动累加 + 手动覆盖」）：活动引用的每一条规则都出按钮。
 *      · 自动累加类（过关 / 未过关 / 第 N 名 / 前 N 名 / X~Y 名）：
 *        点选只标记该生的过关/未过关状态，得分由**全部自动规则按条件累加**
 *        （如「过关 +1」+「第一个额外 +1」→ 第一名共 +2）；
 *      · 覆盖类（手动档位 / 自定义加分条件）：点选后该生得分**只取这条规则的分值**，
 *        覆盖自动累加（适合「不熟练 +0.5」这类老师主观判定的档）。
 *    再点一次当前项 = 取消、回到待检查；也可用行末「撤销」。
 *  - 名次仅用于展示（按标记先后）。
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

  async function handleRule(
    activity: ClassActivity,
    record: ClassActivityRecord,
    ruleId: string | null,
  ) {
    // v29：活动级提交锁 —— 快速连点时丢弃后续调用，配合数据层「从库重读」根治并发名次错乱
    if (processingRef.current.has(activity.id)) return
    processingRef.current.add(activity.id)
    try {
      // v30.2：规则按钮 —— 自动累加类标记状态（按条件累加）；覆盖类只取该规则分值；null = 撤销
      await setActivityRuleOutcome(activity, record, ruleId, ruleMap.get(activity.id) ?? [])
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
            onRule={handleRule}
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
  onRule,
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
  onRule: (
    activity: ClassActivity,
    record: ClassActivityRecord,
    ruleId: string | null,
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
                      customText: r.customText,
                    })}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-[11px] text-text-3">
            每条规则都是学生行上的按钮，全部叠加计分：「过关 / 未过关 / 名次」类点选即按条件
            自动累加（过关+1 且第一个过关额外+1 → 第一名共 +2）；「手动档位 / 自定义加分条件」类
            点选后把该规则分值叠加上去（不覆盖自动分，可同时叠加多条，如「不熟练 +0.5」）。
            自动类命中会显示「✓」；手动类点亮即生效，再点取消。
          </p>
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
              // v30.3：该生手动「叠加」的规则（可多条）
              const manualIds = manualIdsOf(rec).filter((id) => rules.some((r) => r.id === id))
              const manualRules = manualIds
                .map((id) => rules.find((r) => r.id === id))
                .filter((r): r is ResolvedClassRule => Boolean(r))
              // 名次只看本活动的记录，避免跨活动同名次串味（按标记先后）
              const rank = isPass ? rankOf(records, rec.studentId) : 0
              // v30.7：检查名次（过关/未过关都算）供「第一个被检查」条件高亮
              const checkRank = checkRankOf(records, rec.studentId)
              const marked = rec.status !== 'pending' || manualRules.length > 0

              return (
                <div
                  key={rec.id}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-lg border px-3 py-2',
                    manualRules.length > 0
                      ? 'border-amber-300/60 bg-amber-50 dark:border-amber-700/40 dark:bg-amber-950/20'
                      : isPass
                        ? 'border-done/30 bg-surface-0'
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
                    {/* v30.3：活动引用的每一条规则都出按钮，全部叠加计分。
                        自动类 → 点选标记过关/未过关（得分按全部自动规则累加）；
                        手动类（手动档位/自定义条件）→ 点选把该规则分值叠加上去（可多条）。 */}
                    {rules.length === 0 ? (
                      <span className="text-[11px] text-text-3">该活动未引用任何规则</span>
                    ) : (
                      rules.map((r) => {
                        const isManual = isManualRule(r)
                        const selected = isManual && manualIds.includes(r.id)
                        const applied = !isManual && ruleAppliesNow(r, rank, rec.status, checkRank)
                        const title = isManual
                          ? selected
                            ? `已叠加：${r.name}（+${r.points} 分），再点取消叠加`
                            : `叠加「${r.name}」：在自动分之上再 +${r.points} 分`
                          : applied
                            ? `已生效：${r.name}（+${r.points} 分）；要取消请点行末「撤销」`
                            : `标记为「过关」：本规则按条件自动累加，命中时 +${r.points} 分`
                        return (
                          <Button
                            key={r.id}
                            variant={selected ? 'primary' : 'secondary'}
                            size="sm"
                            disabled={!r.enabled}
                            title={title}
                            className={cn(applied && 'border border-done/40 text-done')}
                            onClick={() => onRule(activity, rec, r.id)}
                          >
                            {applied ? '✓ ' : ''}
                            {r.name} +{r.points}
                          </Button>
                        )
                      })
                    )}
                    {marked && (
                      <span className="flex items-center gap-1 text-[12px] font-medium text-amber-600 dark:text-amber-400">
                        {manualRules.length > 0
                          ? `${manualRules.map((r) => r.name).join(' + ')}，`
                          : ''}
                        共 +{rec.pointsAwarded} 分
                      </span>
                    )}
                    {marked && (
                      <Button
                        variant="ghost"
                        size="sm"
                        title="撤销（回到待检查，分数冲销）"
                        onClick={() => onRule(activity, rec, null)}
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
