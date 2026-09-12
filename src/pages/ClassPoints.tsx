import { useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import {
  CheckCircle2,
  Coins,
  Plus,
  Sparkles,
  Trash2,
  Trophy,
  XCircle,
} from 'lucide-react'
import { db, markDeleted, touch, withSyncFields } from '@/lib/db'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Textarea,
} from '@/components/ui'
import { cn } from '@/lib/utils'
import { adjustPoints, type PointBalance } from '@/lib/points'
import { Avatar } from '@/components/Avatar'
import type {
  ClassActivity,
  ClassActivityRecord,
  ClassActivityRule,
  Course,
  Student,
} from '@/lib/types'
import { CLASS_RULE_CONDITION_LABEL } from '@/lib/types'

// ============================================================
// 主页面
// ============================================================

export default function ClassPointsPage() {
  const [activities, setActivities] = useState<ClassActivity[]>([])
  const [allRecords, setAllRecords] = useState<ClassActivityRecord[]>([])
  const [students, setStudents] = useState<Student[]>([])
  const [courses, setCourses] = useState<Course[]>([])
  const [balances, setBalances] = useState<Map<string, PointBalance>>(new Map())
  const [showCreate, setShowCreate] = useState(false)

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    const [acts, recs, studs, cours] = await Promise.all([
      db.classActivities.orderBy('createdAt').reverse().toArray(),
      db.classActivityRecords.toArray(),
      db.students.toArray(),
      db.courses.toArray(),
    ])
    setActivities(acts.filter((a) => !a.deletedAt))
    setAllRecords(recs.filter((r) => !r.deletedAt))
    setStudents(studs.filter((s) => !s.deletedAt))
    setCourses(cours.filter((c) => !c.deletedAt))
  }

  // 批量计算积分余额
  useEffect(() => {
    computeAllBalances()
  }, [activities])

  async function computeAllBalances() {
    const map = new Map<string, PointBalance>()
    const ids = new Set(students.map((s) => s.id))
    for (const sid of ids) {
      const bal = await computeBalanceFor(sid)
      map.set(sid, bal)
    }
    setBalances(map)
  }

  async function computeBalanceFor(studentId: string): Promise<PointBalance> {
    const rows = (await db.pointLedgers.toArray()).filter(
      (l) => !l.deletedAt && l.studentId === studentId,
    )
    let earned = 0
    let spent = 0
    for (const r of rows) {
      if (r.delta >= 0) earned += r.delta
      else spent += -r.delta
    }
    return { studentId, balance: earned - spent, earned, spent }
  }

  const studentMap = useMemo(
    () => new Map(students.map((s) => [s.id, s])),
    [students],
  )
  const courseMap = useMemo(
    () => new Map(courses.map((c) => [c.id, c])),
    [courses],
  )

  function recordsForActivity(activityId: string) {
    return allRecords
      .filter((r) => r.activityId === activityId && !r.deletedAt)
      .sort((a, b) => (b.checkedAt ?? 0) - (a.checkedAt ?? 0))
  }

  // 计算学生得分（实时预览）
  function previewAwarded(rule: ClassActivityRule, rank: number) {
    if (!rule.enabled) return 0
    if (rule.condition === 'pass') return rule.points
    if (rule.condition === 'first') return rank === 1 ? rule.points : 0
    return 0
  }

  async function handleDelete(activity: ClassActivity) {
    if (!confirm(`确定删除「${activity.title}」？关联的记录也会删除。`)) return
    const recIds = allRecords
      .filter((r) => r.activityId === activity.id && !r.deletedAt)
      .map((r) => r.id)
    if (recIds.length > 0) {
      await db.classActivityRecords.bulkPut(
        recIds.map((id) => {
          const rec = allRecords.find((r) => r.id === id)!
          return markDeleted(rec)
        }),
      )
    }
    await db.classActivities.put(markDeleted(activity))
    await loadAll()
  }

  async function handleMarkPass(
    activity: ClassActivity,
    record: ClassActivityRecord,
  ) {
    const recs = recordsForActivity(activity.id).filter((r) => !r.deletedAt)
    const passedRecs = recs.filter((r) => r.status === 'pass')
    const now = Date.now()

    const updated: ClassActivityRecord = {
      ...record,
      status: 'pass',
      checkedAt: now,
    }

    // 计算得分
    let total = 0
    const rank = passedRecs.findIndex((r) => r.studentId === record.studentId) + 1
    for (const rule of activity.rules) {
      const pts = previewAwarded(rule, rank)
      total += pts
    }
    updated.pointsAwarded = total

    await db.classActivityRecords.put(touch(updated))

    // 记录积分流水
    if (total > 0) {
      await adjustPoints(record.studentId, total, `课堂积分 · ${activity.title}`)
    }
    await loadAll()
  }

  async function handleMarkFail(record: ClassActivityRecord) {
    const updated: ClassActivityRecord = {
      ...record,
      status: 'fail',
      pointsAwarded: 0,
      checkedAt: Date.now(),
    }
    await db.classActivityRecords.put(touch(updated))
    await loadAll()
  }

  async function handleAddStudent(activity: ClassActivity) {
    const existing = recordsForActivity(activity.id)
      .map((r) => r.studentId)
      .filter(Boolean)
    const available = students.filter(
      (s) => !s.deletedAt && !existing.includes(s.id),
    )
    if (available.length === 0) {
      alert('所有学生都已参与此活动')
      return
    }
    const now = Date.now()
    const rows = available.map((s) =>
      withSyncFields<ClassActivityRecord>({
        activityId: activity.id,
        studentId: s.id,
        status: 'pending',
        pointsAwarded: 0,
        note: '',
        checkedAt: null,
        createdAt: now,
      }),
    )
    await db.classActivityRecords.bulkPut(rows)
    await loadAll()
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="课堂积分"
        subtitle="课上检查背诵等场景，按自定义规则记录积分"
        action={
          <Button onClick={() => setShowCreate(true)}>
            <Plus size={15} /> 新建活动
          </Button>
        }
      />

      {activities.length === 0 ? (
        <EmptyState
          icon={<Trophy size={36} />}
          title="还没有课堂活动"
          description="点击「新建活动」创建一个背诵检查等活动，设定计分规则后即可开始记录"
        />
      ) : (
        <div className="space-y-4">
          {activities.map((act) => (
            <ActivityCard
              key={act.id}
              activity={act}
              records={recordsForActivity(act.id)}
              studentMap={studentMap}
              courseMap={courseMap}
              balances={balances}
              onMarkPass={handleMarkPass}
              onMarkFail={handleMarkFail}
              onAddStudent={handleAddStudent}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      <CreateActivityModal
        show={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={() => {
          setShowCreate(false)
          loadAll()
        }}
        courses={courses}
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
  courseMap,
  balances,
  onMarkPass,
  onMarkFail,
  onAddStudent,
  onDelete,
}: {
  activity: ClassActivity
  records: ClassActivityRecord[]
  studentMap: Map<string, Student>
  courseMap: Map<string, Course>
  balances: Map<string, PointBalance>
  onMarkPass: (act: ClassActivity, rec: ClassActivityRecord) => void
  onMarkFail: (rec: ClassActivityRecord) => void
  onAddStudent: (act: ClassActivity) => void
  onDelete: (act: ClassActivity) => void
}) {
  const course = activity.courseId ? courseMap.get(activity.courseId) : null
  const passedRecs = records.filter((r) => r.status === 'pass')
  const totalAwarded = records.reduce((s, r) => s + (r.pointsAwarded || 0), 0)

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 p-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Trophy size={16} className="text-amber-500" />
            <h3 className="text-[15px] font-semibold text-text-1">
              {activity.title}
            </h3>
            {course && (
              <Badge variant="primary" className="text-[11px]">
                {course.subject}
              </Badge>
            )}
          </div>
          <div className="mt-1 text-[12px] text-text-3 flex items-center gap-3">
            <span>{format(activity.createdAt, 'M月d日 HH:mm')}</span>
            <span className="flex items-center gap-1">
              <CheckCircle2 size={11} className="text-done" />
              {passedRecs.length}
              <span className="text-text-3">已过关</span>
            </span>
            <span className="flex items-center gap-1 text-amber-600">
              <Coins size={11} /> +{totalAwarded} 分
            </span>
          </div>
          {activity.note && (
            <div className="mt-1.5 text-[12px] text-text-2">
              {activity.note}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button variant="ghost" size="sm" onClick={() => onDelete(activity)}>
            <Trash2 size={13} />
          </Button>
        </div>
      </div>

      {/* 规则展示 */}
      <div className="px-4 pb-3">
        <div className="rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/30 p-3">
          <div className="flex items-center gap-1.5 mb-2">
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
                  'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium border',
                  rule.enabled
                    ? 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800/40'
                    : 'bg-surface-2 text-text-3 border-line-1 line-through',
                )}
              >
                <span>{rule.name}</span>
                <span className="text-amber-600 dark:text-amber-400">
                  {rule.points}分
                </span>
                <span className="text-amber-500/70">
                  · {CLASS_RULE_CONDITION_LABEL[rule.condition]}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 学生列表 */}
      <div className="border-t border-line-1 px-4 py-3">
        <div className="flex items-center justify-between mb-2.5">
          <span className="text-[12px] font-medium text-text-2">
            参与学生（{records.length}）
          </span>
          <Button variant="ghost" size="sm" onClick={() => onAddStudent(activity)}>
            <Plus size={13} /> 添加学生
          </Button>
        </div>

        {records.length === 0 ? (
          <div className="text-[13px] text-text-3 text-center py-4">
            还没有学生参与，点击「添加学生」
          </div>
        ) : (
          <div className="space-y-1.5">
            {records.map((rec) => {
              const student = studentMap.get(rec.studentId)
              if (!student) return null
              const bal = balances.get(rec.studentId)
              const passed = rec.status === 'pass'
              const failed = rec.status === 'fail'
              const pending = rec.status === 'pending'

              // 计算排名（passedRecs 按 checkedAt 降序，第一个过关的排第一）
              const rank = passed
                ? passedRecs.findIndex((r) => r.studentId === rec.studentId) + 1
                : 0

              return (
                <div
                  key={rec.id}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-lg border px-3 py-2',
                    passed
                      ? 'border-done/30 bg-done/5 dark:bg-done/10'
                      : failed
                        ? 'border-money-due/30 bg-money-due/5 dark:bg-money-due/10'
                        : 'border-line-1 bg-surface-0',
                  )}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Avatar name={student.name} colorSlot={student.colorSlot} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[13px] font-medium text-text-1 truncate">
                          {student.name}
                        </span>
                        {rank === 1 && passed && (
                          <Trophy size={11} className="text-amber-500 shrink-0" />
                        )}
                      </div>
                      {bal && (
                        <div className="text-[11px] text-text-3 flex items-center gap-1.5">
                          <Coins size={10} />
                          当前 {bal.balance} 分
                          {rec.pointsAwarded > 0 && (
                            <span className="text-done">+{rec.pointsAwarded}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {pending && (
                      <>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => onMarkPass(activity, rec)}
                        >
                          <CheckCircle2 size={13} /> 过关
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => onMarkFail(rec)}
                        >
                          <XCircle size={13} /> 未过关
                        </Button>
                      </>
                    )}
                    {passed && (
                      <div className="flex items-center gap-1 text-[12px] text-done font-medium">
                        <CheckCircle2 size={13} />
                        <span>+{rec.pointsAwarded}分</span>
                        {rank === 1 && <Trophy size={11} />}
                      </div>
                    )}
                    {failed && (
                      <div className="flex items-center gap-1 text-[12px] text-money-due">
                        <XCircle size={13} /> 未过关
                      </div>
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
// 创建活动弹窗
// ============================================================

function CreateActivityModal({
  show,
  onClose,
  onCreated,
  courses,
}: {
  show: boolean
  onClose: () => void
  onCreated: () => void
  courses: Course[]
}) {
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [courseId, setCourseId] = useState('')
  const [rules, setRules] = useState<ClassActivityRule[]>([
    { name: '过关', points: 1, condition: 'pass', enabled: true },
    { name: '第一个额外', points: 1, condition: 'first', enabled: true },
  ])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (show) {
      setTitle('')
      setNote('')
      setCourseId('')
      setRules([
        { name: '过关', points: 1, condition: 'pass', enabled: true },
        { name: '第一个额外', points: 1, condition: 'first', enabled: true },
      ])
    }
  }, [show])

  async function handleCreate() {
    if (!title.trim()) {
      alert('请填写活动名称')
      return
    }
    setSaving(true)
    try {
      const act = withSyncFields<ClassActivity>({
        title: title.trim(),
        courseId: courseId || null,
        rules: rules.filter((r) => r.name.trim() && r.points > 0),
        note: note.trim(),
        createdAt: Date.now(),
      })
      await db.classActivities.put(act)
      onCreated()
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

  return (
    <Modal open={show} onClose={onClose} title="新建课堂活动" size="xl">
      <div className="space-y-4">
        <Field label="活动名称">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="如：背诵检查、单词听写、课文朗读"
            autoFocus
          />
        </Field>

        <Field label="关联课程（可选）">
          <Select
            value={courseId}
            onChange={(e) => setCourseId(e.target.value)}
          >
            <option value="">不关联</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.subject}
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
          <div className="flex items-center justify-between mb-2">
            <span className="text-[13px] font-medium text-text-1">
              计分规则
            </span>
            <Button variant="ghost" size="sm" onClick={addRule}>
              <Plus size={13} /> 添加规则
            </Button>
          </div>
          <div className="space-y-2">
            {rules.map((rule, idx) => (
              <div
                key={idx}
                className="flex items-center gap-2 rounded-lg border border-line-1 bg-surface-0 p-2.5"
              >
                <Input
                  value={rule.name}
                  onChange={(e) => updateRule(idx, 'name', e.target.value)}
                  placeholder="规则名称"
                  className="flex-1 min-w-0"
                />
                <div className="flex items-center gap-1 shrink-0">
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
                  onChange={(e) =>
                    updateRule(
                      idx,
                      'condition',
                      e.target.value as ClassActivityRule['condition'],
                    )
                  }
                  className="w-28 shrink-0"
                >
                  <option value="pass">过关</option>
                  <option value="first">第一个</option>
                </Select>
                <button
                  type="button"
                  onClick={() => removeRule(idx)}
                  className="text-text-3 hover:text-money-due shrink-0"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[11px] text-text-3">
            <span className="font-medium">过关</span>=该条件满足的所有学生都加分；
            <span className="font-medium">第一个</span>=仅第一个过关的学生额外加分
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
