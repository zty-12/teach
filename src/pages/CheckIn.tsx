import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useSearchParams } from 'react-router-dom'
import { format } from 'date-fns'
import { eachDayOfInterval, startOfDay } from 'date-fns'
import {
  Award,
  CalendarRange,
  CheckCircle2,
  Clock,
  Gift,
  Loader2,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react'
import { db, markDeleted, touch, withSyncFields } from '@/lib/db'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  SegmentedControl,
  Select,
  Textarea,
} from '@/components/ui'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/Avatar'
import {
  adjustPoints,
  createCheckInTask,
  defaultCheckInRuleIds,
  deleteCheckInTask,
  formatCadenceLabel,
  recomputeTaskPoints,
  resolveCheckInRules,
  updateCheckInTaskDays,
  type PointBalance,
  type ResolvedCheckInRule,
  updateCheckInRecord,
} from '@/lib/points'
import type {
  CheckInRecord,
  CheckInStatus,
  CheckInTask,
  Course,
  Group,
  GroupMember,
  PointRule,
  Redemption,
  RewardItem,
  Student,
} from '@/lib/types'

import { CHECKIN_STATUS_LABEL } from '@/lib/types'
import { useSettings } from '@/store/useSettings'
import { generateCheckInFeedback, isAiConfigured, LlmError } from '@/lib/llm'
import { getOrRefreshProfileForFeedback } from '@/lib/studentProfile'
import ClassPointsView from '@/components/ClassPointsView'
import RuleLibraryView from '@/components/RuleLibraryView'
import { RuleChips, RulePicker } from '@/components/RulePicker'

type MainTab = 'tasks' | 'class' | 'rules' | 'market'

export default function CheckInPage() {
  // 支持 /checkin?tab=class 直接落到指定 Tab（课堂积分旧入口重定向用）
  const [searchParams] = useSearchParams()
  const [tab, setTab] = useState<MainTab>(() => {
    const t = searchParams.get('tab')
    return t === 'class' || t === 'rules' || t === 'market' ? (t as MainTab) : 'tasks'
  })

  const tasks = useLiveQuery(() => db.checkInTasks.toArray(), [])
  const records = useLiveQuery(() => db.checkInRecords.toArray(), [])
  const students = useLiveQuery(() => db.students.toArray(), [])
  const groups = useLiveQuery(() => db.groups.toArray(), [])
  const groupMembers = useLiveQuery(() => db.groupMembers.toArray(), [])
  const courses = useLiveQuery(() => db.courses.toArray(), [])
  const rules = useLiveQuery(() => db.pointRules.toArray(), [])
  const rewardItems = useLiveQuery(() => db.rewardItems.toArray(), [])
  const redemptions = useLiveQuery(() => db.redemptions.toArray(), [])
  const ledgers = useLiveQuery(() => db.pointLedgers.toArray(), [])
  const classActivities = useLiveQuery(() => db.classActivities.toArray(), [])

  const liveTasks = (tasks ?? []).filter((t) => !t.deletedAt)
  const liveRecords = (records ?? []).filter((r) => !r.deletedAt)
  const liveStudents = (students ?? []).filter((s) => !s.deletedAt && s.status !== 'archived')
  const sMap = new Map(liveStudents.map((s) => [s.id, s]))
  const gMap = new Map((groups ?? []).filter((g) => !g.deletedAt).map((g) => [g.id, g]))
  const cMap = new Map((courses ?? []).filter((c) => !c.deletedAt).map((c) => [c.id, c]))
  const liveRules = (rules ?? []).filter((r) => !r.deletedAt).sort((a, b) => a.order - b.order)
  const liveRewards = (rewardItems ?? []).filter((r) => !r.deletedAt)
  const liveRedemptions = (redemptions ?? []).filter((r) => !r.deletedAt)
  const liveClassCount = (classActivities ?? []).filter((a) => !a.deletedAt).length

  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)

  return (
    <div>
      <PageHeader
        title="打卡与积分"
        subtitle={`任务 ${liveTasks.length} · 课堂 ${liveClassCount} · 规则 ${liveRules.length} · 奖励 ${liveRewards.length}`}
      />

      <div className="mb-4">
        <SegmentedControl
          value={tab}
          onChange={(v) => setTab(v as MainTab)}
          layout="grid"
          options={[
            { value: 'tasks', label: '打卡任务' },
            { value: 'class', label: '课堂积分' },
            { value: 'rules', label: '积分规则' },
            { value: 'market', label: '兑换商城' },
          ]}
        />
      </div>

      {tab === 'tasks' && (
        <TasksView
          tasks={liveTasks}
          records={liveRecords}
          studentMap={sMap}
          courseMap={cMap}
          activeTaskId={activeTaskId}
          setActiveTaskId={setActiveTaskId}
          groups={Array.from(gMap.values())}
          groupMembers={(groupMembers ?? []).filter((m) => !m.deletedAt)}
          courses={Array.from(cMap.values())}
          students={liveStudents}
          rules={liveRules}
        />
      )}
      {tab === 'class' && <ClassPointsView />}
      {tab === 'rules' && <RuleLibraryView />}
      {tab === 'market' && (
        <MarketView
          rewardItems={liveRewards}
          redemptions={liveRedemptions}
          studentMap={sMap}
          ledgers={(ledgers ?? []).filter((l) => !l.deletedAt)}
        />
      )}
    </div>
  )
}

// ============================================================
// 任务视图
// ============================================================

