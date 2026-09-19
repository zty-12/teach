import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  BookOpen,
  Download,
  Pencil,
  Plus,
  Trash2,
  Users,
} from 'lucide-react'
import {
  db,
  ensureGroupMember,
  markDeleted,
  touch,
  uniqueMemberStudentIds,
  withSyncFields,
} from '@/lib/db'
import { useBreakpoint } from '@/hooks/useBreakpoint'
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
} from '@/components/ui'
import { cn, initialOf, subjectColorVar } from '@/lib/utils'
import type { Group, GroupMember, Student } from '@/lib/types'
import { exportGroups } from '@/lib/exporters'
import { RulePicker } from '@/components/RulePicker'

export default function GroupsPage() {
  const bp = useBreakpoint()
  const isDesktop = bp === 'desktop'

  const [editing, setEditing] = useState<Group | null>(null)
  const [groupModalOpen, setGroupModalOpen] = useState(false)
  const [memberGroup, setMemberGroup] = useState<Group | null>(null)
  const [memberModalOpen, setMemberModalOpen] = useState(false)

  const groups = useLiveQuery(() => db.groups.toArray(), [])
  const members = useLiveQuery(() => db.groupMembers.toArray(), [])
  const students = useLiveQuery(() => db.students.toArray(), [])

  const liveGroups = useMemo(
    () => (groups ?? []).filter((g) => !g.deletedAt).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    [groups],
  )
  const liveMembers = useMemo(
    () => (members ?? []).filter((m) => !m.deletedAt),
    [members],
  )
  const liveStudents = useMemo(
    () => (students ?? []).filter((s) => !s.deletedAt),
    [students],
  )

  // 人数按「去重后的存活学生」计 —— 与成员管理弹窗同一口径。
  // 直接用成员行数在存在重复行时会多算（v31.6 反馈：卡片 10 人 / 弹窗 9 人）。
  const memberCountOf = (groupId: string) => {
    const ids = new Set(uniqueMemberStudentIds(liveMembers, groupId))
    return liveStudents.reduce((n, s) => n + (ids.has(s.id) ? 1 : 0), 0)
  }

  const studentName = (id: string) =>
    liveStudents.find((s) => s.id === id)?.name ?? '未知'

  function openCreate() {
    setEditing(null)
    setGroupModalOpen(true)
  }
  function openEdit(g: Group) {
    setEditing(g)
    setGroupModalOpen(true)
  }
  function openMembers(g: Group) {
    setMemberGroup(g)
    setMemberModalOpen(true)
  }
  async function handleDelete(g: Group) {
    // 未完成（pending）课程在成员关系被清除后，出席名单会变空 → 永远无法再结算。
    // 与其留下这种「打不开名单」的孤儿课程，不如随班课一并软删（v24 审查：P3）。
    const pendingCourses = (await db.courses.toArray()).filter(
      (c) => !c.deletedAt && c.groupId === g.id && c.status !== 'done' && c.status !== 'cancelled',
    )
    const warn =
      pendingCourses.length > 0
        ? `\n\n注意：该班课还有 ${pendingCourses.length} 节未完成课程，成员清除后将无法再结算，会随班课一并删除。`
        : ''
    if (
      !confirm(
        `确定删除班课「${g.name}」吗？成员关系会一并清除（已完成课程的历史记录保留）。${warn}`,
      )
    ) {
      return
    }
    const pendingIds = new Set(pendingCourses.map((c) => c.id))
    const attToSoftDelete = (await db.courseAttendances.toArray()).filter(
      (a) => !a.deletedAt && pendingIds.has(a.courseId),
    )
    // 知识点关联同样要清：老师完全可能先给未完成课程写了反馈、勾了知识点，
    // 删班课后这些 courseKnowledges 行没人再管（消费方按活课程取用，不会算错数字，但会永久同步）。
    const ckToSoftDelete = (await db.courseKnowledges.toArray()).filter(
      (k) => !k.deletedAt && pendingIds.has(k.courseId),
    )
    await db.transaction(
      'rw',
      db.groups,
      db.groupMembers,
      db.courses,
      db.courseAttendances,
      db.courseKnowledges,
      async () => {
        await db.groups.put(markDeleted(g))
        const rel = liveMembers.filter((m) => m.groupId === g.id)
        for (const m of rel) await db.groupMembers.put(markDeleted(m))
        for (const id of pendingIds) {
          const c = await db.courses.get(id)
          if (c && !c.deletedAt) await db.courses.put(markDeleted(c))
        }
        for (const a of attToSoftDelete) await db.courseAttendances.put(markDeleted(a))
        for (const k of ckToSoftDelete) await db.courseKnowledges.put(markDeleted(k))
      },
    )
  }

  function handleExport() {
    exportGroups(
      liveGroups.map((g) => ({
        group: g,
        members: liveMembers
          .filter((m) => m.groupId === g.id)
          .map((m) => studentName(m.studentId)),
      })),
    )
  }

  return (
    <div>
      <PageHeader
        title="班课 / 小组课"
        subtitle={`共 ${liveGroups.length} 个班课`}
        action={
          <>
            <Button variant="secondary" onClick={handleExport}>
              <Download size={16} />
              {isDesktop ? '导出' : ''}
            </Button>
            <Button variant="primary" onClick={openCreate}>
              <Plus size={16} />
              {isDesktop ? '新建班课' : '新建'}
            </Button>
          </>
        }
      />

      {liveGroups.length === 0 ? (
        <Card>
          <EmptyState
            icon={<BookOpen size={30} />}
            title="还没有班课"
            description="班课 / 小组课可一次性给多个学生排课，课酬会按成员均摊计入欠费。"
            action={
              <Button variant="primary" onClick={openCreate}>
                <Plus size={16} />
                新建班课
              </Button>
            }
          />
        </Card>
      ) : isDesktop ? (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line-1 bg-surface-2 text-left text-[13px] text-text-2">
                <th className="px-4 py-2.5 font-medium">班课</th>
                <th className="px-4 py-2.5 font-medium">科目</th>
                <th className="px-4 py-2.5 font-medium">单次时长</th>
                <th className="px-4 py-2.5 font-medium">成员</th>
                <th className="px-4 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-1">
              {liveGroups.map((g) => (
                <tr key={g.id} className="transition-colors hover:bg-surface-1">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <span
                        className="h-7 w-7 shrink-0 rounded-full"
                        style={{ background: subjectColorVar(g.colorSlot) }}
                      />
                      <div className="min-w-0">
                        <span className="font-medium text-text-1">{g.name}</span>
                        {g.note && (
                          <span className="ml-2 truncate text-xs text-text-3">{g.note}</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-text-2">{g.subject || '—'}</td>
                  <td className="px-4 py-2.5 tabular-nums text-text-2">{g.defaultDurationMin} 分钟</td>
                  <td className="px-4 py-2.5 text-text-2">{memberCountOf(g.id)} 人</td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => openMembers(g)}>
                        <Users size={14} />
                        成员
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => openEdit(g)}>
                        <Pencil size={14} />
                        编辑
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void handleDelete(g)}>
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <ul className="space-y-2">
          {liveGroups.map((g) => {
            const hasWeekly = g.weekday >= 0 && g.startTimeMin >= 0
            const scheduleText = hasWeekly
              ? `${WEEKDAY_LABELS[g.weekday]} ${minToHHMM(g.startTimeMin)}–${minToHHMM(g.endTimeMin)}`
              : null
            return (
              <li key={g.id} className="card p-3">
                <div className="flex items-center gap-3">
                  <span
                    className="h-10 w-10 shrink-0 rounded-full"
                    style={{ background: subjectColorVar(g.colorSlot) }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-text-1">{g.name}</p>
                    <p className="mt-0.5 text-[13px] text-text-2">
                      {g.subject || '未设科目'} · {g.defaultDurationMin}分钟 · {memberCountOf(g.id)} 人
                    </p>
                    {scheduleText && (
                      <p className="mt-0.5 truncate text-[12px] text-accent">
                        每周 {scheduleText}
                        {g.perStudentFeeCents > 0
                          ? ` · ¥${(g.perStudentFeeCents / 100).toFixed(0)}/人`
                          : ''}
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="min-w-0 flex-1"
                    onClick={() => openMembers(g)}
                  >
                    <Users size={14} />
                    管理成员
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0"
                    onClick={() => openEdit(g)}
                  >
                    <Pencil size={14} />
                    编辑
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <GroupModal
        open={groupModalOpen}
        group={editing}
        onClose={() => setGroupModalOpen(false)}
      />
      <MemberModal
        open={memberModalOpen}
        group={memberGroup}
        members={liveMembers}
        students={liveStudents}
        onClose={() => setMemberModalOpen(false)}
      />
    </div>
  )
}

// ============================================================
// 班课新建 / 编辑
// ============================================================

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const WEEKDAY_OPTIONS = WEEKDAY_LABELS.map((label, i) => ({ value: String(i), label }))
/** 打卡日「星期几」选择器的展示顺序（周一~周日） */
const CHECKIN_WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

function GroupModal({
  open,
  group,
  onClose,
}: {
  open: boolean
  group: Group | null
  onClose: () => void
}) {
  const [form, setForm] = useState<GroupForm>(emptyForm())
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setForm(group ? toForm(group) : emptyForm())
    setError('')
  }, [open, group])

  const patch = (p: Partial<GroupForm>) => setForm((f) => ({ ...f, ...p }))

  async function handleSave() {
    const name = form.name.trim()
    if (!name) {
      setError('请填写班课名称')
      return
    }
    const payload = {
      name,
      subject: form.subject.trim(),
      defaultDurationMin: form.defaultDurationMin,
      note: form.note.trim(),
      colorSlot: form.colorSlot,
      perStudentFeeCents: Math.round(Number(form.perStudentFeeYuan || 0) * 100),
      weekday: form.weekday,
      startTimeMin: form.startTime,
      endTimeMin: form.endTime,
      // v14：课后自动打卡配置（与详情页「打卡」Tab 写入同一组字段）
      checkInAuto: form.checkInAuto,
      checkInDays: Math.max(1, Math.min(30, Math.floor(form.checkInDays) || 7)),
      checkInStartOffset: Math.max(0, Math.min(30, Math.floor(form.checkInStartOffset) || 0)),
      checkInWeekdays: Array.from(new Set(form.checkInWeekdays.filter((d) => d >= 0 && d <= 6))).sort(
        (a, b) => a - b,
      ),
      // v21：完成课程后自动生成课堂积分活动（与课后自动打卡并列）
      classActivityAuto: form.classActivityAuto,
      // v30.3：自动活动引用哪些课堂规则（空数组 = 用当前启用的全部课堂规则）
      autoClassRuleIds: form.autoClassRuleIds.filter(Boolean),
    }
    if (group) {
      // 计算新计划时长
      const newPlanned =
        payload.endTimeMin > payload.startTimeMin && payload.startTimeMin >= 0
          ? payload.endTimeMin - payload.startTimeMin
          : null

      // 同步更新该班课「未来、未上」课程的 durationMin，
      // 避免「班课改了时间但课表里的旧课程还是旧时长」。
      let synced = 0
      if (newPlanned !== null && newPlanned > 0) {
        const all = await db.courses.toArray()
        const now = Date.now()
        for (const c of all) {
          if (c.deletedAt) continue
          if (c.groupId !== group.id) continue
          if (c.startAt < now) continue // 已经开始的课程不动
          if (c.status !== 'pending') continue // 已完成 / 已取消的不动
          if (c.durationMin === newPlanned) continue
          await db.courses.put(touch({ ...c, durationMin: newPlanned }))
          synced += 1
        }
      }

      await db.groups.put(touch({ ...group, ...payload }))
      if (synced > 0) {
        // 用 alert 同步提示一下（与项目里其它确认交互一致）
        window.alert(`班课时段已保存，已同步更新 ${synced} 节未上课程的时长`)
      }
    } else {
      await db.groups.put(withSyncFields<Group>({ ...payload, createdAt: Date.now() }))
    }
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={group ? '编辑班课' : '新建班课'}
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
        <Field label="班课名称" error={error} hint="必填">
          <Input
            value={form.name}
            onChange={(e) => {
              patch({ name: e.target.value })
              setError('')
            }}
            placeholder="如：初三数学冲刺班"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="科目">
            <Input
              value={form.subject}
              onChange={(e) => patch({ subject: e.target.value })}
              placeholder="数学"
            />
          </Field>
          <Field label="单次时长（分钟）">
            <Input
              type="number"
              min={15}
              step={15}
              value={form.defaultDurationMin}
              onChange={(e) => patch({ defaultDurationMin: Number(e.target.value) || 60 })}
            />
          </Field>
        </div>

        {/* 每周固定时段 + 单价：班课自动排课依据 */}
        <Field label="每周固定时段" hint="设了周几/时间后，可在课表一键「生成本周课程」">
          <div className="grid grid-cols-3 gap-2">
            <Select
              value={String(form.weekday)}
              onChange={(e) => patch({ weekday: Number(e.target.value) })}
            >
              <option value="-1">未设</option>
              {WEEKDAY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <Input
              type="time"
              value={form.startTime >= 0 ? minToHHMM(form.startTime) : ''}
              onChange={(e) => patch({ startTime: hhmmToMin(e.target.value) })}
              disabled={form.weekday < 0}
            />
            <Input
              type="time"
              value={form.endTime >= 0 ? minToHHMM(form.endTime) : ''}
              onChange={(e) => patch({ endTime: hhmmToMin(e.target.value) })}
              disabled={form.weekday < 0}
            />
          </div>
        </Field>

        <Field label="每人单次课酬（元）" hint="课酬 = 单价 × 实际出席人数">
          <Input
            type="number"
            min={0}
            step={5}
            value={form.perStudentFeeYuan}
            onChange={(e) => patch({ perStudentFeeYuan: e.target.value })}
            placeholder="20"
            inputMode="decimal"
          />
        </Field>

        <Field label="备注">
          <Input
            value={form.note}
            onChange={(e) => patch({ note: e.target.value })}
            placeholder="班级特点、教材版本等"
          />
        </Field>

        {/* v14：班课「课后自动打卡」配置（与详情页「打卡」Tab 同源，便于在班课设置里直接找到） */}
        <Field
          label="课后自动打卡"
          hint="本班每次课完成后，自动为出勤学员生成周期打卡任务"
        >
          <label className="flex items-start gap-2 rounded-lg border border-line-1 bg-surface-0 px-3 py-2.5 text-[13px] text-text-1">
            <input
              type="checkbox"
              checked={form.checkInAuto}
              onChange={(e) => patch({ checkInAuto: e.target.checked })}
              className="mt-0.5 h-3.5 w-3.5 accent-accent"
            />
            <span>
              完成课程后自动生成打卡
              <span className="block text-[11px] text-text-3">
                关闭后需到「打卡」页手动创建任务。
              </span>
            </span>
          </label>
        </Field>
        {form.checkInAuto && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="打卡天数" hint="1 ~ 30 天">
                <Input
                  type="number"
                  min={1}
                  max={30}
                  value={form.checkInDays}
                  onChange={(e) => patch({ checkInDays: Number(e.target.value) })}
                />
              </Field>
              <Field label="起始日" hint="从下课日往后推">
                <Select
                  value={String(form.checkInStartOffset)}
                  onChange={(e) => patch({ checkInStartOffset: Number(e.target.value) })}
                >
                  <option value="0">下课当天开始</option>
                  <option value="1">次日起（默认）</option>
                  <option value="2">第 3 天起</option>
                  <option value="6">一周后起</option>
                </Select>
              </Field>
            </div>
            <Field
              label="打卡日（星期几）"
              hint="不选=按自然日连续；选择后仅在这些星期几生成打卡"
            >
              <div className="flex flex-wrap gap-1.5">
                {CHECKIN_WEEKDAY_ORDER.map((i) => {
                  const on = form.checkInWeekdays.includes(i)
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() =>
                        patch({
                          checkInWeekdays: on
                            ? form.checkInWeekdays.filter((d) => d !== i)
                            : [...form.checkInWeekdays, i].sort((a, b) => a - b),
                        })
                      }
                      className={cn(
                        'h-8 w-9 rounded-lg border text-[12px] font-semibold transition-colors',
                        on
                          ? 'border-accent bg-accent text-white'
                          : 'border-line-1 bg-surface-0 text-text-2 hover:bg-surface-2',
                      )}
                    >
                      {WEEKDAY_LABELS[i]?.replace('周', '') ?? i}
                    </button>
                  )
                })}
                {form.checkInWeekdays.length > 0 && (
                  <button
                    type="button"
                    onClick={() => patch({ checkInWeekdays: [] })}
                    className="h-8 rounded-lg border border-line-1 bg-surface-0 px-2.5 text-[12px] font-medium text-text-2 hover:bg-surface-2"
                  >
                    清空
                  </button>
                )}
              </div>
            </Field>
          </div>
        )}

        {/* v21：班课「课堂积分活动」自动生成（与「课后自动打卡」并列，可在班课设置里直接开关） */}
        <Field
          label="自动生成课堂活动"
          hint="本班每次课完成后，自动为出勤学员生成「课堂积分」活动"
        >
          <label className="flex items-start gap-2 rounded-lg border border-line-1 bg-surface-0 px-3 py-2.5 text-[13px] text-text-1">
            <input
              type="checkbox"
              checked={form.classActivityAuto}
              onChange={(e) => patch({ classActivityAuto: e.target.checked })}
              className="mt-0.5 h-3.5 w-3.5 accent-accent"
            />
            <span>
              完成课程后自动生成课堂活动
              <span className="block text-[11px] text-text-3">
                关闭后需到「打卡与积分 → 课堂积分」页手动新建活动。
              </span>
            </span>
          </label>
        </Field>

        {/* v30.3：自动生成的课堂活动「出哪些规则按钮」——不选=沿用当前启用的全部课堂规则 */}
        {form.classActivityAuto && (
          <Field
            label="自动活动的计分规则"
            hint="决定自动生成的课堂积分活动出哪些规则按钮；不选=沿用当前启用的全部课堂规则"
          >
            <RulePicker
              scope="class"
              value={form.autoClassRuleIds}
              onChange={(ids) => patch({ autoClassRuleIds: ids })}
            />
            <p className="mt-1 text-[11px] text-text-3">
              留空时自动活动引用「积分规则 → 课堂规则」里全部启用项；已选规则若之后被删除/停用，
              会自动回退为全部启用项，不会生成零规则的空活动。这里显示的就是规则库里的课堂规则
              ——若看到「过关 / 第一个额外」等旧命名，说明它们是旧规则、还没清理（可到「积分规则」页停用或删除）。
            </p>
          </Field>
        )}

        <Field label="配色">
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 8 }, (_, i) => i + 1).map((slot) => (
              <button
                key={slot}
                type="button"
                aria-label={`配色 ${slot}`}
                onClick={() => patch({ colorSlot: slot })}
                className={cn(
                  'h-8 w-8 rounded-full transition-transform',
                  form.colorSlot === slot && 'ring-2 ring-accent ring-offset-2',
                )}
                style={{ background: subjectColorVar(slot) }}
              />
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  )
}

/** 「分钟数（一天中的）」 ↔ 「HH:mm」 */
function minToHHMM(min: number): string {
  if (min < 0) return ''
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map(Number)
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return -1
  return h * 60 + m
}

// ============================================================
// 班课成员管理
// ============================================================

function MemberModal({
  open,
  group,
  members,
  students,
  onClose,
}: {
  open: boolean
  group: Group | null
  members: GroupMember[]
  students: Student[]
  onClose: () => void
}) {
  const [addId, setAddId] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setAddId('')
      setError('')
    }
  }, [open, group])

  if (!group) return null

  const currentIds = members.filter((m) => m.groupId === group.id).map((m) => m.studentId)
  const current = students.filter((s) => currentIds.includes(s.id))
  const available = students.filter((s) => !currentIds.includes(s.id))

  async function handleAdd() {
    if (!addId) {
      setError('请选择要添加的学生')
      return
    }
    // 幂等加入：已是成员则不新增（避免重复行让班课人数 / 课酬多算）
    await ensureGroupMember(group!.id, addId)
    setAddId('')
    setError('')
  }

  async function handleRemove(studentId: string) {
    const rel = members.find((m) => m.groupId === group!.id && m.studentId === studentId)
    if (rel) await db.groupMembers.put(markDeleted(rel))
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`成员管理 · ${group.name}`}
      footer={<Button onClick={onClose}>完成</Button>}
    >
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-[13px] font-medium text-text-1">当前成员（{current.length}）</p>
          {current.length === 0 ? (
            <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-[13px] text-text-3">
              还没有成员，从下方添加
            </p>
          ) : (
            <ul className="space-y-1.5">
              {current.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-2.5 rounded-lg border border-line-1 px-3 py-2"
                >
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-medium text-white"
                    style={{ background: subjectColorVar(s.colorSlot) }}
                  >
                    {initialOf(s.name)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-text-1">{s.name}</span>
                  <Badge>{s.grade || '—'}</Badge>
                  <Button size="sm" variant="ghost" onClick={() => void handleRemove(s.id)}>
                    <Trash2 size={14} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Field label="添加成员" error={error}>
          <div className="flex gap-2">
            <Select value={addId} onChange={(e) => {
              setAddId(e.target.value)
              setError('')
            }}>
              <option value="">选择学生…</option>
              {available.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.grade ? ` · ${s.grade}` : ''}
                </option>
              ))}
            </Select>
            <Button variant="primary" onClick={handleAdd} disabled={!addId}>
              添加
            </Button>
          </div>
          {available.length === 0 && (
            <span className="mt-1 block text-xs text-text-3">所有学生都已在该班课中</span>
          )}
        </Field>
      </div>
    </Modal>
  )
}

// ============================================================
// 表单类型
// ============================================================

interface GroupForm {
  name: string
  subject: string
  defaultDurationMin: number
  note: string
  colorSlot: number
  perStudentFeeYuan: string
  weekday: number
  startTime: number
  endTime: number
  // v14：班课「课后自动打卡」配置（从课表详情页迁入，便于在班课设置里直接找到）
  checkInAuto: boolean
  checkInDays: number
  checkInStartOffset: number
  /** v16：限定打卡日落在这些星期几（0=周日~6=周六）；空=按自然日连续 */
  checkInWeekdays: number[]
  /** v21：完成课程后是否自动生成「课堂积分活动」（与课后自动打卡并列） */
  classActivityAuto: boolean
  /**
   * v30.3：自动生成的课堂积分活动引用哪些课堂规则（规则 id）。空 = 用当前启用的全部课堂规则。
   */
  autoClassRuleIds: string[]
}

const emptyForm = (): GroupForm => ({
  name: '',
  subject: '',
  defaultDurationMin: 60,
  note: '',
  colorSlot: 1,
  perStudentFeeYuan: '',
  weekday: -1,
  startTime: -1,
  endTime: -1,
  checkInAuto: true,
  checkInDays: 7,
  checkInStartOffset: 1,
  checkInWeekdays: [],
  classActivityAuto: true,
  autoClassRuleIds: [],
})

const toForm = (g: Group): GroupForm => ({
  name: g.name,
  subject: g.subject,
  defaultDurationMin: g.defaultDurationMin,
  note: g.note,
  colorSlot: g.colorSlot,
  perStudentFeeYuan: g.perStudentFeeCents ? String(g.perStudentFeeCents / 100) : '',
  weekday: g.weekday ?? -1,
  startTime: g.startTimeMin ?? -1,
  endTime: g.endTimeMin ?? -1,
  checkInAuto: g.checkInAuto !== false,
  checkInDays: g.checkInDays ?? 7,
  checkInStartOffset: g.checkInStartOffset ?? 1,
  checkInWeekdays: Array.isArray(g.checkInWeekdays)
    ? Array.from(new Set(g.checkInWeekdays.filter((d) => d >= 0 && d <= 6))).sort((a, b) => a - b)
    : [],
  classActivityAuto: g.classActivityAuto !== false,
  autoClassRuleIds: Array.isArray(g.autoClassRuleIds)
    ? g.autoClassRuleIds.filter(Boolean)
    : [],
})
