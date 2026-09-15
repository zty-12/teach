/**
 * 积分引擎
 *
 * 设计要点：
 *  - **单一真源**：积分余额不冗余存在学生表上，全部由 `pointLedgers` 流水聚合得出，
 *    避免「余额与流水不一致」的经典问题。数据量不大，实时聚合足够快。
 *  - **幂等重算**：批次的加分通过「先删该批次的 earn 流水 → 再按当前状态重写」实现，
 *    因此老师反复修改打卡状态不会重复加分。
 *  - **规则可配置**：base=每次打卡的基础分（默认 1）；bonus=满足条件额外奖励。
 */
import { db, ensureDefaultPointRules, markDeleted, touch, withSyncFields } from './db'
import type {
  CheckInRecord,
  CheckInTask,
  PointLedger,
  PointRule,
  PointRuleCondition,
  Redemption,
  RuleMode,
  Student,
} from './types'
import { startOfDay } from 'date-fns'

// ============================================================
// 打卡规则解析（v20：任务引用规则库；旧任务回退为「全部启用规则」）
// ============================================================

/** 归一化后的打卡规则 */
export interface ResolvedCheckInRule {
  /** 库规则 id */
  id: string
  name: string
  points: number
  /** v30.8：统一为 RuleMode（打卡范围实际只用 auto / tier） */
  mode: RuleMode
  /** 度量条件（连续天数 / 准时率等）；null = 无条件（所有已打卡学生都加） */
  condition: PointRuleCondition | null
  enabled: boolean
}

/** 规则是否属于打卡范围（旧数据没有 scope，按打卡处理） */
export function isCheckinRule(r: PointRule): boolean {
  return (r.scope ?? 'checkin') === 'checkin'
}

/**
 * 解析一个打卡任务实际生效的规则。
 *  - 有 ruleIds（含空数组）→ 只从规则库取这些（空数组 = 明确不引用任何规则）
 *  - 无 ruleIds（undefined，仅旧数据）→ 回退到「所有启用的打卡规则」
 *
 * 注意：`[]` 与 `undefined` 语义不同 —— 老师把规则全部清空时写的是 `[]`，
 * 必须解释成「不加任何分」，而不是「回退到全部规则」。
 */
export function resolveCheckInRules(
  task: CheckInTask,
  lib: PointRule[],
): ResolvedCheckInRule[] {
  const live = lib.filter((r) => !r.deletedAt)
  const toResolved = (r: PointRule): ResolvedCheckInRule => ({
    id: r.id,
    name: r.name,
    points: r.points,
    mode: r.mode ?? 'auto',
    // 旧版 base 规则无 condition；bonus 规则带 condition —— 两者都按自动累加处理
    condition: r.condition ?? null,
    enabled: r.enabled,
  })
  const ids = task.ruleIds
  if (Array.isArray(ids)) {
    const map = new Map(live.map((r) => [r.id, r]))
    const out: ResolvedCheckInRule[] = []
    for (const id of ids) {
      const r = map.get(id)
      if (!r) continue
      out.push(toResolved(r))
    }
    return out
  }
  return live.filter(isCheckinRule).sort((a, b) => a.order - b.order).map(toResolved)
}

/** 取启用中的打卡规则 id 列表（新建打卡任务时的默认适用范围） */
export async function defaultCheckInRuleIds(): Promise<string[]> {
  // 规则库为空时先补齐默认规则（与课堂规则 defaultClassRuleIds 的处理一致），
  // 否则全新安装会创建出「零规则」的打卡任务，怎么打卡都不加分。
  await ensureDefaultPointRules()
  const all = await db.pointRules.toArray()
  return all
    .filter((r) => !r.deletedAt && isCheckinRule(r) && r.enabled)
    .sort((a, b) => a.order - b.order)
    .map((r) => r.id)
}

// ============================================================
// 余额查询
// ============================================================

export interface PointBalance {
  studentId: string
  /** 当前可用余额 = 累计获得 - 累计消耗 */
  balance: number
  /** 累计获得 */
  earned: number
  /** 累计消耗 */
  spent: number
}

