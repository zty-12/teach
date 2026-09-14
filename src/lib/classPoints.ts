/**
 * 课堂积分业务逻辑（v20）
 * ------------------------------------------------------------
 * 场景：课上检查背诵/听写等，教师标记「过关 / 未过关」，按规则自动计分。
 *
 * 设计要点：
 *  1) **规则集中在「积分规则」页**（pointRules，scope='class'）。活动通过 ruleIds 引用，
 *     同一活动可混用「自动累加」与「手动档位」两类规则：
 *       - auto：达标学生自动加分（如「过关 +1」「第一个过关额外 +1」「前 3 名 +2」）
 *       - tier：标记学生时手动选一条（如「背诵熟练 +1 / 不熟练 +0.5」），
 *               选择结果记在 ClassActivityRecord.selectedRuleId 上
 *  2) 计分复用 pointLedgers 流水（与打卡积分同一账户体系），
 *     每条课堂加分都记下 ledgerId，撤销/改判/换档时精确冲销，不留残分。
 *  3) 名次与积分「整体重算」：任何一次标记/改判/撤销后调用 resettleActivity，
 *     按过关时间升序重排名次并重算所有人得分（名次仅用于展示与名次类规则）。
 *  4) 兼容旧数据：没有 ruleIds 的历史活动仍按内嵌 rules 计分，行为完全不变。
 *  5) 自动生成：班课按排课当天自动建活动（用当前启用的课堂规则）。
 */
import { startOfDay } from 'date-fns'
import { db, markDeleted, touch, withSyncFields } from './db'
import { adjustPoints } from './points'
import type {
  ClassActivity,
  ClassActivityRecord,
  ClassRuleConditionSpec,
  ClassRuleSnapshotItem,
  PointRule,
} from './types'

/**
 * 归一化后的课堂规则：库规则引用 or 旧版内嵌规则，引擎只认这个形状。
 * 结构与持久化快照 `ClassRuleSnapshotItem`（types.ts）完全一致，
 * 因此 `resolveClassRules`（优先读快照时可把快照数组直接当 ResolvedClassRule[] 返回）。
 */
export interface ResolvedClassRule extends ClassRuleSnapshotItem {}

/** 新建课堂活动时的默认计分规则（库为空时补齐用） */
export const DEFAULT_CLASS_RULES: ClassRuleConditionSpec[] = [
  { condition: 'pass' },
  { condition: 'first' },
]
export const DEFAULT_CLASS_RULE_NAMES = ['过关', '第一个额外']

/**
 * 解析一个活动实际生效的规则列表。
 *
 * 优先序（v29 起）：
 *  1. 有 `classRuleSnapshot`（含空数组）→ 直接用它。这是历史积分不随规则编辑漂移的保证；
 *  2. 有 ruleIds（含空数组）→ 从规则库取这些（空数组 = 明确不引用任何规则）；
 *  3. 无 ruleIds（undefined）→ 回退到旧版内嵌 rules（历史活动兼容）。
 *
 * 注意：`[]` 与 `undefined` 语义不同 —— 规则全清空写 `[]`，旧数据为 `undefined`。
 */
export function resolveClassRules(
  activity: ClassActivity,
  lib: PointRule[],
): ResolvedClassRule[] {
  // v29：优先读固化快照 —— 历史分值不随规则库后续编辑漂移
  if (Array.isArray(activity.classRuleSnapshot)) {
    return activity.classRuleSnapshot
  }
  const ids = activity.ruleIds
  if (Array.isArray(ids)) {
    const map = new Map(lib.map((r) => [r.id, r]))
    const out: ResolvedClassRule[] = []
    for (const id of ids) {
      const r = map.get(id)
      if (!r || r.deletedAt) continue
      const spec = r.classCondition
      out.push({
        id: r.id,
        name: r.name,
        points: r.points,
        mode: r.mode ?? 'auto',
        condition: spec?.condition ?? null,
        rankN: spec?.rankN,
        rankFrom: spec?.rankFrom,
        rankTo: spec?.rankTo,
        customText: spec?.customText,
        enabled: r.enabled,
        fromLibrary: true,
      })
    }
    return out
  }
  return (activity.rules ?? []).map((r, i) => ({
    id: `legacy:${i}`,
    name: r.name,
    points: r.points,
    mode: 'auto' as const,
    condition: r.condition,
    rankN: r.rankN,
    rankFrom: r.rankFrom,
    rankTo: r.rankTo,
    enabled: r.enabled,
    fromLibrary: false,
  }))
}

/** 取活动里所有处于「手动档位」模式的启用规则 */
export function tierRules(rules: ResolvedClassRule[]): ResolvedClassRule[] {
  return rules.filter((r) => r.mode === 'tier' && r.enabled)
}