function TasksView({
  tasks,
  records,
  studentMap,
  courseMap,
  activeTaskId,
  setActiveTaskId,
  groups,
  groupMembers,
  courses,
  students,
  rules,
}: {
  tasks: CheckInTask[]
  records: CheckInRecord[]
  studentMap: Map<string, Student>
  courseMap: Map<string, Course>
  activeTaskId: string | null
  setActiveTaskId: (v: string | null) => void
  groups: Group[]
  groupMembers: GroupMember[]
  courses: Course[]
  students: Student[]
  rules: PointRule[]
}) {
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [editTask, setEditTask] = useState<CheckInTask | null>(null)

  const activeTask = activeTaskId ? tasks.find((t) => t.id === activeTaskId) ?? null : null
  const recordsOfActive = activeTask
    ? records
        .filter((r) => r.taskId === activeTask.id)
        .sort((a, b) => a.createdAt - b.createdAt)
    : []

  /** 任务引用的规则；未指定时按「全部启用的打卡规则」 */
  function rulesOfTask(t: CheckInTask): PointRule[] {
    const ids = t.ruleIds
    if (ids && ids.length > 0) {
      const map = new Map(rules.map((r) => [r.id, r]))
      return ids.map((id) => map.get(id)).filter((r): r is PointRule => Boolean(r))
    }
    return rules
      .filter((r) => (r.scope ?? 'checkin') === 'checkin')
      .sort((a, b) => a.order - b.order)
  }

  /** 当前任务里的「手动档位」规则 */
  function tierRulesOfTask(t: CheckInTask): ResolvedCheckInRule[] {
    return resolveCheckInRules(t, rules).filter((r) => r.mode === 'tier' && r.enabled)
  }

  async function handleDeleteTask(t: CheckInTask) {
    if (!confirm(`删除打卡任务「${t.title}」？会同时清除其记录与积分流水。`)) return
    await deleteCheckInTask(t.id)
    setActiveTaskId(null)
  }

  return (
    <>
      <Card className="mb-4">
        <CardHeader
          title="打卡任务"
          subtitle={`${tasks.length} 个批次`}
          action={
            <Button variant="primary" size="sm" onClick={() => setNewTaskOpen(true)}>
              <Plus size={13} /> 新建打卡任务
            </Button>
          }
        />
        {tasks.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 size={22} />}
            title="还没有打卡任务"
            description="点击「新建打卡任务」为课后安排打卡"
          />
        ) : (
          <ul className="divide-y divide-line-1">
            {tasks
              .slice()
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((t) => {
                const taskRecs = records.filter((r) => r.taskId === t.id)
                const done = taskRecs.filter((r) => r.status === 'done').length
                const total = taskRecs.length
                const c = t.courseId ? courseMap.get(t.courseId) : null
                const active = t.id === activeTaskId
                return (
                  <li
                    key={t.id}
                    onClick={() => setActiveTaskId(t.id === activeTaskId ? null : t.id)}
                    className={cn(
                      'group cursor-pointer px-4 py-3 transition-colors',
                      active ? 'bg-accent-soft' : 'hover:bg-surface-1',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-text-1">{t.title}</span>
                          {c && (
                            <Badge variant="primary">{c.subject}</Badge>
                          )}
                          {t.days && t.days.length > 1 && (
                            <Badge>
                              <CalendarRange size={11} /> {t.days.length} 天
                            </Badge>
                          )}
                          {t.dueAt && t.days.length <= 1 && (
                            <Badge variant="warning">
                              <Clock size={11} /> {format(t.dueAt, 'M月d日 HH:mm')}
                            </Badge>
                          )}
                          <Badge>
                            {t.scope === 'group'
                              ? '指定班课'
                              : t.scope === 'course'
                                ? '指定课程'
                                : '全体在读'}
                          </Badge>
                        </div>
                        <p className="mt-0.5 text-[12px] text-text-3">
                          {t.cadenceLabel || format(t.createdAt, 'yyyy-MM-dd HH:mm')}
                          {total > 0 && ` · ${done}/${total} 次已打卡`}
                          {c && ` · 关联：${c.subject}`}
                          {` · ${rulesOfTask(t).length} 条规则`}
                        </p>
                        <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
                          <RuleChips
                            rules={rulesOfTask(t)}
                            emptyText="未引用规则（按全部启用的打卡规则计分）"
                          />
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditTask(t)
                          }}
                          className="hidden h-7 w-7 items-center justify-center rounded-md text-text-3 hover:bg-accent-soft hover:text-accent group-hover:flex"
                          title="编辑任务 / 打卡日期"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            void handleDeleteTask(t)
                          }}
                          className="hidden h-7 w-7 items-center justify-center rounded-md text-text-3 hover:bg-money-out/10 hover:text-money-out group-hover:flex"
                          title="删除任务"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  </li>
                )
              })}
          </ul>
        )}
      </Card>

      {activeTask && (
        <Card>
          <CardHeader
            title={`「${activeTask.title}」打卡记录`}
            subtitle={`${recordsOfActive.filter((r) => r.status === 'done').length} / ${recordsOfActive.length} 次已完成`}
            action={
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void recomputeTaskPoints(activeTask.id)}
                  title="按当前规则重算一次积分"
                >
                  <Sparkles size={13} /> 重算积分
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setActiveTaskId(null)}>
                  关闭
                </Button>
              </div>
            }
          />
          {recordsOfActive.length === 0 ? (
            <EmptyState title="此批次暂无记录" description="通常是创建任务时自动生成的成员记录" />
          ) : activeTask.days && activeTask.days.length > 1 ? (
            <CheckInMatrix
              task={activeTask}
              records={recordsOfActive}
              studentMap={studentMap}
              tierRules={tierRulesOfTask(activeTask)}
            />
          ) : (
            <ul className="divide-y divide-line-1">
              {recordsOfActive.map((r) => (
                <CheckInRow
                  key={r.id}
                  record={r}
                  student={studentMap.get(r.studentId)}
                  tierRules={tierRulesOfTask(activeTask)}
                  onUpdate={(patch) => void updateCheckInRecord(r, patch)}
                />
              ))}
            </ul>
          )}
        </Card>
      )}

      <NewCheckInTaskModal
        open={newTaskOpen}
        onClose={() => setNewTaskOpen(false)}
        groups={groups}
        groupMembers={groupMembers}
        courses={courses}
        students={students}
      />

      <EditCheckInTaskModal task={editTask} onClose={() => setEditTask(null)} />
    </>
  )
}