/** 计算单个学生的积分余额 */
export async function computeBalance(studentId: string): Promise<PointBalance> {
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

/** 批量计算所有学生的积分余额（一次扫表，避免 N 次查询） */
export async function computeAllBalances(): Promise<Map<string, PointBalance>> {
  const rows = (await db.pointLedgers.toArray()).filter((l) => !l.deletedAt)
  const map = new Map<string, PointBalance>()
  for (const r of rows) {
    let b = map.get(r.studentId)
    if (!b) {
      b = { studentId: r.studentId, balance: 0, earned: 0, spent: 0 }
      map.set(r.studentId, b)
    }
    if (r.delta >= 0) b.earned += r.delta
    else b.spent += -r.delta
  }
  for (const b of map.values()) b.balance = b.earned - b.spent
  return map
}

// ============================================================
// 条件评估
// ============================================================

function compare(actual: number, op: PointRuleCondition['operator'], expected: number): boolean {
  if (op === '>=') return actual >= expected
  if (op === '>') return actual > expected
  return actual === expected
}

/**
 * 表快照：一次调用内复用 records / tasks，避免在「记录 × 规则」循环里反复全表扫描。
 * （此前 recomputeTaskPoints 每条 (记录, 规则) 都会 toArray 两张表，
 *  7 天 × 40 人 × 2 条条件规则 ≈ 560 次全表扫描。）
 */
interface RecordsSnapshot {
  records: CheckInRecord[]
  tasks: CheckInTask[]
  /** 学生 → 已完成记录缓存（同一次调用内惰性构建） */
  doneCache: Map<string, Array<{ record: CheckInRecord; task: CheckInTask }>>
}

/** 取某学生的历史打卡（done）记录，按批次时间升序 */
async function doneRecordsOf(
  studentId: string,
  snapshot?: RecordsSnapshot,
): Promise<Array<{ record: CheckInRecord; task: CheckInTask }>> {
  if (!snapshot) {
    return doneRecordsOf(studentId, await buildSnapshot())
  }
  const cached = snapshot.doneCache.get(studentId)
  if (cached) return cached

  const taskMap = new Map(snapshot.tasks.filter((t) => !t.deletedAt).map((t) => [t.id, t]))
  const out: Array<{ record: CheckInRecord; task: CheckInTask }> = []
  for (const r of snapshot.records) {
    if (r.deletedAt || r.studentId !== studentId || r.status !== 'done') continue
    const t = taskMap.get(r.taskId)
    if (!t) continue
    out.push({ record: r, task: t })
  }
  // 按批次时间升序（用 createdAt 作为批次的时间锚点，稳定且与 dueAt 无关）
  out.sort((a, b) => a.task.createdAt - b.task.createdAt)
  snapshot.doneCache.set(studentId, out)
  return out
}

/** 构建一次性的表快照（供一次重算内复用） */
async function buildSnapshot(): Promise<RecordsSnapshot> {
  const [records, tasks] = await Promise.all([
    db.checkInRecords.toArray(),
    db.checkInTasks.toArray(),
  ])
  return { records, tasks, doneCache: new Map() }
}

/**
 * 计算「连续打卡天数」：
 * 把所有 done 的批次按其日期去重，从最新一天往回数，连续有打卡的天数。
 */
export async function consecutiveDays(
  studentId: string,
  snapshot?: RecordsSnapshot,
): Promise<number> {
  const dones = await doneRecordsOf(studentId, snapshot)
  const daySet = new Set<number>()
  for (const { record, task } of dones) {
    // 周期任务用每条记录的打卡日；单次任务回退 dueAt / createdAt
    const day = record.dayAt ?? task.dueAt ?? task.createdAt
    daySet.add(startOfDay(new Date(day)).getTime())
  }
  const days = Array.from(daySet).sort((a, b) => b - a)
  if (days.length === 0) return 0
  const DAY = 86_400_000
  let streak = 1
  for (let i = 1; i < days.length; i++) {
    if (days[i - 1]! - days[i]! <= DAY) streak++
    else break
  }
  return streak
}

/** 计算「准时打卡率」：done 记录中 checkedAt <= dueAt 的比例（0-100） */
export async function onTimeRate(
  studentId: string,
  snapshot?: RecordsSnapshot,
): Promise<number> {
  const dones = await doneRecordsOf(studentId, snapshot)
  if (dones.length === 0) return 0
  let onTime = 0
  let counted = 0
  for (const { record, task } of dones) {
    // 单次任务看 dueAt；周期任务看每条记录的打卡日当天截止
    const deadline = record.dayAt
      ? startOfDay(new Date(record.dayAt)).getTime() + 86_400_000 - 1
      : task.dueAt
    if (!deadline) continue
    counted++
    if (record.checkedAt && record.checkedAt <= deadline) onTime++
  }
  if (counted === 0) return 0
  return Math.round((onTime / counted) * 100)
}

/** 本批次是否全部完成（所有记录都是 done，且至少有 1 条记录） */
function isAllDone(records: CheckInRecord[]): boolean {
  if (records.length === 0) return false
  return records.every((r) => r.status === 'done')
}

/**
 * 评估某学生在某批次下，单条 bonus 规则是否命中。
 * @param records 该批次的全部记录（用于 all_done 这类批次级条件）
 */
export async function evaluateCondition(
  cond: PointRuleCondition,
  studentId: string,
  records: CheckInRecord[],
  snapshot?: RecordsSnapshot,
): Promise<boolean> {
  switch (cond.metric) {
    case 'checkin_count': {
      const dones = await doneRecordsOf(studentId, snapshot)
      return compare(dones.length, cond.operator, cond.value)
    }
    case 'consecutive_days': {
      const days = await consecutiveDays(studentId, snapshot)
      return compare(days, cond.operator, cond.value)
    }
    case 'on_time_rate': {
      const rate = await onTimeRate(studentId, snapshot)
      return compare(rate, cond.operator, cond.value)
    }
    case 'all_done': {
      // all_done 用 ==1 表示「是」，==0 表示「否」
      return compare(isAllDone(records) ? 1 : 0, cond.operator, cond.value)
    }
    default:
      return false
  }
}

// ============================================================
// 批次加分（幂等重算）
// ============================================================

/**
 * 重算某个打卡批次的全部积分。
 *
 * 做法：先物理删除该批次产生的 earn 流水（它们只由本函数生成，可安全重建），
 * 再按当前打卡状态重新生成。这样老师反复改状态不会重复加分。
 *
 * @returns 本次实际写入的流水条数
 */
export async function recomputeTaskPoints(taskId: string): Promise<number> {
  const task = await db.checkInTasks.get(taskId)
  if (!task || task.deletedAt) return 0

  const [snapshot, allRules, allLedgers] = await Promise.all([
    buildSnapshot(),
    db.pointRules.toArray(),
    db.pointLedgers.toArray(),
  ])
  const records = snapshot.records.filter((r) => !r.deletedAt && r.taskId === taskId)
  const rules = resolveCheckInRules(task, allRules)

  // 1) 冲销该批次已生成的 earn 流水（幂等的关键）
  //    ⚠️ 必须**软删**（留墓碑）而不是物理删除：否则云端仍保留这批旧流水，
  //    换设备/清缓存后重新拉取会把它们带回来 → 同一批打卡被重复计分。
  const oldLedgers = allLedgers.filter(
    (l) => !l.deletedAt && l.taskId === taskId && l.kind === 'earn',
  )
  if (oldLedgers.length > 0) {
    await db.pointLedgers.bulkPut(oldLedgers.map((l) => markDeleted(l)))
  }

  // 2) 重新生成：自动累加规则直接生效；带条件规则按条件判定；档位规则按选中项生效
  const now = Date.now()
  const rows: PointLedger[] = []
  for (const rec of records) {
    if (rec.status !== 'done') continue
    for (const rule of rules) {
      if (!rule.enabled || rule.points === 0) continue
      if (rule.mode === 'tier') {
        if (rec.selectedRuleId !== rule.id) continue
      } else if (rule.condition) {
        // 传 snapshot 让条件评估复用同一份表数据（避免逐条全表扫描）
        const hit = await evaluateCondition(rule.condition, rec.studentId, records, snapshot)
        if (!hit) continue
      }
      rows.push(
        withSyncFields<PointLedger>({
          studentId: rec.studentId,
          delta: rule.points,
          kind: 'earn',
          reason: `${task.title} · ${rule.name}`,
          taskId: task.id,
          createdAt: now,
        }),
      )
    }
  }
  if (rows.length > 0) await db.pointLedgers.bulkPut(rows)
  return rows.length
}

// ============================================================
// 兑换
// ============================================================

export interface RedeemResult {
  ok: boolean
  message: string
}

/**
 * 兑换奖励：校验积分充足与库存 → 扣积分（写 spend 流水）+ 建兑换记录。
 * 兑换记录初始状态为 pending（待发放），由老师在核销时改为 fulfilled。
 */
export async function redeemReward(
  studentId: string,
  rewardItemId: string,
): Promise<RedeemResult> {
  // ⚠ 「读库存 → 校验 → 写回」必须包在**同一事务**里，并在事务内重读库存。
  //   否则两个并发兑换都会读到旧 stock 并通过校验，各自写回 stock-1（覆盖写丢一次扣减），
  //   结果是「1 个库存卖出 2 份、扣两次积分」（v26 审查实证：P3）。
  return db.transaction(
    'rw',
    db.rewardItems,
    db.students,
    db.pointLedgers,
    db.redemptions,
    async () => {
      const [item, student, balance] = await Promise.all([
        db.rewardItems.get(rewardItemId),
        db.students.get(studentId),
        computeBalance(studentId),
      ])
      if (!item || item.deletedAt) return { ok: false as const, message: '奖励项不存在' }
      if (!item.enabled) return { ok: false as const, message: '该奖励已下架' }
      if (!student) return { ok: false as const, message: '学生不存在' }
      if (balance.balance < item.pointsCost) {
        return {
          ok: false as const,
          message: `积分不足：需要 ${item.pointsCost} 分，当前 ${balance.balance} 分`,
        }
      }
      if (item.stock !== null && item.stock <= 0) {
        return { ok: false as const, message: '库存不足' }
      }

      const now = Date.now()
      const cost = item.pointsCost
      await db.pointLedgers.put(
        withSyncFields<PointLedger>({
          studentId,
          delta: -cost,
          kind: 'spend',
          reason: `兑换：${item.name}`,
          taskId: null,
          createdAt: now,
        }),
      )
      await db.redemptions.put(
        withSyncFields<Redemption>({
          studentId,
          rewardItemId: item.id,
          rewardName: item.name,
          pointsSpent: cost,
          status: 'pending',
          redeemedAt: now,
          fulfilledAt: null,
          note: '',
          createdAt: now,
        }),
      )
      if (item.stock !== null) {
        await db.rewardItems.put(touch({ ...item, stock: item.stock - 1 }))
      }
      return { ok: true as const, message: `兑换成功，消耗 ${cost} 积分` }
    },
  )
}

/** 手动调整积分（老师加/减分，写 adjust 流水） */
export async function adjustPoints(
  studentId: string,
  delta: number,
  reason: string,
): Promise<string | null> {
  if (!delta) return null
  const ledger = withSyncFields<PointLedger>({
    studentId,
    delta,
    kind: 'adjust',
    reason: reason.trim() || '手动调整',
    taskId: null,
    createdAt: Date.now(),
  })
  await db.pointLedgers.put(ledger)
  // 返回流水 id：课堂积分等场景据此记录来源，撤销时可精确冲销
  return ledger.id
}

// ============================================================
// 打卡批次创建
// ============================================================

/**
 * 创建一个打卡任务，并预生成参与学生 × 打卡天的记录（默认 pending）。
 * @param scope course=指定课程成员；group=指定班课成员；all=全体在读学生
 * @param memberIds 已解析好的目标学生 id 列表（course/group 模式，调用方负责解析）
 * @param days 打卡日零点时间戳集合；单次任务传 1 个元素
 */
export async function createCheckInTask(input: {
  courseId: string | null
  groupId: string | null
  title: string
  dueAt: number | null
  scope: 'course' | 'group' | 'all'
  note: string
  cadenceLabel: string
  /** 参与学生 studentId 列表（course / group 模式传入） */
  memberIds: string[]
  /** 打卡日零点时间戳；缺省时用 dueAt 所在日 */
  days: number[]
  /** 本任务适用的打卡规则 id（v20）；缺省时不写，按「全部启用规则」处理 */
  ruleIds?: string[]
  /** v21：是否为「完成课程」自动生成（取消完成时据此清理） */
  auto?: boolean
  /** all 模式下的在读学生列表 */
  activeStudents?: Student[]
}): Promise<{ task: CheckInTask; created: number }> {
  const now = Date.now()
  // 打卡日兜底：没传 days 时用 dueAt 所在日（保留旧单次行为）
  const daySet =
    input.days.length > 0
      ? Array.from(new Set(input.days.map((d) => startOfDay(new Date(d)).getTime())))
      : input.dueAt
        ? [startOfDay(new Date(input.dueAt)).getTime()]
        : []
  const task = withSyncFields<CheckInTask>({
    courseId: input.courseId,
    groupId: input.groupId,
    title: input.title.trim() || '课后打卡',
    dueAt: input.dueAt,
    scope: input.scope,
    days: daySet,
    cadenceLabel: input.cadenceLabel.trim() || '单次打卡',
    note: input.note.trim(),
    ...(input.ruleIds ? { ruleIds: input.ruleIds } : {}),
    // v21：标记「完成课程自动生成」，供「取消完成」精确回收
    ...(input.auto ? { auto: true } : {}),
    createdAt: now,
  })
  await db.checkInTasks.put(task)

  const ids =
    input.scope === 'all'
      ? (input.activeStudents ?? []).map((s) => s.id)
      : input.memberIds
  const uniq = Array.from(new Set(ids))
  const rows: CheckInRecord[] = []
  const anchor = daySet.length > 0 ? daySet : [null]
  for (const sid of uniq) {
    for (const day of anchor) {
      rows.push(
        withSyncFields<CheckInRecord>({
          taskId: task.id,
          studentId: sid,
          dayAt: day,
          status: 'pending',
          note: '',
          aiFeedback: '',
          checkedAt: null,
          // v-next：打卡时固化「当天对应打卡任务」内容快照，任务被改/删后历史仍自包含
          taskSnapshot: { title: task.title, note: task.note, cadenceLabel: task.cadenceLabel },
          createdAt: now,
        }),
      )
    }
  }
  if (rows.length > 0) await db.checkInRecords.bulkPut(rows)
  return { task, created: rows.length }
}

/**
 * 解析打卡记录对应的任务内容（v-next）。
 * 优先用记录内固化的 `taskSnapshot`（打卡时快照，历史不随任务编辑漂移），
 * 缺则回退按 `taskId` 关联传入的任务对象（兼容旧数据 / 快照缺失）。
 * 返回 `{ title, note }` 或 `undefined`（无任何任务上下文时）。
 */
export function resolveCheckInTaskContent(
  record: Pick<CheckInRecord, 'taskSnapshot' | 'taskId'>,
  task?: CheckInTask | null,
): { title: string; note: string } | undefined {
  if (record.taskSnapshot && (record.taskSnapshot.title || record.taskSnapshot.note)) {
    return { title: record.taskSnapshot.title, note: record.taskSnapshot.note }
  }
  if (task && (task.title || task.note)) {
    return { title: task.title, note: task.note }
  }
  return undefined
}

/** 把打卡日集合格式化为用户可读的节奏文案 */
export function formatCadenceLabel(days: number[]): string {
  if (days.length === 0) return '未设置打卡日'
  if (days.length === 1) return '单次打卡'
  const sorted = [...days].sort((a, b) => a - b)
  const DAY = 86_400_000
  const consecutive = sorted.every((d, i) => i === 0 || d - sorted[i - 1] === DAY)
  return consecutive ? `每天打卡 · ${days.length} 天` : `自定义 · ${days.length} 天`
}

/**
 * 编辑打卡任务：更新标题/备注/打卡日，并按新旧打卡日差异同步增删记录。
 *  - 移除的天：该任务这些天的记录软删（含已打卡的，编辑日期是明确操作）
 *  - 新增的天：为任务现有参与学生补 pending 记录
 *  - 最后幂等重算积分，避免删掉已打卡记录后积分虚高
 */
export async function updateCheckInTaskDays(
  task: CheckInTask,
  nextDays: number[],
  patch?: { title?: string; note?: string; ruleIds?: string[] },
): Promise<void> {
  const days = Array.from(
    new Set(nextDays.map((d) => startOfDay(new Date(d)).getTime())),
  ).sort((a, b) => a - b)
  const now = Date.now()
  await db.checkInTasks.put(
    touch({
      ...task,
      ...(patch?.title !== undefined ? { title: patch.title.trim() || task.title } : {}),
      ...(patch?.note !== undefined ? { note: patch.note.trim() } : {}),
      ...(patch?.ruleIds !== undefined ? { ruleIds: patch.ruleIds } : {}),
      days,
      cadenceLabel: formatCadenceLabel(days),
    }),
  )

  const recs = (await db.checkInRecords.toArray()).filter(
    (r) => !r.deletedAt && r.taskId === task.id,
  )
  const daySet = new Set(days)
  // 参与学生 = 现有记录里出现过的学生（保持参与范围稳定）
  const studentIds = Array.from(new Set(recs.map((r) => r.studentId)))

  for (const r of recs) {
    if (r.dayAt !== null && !daySet.has(r.dayAt)) {
      await db.checkInRecords.put(touch({ ...r, deletedAt: now }))
    }
  }
  const kept = new Set(
    recs
      .filter((r) => r.dayAt !== null && daySet.has(r.dayAt))
      .map((r) => `${r.studentId}::${r.dayAt}`),
  )
  const rows: CheckInRecord[] = []
  for (const sid of studentIds) {
    for (const day of days) {
      if (kept.has(`${sid}::${day}`)) continue
      rows.push(
        withSyncFields<CheckInRecord>({
          taskId: task.id,
          studentId: sid,
          dayAt: day,
          status: 'pending',
          note: '',
          aiFeedback: '',
          checkedAt: null,
          // v-next：补天记录同样固化任务快照（沿用当时任务内容）
          taskSnapshot: { title: task.title, note: task.note, cadenceLabel: task.cadenceLabel },
          createdAt: now,
        }),
      )
    }
  }
  if (rows.length > 0) await db.checkInRecords.bulkPut(rows)
  await recomputeTaskPoints(task.id)
}

/**
 * 课程完成后自动创建「课后打卡」周期任务（幂等：每门课程只建一次）。
 * 打卡日 = 下课次日起连续 7 天；参与者 = 本次实际出勤的学生（无出席数据时回退）。
 *
 * v30.2 去重修正：**只被「存活」任务阻挡**。此前的判定把「任何非 revert 的墓碑」
 * （老版本 markDeleted 未写 reason 的 undefined、或被旧版取消完成误标为 manual 的墓碑）
 * 都当成「已存在」而永久跳过 —— 于是「完成 → 取消 → 再完成」后再也不生成打卡，
 * 且旧墓碑无法自动修复（用户实测：打卡与课堂活动同时消失）。
 * 完成上课是老师的明确动作，理应始终为该课补齐自动打卡；墓碑一律不阻断重建。
 */
export async function ensureAutoCheckInTask(input: {
  courseId: string
  groupId: string | null
  /** 下课时间戳（用于推算打卡周期起点） */
  courseEndAt: number
  /** 任务标题（会加「课后打卡 · 」前缀） */
  title: string
  /** 本次实际出勤的学生 id */
  presentStudentIds: string[]
  /** 出席数据缺失时的回退名单（班课全员 / 单个学生） */
  fallbackStudentIds: string[]
}): Promise<{ created: boolean }> {
  const existing = (await db.checkInTasks.toArray()).find(
    (t) => t.courseId === input.courseId && !t.deletedAt,
  )
  if (existing) return { created: false }

  const ids = Array.from(
    new Set(input.presentStudentIds.length > 0 ? input.presentStudentIds : input.fallbackStudentIds),
  )
  if (ids.length === 0) return { created: false }

  const DAY = 86_400_000
  const WD_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  // v8：读取班课的「自动打卡」配置（班课设置里可调；1对1 或未配置时走默认 7 天 / 次日起）
  let cycleDays = 7
  let startOffset = 1
  /** 限定打卡日落在这些星期几（0=周日~6=周六）；为空=按自然日连续 */
  let weekdays: number[] = []
  if (input.groupId) {
    const g = await db.groups.get(input.groupId)
    if (g) {
      // 该班课关闭了自动打卡
      if (g.checkInAuto === false) return { created: false }
      cycleDays = Math.max(1, Math.min(30, Math.floor(g.checkInDays ?? 7) || 7))
      startOffset = Math.max(
        0,
        Math.min(30, Math.floor(g.checkInStartOffset ?? 1) || 0),
      )
      if (Array.isArray(g.checkInWeekdays)) {
        weekdays = Array.from(
          new Set(g.checkInWeekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)),
        ).sort((a, b) => a - b)
      }
    }
  }
  const day0 = startOfDay(new Date(input.courseEndAt)).getTime()
  const days: number[] = []
  if (weekdays.length > 0) {
    // 限定星期几：从起始日起向后取落在所选星期几的日期，共 cycleDays 天
    const allow = new Set(weekdays)
    const limit = startOffset + cycleDays * 7 + 7
    for (let i = startOffset; i <= limit && days.length < cycleDays; i++) {
      const d = day0 + i * DAY
      if (allow.has(new Date(d).getDay())) days.push(d)
    }
  } else {
    for (let i = 0; i < cycleDays; i++) days.push(day0 + (startOffset + i) * DAY)
  }
  if (days.length === 0) return { created: false }
  const offsetText = startOffset === 0 ? '下课当日起' : `第 ${startOffset + 1} 天起`
  const weekdayText =
    weekdays.length > 0
      ? `，限 ${weekdays.map((d) => WD_LABELS[d]).join('/')}`
      : ''
  await createCheckInTask({
    courseId: input.courseId,
    groupId: input.groupId,
    title: `课后打卡 · ${input.title}`,
    dueAt: null,
    scope: 'course',
    note: `课程完成后自动创建（${cycleDays} 天，${offsetText}${weekdayText}）；可在「班课设置 → 课后自动打卡」调整，也可在打卡页改日期`,
    cadenceLabel: formatCadenceLabel(days),
    memberIds: ids,
    days,
    // 与手动创建的任务保持一致：固化创建时的规则集，
    // 否则后续新增的规则会「追溯」影响这个历史任务（历史积分悄悄变化）。
    ruleIds: await defaultCheckInRuleIds(),
    auto: true,
  })
  return { created: true }
}