/**
 * v30.2「按钮覆盖」判定：这条规则是否属于**手动覆盖**类（而非按条件自动累加）。
 *
 *  - `mode === 'tier'`（旧版手动档位）→ 覆盖类；
 *  - `condition === 'custom'`（自定义加分条件）→ 覆盖类 —— 自定义条件无法自动求值，
 *    只能由老师点按钮手动指定。
 *  其余（pass/fail/first/topN/rank/range 或无条件的自动累加规则）→ 自动累加类。
 *
 * 语义差异（见 resettleActivity）：
 *  - 覆盖类被点选 → 该生得分**只取这条规则的分值**；
 *  - 自动累加类被点选 → 只标记学生的过关/未过关状态，得分仍由全部自动规则按条件累加。
 */
export function isOverrideRule(r: ResolvedClassRule): boolean {
  return r.mode === 'tier' || r.condition === 'custom'
}

/**
 * 确保某活动已固化「课堂规则快照」（v29）。
 *
 * 任一写入入口（改判 / 换档）在计算前调用：
 *  - 库里已有 `classRuleSnapshot` → 直接返回库里对象（快照一旦写入即权威，永不被覆盖）；
 *  - 库里无快照（历史活动 / 尚未触碰）→ 用当前解析出的 rules 写回快照，
 *    从这一刻起该活动的历史分值固化，之后规则库怎么改都不再影响它。
 *
 * ⚠ 判定必须**以库为准**：调用方传入的活动对象可能是旧内存快照（useLiveQuery 尚未刷新），
 * 若用它判断「是否有快照」，会拿新规则覆盖已固化的旧快照 —— 快照就失效了。
 *
 * 返回更新后的活动对象（调用方应优先用它，保证拿到最新快照）。
 */
export async function ensureClassRuleSnapshot(
  activity: ClassActivity,
  rules: ResolvedClassRule[],
): Promise<ClassActivity> {
  const fresh = (await db.classActivities.get(activity.id)) ?? activity
  if (Array.isArray(fresh.classRuleSnapshot)) return fresh
  const updated = touch({
    ...fresh,
    classRuleSnapshot: rules,
  })
  await db.classActivities.put(updated)
  return updated
}

/**
 * 从快照 / 规则库解析出的规则列表构建持久化快照项（用于新建活动时直接固化）。
 * 底层等同 resolveClassRules 的结果，暴露出来便于「引擎解得数、调用方落快照」。
 */
export function snapshotFromRules(rules: ResolvedClassRule[]): ClassRuleSnapshotItem[] {
  return rules
}

/**
 * 按 ruleIds 从规则库解析并构建快照（v29，新建活动时固化「当时生效」的课堂规则）。
 * 无 ruleIds（undefined）时返回 undefined（沿用旧版内嵌规则路径，不固快照）；
 * 返回空数组表示「明确不引用任何规则」（老师把规则全清空）。
 */
export async function buildSnapshotForRuleIds(
  ruleIds?: string[],
): Promise<ClassRuleSnapshotItem[] | undefined> {
  if (!Array.isArray(ruleIds)) return undefined
  const rules = await db.pointRules.toArray()
  const map = new Map(rules.map((r) => [r.id, r]))
  const out: ClassRuleSnapshotItem[] = []
  for (const id of ruleIds) {
    const r = map.get(id)
    if (!r || r.deletedAt) continue
    const spec = r.classCondition
    out.push({
      id: r.id,
      name: r.name,
      points: r.points,
      mode: r.mode ?? 'auto',
      condition: spec?.condition ?? null,
      rankN: spec?.rankN,
      rankFrom: spec?.rankFrom,
      rankTo: spec?.rankTo,
      customText: spec?.customText,
      enabled: r.enabled,
      fromLibrary: true,
    })
  }
  return out
}

// ============================================================
// 计分核心
// ============================================================

/**
 * 判断一条「自动累加」规则是否命中某学生的状态 / 名次。
 * @param rank 过关名次（1 起）；未过关或待检查时为 0
 */
function condHit(rule: ResolvedClassRule, rank: number, status: 'pass' | 'fail'): boolean {
  // 无条件：所有过关学生都加
  if (rule.condition === null) return status === 'pass'
  if (rule.condition === 'fail') return status === 'fail'
  // v30.2：自定义条件无法自动求值 —— 一律由老师点按钮手动覆盖，不参与自动累加。
  if (rule.condition === 'custom') return false
  if (status !== 'pass' || rank < 1) return false
  switch (rule.condition) {
    case 'pass':
      return true
    case 'first':
      return rank === 1
    case 'topN':
      return rank <= Math.max(1, rule.rankN ?? 1)
    case 'rank':
      return rank === Math.max(1, rule.rankN ?? 1)
    case 'range': {
      const from = Math.max(1, rule.rankFrom ?? 1)
      const to = Math.max(from, rule.rankTo ?? from)
      return rank >= from && rank <= to
    }
    default:
      return false
  }
}

