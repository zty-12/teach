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
  manualIdsOf,
  resolveClassRules,
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
import { RulePicker } from '@/components/RulePicker'

/**
 * 课堂积分视图（v30.8「纯手动按钮」模型）
 * ------------------------------------------------------------
 * 从独立页面合并进「打卡与积分」，作为「课堂积分」Tab。
 * 相对旧版的改动（v30.8）：
 *  - 计分规则全部集中在「积分规则 → 课堂规则」页维护，活动只通过 ruleIds 引用；
 *  - 每条规则就是学生行上的一枚按钮：**点选即加该规则分值、再点取消**，可同时选中多条叠加
 *    （如「熟练 +1」+「主动 +1」= +2）。**没有任何自动条件**（不再有过关 / 名次 / 档位自动求值）；
 *  - 计分只认「该生选中的规则 id 列表（manualRuleIds）」，规则分值之和即得分；
 *  - 行末「撤销」清空该生全部已选规则，回到 0 分；
 *  - 按班课排课时间，当天自动生成活动（沿用当前启用的课堂规则）。
 *  - 旧版「过关 / 名次」等自动计分已在 v30.8 迁移（db.ts v16）全部清零，之后完全由老师手动判定。
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
      // v30.8：纯手动按钮 —— ruleId 为规则 id 时在「已选」里增删（切换），null = 撤销清空
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
  const scored = records.filter((r) => (r.pointsAwarded || 0) > 0)
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
              {scored.length} 人已计分
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

      {/* 计分规则（来自规则库引用）：v30.8 纯手动按钮 */}
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
                >
                  <span>{r.name}</span>
                  <span className="text-amber-600 dark:text-amber-400">{r.points}分</span>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-[11px] text-text-3">
            每条规则都是学生行上的按钮：点一下即给该生加对应分值，再点取消；可同时选中多条规则叠加
            （如「熟练 +1」+「主动 +1」= +2）。完全由你按课堂表现手动判定，没有任何自动条件。
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
              // v30.8：该生选中的规则（可多条），即其得分来源
              const selectedIds = manualIdsOf(rec).filter((id) => rules.some((r) => r.id === id))
              const selectedRules = selectedIds
                .map((id) => rules.find((r) => r.id === id))
                .filter((r): r is ResolvedClassRule => Boolean(r))
              const marked = selectedIds.length > 0

              return (
                <div
                  key={rec.id}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-lg border px-3 py-2',
                    selectedIds.length > 0
                      ? 'border-amber-300/60 bg-amber-50 dark:border-amber-700/40 dark:bg-amber-950/20'
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
                    {/* v30.8：活动引用的每一条规则都出按钮，点选即加该规则分值（再点取消），可多条叠加 */}
                    {rules.length === 0 ? (
                      <span className="text-[11px] text-text-3">该活动未引用任何规则</span>
                    ) : (
                      rules.map((r) => {
                        const selected = selectedIds.includes(r.id)
                        const title = selected
                          ? `已选中：${r.name}（+${r.points} 分），再点取消`
                          : `给 ${student.name} 加「${r.name}」+${r.points} 分`
                        return (
                          <Button
                            key={r.id}
                            variant={selected ? 'primary' : 'secondary'}
                            size="sm"
                            disabled={!r.enabled}
                            title={title}
                            onClick={() => onRule(activity, rec, r.id)}
                          >
                            {r.name} +{r.points}
                          </Button>
                        )
                      })
                    )}
                    {marked && (
                      <span className="flex items-center gap-1 text-[12px] font-medium text-amber-600 dark:text-amber-400">
                        {selectedRules.length > 0
                          ? `${selectedRules.map((r) => r.name).join(' + ')}，`
                          : ''}
                        共 +{rec.pointsAwarded} 分
                      </span>
                    )}
                    {marked && (
                      <Button
                        variant="ghost"
                        size="sm"
                        title="撤销（清空该生全部已选规则，分数冲销）"
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
