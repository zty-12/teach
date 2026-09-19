/**
 * 课堂积分业务逻辑（v30.8「纯手动按钮」模型）
 * ------------------------------------------------------------
 * 场景：课上检查背诵/听写等，老师**按自己判断**点亮规则按钮给学生加分。
 *
 * 设计要点：
 *  1) **规则集中在「积分规则 → 课堂规则」页**（pointRules，scope='class'）。
 *     每条规则 = 一个自定义的「名称 + 分值」，在活动里渲染成一枚按钮：
 *       **点选即加该规则分值、再点取消**，可同时选中多条（如「熟练 +1」+「主动 +1」= +2）。
 *     v30.8 起课堂规则**不再有**「过关 / 名次 / 任何自动条件」——一律由老师手动决定，
 *     记录里选中的规则 id 存在 ClassActivityRecord.manualRuleIds。
 *  2) 计分复用 pointLedgers 流水（与打卡积分同一账户体系），
 *     每条课堂加分都记下 ledgerId，取消/改选时精确冲销，不留残分。
 *  3) 积分「整体重算」：任何一次按钮变更后调用 resettleActivity，
 *     重算该活动每人得分（幂等）。
 *  4) 兼容旧数据：没有 ruleIds 的历史活动仍按内嵌 rules 计分。
 *     旧规则/旧快照里可能残留 condition / mode / status 字段，计分时**一律忽略**
 *     —— v30.8 的计分只认「该生 manualRuleIds 里命中的规则分值之和」。
 *  5) 自动生成：班课按排课当天自动建活动（用当前启用的课堂规则）。
 *
 * ⚠️ 历史自动计分（过关/名次/档位）已随 v30.8 迁移（db.ts v16）全部清零，
 *    之后课堂积分只由老师点按钮产生，不再有任何自动求值。
 */
import { startOfDay } from 'date-fns'
import { db, isRuleOrderSafe, markDeleted, touch, withSyncFields, MAX_RULE_ORDER, uniqueMemberStudentIds } from './db'
import { adjustPoints } from './points'
import type {
  ClassActivity,
  ClassActivityRecord,
  ClassRuleSnapshotItem,
  Group,
  PointRule,
  RuleScope,
} from './types'

/**
 * 归一化后的课堂规则：库规则引用 or 旧版内嵌规则，引擎只认这个形状。
 * 结构与持久化快照 `ClassRuleSnapshotItem`（types.ts）完全一致，
 * 因此 `resolveClassRules`（优先读快照时可把快照数组直接当 ResolvedClassRule[] 返回）。
 *
 * 注意：快照里的 `mode` / `condition` / `rankN` 等字段**已不参与 v30.8 计分**，
 * 仅为旧数据兼容保留（即使某条旧快照是 `mode:'tier'` 或 `condition:'pass'`，
 * 也一律当成「手动按钮」处理 —— 只看它是否被选中）。
 */
export interface ResolvedClassRule extends ClassRuleSnapshotItem {}

/** 新建课堂活动时的默认计分规则（库为空时补齐用）。v30.8：纯「名称 + 分值」，无自动条件。 */
export const DEFAULT_CLASS_RULES: { name: string; points: number }[] = [
  { name: '熟练', points: 1 },
  { name: '主动', points: 1 },
  { name: '进步', points: 1 },
]

/**
 * 解析一个活动实际生效的规则列表。
 *
 * 优先序（v29 起）：
 *  1. 有 `classRuleSnapshot`（含空数组）→ 直接用它。这是历史积分不随规则编辑漂移的保证；
 *  2. 有 ruleIds（含空数组）→ 从规则库取这些（空数组 = 明确不引用任何规则）；
 *  3. 无 ruleIds（undefined）→ 回退到旧版内嵌 rules（历史活动兼容）。
 *
 * 注意：`[]` 与 `undefined` 语义不同 —— 规则全清空写 `[]`，旧数据为 `undefined`。
 *
 * ⚠️ v30.8：解析结果里的 `mode` / `condition` 仅作展示/兼容，计分一律忽略。
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
        mode: r.mode ?? 'manual',
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
    mode: 'manual' as const,
    condition: r.condition,
    rankN: r.rankN,
    rankFrom: r.rankFrom,
    rankTo: r.rankTo,
    enabled: r.enabled,
    fromLibrary: false,
  }))
}

/**
 * 取某条记录当前「手动叠加」的规则 id 列表。
 * 兼容 v30.2 及更早的单一 `selectedRuleId` 字段（会被合并进来，迁移无感）。
 */