/**
 * 计算某学生在某状态 / 名次下应得积分。
 * @param rank 过关名次，从 1 开始（1 = 第一个过关）；未过关 / 待检查传 0
 * @param status 学生状态，默认按「过关」计算
 * @param selectedRuleId 该学生选中的档位规则 id（mode='tier' 的规则据此计分）
 */
export function awardedPoints(
  rules: ResolvedClassRule[],
  rank: number,
  status: 'pass' | 'fail' = 'pass',
  selectedRuleId?: string | null,
): number {
  let total = 0
  for (const r of rules) {
    if (!r.enabled) continue
    if (r.mode === 'tier') {
      // 档位规则：老师选中的那条生效
      if (selectedRuleId && selectedRuleId === r.id) total += r.points
      continue
    }
    if (condHit(r, rank, status)) total += r.points
  }
  return total
}

/**
 * 只取某「档位规则」自身的分值（忽略所有自动规则）。
 * 用于「档位」独立态（如 不熟练 +0.5）：该态既不走过关加分、也不走未过关的自动加分，
 * 只拿这一档的分值 —— 对应 UI 上的第三个按钮「不熟练」。
 */
function tierOnlyPoints(rules: ResolvedClassRule[], tierId: string): number {
  const r = rules.find((x) => x.mode === 'tier' && x.enabled && x.id === tierId)
  return r ? r.points : 0
}

/** 已过关记录按「过关时间升序」排列：index 0 即第一个过关的学生 */
export function passedOrder(records: ClassActivityRecord[]): ClassActivityRecord[] {
  return records
    .filter((r) => r.status === 'pass')
    .sort((a, b) => (a.checkedAt ?? 0) - (b.checkedAt ?? 0))
}

/**
 * v30.2（UI 用）：判断某条**自动累加类**规则此刻是否命中该学生，
 * 用于学生行按钮上的「已生效」标识。覆盖类规则恒返回 false（由选中态决定高亮）。
 */
export function ruleAppliesNow(
  rule: ResolvedClassRule,
  rank: number,
  status: 'pending' | 'pass' | 'fail',
): boolean {
  if (!rule.enabled) return false
  if (isOverrideRule(rule)) return false
  if (status === 'pending') return false
  return condHit(rule, rank, status)
}

/** 学生在活动中当前的名次（1 起）；未过关返回 0 */
export function rankOf(records: ClassActivityRecord[], studentId: string): number {
  const idx = passedOrder(records).findIndex((r) => r.studentId === studentId)
  return idx < 0 ? 0 : idx + 1
}

/**
 * 预览：若此刻把某学生标为「过关」，他能拿多少分（不含档位选择）。
 * 用于学生行上的「+N 分」提示，避免老师误判规则。
 */
export function previewPassPoints(
  activity: ClassActivity,
  rules: ResolvedClassRule[],
  records: ClassActivityRecord[],
  studentId: string,
): number {
  const siblings = records.filter(
    (r) => r.activityId === activity.id && !r.deletedAt && r.studentId !== studentId,
  )
  return awardedPoints(rules, passedOrder(siblings).length + 1, 'pass', null)
}

// ============================================================
// 写入：标记 / 撤销 / 换档 / 重算
// ============================================================

/** 冲销一条积分流水（软删，随同步传播） */
async function revokeLedger(ledgerId: string | null | undefined): Promise<void> {
  if (!ledgerId) return
  const l = await db.pointLedgers.get(ledgerId)
  if (!l || l.deletedAt) return
  await db.pointLedgers.put(markDeleted(l))
}

/**
 * 重算整个活动：按过关时间升序重排名次、重算每人得分，
 * 先冲销旧流水再按新结果写入（幂等）。
 *
 * @param allRecords 该活动的最新记录集合（调用方负责含刚写入的那条）
 * @param opts.force   需要强制重算的记录 id（如换档后，即使分值相同也重建流水事由）
 */