/** 编辑打卡任务：标题 / 备注 / 打卡日期（增删日期自动同步学生记录） */
function EditCheckInTaskModal({
  task,
  onClose,
}: {
  task: CheckInTask | null
  onClose: () => void
}) {
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [days, setDays] = useState<number[]>([])
  const [addDate, setAddDate] = useState('')
  const [rangeFrom, setRangeFrom] = useState('')
  const [rangeTo, setRangeTo] = useState('')
  // v20：本任务适用的打卡规则
  const [ruleIds, setRuleIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!task) return
    setTitle(task.title)
    setNote(task.note)
    setDays([...(task.days ?? [])].sort((a, b) => a - b))
    setAddDate('')
    setRangeFrom('')
    setRangeTo('')
    const ids = task.ruleIds
    if (ids && ids.length > 0) {
      setRuleIds(ids)
    } else {
      // 旧任务未指定 → 默认全选启用中的打卡规则（行为与旧版一致）
      void defaultCheckInRuleIds().then(setRuleIds)
    }
  }, [task])

  function removeDay(d: number) {
    setDays((prev) => prev.filter((x) => x !== d))
  }

  function addSingle() {
    if (!addDate) return
    const t = startOfDay(new Date(`${addDate}T00:00:00`)).getTime()
    if (Number.isNaN(t)) return
    setDays((prev) => (prev.includes(t) ? prev : [...prev, t].sort((a, b) => a - b)))
    setAddDate('')
  }

  function addRange() {
    if (!rangeFrom || !rangeTo) return
    const a = new Date(`${rangeFrom}T00:00:00`)
    const b = new Date(`${rangeTo}T00:00:00`)
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) return
    const list = eachDayOfInterval({ start: a, end: b }).map((d) => startOfDay(d).getTime())
    setDays((prev) => Array.from(new Set([...prev, ...list])).sort((x, y) => x - y))
    setRangeFrom('')
    setRangeTo('')
  }

  async function handleSave() {
    if (!task || days.length === 0) return
    setSaving(true)
    try {
      await updateCheckInTaskDays(task, days, { title, note, ruleIds })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']
  const label = (d: number) => {
    const dt = new Date(d)
    return `${format(dt, 'M月d日')} 周${WEEKDAY[dt.getDay()]}`
  }

  return (
    <Modal
      open={!!task}
      onClose={onClose}
      title="编辑打卡任务"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={days.length === 0 || saving}
            onClick={() => void handleSave()}
          >
            {saving ? '保存中…' : `保存（${days.length} 天）`}
          </Button>
        </>
      }
    >
      {task && (
        <div className="space-y-3">
          <Field label="任务标题">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="打卡日期">
            {days.length > 0 ? (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {days.map((d) => (
                  <span
                    key={d}
                    className="inline-flex items-center gap-1 rounded-md bg-accent-soft px-2 py-0.5 text-[12px] text-accent-text"
                  >
                    {label(d)}
                    <button
                      type="button"
                      onClick={() => removeDay(d)}
                      className="text-accent-text/60 hover:text-money-out"
                      title="移除该天"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="mb-2 text-[12px] text-money-out">至少保留 1 个打卡日期</p>
            )}
            <div className="flex items-center gap-2">
              <Input type="date" value={addDate} onChange={(e) => setAddDate(e.target.value)} />
              <Button size="sm" onClick={addSingle} disabled={!addDate}>
                添加日期
              </Button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Input
                type="date"
                value={rangeFrom}
                onChange={(e) => setRangeFrom(e.target.value)}
              />
              <span className="shrink-0 text-[12px] text-text-3">至</span>
              <Input type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} />
              <Button size="sm" onClick={addRange} disabled={!rangeFrom || !rangeTo}>
                添加区间
              </Button>
            </div>
            <p className="mt-1 text-[11px] text-text-3">
              当前节奏：{formatCadenceLabel(days)}。移除日期会同时删除该天的打卡记录，新增日期会为参与学生补上待打卡记录。
            </p>
          </Field>
          <Field label="适用规则">
            <RulePicker scope="checkin" value={ruleIds} onChange={setRuleIds} />
            <p className="mt-1 text-[11px] text-text-3">
              规则统一在「积分规则 → 打卡规则」里维护，这里只做引用增减。
            </p>
          </Field>
          <Field label="备注">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </Field>
        </div>
      )}
    </Modal>
  )
}

function CheckInRow({
  record,
  student,
  tierRules,
  onUpdate,
}: {
  record: CheckInRecord
  student: Student | undefined
  /** 该任务里的手动档位规则（为空则不显示档位选择） */
  tierRules: ResolvedCheckInRule[]
  onUpdate: (patch: {
    status?: CheckInStatus
    note?: string
    selectedRuleId?: string | null
  }) => void
}) {
  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <Avatar name={student?.name ?? '?'} colorSlot={student?.colorSlot ?? 0} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-text-1">
              {student?.name ?? '已删学生'}
            </span>
            <Badge
              variant={
                record.status === 'done'
                  ? 'success'
                  : record.status === 'missed'
                    ? 'danger'
                    : 'neutral'
              }
            >
              {CHECKIN_STATUS_LABEL[record.status]}
            </Badge>
            {record.checkedAt && (
              <span className="text-[11px] text-text-3">
                {format(record.checkedAt, 'M-d HH:mm')}
              </span>
            )}
          </div>
          <input
            value={record.note}
            onChange={(e) => onUpdate({ note: e.target.value })}
            placeholder="备注打卡内容（可空）"
            className="mt-1.5 w-full rounded-md border border-line-1 bg-surface-0 px-2 py-1 text-[13px] text-text-1 placeholder:text-text-3 focus:border-accent focus:outline-none"
          />
          {tierRules.length > 0 && record.status === 'done' && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-text-3">计分档位</span>
              <Select
                value={record.selectedRuleId ?? ''}
                onChange={(e) => onUpdate({ selectedRuleId: e.target.value || null })}
                className="w-48"
              >
                <option value="">不选（仅按自动规则）</option>
                {tierRules.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} {r.points > 0 ? '+' : ''}
                    {r.points}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            size="sm"
            variant={record.status === 'done' ? 'primary' : 'secondary'}
            onClick={() => onUpdate({ status: 'done' })}
          >
            <CheckCircle2 size={13} /> 完成
          </Button>
          <Button
            size="sm"
            variant={record.status === 'missed' ? 'danger' : 'ghost'}
            onClick={() => onUpdate({ status: 'missed' })}
          >
            <XCircle size={13} /> 未通过
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onUpdate({ status: 'pending' })}
          >
            重置
          </Button>
        </div>
      </div>
    </li>
  )
}

// ============================================================
// 周期/自定义打卡：学生 × 天数 矩阵
// 每个格子点击循环 未打卡 → 已打卡 → 未通过 → 未打卡，天然支持补卡
// 行尾的备注按钮打开抽屉，编辑该学生每天的备注（打卡视频问题等）
// ============================================================
const STATUS_CYCLE: CheckInStatus[] = ['pending', 'done', 'missed']

function CheckInMatrix({
  task,
  records,
  studentMap,
  tierRules,
}: {
  task: CheckInTask
  records: CheckInRecord[]
  studentMap: Map<string, Student>
  /** 该任务里的手动档位规则（为空则不显示档位选择） */
  tierRules: ResolvedCheckInRule[]
}) {
  const days = useMemo(
    () => Array.from(new Set((task.days ?? []).map((d) => startOfDay(d).getTime())))
      .sort((a, b) => a - b),
    [task.days],
  )

  // studentId -> (day -> record)；day 用零点时间戳作为 key
  const byStudent = useMemo(() => {
    const idx = new Map<string, Map<number, CheckInRecord>>()
    for (const r of records) {
      const day = r.dayAt == null ? -1 : startOfDay(r.dayAt).getTime()
      if (!idx.has(r.studentId)) idx.set(r.studentId, new Map())
      idx.get(r.studentId)!.set(day, r)
    }
    return idx
  }, [records])

  const studentsOf = useMemo(() => {
    const ids = Array.from(byStudent.keys()).sort((a, b) =>
      (studentMap.get(a)?.name ?? '').localeCompare(studentMap.get(b)?.name ?? ''),
    )
    return ids
  }, [byStudent, studentMap])

  function next(status: CheckInStatus): CheckInStatus {
    const i = STATUS_CYCLE.indexOf(status)
    return STATUS_CYCLE[(i + 1) % STATUS_CYCLE.length]!
  }

  const [noteFor, setNoteFor] = useState<{
    studentId: string
    studentName: string
  } | null>(null)

  const [quickNote, setQuickNote] = useState<{
    studentId: string
    studentName: string
    day: number
    recordId: string
    existingNote: string
    existingAiFeedback: string
  } | null>(null)

  function noteCountOf(sid: string): number {
    const map = byStudent.get(sid)
    if (!map) return 0
    let n = 0
    for (const d of days) {
      const r = map.get(d)
      if (r && r.note && r.note.trim()) n += 1
    }
    return n
  }

  return (
    <div className="max-h-[60vh] overflow-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 border-b border-line-1 bg-surface-1 px-2 py-2 text-left font-medium text-text-2">
              学生
            </th>
            {days.map((d) => (
              <th
                key={d}
                className="border-b border-line-1 px-1.5 py-2 text-center font-medium text-text-2"
              >
                <div>{format(d, 'M/d')}</div>
                <div className="text-[10px] font-normal text-text-3">
                  {format(d, 'EEE')}
                </div>
              </th>
            ))}
            <th className="border-b border-line-1 px-2 py-2 text-center font-medium text-text-2">
              完成率
            </th>
            <th className="sticky right-0 z-10 border-b border-line-1 bg-surface-1 px-2 py-2 text-center font-medium text-text-2">
              备注
            </th>
          </tr>
        </thead>
        <tbody>
          {studentsOf.map((sid) => {
            const recByDay = byStudent.get(sid)!
            const dones = days.filter((d) => recByDay.get(d)?.status === 'done').length
            const notesCount = noteCountOf(sid)
            return (
              <tr key={sid} className="border-b border-line-1 last:border-0">
                <td className="sticky left-0 z-10 bg-surface-0 px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <Avatar
                      name={studentMap.get(sid)?.name ?? '?'}
                      colorSlot={studentMap.get(sid)?.colorSlot ?? 0}
                      size="sm"
                    />
                    <span className="truncate font-medium text-text-1">
                      {studentMap.get(sid)?.name ?? '已删学生'}
                    </span>
                  </div>
                </td>
                {days.map((d) => {
                  const rec = recByDay.get(d)
                  const status: CheckInStatus = rec?.status ?? 'pending'
                  const noteText = rec?.note ?? ''
                  return (
                    <td key={d} className="px-1.5 py-1.5 text-center">
                      {rec ? (
                        <div className="flex flex-col items-center gap-1">
                          <button
                            type="button"
                            title={
                              noteText
                                ? `${CHECKIN_STATUS_LABEL[status]} · ${noteText}`
                                : CHECKIN_STATUS_LABEL[status]
                            }
                            onClick={() => {
                              const nextStatus = next(status)
                              void updateCheckInRecord(rec, { status: nextStatus })
                              if (nextStatus === 'done') {
                                setQuickNote({
                                  studentId: sid,
                                  studentName: studentMap.get(sid)?.name ?? '已删学生',
                                  day: d,
                                  recordId: rec.id,
                                  existingNote: rec.note ?? '',
                                  existingAiFeedback: rec.aiFeedback ?? '',
                                })
                              }
                            }}
                            className={cn(
                              'relative mx-auto flex h-6 w-6 items-center justify-center rounded-md border transition-colors',
                              status === 'done' &&
                                'border-done bg-done-soft text-done',
                              status === 'missed' &&
                                'border-leave bg-leave-soft text-leave',
                              status === 'pending' &&
                                'border-line-1 text-text-3 hover:border-accent',
                            )}
                          >
                            {status === 'done' ? (
                              <CheckCircle2 size={13} />
                            ) : status === 'missed' ? (
                              <XCircle size={13} />
                            ) : (
                              <span className="text-[10px]">—</span>
                            )}
                            {noteText.trim() && (
                              <span
                                aria-label="有备注"
                                className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-accent ring-1 ring-white"
                              />
                            )}
                          </button>
                          {tierRules.length > 0 && status === 'done' && (
                            <select
                              value={rec.selectedRuleId ?? ''}
                              onChange={(e) =>
                                void updateCheckInRecord(rec, {
                                  selectedRuleId: e.target.value || null,
                                })
                              }
                              title="计分档位"
                              className="w-[72px] rounded border border-line-1 bg-surface-0 px-0.5 py-0.5 text-[10px] text-text-2"
                            >
                              <option value="">档位</option>
                              {tierRules.map((r) => (
                                <option key={r.id} value={r.id}>
                                  {r.name}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      ) : (
                        <span className="text-text-3">·</span>
                      )}
                    </td>
                  )
                })}
                <td className="px-2 py-1.5 text-center text-[11px] text-text-2">
                  {dones}/{days.length}
                </td>
                <td className="sticky right-0 z-10 bg-surface-0 px-2 py-1.5 text-center">
                  <button
                    type="button"
                    onClick={() =>
                      setNoteFor({
                        studentId: sid,
                        studentName: studentMap.get(sid)?.name ?? '已删学生',
                      })
                    }
                    title={
                      notesCount > 0
                        ? `已备注 ${notesCount} 天`
                        : '添加每日备注'
                    }
                    className={cn(
                      'inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-[11px] transition-colors',
                      notesCount > 0
                        ? 'border-accent bg-accent-soft text-accent-text'
                        : 'border-line-1 text-text-3 hover:border-accent hover:text-accent',
                    )}
                  >
                    <Sparkles size={11} />
                    {notesCount > 0 ? `${notesCount} 条` : '备注'}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="px-3 py-2 text-[11px] text-text-3">
        点击格子切换状态：未打卡 → 已打卡 → 未通过。任意一天均可补卡并自动更新积分。
        点「备注」可记录当天打卡视频暴露的问题（按天保存）。
      </p>
      {noteFor && (
        <DayNoteDrawer
          studentId={noteFor.studentId}
          studentName={noteFor.studentName}
          days={days}
          byStudent={byStudent}
          onClose={() => setNoteFor(null)}
        />
      )}
      {quickNote && (
        <QuickNoteModal
          studentId={quickNote.studentId}
          studentName={quickNote.studentName}
          day={quickNote.day}
          existingNote={quickNote.existingNote}
          existingAiFeedback={quickNote.existingAiFeedback}
          onSave={(note, aiFeedback) => {
            void db.checkInRecords.put({
              ...byStudent.get(quickNote.studentId)!.get(quickNote.day)!,
              note,
              aiFeedback,
              updatedAt: Date.now(),
              dirty: 1,
            })
            setQuickNote(null)
          }}
          onClose={() => setQuickNote(null)}
        />
      )}
    </div>
  )
}

/**
 * 每日备注抽屉：列出当前学生在该任务所有打卡日的备注，可逐条编辑。
 * 失焦/回车自动保存到 CheckInRecord.note（updateCheckInRecord 内部会幂等重算积分）。
 */
function DayNoteDrawer({
  studentId,
  studentName,
  days,
  byStudent,
  onClose,
}: {
  studentId: string
  studentName: string
  days: number[]
  byStudent: Map<string, Map<number, CheckInRecord>>
  onClose: () => void
}) {
  const recByDay = byStudent.get(studentId) ?? new Map<number, CheckInRecord>()
  return (
    <Modal
      open
      onClose={onClose}
      title={`${studentName} · 每日备注`}
      footer={<Button onClick={onClose}>完成</Button>}
    >
      <p className="mb-3 text-[12px] text-text-3">
        每行 = 一天。失焦或按 Ctrl+Enter 自动保存。常用于记录当天打卡视频暴露的问题。
      </p>
      <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
        {days.map((d) => {
          const rec = recByDay.get(d)
          return (
            <div
              key={d}
              className="rounded-lg border border-line-1 bg-surface-0 p-2.5"
            >
              <div className="mb-1.5 flex items-center justify-between text-[12px]">
                <span className="font-medium text-text-1">
                  {format(d, 'M月d日')}
                  <span className="ml-1.5 text-text-3">周{format(d, 'EEEEE')}</span>
                </span>
                {rec && (
                  <Badge
                    variant={
                      rec.status === 'done'
                        ? 'success'
                        : rec.status === 'missed'
                          ? 'danger'
                          : 'neutral'
                    }
                  >
                    {CHECKIN_STATUS_LABEL[rec.status]}
                  </Badge>
                )}
              </div>
              <textarea
                defaultValue={rec?.note ?? ''}
                disabled={!rec}
                placeholder={
                  rec
                    ? '如：朗读流利度不错，但「er」音节还不太稳；建议家长示范 3 次跟读。'
                    : '该日未生成打卡记录'
                }
                rows={2}
                onBlur={(e) => {
                  if (!rec) return
                  const next = e.target.value
                  if (next === rec.note) return
                  void updateCheckInRecord(rec, { note: next })
                }}
                onKeyDown={(e) => {
                  if (!rec) return
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault()
                    ;(e.target as HTMLTextAreaElement).blur()
                  }
                }}
                className="w-full resize-none rounded-md border border-line-1 bg-surface-0 px-2 py-1.5 text-[13px] text-text-1 placeholder:text-text-3 focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
          )
        })}
      </div>
    </Modal>
  )
}

/**
 * 快速备注弹窗：完成打卡后自动弹出，针对单日记录。
 * 内容可同步作为学习报告的数据源（写入 CheckInRecord.note）。
 * 支持 AI 根据备注生成面向家长的反馈（写入 CheckInRecord.aiFeedback）。
 * 生成时自动读取该学生的历史画像（若画像 <24h 则复用，否则刷新），
 * 让每次反馈都针对该学生个性化，而不是每次都一模一样。
 */
function QuickNoteModal({
  studentId,
  studentName,
  day,
  existingNote,
  existingAiFeedback,
  onSave,
  onClose,
}: {
  studentId: string
  studentName: string
  day: number
  existingNote: string
  existingAiFeedback: string
  onSave: (note: string, aiFeedback: string) => void
  onClose: () => void
}) {
  const settings = useSettings((s) => s.settings)
  const [text, setText] = useState(existingNote)
  const [aiFeedback, setAiFeedback] = useState(existingAiFeedback)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [copied, setCopied] = useState(false)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileSnapshot, setProfileSnapshot] = useState<
    { summary: string; strengths: string; weaknesses: string; teachingStyle: string; profileUpdatedAt: number; sourceCount: number } | null
  >(null)

  const aiReady = isAiConfigured(settings) && text.trim().length >= 5

  // 弹窗打开时静默加载该学生画像（不阻塞 UI，只是让 AI 生成时更有针对性）
  useEffect(() => {
    if (!studentId || !isAiConfigured(settings)) return
    let cancelled = false
    setProfileLoading(true)
    void getOrRefreshProfileForFeedback(settings, studentId, studentName)
      .then((p) => {
        if (!cancelled) setProfileSnapshot(p ?? null)
      })
      .catch(() => {
        /* 画像加载失败不影响主流程 */
      })
      .finally(() => {
        if (!cancelled) setProfileLoading(false)
      })
    return () => {
      cancelled = true
    }
    // 只依赖学生标识 + AI 配置；避免 settings 引用变化导致重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId, studentName])

  async function handleGenerateFeedback() {
    if (!text.trim() || aiLoading) return
    setAiLoading(true)
    setAiError('')
    try {
      // 若之前预加载失败，再补一次尝试（同步阻塞，确保本次反馈用到画像）
      const snapshot =
        profileSnapshot ??
        (await getOrRefreshProfileForFeedback(settings, studentId, studentName).catch(() => undefined))
      if (snapshot) setProfileSnapshot(snapshot)
      const fb = await generateCheckInFeedback(settings, text, studentName, snapshot)
      setAiFeedback(fb)
    } catch (e) {
      setAiError(e instanceof LlmError ? e.message : `AI 生成失败：${String(e)}`)
    } finally {
      setAiLoading(false)
    }
  }

  function handleSave() {
    onSave(text.trim(), aiFeedback.trim())
  }

  async function handleCopy() {
    if (!aiFeedback) return
    try {
      await navigator.clipboard.writeText(aiFeedback)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* 忽略剪贴板失败 */
    }
  }

  const profileBadge = profileLoading
    ? '画像加载中…'
    : profileSnapshot
      ? `已结合画像 · ${profileSnapshot.sourceCount} 条历史`
      : '无历史画像（本次反馈基于当前记录）'

  return (
    <Modal
      open
      onClose={onClose}
      title={`${studentName} · ${format(day, 'M月d日')} 打卡备注`}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>跳过</Button>
          <Button variant="primary" onClick={handleSave}>
            保存备注
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[13px] text-text-2">
          记录本次打卡视频暴露的问题或表现亮点。此备注可作为后续
          <strong> 学习报告 </strong>的数据源。
        </p>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          autoFocus
          placeholder="如：朗读流利度不错，但「er」音节还不太稳；建议家长示范 3 次跟读。"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault()
              handleSave()
            }
          }}
        />
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-text-3">Ctrl+Enter 快速保存</p>
          {isAiConfigured(settings) && (
            <Button
              variant="secondary"
              size="sm"
              disabled={!aiReady || aiLoading}
              title={
                !aiReady && text.trim().length < 5
                  ? '先输入备注（至少 5 个字），再生成家长反馈'
                  : undefined
              }
              onClick={() => void handleGenerateFeedback()}
            >
              {aiLoading ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Sparkles size={13} />
              )}
              {aiLoading ? '生成中…' : 'AI 生成家长反馈'}
            </Button>
          )}
        </div>
        {aiError && <p className="text-[12px] text-leave">{aiError}</p>}
        {isAiConfigured(settings) && (
          <div className="flex items-center gap-2 text-[11px] text-text-3">
            <Sparkles size={11} className="shrink-0" />
            <span>{profileBadge}</span>
          </div>
        )}
        {aiFeedback && (
          <div className="rounded-lg border border-line-1 bg-surface-1 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[12px] font-medium text-text-2">
                家长反馈（可编辑后复制）
              </span>
              <Button size="sm" variant="ghost" onClick={() => void handleCopy()}>
                {copied ? '已复制' : '复制'}
              </Button>
            </div>
            <Textarea
              value={aiFeedback}
              onChange={(e) => setAiFeedback(e.target.value)}
              rows={4}
              className="text-[13px]"
            />
          </div>
        )}
      </div>
    </Modal>
  )
}

function NewCheckInTaskModal({
  open,
  onClose,
  groups,
  groupMembers,
  courses,
  students,
}: {
  open: boolean
  onClose: () => void
  groups: Group[]
  groupMembers: GroupMember[]
  courses: Course[]
  students: Student[]
}) {
  const [title, setTitle] = useState('')
  const [scope, setScope] = useState<'course' | 'group' | 'all'>('all')
  const [courseId, setCourseId] = useState('')
  const [groupId, setGroupId] = useState('')
  const [kind, setKind] = useState<'single' | 'periodic' | 'custom'>('single')
  // 单次：截止时间
  const [dueAtEnabled, setDueAtEnabled] = useState(false)
  const [dueAtText, setDueAtText] = useState('')
  // 周期/自定义：区间
  const [fromText, setFromText] = useState('')
  const [toText, setToText] = useState('')
  // 自定义：选中的天（yyyy-MM-dd）
  const [selectedDays, setSelectedDays] = useState<Set<string>>(new Set())
  const [note, setNote] = useState('')
  // v20：本任务适用的打卡规则（默认全选启用项）
  const [ruleIds, setRuleIds] = useState<string[]>([])

  useMemo(() => {
    if (!open) return
    setTitle('')
    setScope('all')
    setCourseId('')
    setGroupId('')
    setKind('single')
    setDueAtEnabled(false)
    setDueAtText('')
    setFromText('')
    setToText('')
    setSelectedDays(new Set())
    setNote('')
  }, [open])

  useEffect(() => {
    if (!open) return
    void defaultCheckInRuleIds().then(setRuleIds)
  }, [open])

  const rangeDays: Date[] = useMemo(() => {
    if (kind === 'single' || !fromText || !toText) return []
    const a = new Date(`${fromText}T00:00:00`)
    const b = new Date(`${toText}T00:00:00`)
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return []
    if (b.getTime() < a.getTime()) return []
    return eachDayOfInterval({ start: a, end: b })
  }, [kind, fromText, toText])

  function toggleDay(s: string) {
    setSelectedDays((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }

  async function handleSave() {
    // 解析目标学生
    let memberIds: string[] = []
    if (scope === 'group' && groupId) {
      memberIds = groupMembers
        .filter((m) => m.groupId === groupId && !m.deletedAt)
        .map((m) => m.studentId)
    } else if (scope === 'course' && courseId) {
      const c = courses.find((x) => x.id === courseId)
      if (c?.groupId) {
        memberIds = groupMembers
          .filter((m) => m.groupId === c.groupId && !m.deletedAt)
          .map((m) => m.studentId)
      } else if (c?.studentId) {
        memberIds = [c.studentId]
      }
    }

    // 解析打卡日（零点时间戳）
    let days: number[] = []
    if (kind === 'single') {
      if (dueAtEnabled && dueAtText) {
        days = [startOfDay(new Date(dueAtText)).getTime()]
      }
    } else if (kind === 'periodic') {
      days = rangeDays.map((d) => startOfDay(d).getTime())
    } else if (kind === 'custom') {
      days = rangeDays
        .filter((d) => selectedDays.has(format(d, 'yyyy-MM-dd')))
        .map((d) => startOfDay(d).getTime())
    }

    const cadenceLabel =
      kind === 'single'
        ? '单次打卡'
        : kind === 'periodic'
          ? `每天打卡 · ${rangeDays.length} 天`
          : `自定义 · ${days.length} 天`
    const taskCourseId =
      scope === 'course' && courseId
        ? courseId
        : scope === 'group' && groupId
          ? null
          : null
    const taskGroupId = scope === 'group' && groupId ? groupId : null

    await createCheckInTask({
      courseId: taskCourseId,
      groupId: taskGroupId,
      title: title.trim() || (kind === 'single' ? '课后打卡' : '周期打卡'),
      dueAt: dueAtEnabled && dueAtText ? new Date(dueAtText).getTime() : null,
      scope,
      note: note.trim(),
      cadenceLabel,
      memberIds,
      days,
      ruleIds,
      activeStudents: students,
    })
    onClose()
  }

  const scopeReady =
    scope === 'all' ? true : scope === 'group' ? !!groupId : !!courseId

  // 当前可用的打卡天数（用于禁用在保存前校验是否为空）
  const dayCount =
    kind === 'single'
      ? dueAtEnabled && dueAtText
        ? 1
        : 0
      : kind === 'periodic'
        ? rangeDays.length
        : selectedDays.size

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建打卡任务"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={!scopeReady || dayCount === 0}
            onClick={() => void handleSave()}
          >
            创建并预生成记录
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="任务类型">
          <SegmentedControl
            value={kind}
            onChange={(v) => setKind(v as 'single' | 'periodic' | 'custom')}
            layout="grid"
            options={[
              { value: 'single', label: '单次' },
              { value: 'periodic', label: '周期每天' },
              { value: 'custom', label: '选择日期' },
            ]}
          />
          <p className="mt-1 text-[11px] text-text-3">
            {kind === 'single'
              ? '一次课后，截止前完成一次打卡'
              : kind === 'periodic'
                ? '区间内每天都要打卡，支持后期补卡'
                : '区间内仅选中哪几天需要打卡'}
          </p>
        </Field>
        <Field label="任务标题">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={kind === 'single' ? '如：9月6日课后打卡' : '如：本周单词每日打卡'}
          />
        </Field>
        <Field label="参与范围">
          <SegmentedControl
            value={scope}
            onChange={(v) => setScope(v as 'course' | 'group' | 'all')}
            layout="grid"
            options={[
              { value: 'all', label: '全体在读' },
              { value: 'group', label: '指定班课' },
              { value: 'course', label: '指定课程' },
            ]}
          />
        </Field>
        <Field label="适用规则">
          <RulePicker scope="checkin" value={ruleIds} onChange={setRuleIds} />
          <p className="mt-1 text-[11px] text-text-3">
            规则统一在「积分规则 → 打卡规则」里维护，这里只做引用增减。
          </p>
        </Field>
        {scope === 'group' && (
          <Field label="选择班课">
            <Select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">请选择班课</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}（{g.subject}）
                </option>
              ))}
            </Select>
            <p className="mt-1 text-[11px] text-text-3">自动取该班课的当前成员</p>
          </Field>
        )}
        {scope === 'course' && (
          <Field label="关联课程">
            <Select value={courseId} onChange={(e) => setCourseId(e.target.value)}>
              <option value="">请选择课程</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {format(c.startAt, 'M-d HH:mm')} {c.subject}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-[11px] text-text-3">自动取该课程的成员</p>
          </Field>
        )}
        {kind === 'single' && (
          <Field label="截止时间">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={dueAtEnabled}
                onChange={(e) => setDueAtEnabled(e.target.checked)}
              />
              <span className="text-[13px]">设置截止时间</span>
            </label>
            {dueAtEnabled && (
              <Input
                type="datetime-local"
                value={dueAtText}
                onChange={(e) => setDueAtText(e.target.value)}
                className="mt-2"
              />
            )}
          </Field>
        )}
        {(kind === 'periodic' || kind === 'custom') && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="开始日期">
                <Input
                  type="date"
                  value={fromText}
                  onChange={(e) => setFromText(e.target.value)}
                />
              </Field>
              <Field label="结束日期">
                <Input
                  type="date"
                  value={toText}
                  onChange={(e) => setToText(e.target.value)}
                />
              </Field>
            </div>
          </>
        )}
        {kind === 'custom' && rangeDays.length > 0 && (
          <Field label={`选择打卡日（${selectedDays.size} 天）`}>
            <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto rounded-md border border-line-1 bg-surface-0 p-2">
              {rangeDays.map((d) => {
                const s = format(d, 'yyyy-MM-dd')
                const on = selectedDays.has(s)
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleDay(s)}
                    className={cn(
                      'rounded-md border px-2 py-1 text-[11px] transition-colors',
                      on
                        ? 'border-accent bg-accent text-white'
                        : 'border-line-1 text-text-2 hover:border-accent',
                    )}
                  >
                    {format(d, 'M/d')}
                  </button>
                )
              })}
            </div>
          </Field>
        )}
        <Field label="打卡说明">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="打卡要求 / 评分标准"
            rows={3}
          />
        </Field>
      </div>
    </Modal>
  )
}

// ============================================================
// 商城视图
// ============================================================

function MarketView({
  rewardItems,
  redemptions,
  studentMap,
  ledgers,
}: {
  rewardItems: RewardItem[]
  redemptions: Redemption[]
  studentMap: Map<string, Student>
  ledgers: import('@/lib/types').PointLedger[]
}) {
  const [newOpen, setNewOpen] = useState(false)
  const [editing, setEditing] = useState<RewardItem | null>(null)
  const [search, setSearch] = useState('')

  const balances = useMemo(() => {
    // 同步计算（数据量小，实时算即可；不阻塞 UI）
    const m = new Map<string, PointBalance>()
    for (const l of ledgers) {
      let b = m.get(l.studentId)
      if (!b) {
        b = { studentId: l.studentId, balance: 0, earned: 0, spent: 0 }
        m.set(l.studentId, b)
      }
      if (l.delta >= 0) b.earned += l.delta
      else b.spent += -l.delta
    }
    for (const b of m.values()) b.balance = b.earned - b.spent
    return m
  }, [ledgers])

  const sortedStudents = useMemo(() => {
    const list = Array.from(studentMap.values())
      .map((s) => ({
        student: s,
        balance: balances.get(s.id)?.balance ?? 0,
        earned: balances.get(s.id)?.earned ?? 0,
      }))
      .sort((a, b) => b.balance - a.balance)
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter((x) => x.student.name.toLowerCase().includes(q))
  }, [studentMap, balances, search])

  async function handleDelete(r: RewardItem) {
    if (!confirm(`删除奖励项「${r.name}」？`)) return
    await db.rewardItems.put(markDeleted(r))
  }
  async function handleToggle(r: RewardItem) {
    await db.rewardItems.put(touch({ ...r, enabled: !r.enabled }))
  }
  async function handleFulfill(r: Redemption) {
    await db.redemptions.put(
      touch({ ...r, status: 'fulfilled', fulfilledAt: Date.now() }),
    )
  }
  async function handleRevoke(r: Redemption) {
    if (!confirm(`撤销该兑换？会退还 ${r.pointsSpent} 积分给学生。`)) return
    await db.redemptions.put(touch({ ...r, status: 'cancelled' }))
    await adjustPoints(r.studentId, r.pointsSpent, `撤销兑换：${r.rewardName}`)
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader
          title="奖励项"
          subtitle={`${rewardItems.length} 项 · 学生可兑换`}
          action={
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setEditing(null)
                setNewOpen(true)
              }}
            >
              <Plus size={13} /> 新建奖励
            </Button>
          }
        />
        {rewardItems.length === 0 ? (
          <EmptyState
            icon={<Gift size={22} />}
            title="还没有奖励项"
            description="例如「免作业一次 20 分」「错题本一本 50 分"
          />
        ) : (
          <ul className="divide-y divide-line-1">
            {rewardItems.map((r) => (
              <li
                key={r.id}
                className={cn(
                  'group flex items-start gap-3 px-4 py-3',
                  !r.enabled && 'opacity-60',
                )}
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-accent">
                  <Gift size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-text-1">{r.name}</span>
                    <Badge variant="primary">{r.pointsCost} 分</Badge>
                    {r.stock !== null && (
                      <Badge>库存 {r.stock}</Badge>
                    )}
                    {!r.enabled && <Badge variant="warning">已下架</Badge>}
                  </div>
                  {r.note && (
                    <p className="mt-0.5 line-clamp-2 text-[12px] text-text-3">{r.note}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => void handleToggle(r)}>
                    {r.enabled ? '下架' : '上架'}
                  </Button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(r)
                      setNewOpen(true)
                    }}
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
        )}

        {/* 兑换记录 */}
        <div className="border-t border-line-1">
          <CardHeader title="兑换记录" subtitle={`${redemptions.length} 条`} />
          {redemptions.length === 0 ? (
            <EmptyState title="还没有兑换记录" />
          ) : (
            <ul className="divide-y divide-line-1">
              {redemptions
                .slice()
                .sort((a, b) => b.redeemedAt - a.redeemedAt)
                .slice(0, 30)
                .map((r) => {
                  const s = studentMap.get(r.studentId)
                  return (
                    <li key={r.id} className="flex items-center gap-2 px-4 py-2.5">
                      <Avatar name={s?.name ?? '?'} colorSlot={s?.colorSlot ?? 0} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-text-1">
                            {s?.name ?? '已删学生'}
                          </span>
                          <span className="text-[12px] text-text-2">{r.rewardName}</span>
                          <Badge variant="primary">-{r.pointsSpent} 分</Badge>
                          <Badge
                            variant={
                              r.status === 'fulfilled'
                                ? 'success'
                                : r.status === 'cancelled'
                                  ? 'danger'
                                  : 'warning'
                            }
                          >
                            {r.status === 'fulfilled' ? '已发放' : r.status === 'cancelled' ? '已撤销' : '待发放'}
                          </Badge>
                        </div>
                        <p className="mt-0.5 text-[11px] text-text-3">
                          {format(r.redeemedAt, 'yyyy-MM-dd HH:mm')}
                        </p>
                      </div>
                      {r.status === 'pending' && (
                        <>
                          <Button size="sm" variant="primary" onClick={() => void handleFulfill(r)}>
                            <CheckCircle2 size={13} /> 发放
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => void handleRevoke(r)}>
                            撤销
                          </Button>
                        </>
                      )}
                    </li>
                  )
                })}
            </ul>
          )}
        </div>

        <RewardItemModal
          open={newOpen}
          reward={editing}
          onClose={() => setNewOpen(false)}
        />
      </Card>

      {/* 积分余额排行 */}
      <Card>
        <CardHeader title="积分余额" subtitle={`${sortedStudents.length} 名在读学生`} />
        <div className="border-b border-line-1 px-3 py-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-3" />
            <Input
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索学生"
            />
          </div>
        </div>
        {sortedStudents.length === 0 ? (
          <EmptyState
            icon={<Award size={22} />}
            title="暂无学生积分"
            description="设置基础分规则后开始打卡就会产生"
          />
        ) : (
          <ul className="max-h-[600px] divide-y divide-line-1 overflow-y-auto">
            {sortedStudents.map(({ student, balance, earned }, idx) => (
              <li key={student.id} className="flex items-center gap-2 px-3 py-2">
                <span className="w-6 text-center text-xs font-medium text-text-3">
                  {idx + 1}
                </span>
                <Avatar
                  name={student.name}
                  colorSlot={student.colorSlot}
                  size="sm"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-text-1">
                  {student.name}
                </span>
                <Badge variant="primary">余额 {balance}</Badge>
                <span className="text-[11px] text-text-3">+{earned}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function RewardItemModal({
  open,
  reward,
  onClose,
}: {
  open: boolean
  reward: RewardItem | null
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [cost, setCost] = useState('20')
  const [stockText, setStockText] = useState('')
  const [noteText, setNoteText] = useState('')

  useMemo(() => {
    if (!open) return
    setName(reward?.name ?? '')
    setCost(String(reward?.pointsCost ?? 20))
    setStockText(reward?.stock === null || reward?.stock === undefined ? '' : String(reward.stock))
    setNoteText(reward?.note ?? '')
  }, [open, reward])

  async function handleSave() {
    const payload = {
      name: name.trim(),
      pointsCost: Number(cost) || 0,
      stock: stockText.trim() === '' ? null : Number(stockText),
      note: noteText.trim(),
      enabled: reward?.enabled ?? true,
    }
    if (!payload.name || payload.pointsCost <= 0) return
    if (reward) {
      await db.rewardItems.put(touch({ ...reward, ...payload }))
    } else {
      await db.rewardItems.put(withSyncFields<RewardItem>({ ...payload, createdAt: Date.now() }))
    }
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={reward ? '编辑奖励' : '新建奖励'}
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
        <Field label="奖励名称">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：免作业一次 / 错题本一本"
          />
        </Field>
        <Field label="所需积分">
          <Input
            type="number"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </Field>
        <Field label="库存" hint="留空表示不限">
          <Input
            type="number"
            value={stockText}
            onChange={(e) => setStockText(e.target.value)}
            placeholder="不限"
          />
        </Field>
        <Field label="说明">
          <Textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            rows={3}
          />
        </Field>
      </div>
    </Modal>
  )
}

// ============================================================
// 学生手动调分（积分余额卡片右键或点击后的操作，暂未实现） — 后续可在 CardHeader 加按钮
// ============================================================

export { adjustPoints }