/**
 * v30.3 自愈：打开打卡页时，为「今天已完成」的班课补上缺失的「课后自动打卡」任务。
 *
 * 背景：自动打卡只在「完成课程」那一刻创建；若那一步静默失败、任务又被
 * 「取消完成」回收过（或历史版本留下墓碑），老师打开打卡页时就会觉得
 * 「完成 → 取消 → 再完成」后打卡没了。这里做一次幂等补偿：
 *  - 只针对**今天已完成**的班课课程（未完成 / 已取消的课不补 —— 那是老师的明确意图）；
 *  - 该课已有存活任务 → 跳过；
 *  - 班课关掉了「课后自动打卡」→ 跳过。
 *
 * 幂等、可重复调用；失败不抛（由调用方兜底）。
 */
export async function ensureTodayAutoCheckInTasks(
  dayAt: number = Date.now(),
): Promise<{ created: number }> {
  const dayStart = startOfDay(new Date(dayAt)).getTime()
  const [courses, groups, tasks, members, atts] = await Promise.all([
    db.courses.toArray(),
    db.groups.toArray(),
    db.checkInTasks.toArray(),
    db.groupMembers.toArray(),
    db.courseAttendances.toArray(),
  ])
  const doneToday = courses.filter(
    (c) =>
      !c.deletedAt &&
      !!c.groupId &&
      c.status === 'done' &&
      startOfDay(new Date(c.startAt)).getTime() === dayStart,
  )
  if (doneToday.length === 0) return { created: 0 }

  const groupMap = new Map(groups.filter((g) => !g.deletedAt).map((g) => [g.id, g]))
  let created = 0
  for (const c of doneToday) {
    // 已有存活任务 → 幂等跳过
    if (tasks.some((t) => t.courseId === c.id && !t.deletedAt)) continue
    const g = c.groupId ? groupMap.get(c.groupId) : undefined
    if (!g) continue
    if (g.checkInAuto === false) continue
    const presentIds = atts
      .filter((a) => !a.deletedAt && a.courseId === c.id && a.present)
      .map((a) => a.studentId)
    const memberIds = members
      .filter((m) => !m.deletedAt && m.groupId === g.id)
      .map((m) => m.studentId)
    if (presentIds.length === 0 && memberIds.length === 0) continue
    try {
      const res = await ensureAutoCheckInTask({
        courseId: c.id,
        groupId: g.id,
        courseEndAt: c.startAt + Math.max(0, c.durationMin || 0) * 60_000,
        title: g.name,
        presentStudentIds: presentIds,
        fallbackStudentIds: memberIds,
      })
      if (res.created) created += 1
    } catch {
      // 单个班课失败不影响其它班课
    }
  }
  return { created }
}