export async function resettleActivity(
  activity: ClassActivity,
  allRecords: ClassActivityRecord[],
  opts: { rules: ResolvedClassRule[]; force?: Set<string> },
): Promise<void> {
  const rules = opts.rules
  const siblings = allRecords.filter(
    (r) => r.activityId === activity.id && !r.deletedAt,
  )
  const rankMap = new Map(
    passedOrder(siblings).map((r, i) => [r.studentId, i + 1]),
  )
  // v30.2：规则按钮「自动累加 + 手动覆盖」模型 ——
  //   · selectedRuleId 非空 = 该生被**手动覆盖**为某条规则 → 得分只取该规则分值；
  //   · selectedRuleId 为空 = **自动累加** → 按 status/名次 + 各规则的加分条件累加。
  const ruleName = new Map(rules.map((r) => [r.id, r.name]))
  // v30.2：当前活动生效的规则 id 集合。
  // selectedRuleId 可指向「任意」生效规则（含自动累加类）；只有当所选规则已不在 rules 中
  // （被删 / ruleIds 被改）时才算悬空，需清空并按自动累加重算。
  const ruleIds = new Set(rules.map((r) => r.id))

  const updates: ClassActivityRecord[] = []
  for (const rec of siblings) {
    const rank = rankMap.get(rec.studentId) ?? 0
    // 悬空判定：选中的规则已不在当前活动规则集合（已删/失效）时，按「自动累加」重算并清空失效引用，
    // 避免历史分值凭空消失、又永久残留一条悬空 id。
    const staleTier = Boolean(rec.selectedRuleId) && !ruleIds.has(rec.selectedRuleId!)
    const effectiveSelected = staleTier ? null : rec.selectedRuleId
    // v30.2 计分优先级：
    //  1) 手动覆盖（selectedRuleId）→ 只取该规则分值；
    //  2) 否则按 status/名次 + 条件**自动累加**（兼容历史遗留数据）：
    //       · 过关 → 全部「过关类」自动规则按名次累加（如 过关+1、第一个额外+1 → 第一名 +2）；
    //       · 未过关 → 有档位时只按该档位，否则按「未过关者加」；
    //       · 待检查 → 0。
    let expected: number
    if (rec.selectedRuleId) {
      const sel = rules.find((r) => r.id === rec.selectedRuleId)
      expected = sel ? sel.points : 0
    } else if (rec.status === 'pass') {
      expected = awardedPoints(rules, rank, 'pass', effectiveSelected)
    } else if (rec.status === 'fail') {
      expected = effectiveSelected
        ? tierOnlyPoints(rules, effectiveSelected)
        : awardedPoints(rules, 0, 'fail', null)
    } else {
      expected = 0
    }
    const hasLedger = Boolean(rec.ledgerId)
    const forced = opts.force?.has(rec.id) ?? false
    // 结果未变化则跳过，避免每次标记都产生新流水
    if (!forced && expected === (rec.pointsAwarded ?? 0) && (expected > 0) === hasLedger) {
      continue
    }

    await revokeLedger(rec.ledgerId)
    const suffix = rec.selectedRuleId ? ruleName.get(rec.selectedRuleId) : undefined
    const ledgerId =
      expected !== 0
        ? await adjustPoints(
            rec.studentId,
            expected,
            `课堂积分 · ${activity.title}${suffix ? ` · ${suffix}` : ''}`,
          )
        : null
    updates.push(touch({ ...rec, pointsAwarded: expected, ledgerId, ...(staleTier ? { selectedRuleId: null } : {}) }))
  }
  if (updates.length > 0) await db.classActivityRecords.bulkPut(updates)
}

/**
 * 设置某学生的状态（过关 / 未过关 / 待检查），随后整体重算名次与积分。
 * 撤销（→ pending）后，后面学生的名次会自动前移。
 *
 * v29 并发安全：同活动的写串行化（活动级队列），配合「从库重读」，
 * 彻底消除并发过关时的名次错乱与重复发流水（两个 resettle 对同一批记录并发改时的竞态）。
 */
export function setActivityStatus(
  activity: ClassActivity,
  record: ClassActivityRecord,
  status: 'pending' | 'pass' | 'fail',
  _allRecords: ClassActivityRecord[], // 保留签名兼容；v29 起从库重读，不再信任调用方快照
  rules: ResolvedClassRule[],
): Promise<void> {
  return serializeActivity(activity.id, () => doSetActivityStatus(activity, record, status, rules))
}

/** 设置某学生的「手动档位」（选中的 tier 规则 id；null = 不选），随后重算。 */
export function setActivityTier(
  activity: ClassActivity,
  record: ClassActivityRecord,
  ruleId: string | null,
  _allRecords: ClassActivityRecord[], // 保留签名兼容；v29 起从库重读
  rules: ResolvedClassRule[],
): Promise<void> {
  return serializeActivity(activity.id, () =>
    doSetActivityTier(activity, record, ruleId, rules),
  )
}

/**
 * 三态标记（v30，UI 用）：过关 / 未过关 / 重置为待检查。
 *
 * 与 `setActivityTier` 的区别：**三态互斥** —— 落状态时一并清空所选档位，
 * 避免出现「未过关 + 残留档位」这种半吊子状态（用户反馈：点过关后仍带着旧档位）。
 */
export function setActivityOutcome(
  activity: ClassActivity,
  record: ClassActivityRecord,
  status: 'pending' | 'pass' | 'fail',
  rules: ResolvedClassRule[],
): Promise<void> {
  return serializeActivity(activity.id, () =>
    doSetActivityStatus(activity, { ...record, selectedRuleId: null }, status, rules),
  )
}

/**
 * 三态标记（v30，UI 用）：把学生标为某个「档位」（如「不熟练 +0.5」）。
 *
 * 档位是独立的第三态：底层落 `status='fail' + selectedRuleId=tierId`，
 * 计分只按该档位（不叠加过关/未过关的自动规则，见 resettleActivity）。
 */