export function manualIdsOf(rec: {
  manualRuleIds?: string[]
  selectedRuleId?: string | null
}): string[] {
  const list = Array.isArray(rec.manualRuleIds) ? rec.manualRuleIds.filter(Boolean) : []
  if (rec.selectedRuleId && !list.includes(rec.selectedRuleId)) {
    return [...list, rec.selectedRuleId]
  }
  return list
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
      mode: r.mode ?? 'manual',
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
// 计分核心（v30.8：纯手动按钮）
// ============================================================

/**
 * v30.8：**一条记录在该活动下的得分 = 其选中的规则分值之和**。
 *
 * 不再有任何「过关 / 名次 / 自动条件」求值 —— 全部由老师点选按钮决定。
 * 仅对「启用中」且「被该生选中（出现在 manualIds 里）」的规则累加。
 *
 * @param manualIds 该生被手动选中的规则 id 列表（ClassActivityRecord.manualRuleIds）
 */
export function awardedPoints(
  rules: ResolvedClassRule[],
  manualIds?: string[] | null,
): number {
  const manual = new Set(manualIds ?? [])
  let total = 0
  for (const r of rules) {
    if (!r.enabled) continue
    if (manual.has(r.id)) total += r.points
  }
  return total
}

/** 冲销一条积分流水（软删，随同步传播） */
async function revokeLedger(ledgerId: string | null | undefined): Promise<void> {
  if (!ledgerId) return
  const l = await db.pointLedgers.get(ledgerId)
  if (!l || l.deletedAt) return
  await db.pointLedgers.put(markDeleted(l))
}

/**
 * 重算整个活动：按当前每条记录的 manualRuleIds 重算每人得分，
 * 先冲销旧流水再按新结果写入（幂等）。
 *
 * v30.8：计分只看 manualRuleIds，不再涉及任何名次 / 过关状态。
 *
 * @param allRecords 该活动的最新记录集合（调用方负责含刚写入的那条）
 * @param opts.force   需要强制重算的记录 id（如按钮变更后，即使分值相同也重建流水事由）
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
  const ruleName = new Map(rules.map((r) => [r.id, r.name]))
  // 当前活动生效的规则 id 集合：手动叠加列表里若残留了「已删 / 已改」的规则 id，
  // 视为悬空 —— 计分时忽略，并顺手把它从记录里清掉，避免永久残留。
  const ruleIds = new Set(rules.map((r) => r.id))

  const updates: ClassActivityRecord[] = []
  for (const rec of siblings) {
    const rawManual = manualIdsOf(rec)
    const manual = rawManual.filter((id) => ruleIds.has(id))
    const staleManual = manual.length !== rawManual.length
    const expected = awardedPoints(rules, manual)
    const hasLedger = Boolean(rec.ledgerId)
    const forced = opts.force?.has(rec.id) ?? false
    // 结果未变化则跳过，避免每次点击都产生新流水
    if (
      !forced &&
      !staleManual &&
      expected === (rec.pointsAwarded ?? 0) &&
      (expected > 0) === hasLedger
    ) {
      continue
    }

    await revokeLedger(rec.ledgerId)
    const suffix = manual
      .map((id) => ruleName.get(id))
      .filter((n): n is string => Boolean(n))
      .join(' + ')
    const ledgerId =
      expected !== 0
        ? await adjustPoints(
            rec.studentId,
            expected,
            `课堂积分 · ${activity.title}${suffix ? ` · ${suffix}` : ''}`,
          )
        : null
    updates.push(
      touch({
        ...rec,
        pointsAwarded: expected,
        ledgerId,
        // 统一收敛到 manualRuleIds，并把悬空 id 一并清掉（selectedRuleId 作为旧字段同时清空）
        ...(staleManual || rec.selectedRuleId
          ? { manualRuleIds: manual, selectedRuleId: null }
          : {}),
      }),
    )
  }
  if (updates.length > 0) await db.classActivityRecords.bulkPut(updates)
}

/**
 * 规则按钮点击（v30.8「纯手动按钮」）：
 *  - 点某规则 id → 该规则的分值**叠加**到该生总分（不清空、不覆盖）；
 *    若已选中则**取消**叠加（再点一次）。可同时选中多条（如「熟练 +1」+「主动 +1」= +2）。
 *  - 传 `ruleId=null` 表示**撤销**：清空该生全部已选规则，回到 0 分。
 *
 * 计分时只维护 `manualRuleIds`；`status` 字段已 deprecated（v30.8 清零迁移），不再参与计分。
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
  // 以库中最新记录为准判断「是否已是当前选中态」（调用方传入的可能是过期快照）
  const fresh = (await db.classActivityRecords.get(record.id)) ?? record

  let updated: ClassActivityRecord
  if (!ruleId) {
    // 撤销：清空全部手动规则选择，回到零分
    updated = {
      ...fresh,
      manualRuleIds: [],
      selectedRuleId: null,
      status: 'pending',
      checkedAt: null,
    }
  } else {
    // 在「手动规则列表」里增删这条规则（可叠加多条，互不影响）
    const cur = manualIdsOf(fresh)
    const next = cur.includes(ruleId)
      ? cur.filter((id) => id !== ruleId)
      : [...cur, ruleId]
    updated = { ...fresh, manualRuleIds: next, selectedRuleId: null }
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

/**
 * v31.0：旧「自动条件」时代遗留的课堂规则名判定。
 *
 * 实现在 types.ts（纯函数、无依赖），这里只做**再导出**，方便业务层从 classPoints 引用。
 * 放在 types.ts 的原因：db.ts 的 v18 迁移也要用同一套判据，
 * 而 db.ts 只依赖 types.ts —— 若把实现放这里会形成 `db → classPoints → db` 循环依赖。
 */
export { isLegacyNamedClassRule } from './types'

/**
 * 保证规则库里存在 v30.8 的默认课堂规则（熟练 / 主动 / 进步）。
 *
 * v31.0 起条件放宽：**不再只在「一条课堂规则都没有」时补齐**。
 * 旧逻辑是 `if (hasClass) return 0` —— 只要库里有任意一条课堂规则就跳过，
 * 于是老用户（库里全是「过关」「第一个额外」「1」这类旧命名规则）**永远补不出新默认规则**，
 * 表现为「v30.8 都更新了，班课设置里的规则还是老的」。
 *
 * 新逻辑：按**规则名**判断是否已具备新词表里的规则（不看 id，避免重复建）。
 *  - 已有「熟练/主动/进步」中任意一条 → 认为词表已就位，一条都不补（严格不侵入）；
 *  - 一条都没有 → 只补**缺失**的那几条（已存在的同名规则不重复创建）。
 *
 * 仍然完全不动用户已有的任何规则（不删、不停用、不改名）——
 * 旧规则的清理交给老师在「积分规则 → 课堂规则」页自行完成，UI 会标注提示。
 */
export async function ensureDefaultClassRules(): Promise<number> {
  const all = await db.pointRules.toArray()
  const liveClass = all.filter((r) => !r.deletedAt && (r.scope ?? 'checkin') === 'class')
  const existingNames = new Set(liveClass.map((r) => (r.name ?? '').trim()))
  const missing = DEFAULT_CLASS_RULES.filter((spec) => !existingNames.has(spec.name))
  if (missing.length === 0) return 0
  const now = Date.now()
  // 排序值接在已有课堂规则之后，避免与现有顺序冲突（nextRuleOrder 会忽略非法脏值）
  const baseOrder = nextRuleOrder(all, 'class')
  const rows = missing.map((spec, i) =>
    withSyncFields<PointRule>({
      name: spec.name,
      points: spec.points,
      scope: 'class',
      mode: 'manual',
      condition: null,
      classCondition: null,
      enabled: true,
      order: Math.min(baseOrder + i, MAX_RULE_ORDER),
      createdAt: now,
    }),
  )
  await db.pointRules.bulkPut(rows)
  return rows.length
}

/**
 * 新建规则时的排序值 = 同范围内已有规则的**最大 order + 1**（保证新建的排在最后）。
 *
 * ⚠ **不要用 `Date.now()`**：云端 `pointRules."order"` 是 `integer`（int4，上限 2147483647），
 *   毫秒时间戳约 1.8e12 会溢出 → PostgREST 报
 *   `value "1789311709042" is out of range for type integer` → **整张 pointRules 推送失败**
 *   （本地 IndexedDB 无类型限制，脏值能存下，所以表现为「本地正常、同步一直失败」）。
 *   v30.5 修复根因；历史脏值由 db.ts v15 迁移经 `planPointRuleOrderFixes` 归一化。
 *
 * 同时**忽略非法 order**（历史脏值 / NaN / 负数 / 超上限），避免脏值把新序号一起带飞。
 * 返回值封顶 `MAX_RULE_ORDER`，保证一定满足 `isRuleOrderSafe`（不变量）。
 */
export function nextRuleOrder(
  rules: ReadonlyArray<{ scope?: RuleScope; order?: number }>,
  scope: RuleScope,
): number {
  let max = -1
  for (const r of rules) {
    if ((r.scope ?? 'checkin') !== scope) continue
    if (isRuleOrderSafe(r.order)) max = Math.max(max, r.order)
  }
  return Math.min(max + 1, MAX_RULE_ORDER)
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

/**
 * v30.3：自动生成的课堂积分活动应该引用哪些规则。
 *
 * 优先级：
 *  1) 班课设置了 `autoClassRuleIds`（班课设置 → 自动生成课堂活动 里选的规则）
 *     → 用这批 id（只保留仍存在且启用的；被删/停用的自动剔除，避免生成出「空规则」活动）；
 *  2) 未设置 → 回退「当前启用的全部课堂规则」（与手动新建活动的默认值一致）。
 *
 * 若班课选的规则已全部失效（都删了），为避免生成零规则活动，回退到默认集合。
 */
export async function autoClassRuleIdsOf(
  group: Pick<Group, 'autoClassRuleIds'> | null | undefined,
): Promise<string[]> {
  const picked = Array.isArray(group?.autoClassRuleIds)
    ? group!.autoClassRuleIds!.filter(Boolean)
    : []
  if (picked.length === 0) return defaultClassRuleIds()
  const all = await db.pointRules.toArray()
  const usable = new Set(
    all
      .filter((r) => !r.deletedAt && (r.scope ?? 'checkin') === 'class' && r.enabled)
      .map((r) => r.id),
  )
  const kept = picked.filter((id) => usable.has(id))
  return kept.length > 0 ? kept : defaultClassRuleIds()
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

  // 新建活动使用的规则：v30.3 起优先用「班课设置 → 自动生成课堂活动」里选的规则，
  // 未设置时回退「当前启用的全部课堂规则」。规则随班课不同而不同，故在循环内按班课取。
  const titles: string[] = []
  for (const gid of scheduled) {
    const g = groupMap.get(gid)
    if (!g) continue
    // v21：班课可关闭「自动生成课堂活动」（与课后自动打卡同款开关）
    if (g.classActivityAuto === false) continue
    // 该班课今天是否已有「存活」活动。
    //  - 有存活活动 → 幂等跳过；
    //  - 只剩墓碑时（v30.3 自愈）：若今天该班课有**已完成**的课，说明这份活动本该存在
    //    （可能被「取消完成」回收、或完成时创建失败）→ 补齐一份，避免老师看到「完成 → 取消 →
    //    再完成」后课堂活动凭空消失。若课还没完成，则视为老师手动删除 → 尊重，不重生。
    const aliveSameDay = activities.some(
      (a) => a.groupId === gid && a.activityDate === dayStart && !a.deletedAt,
    )
    if (aliveSameDay) continue
    const hasTombstone = activities.some(
      (a) => a.groupId === gid && a.activityDate === dayStart,
    )
    const doneCourseToday = todayCourses.find(
      (c) => c.groupId === gid && c.status === 'done',
    )
    if (hasTombstone && !doneCourseToday) continue

    const studentIds = liveMembers
      .filter((m) => m.groupId === gid)
      .map((m) => m.studentId)
    if (studentIds.length === 0) continue

    const course = doneCourseToday ?? courseByGroup.get(gid)
    const now = Date.now()
    // v30.3：按班课配置决定引用的规则（未配置 → 当前启用的全部课堂规则）
    const ruleIds = await autoClassRuleIdsOf(g)
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
    ids = uniqueMemberStudentIds(mem)
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

  // v30.3：按班课配置决定引用的规则（未配置 → 当前启用的全部课堂规则）
  const ruleIds = await autoClassRuleIdsOf(g)
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