/** 更新单条打卡记录（状态 / 备注 / 计分档位），并幂等重算该批次积分 */
export async function updateCheckInRecord(
  record: CheckInRecord,
  patch: {
    status?: CheckInRecord['status']
    note?: string
    selectedRuleId?: string | null
  },
): Promise<void> {
  // 显式比较 status 是否在合法集合里，避免 'pending' 这种"真值字符串但语义陷阱"的写法
  const statusNext =
    patch.status && ['pending', 'done', 'missed'].includes(patch.status)
      ? patch.status
      : undefined
  const next: CheckInRecord = {
    ...record,
    ...(statusNext ? { status: statusNext } : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    ...(patch.selectedRuleId !== undefined
      ? { selectedRuleId: patch.selectedRuleId }
      : {}),
    checkedAt:
      statusNext === 'done'
        ? record.checkedAt ?? Date.now()
        : statusNext
          ? null
          : record.checkedAt,
  }
  await db.checkInRecords.put(touch(next))
  await recomputeTaskPoints(record.taskId)
}

/**
 * 删除打卡批次（连同其记录与积分流水）。
 *
 * ⚠️ 一律走**软删**：保留墓碑（deletedAt + dirty=1）才能把删除推到云端。
 * 早先这里是物理删除，导致云端仍保留任务、换设备/清缓存后「复活」。
 * 本地墓碑由 sync.ts 在推送成功后清理；纯本地模式由启动时的 purgeTombstones 回收。
 *
 * @param opts.reason 'manual'（默认，老师手动删）| 'revert'（取消完成时的自动回收）
 */
export async function deleteCheckInTask(
  taskId: string,
  opts?: { reason?: 'manual' | 'revert' },
): Promise<void> {
  const reason = opts?.reason ?? 'manual'
  const [records, ledgers] = await Promise.all([
    db.checkInRecords.toArray(),
    db.pointLedgers.toArray(),
  ])
  const recs = records.filter((r) => !r.deletedAt && r.taskId === taskId)
  if (recs.length > 0) {
    await db.checkInRecords.bulkPut(recs.map((r) => markDeleted(r)))
  }
  const lgs = ledgers.filter((l) => !l.deletedAt && l.taskId === taskId)
  if (lgs.length > 0) await db.pointLedgers.bulkPut(lgs.map((l) => markDeleted(l)))
  const task = await db.checkInTasks.get(taskId)
  if (task && !task.deletedAt) {
    await db.checkInTasks.put(markDeleted({ ...task, deletedReason: reason }))
  }
}

/**
 * 一次性迁移（v23）：把「没有 ruleIds」的旧打卡任务固化为「迁移当时启用的规则集」。
 *
 * 背景：无 ruleIds 的任务会回退成「所有启用的打卡规则」，于是老师之后新增一条规则，
 * 历史任务在重算时会一并吸收 → 历史积分悄悄变化。固化后历史不再漂移。
 *
 * 幂等：只处理 `ruleIds === undefined` 的任务；已固化/已被老师显式清空（[]）的不动。
 */
export async function ensureCheckInRuleBindings(): Promise<number> {
  const [tasks, rules] = await Promise.all([
    db.checkInTasks.toArray(),
    db.pointRules.toArray(),
  ])
  const legacy = tasks.filter((t) => !t.deletedAt && t.ruleIds === undefined)
  if (legacy.length === 0) return 0
  const ids = rules
    .filter((r) => !r.deletedAt && isCheckinRule(r) && r.enabled)
    .sort((a, b) => a.order - b.order)
    .map((r) => r.id)
  const now = Date.now()
  await db.checkInTasks.bulkPut(
    legacy.map((t) => ({ ...t, ruleIds: ids, updatedAt: now, dirty: 1 as const })),
  )
  return legacy.length
}