export function setActivityTierOutcome(
  activity: ClassActivity,
  record: ClassActivityRecord,
  tierId: string,
  rules: ResolvedClassRule[],
): Promise<void> {
  return serializeActivity(activity.id, () =>
    doSetActivityStatus(activity, { ...record, selectedRuleId: tierId }, 'fail', rules),
  )
}

/**
 * 规则按钮点击（v30.2，UI 用）：「自动累加 + 手动覆盖」。
 *
 * 活动引用的**每一条规则**都是学生行上的可选按钮，点击行为按规则类别分两种：
 *  - **覆盖类**（`mode='tier'` 或 `condition='custom'`）：
 *      点选 → 该生得分**只取这条规则的分值**（覆盖自动累加）；再点一次 → 取消覆盖、回到待检查。
 *  - **自动累加类**（过关/未过关/第N名/前N名/X~Y名 等可自动求值的条件）：
 *      点选 → 只把该生标记为「过关/未过关」（视条件而定），得分仍由**全部自动规则按条件累加**
 *      （如 过关+1 与 第一个额外+1 同时命中 → 第一名共 +2）。
 *      幂等：重复点击不取消（避免误清过关标记），清空请用 `ruleId=null`「撤销」。
 *
 * 传 `ruleId=null` 表示**撤销**：清空状态与覆盖，回到待检查。
 */
export function setActivityRuleOutcome(
  activity: ClassActivity,
  record: ClassActivityRecord,
  ruleId: string | null,
  rules: ResolvedClassRule[],
): Promise<void> {
  return serializeActivity(activity.id, () =>
    doSetActivityRuleOutcome(activity, record, ruleId, rules),
  )
}

async function doSetActivityRuleOutcome(
  activity: ClassActivity,
  record: ClassActivityRecord,
  ruleId: string | null,
  rules: ResolvedClassRule[],
): Promise<void> {
  const act = await ensureClassRuleSnapshot(activity, rules)
  const effectiveRules =
    Array.isArray(act.classRuleSnapshot) && act.classRuleSnapshot.length > 0
      ? ((act.classRuleSnapshot as ClassRuleSnapshotItem[]) as ResolvedClassRule[])
      : rules
  const sel = ruleId ? effectiveRules.find((r) => r.id === ruleId) ?? null : null
  // 以库中最新记录为准判断「是否已是当前选中态」（调用方传入的可能是过期快照）
  const fresh = (await db.classActivityRecords.get(record.id)) ?? record

  let updated: ClassActivityRecord
  if (!sel) {
    // 撤销：清空状态与覆盖，回到待检查
    updated = { ...fresh, selectedRuleId: null, status: 'pending', checkedAt: null }
  } else if (isOverrideRule(sel)) {
    const isActive = fresh.selectedRuleId === sel.id
    updated = isActive
      ? // 再点当前覆盖项 → 取消覆盖，回到待检查
        { ...fresh, selectedRuleId: null, status: 'pending', checkedAt: null }
      : // 覆盖为该规则：得分只取这条规则分值
        { ...fresh, selectedRuleId: sel.id, status: 'pass', checkedAt: Date.now() }
  } else {
    // 自动累加类：只标记状态（未过关条件 → 'fail'，其余 → 'pass'），得分走自动累加。
    // 幂等：重复点击不会取消（否则给已过关的学生点「第一个额外」会误清过关标记）；
    // 需要清空请用「撤销」。
    const target: 'pass' | 'fail' = sel.condition === 'fail' ? 'fail' : 'pass'
    if (fresh.status === target && !fresh.selectedRuleId) return
    updated = { ...fresh, selectedRuleId: null, status: target, checkedAt: Date.now() }
  }
  await db.classActivityRecords.put(touch(updated))
  const merged = await freshActivityRecords(activity.id, updated)
  await resettleActivity(act, merged, {
    rules: effectiveRules,
    force: new Set([updated.id]),
  })
}

/** 按活动 id 串行执行的 Promise 队列（v29）：同活动的写入线性化，避免并发重算竞态。 */
const activityQueue = new Map<string, Promise<unknown>>()

function serializeActivity<T>(activityId: string, task: () => Promise<T>): Promise<T> {
  const prev = activityQueue.get(activityId) ?? Promise.resolve()
  const run = prev.then(task, task)
  // 失败也清理，让后续排队者继续；把原始 promise 返回给调用方报错
  activityQueue.set(
    activityId,
    run.catch(() => {}),
  )
  return run
}

async function doSetActivityStatus(
  activity: ClassActivity,
  record: ClassActivityRecord,
  status: 'pending' | 'pass' | 'fail',
  rules: ResolvedClassRule[],
): Promise<void> {
  // v29：写入前先固化「该活动当时生效的规则快照」。
  // 若活动已有快照，传入的 rules 可能是从「已改后的规则库」实时解的，会污染重算；
  // 因此这里一律以固化快照为准（无快照时传入 rules 正是「当时的规则」，正好用于固化）。
  const act = await ensureClassRuleSnapshot(activity, rules)
  const effectiveRules =
    Array.isArray(act.classRuleSnapshot) && act.classRuleSnapshot.length > 0
      ? ((act.classRuleSnapshot as ClassRuleSnapshotItem[]) as ResolvedClassRule[])
      : rules

  const updated: ClassActivityRecord = {
    ...record,
    status,
    // 过关时间决定名次：非过关清空，过关刷新为当下
    checkedAt: status === 'pending' ? null : Date.now(),
  }
  await db.classActivityRecords.put(touch(updated))

  // v29 并发修复：不信任调用方传入的 allRecords 快照（两次并发共用同一份过期的将各判各的第一）。
  // 以库里最新记录为准计算名次，则并发的第二次运行时能读到第一次已提交的状态。
  const merged = await freshActivityRecords(activity.id, updated)
  await resettleActivity(act, merged, {
    rules: effectiveRules,
    force: new Set([updated.id]),
  })
}

async function doSetActivityTier(
  activity: ClassActivity,
  record: ClassActivityRecord,
  ruleId: string | null,
  rules: ResolvedClassRule[],
): Promise<void> {
  const act = await ensureClassRuleSnapshot(activity, rules)
  const effectiveRules =
    Array.isArray(act.classRuleSnapshot) && act.classRuleSnapshot.length > 0
      ? ((act.classRuleSnapshot as ClassRuleSnapshotItem[]) as ResolvedClassRule[])
      : rules

  const updated: ClassActivityRecord = { ...record, selectedRuleId: ruleId }
  await db.classActivityRecords.put(touch(updated))
  // 未标记状态时选档位：视为「过关」，方便先选档再确认。
  // 直接调底层 doSetActivityStatus，避免经过 serializeActivity 造成同活动自死锁。
  if (updated.status === 'pending') {
    await doSetActivityStatus(act, updated, 'pass', effectiveRules)
    return
  }
  const merged = await freshActivityRecords(activity.id, updated)
  await resettleActivity(act, merged, { rules: effectiveRules, force: new Set([updated.id]) })
}

/**
 * 从库里重读某活动的全部活记录，并把「刚写入的那条」合并进去（保证本次计算包含它）。
 * 返回的数组即 resettleActivity 计算名次/积分的权威集合 —— 用最新库态而非调用方过期快照。
 */
async function freshActivityRecords(
  activityId: string,
  override: ClassActivityRecord,
): Promise<ClassActivityRecord[]> {
  const all = await db.classActivityRecords.toArray()
  return all
    .filter((r) => !r.deletedAt && r.activityId === activityId)
    .map((r) => (r.id === override.id ? override : r))
}

/** 学生名单：把给定学生加入活动（已存在则跳过），返回新增条数 */
export async function addStudentsToActivity(
  activity: ClassActivity,
  studentIds: string[],
  allRecords: ClassActivityRecord[],
): Promise<number> {
  const existing = new Set(
    allRecords
      .filter((r) => r.activityId === activity.id)
      .map((r) => r.studentId),
  )
  const now = Date.now()
  const rows = Array.from(new Set(studentIds))
    .filter((sid) => sid && !existing.has(sid))
    .map((sid) =>
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
    )
  if (rows.length > 0) await db.classActivityRecords.bulkPut(rows)
  return rows.length
}

/**
 * 删除活动：软删活动与其记录，并冲销全部分数（避免积分残留）。
 *
 * ⚠️ 一律软删（保留墓碑以传播同步）。`reason` 用于区分删除来源：
 *  - 'manual'（默认）：老师手动删掉 → 之后「完成课程」不再自动重建该活动；
 *  - 'revert'：「取消完成」时的自动回收 → 允许「重新完成」时重建。
 */
export async function deleteClassActivity(
  activity: ClassActivity,
  allRecords: ClassActivityRecord[],
  opts?: { reason?: 'manual' | 'revert' },
): Promise<void> {
  const reason = opts?.reason ?? 'manual'
  const siblings = allRecords.filter(
    (r) => r.activityId === activity.id && !r.deletedAt,
  )
  for (const rec of siblings) await revokeLedger(rec.ledgerId)
  if (siblings.length > 0) {
    await db.classActivityRecords.bulkPut(
      siblings.map((r) =>
        markDeleted({ ...r, pointsAwarded: 0, ledgerId: null }),
      ),
    )
  }
  await db.classActivities.put(markDeleted({ ...activity, deletedReason: reason }))
}

// ============================================================
// 规则库：默认课堂规则补齐
// ============================================================

/** 课堂规则库为空时补齐默认规则（过关 +1 / 第一个过关额外 +1），保证开箱可用 */
export async function ensureDefaultClassRules(): Promise<number> {
  const all = await db.pointRules.toArray()
  const hasClass = all.some((r) => !r.deletedAt && (r.scope ?? 'checkin') === 'class')
  if (hasClass) return 0
  const now = Date.now()
  const rows = DEFAULT_CLASS_RULES.map((spec, i) =>
    withSyncFields<PointRule>({
      name: DEFAULT_CLASS_RULE_NAMES[i] ?? `规则 ${i + 1}`,
      points: 1,
      scope: 'class',
      mode: 'auto',
      condition: null,
      classCondition: spec,
      enabled: true,
      order: i,
      createdAt: now,
    }),
  )
  await db.pointRules.bulkPut(rows)
  return rows.length
}

/** 取当前「启用中」的课堂规则 id 列表（新建活动时的默认适用范围） */
export async function defaultClassRuleIds(): Promise<string[]> {
  await ensureDefaultClassRules()
  const all = await db.pointRules.toArray()
  return all
    .filter((r) => !r.deletedAt && (r.scope ?? 'checkin') === 'class' && r.enabled)
    .sort((a, b) => a.order - b.order)
    .map((r) => r.id)
}

// ============================================================
// 按排课自动生成
// ============================================================

export interface EnsureClassActivityResult {
  /** 本次新建的活动数 */
  created: number
  /** 生成的活动标题（用于提示） */
  titles: string[]
}

/**
 * 为「今天有课的班课」自动生成课堂积分活动（幂等）。
 *
 * 判定今天有课：
 *  1) 已排课程：courses 中 startAt 落在今天、关联班课、状态非 cancelled；
 *  2) 兜底：班课设了每周固定时段且 weekday === 今天（课程还没物化时也能生成）。
 *
 * 去重：同一班课同一天只生成一次；被手动删除过的活动也不再重生。
 */
export async function ensureTodayClassActivities(
  dayAt: number = Date.now(),
): Promise<EnsureClassActivityResult> {
  const dayStart = startOfDay(new Date(dayAt)).getTime()
  const [groups, members, activities, courses] = await Promise.all([
    db.groups.toArray(),
    db.groupMembers.toArray(),
    db.classActivities.toArray(),
    db.courses.toArray(),
  ])

  const liveGroups = groups.filter((g) => !g.deletedAt)
  const liveMembers = members.filter((m) => !m.deletedAt)
  const groupMap = new Map(liveGroups.map((g) => [g.id, g]))

  // 今天已排的班课课程（cancelled 视为不上课）
  const todayCourses = courses.filter(
    (c) =>
      !c.deletedAt &&
      !!c.groupId &&
      c.status !== 'cancelled' &&
      startOfDay(new Date(c.startAt)).getTime() === dayStart,
  )
  const courseByGroup = new Map(todayCourses.map((c) => [c.groupId!, c]))

  // 收集「今天有课」的班课 id：已排课程优先，未排课时用每周固定时段兜底
  const scheduled = new Set<string>(courseByGroup.keys())
  const weekdayToday = new Date(dayStart).getDay() // 0=周日..6=周六，与 Group.weekday 一致
  for (const g of liveGroups) {
    if (scheduled.has(g.id)) continue
    if (g.weekday === weekdayToday && g.startTimeMin >= 0) scheduled.add(g.id)
  }
  if (scheduled.size === 0) return { created: 0, titles: [] }

  // 新建活动使用的规则：当前启用的课堂规则（库为空时补齐默认规则）
  const ruleIds = await defaultClassRuleIds()

  const titles: string[] = []
  for (const gid of scheduled) {
    const g = groupMap.get(gid)
    if (!g) continue
    // v21：班课可关闭「自动生成课堂活动」（与课后自动打卡同款开关）
    if (g.classActivityAuto === false) continue
    // 该班课今天是否已有活动（**含已删除** —— 删过就不再自动生成）。
    // 与 ensureAutoClassActivityForCourse 的差异是刻意的：
    //  - 这里由「打开课堂积分页 / 排课当天」触发，任何删除都视为老师的明确意图 → 不重生；
    //  - 那里由「完成课程」触发，需支持「取消完成 → 重新完成」的重建，
    //    因此按「课程」精确匹配去重，并允许认领当天尚未归属课程的自动活动（v30）。
    const exists = activities.some(
      (a) => a.groupId === gid && a.activityDate === dayStart,
    )
    if (exists) continue

    const studentIds = liveMembers
      .filter((m) => m.groupId === gid)
      .map((m) => m.studentId)
    if (studentIds.length === 0) continue

    const course = courseByGroup.get(gid)
    const now = Date.now()
    // v29：新建即固化快照 —— 历史分值不随规则库后续编辑漂移
    const snapshot = await buildSnapshotForRuleIds(ruleIds)
    const activity = withSyncFields<ClassActivity>({
      title: `课堂积分 · ${g.name}`,
      courseId: course?.id ?? null,
      groupId: gid,
      activityDate: dayStart,
      auto: true,
      sourceCourseId: course?.id ?? null,
      ruleIds,
      rules: [],
      classRuleSnapshot: snapshot,
      note: '',
      createdAt: now,
    })
    await db.classActivities.put(activity)
    await db.classActivityRecords.bulkPut(
      studentIds.map((sid) =>
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
    titles.push(activity.title)
  }

  return { created: titles.length, titles }
}

/**
 * v21：课程「完成上课」后，为该班课自动生成当天的课堂积分活动（幂等）。
 *
 * 与「课后自动打卡」并列，受班课设置 `classActivityAuto` 控制（缺省开启）：
 *  - 仅处理班课课程（1对1 无课堂积分场景）；
 *  - 为「本次出席学生」建记录（出勤数据缺失时回退班课全员）；
 *  - 去重：同一节课已生成 / 同班同天已有活动 → 跳过；
 *  - 「取消完成」时会软删对应活动（见 courseCompletion.revertCompletion）。
 *
 * 失败由调用方兜底，不应阻塞课程完成流程。
 */
export async function ensureAutoClassActivityForCourse(input: {
  /** 来源课程 id（写入 sourceCourseId，便于取消完成时精确清理） */
  courseId: string
  groupId: string | null
  /** 上课日期（通常为课程 startAt）；内部取当天零点 */
  activityDate: number
  /** 参与学生 id（出席学生；为空则调用方回退全班） */
  studentIds: string[]
  /** 活动标题（会加「课堂积分 · 」前缀） */
  title: string
}): Promise<{ created: boolean; activityId?: string }> {
  if (!input.groupId) return { created: false }
  const g = await db.groups.get(input.groupId)
  if (!g || g.deletedAt) return { created: false }
  // 班课关闭了自动生成 → 不建
  if (g.classActivityAuto === false) return { created: false }

  let ids = Array.from(new Set((input.studentIds ?? []).filter(Boolean)))
  // 兜底：调用方未给到学生（如完成课程时 liveMembers 尚未加载 / 为空）时，
  // 直接从库里取该班课成员，避免课堂活动被静默漏建。
  if (ids.length === 0 && input.groupId) {
    const mem = (await db.groupMembers.toArray()).filter(
      (m) => !m.deletedAt && m.groupId === input.groupId,
    )
    ids = mem.map((m) => m.studentId)
  }
  if (ids.length === 0) return { created: false }

  const dayStart = startOfDay(new Date(input.activityDate)).getTime()
  const activities = await db.classActivities.toArray()
  const sameDay = activities.filter(
    (a) => a.groupId === input.groupId && a.activityDate === dayStart,
  )

  // 去重（v30.2：**只被「存活」活动阻挡**，墓碑一律不阻断重建）：
  //  1) 本课程自己已生成过且存活 → 幂等跳过。
  //  2) 当天该班课存在「尚未归属任何课程」的存活自动活动（课堂积分页按排课预生成的孤儿）
  //     → **认领**为本课程：这样「取消完成」能精确回收它、「重新完成」又能重建。
  //  3) 当天该班课已有其它存活活动（老师手动新建 / 已归属别的课）→ 不重复建。
  //  4) 否则新建。
  //  ⚠ 旧实现有两处「manual 墓碑拦截」（本课程被手动删过 / 当天该班课有 manual 墓碑就永久不再建）：
  //     老版本「取消完成」用默认 reason(manual) 软删活动 → 墓碑永久阻断重建，
  //     于是「完成 → 取消 → 再完成」再也看不到本课的课堂活动（用户实测，与打卡同时消失）。
  //     完成上课是老师的明确动作，理应始终补齐活动；因此移除这两处拦截（v30.2）。
  const owned = sameDay.find(
    (a) => !a.deletedAt && a.sourceCourseId === input.courseId,
  )
  if (owned) return { created: false, activityId: owned.id }

  const orphan = sameDay.find(
    (a) => !a.deletedAt && a.auto === true && !a.sourceCourseId,
  )
  if (orphan) {
    await db.classActivities.put(
      touch({ ...orphan, sourceCourseId: input.courseId, courseId: input.courseId }),
    )
    return { created: false, activityId: orphan.id }
  }

  // 当天该班课已有其它存活活动（老师手动新建 / 已归属别的课）→ 不重复建。
  const otherAlive = sameDay.find((a) => !a.deletedAt)
  if (otherAlive) return { created: false, activityId: otherAlive.id }

  const ruleIds = await defaultClassRuleIds()
  const now = Date.now()
  // v29：新建即固化快照 —— 历史分值不随规则库后续编辑漂移
  const snapshot = await buildSnapshotForRuleIds(ruleIds)
  const activity = withSyncFields<ClassActivity>({
    title: `课堂积分 · ${input.title}`,
    courseId: input.courseId,
    groupId: input.groupId,
    activityDate: dayStart,
    auto: true,
    sourceCourseId: input.courseId,
    ruleIds,
    rules: [],
    classRuleSnapshot: snapshot,
    note: '',
    createdAt: now,
  })
  await db.classActivities.put(activity)
  await db.classActivityRecords.bulkPut(
    ids.map((sid) =>
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
  return { created: true, activityId: activity.id }
}
