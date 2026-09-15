import Dexie, { type Table } from 'dexie'
import type {
  AppSettings,
  CheckInRecord,
  CheckInTask,
  ClassActivity,
  ClassActivityRecord,
  Course,
  CourseAttendance,
  CourseFeedback,
  CourseKnowledge,
  DataSnapshot,
  FeedbackTemplate,
  FeedbackTemplateField,
  Group,
  GroupMember,
  KnowledgePoint,
  LearningReport,
  LearningTag,
  Payment,
  PointLedger,
  PointRule,
  Redemption,
  RewardItem,
  Settlement,
  Student,
  StudentProfile,
  StudentTag,
  SyncFields,
  SyncMeta,
  Textbook,
  TextbookUnit,
} from './types'

/**
 * 本地数据库（IndexedDB）。
 * 本地为真源（local-first）：所有写入先落本地，再由同步引擎异步推送到云端。
 */
export class EduDB extends Dexie {
  students!: Table<Student, string>
  groups!: Table<Group, string>
  groupMembers!: Table<GroupMember, string>
  courses!: Table<Course, string>
  courseAttendances!: Table<CourseAttendance, string>
  courseFeedbacks!: Table<CourseFeedback, string>
  learningReports!: Table<LearningReport, string>
  learningTags!: Table<LearningTag, string>
  studentTags!: Table<StudentTag, string>
  payments!: Table<Payment, string>
  settlements!: Table<Settlement, string>
  // v4：知识库 / 反馈模板 / 打卡 / 积分 / 兑换
  textbooks!: Table<Textbook, string>
  textbookUnits!: Table<TextbookUnit, string>
  knowledgePoints!: Table<KnowledgePoint, string>
  feedbackTemplates!: Table<FeedbackTemplate, string>
  courseKnowledges!: Table<CourseKnowledge, string>
  checkInTasks!: Table<CheckInTask, string>
  checkInRecords!: Table<CheckInRecord, string>
  pointRules!: Table<PointRule, string>
  pointLedgers!: Table<PointLedger, string>
  rewardItems!: Table<RewardItem, string>
  redemptions!: Table<Redemption, string>
  // v7：学生画像（AI 从历史 aiFeedback 汇总）
  studentProfiles!: Table<StudentProfile, string>
  // v8：结构化反馈模板的字段
  feedbackTemplateFields!: Table<FeedbackTemplateField, string>
  // v9：数据版本快照（本地滚动留存；云端另存 data_snapshots 表）
  snapshots!: Table<DataSnapshot, string>
  // v16：课堂积分
  classActivities!: Table<ClassActivity, string>
  classActivityRecords!: Table<ClassActivityRecord, string>
  settings!: Table<{ key: string; value: AppSettings }, string>
  syncMeta!: Table<SyncMeta, string>

  constructor() {
    super('edu-workbench')
    this.version(1).stores({
      students: 'id, updatedAt, deletedAt, status, name, dirty',
      groups: 'id, updatedAt, deletedAt, dirty',
      groupMembers: 'id, groupId, studentId, updatedAt, deletedAt, dirty',
      courses: 'id, startAt, studentId, groupId, status, updatedAt, deletedAt, dirty',
      courseFeedbacks: 'id, courseId, updatedAt, deletedAt, dirty',
      learningReports: 'id, studentId, updatedAt, deletedAt, dirty',
      learningTags: 'id, updatedAt, deletedAt, dirty',
      payments: 'id, studentId, paidAt, updatedAt, deletedAt, dirty',
      settlements: 'id, courseId, studentId, updatedAt, deletedAt, dirty',
      settings: 'key',
      syncMeta: 'table',
    })

    // v2：新增「学生 ↔ 标签」关联表（学习标签库）
    this.version(2).stores({
      studentTags: 'id, studentId, tagId, updatedAt, deletedAt, dirty',
    })

    // v3：学生计费字段 / 班课每周时段 / 课程出席表
    //  - students 增加 remainingHours 等索引
    //  - groups 增加 weekday 索引（便于按周几筛班课）
    //  - 新增 courseAttendances 表
    this.version(3).stores({
      students:
        'id, updatedAt, deletedAt, status, name, dirty, isTrial, remainingHours',
      groups: 'id, updatedAt, deletedAt, weekday, dirty',
      courseAttendances:
        'id, courseId, studentId, present, updatedAt, deletedAt, dirty',
    })

    // v4：知识库 / 反馈模板 / 打卡 / 积分 / 兑换商城
    this.version(4).stores({
      textbooks: 'id, subject, updatedAt, deletedAt, dirty',
      textbookUnits: 'id, textbookId, order, updatedAt, deletedAt, dirty',
      knowledgePoints:
        'id, textbookId, unitId, updatedAt, deletedAt, dirty',
      feedbackTemplates: 'id, isDefault, updatedAt, deletedAt, dirty',
      courseKnowledges:
        'id, courseId, knowledgePointId, updatedAt, deletedAt, dirty',
      checkInTasks: 'id, courseId, createdAt, updatedAt, deletedAt, dirty',
      checkInRecords:
        'id, taskId, studentId, status, updatedAt, deletedAt, dirty',
      pointRules: 'id, kind, enabled, order, updatedAt, deletedAt, dirty',
      pointLedgers: 'id, studentId, kind, createdAt, updatedAt, deletedAt, dirty',
      rewardItems: 'id, enabled, pointsCost, updatedAt, deletedAt, dirty',
      redemptions:
        'id, studentId, rewardItemId, status, redeemedAt, updatedAt, deletedAt, dirty',
    })

    // v5：打卡任务支持多天（周期/自定义）与班课参与范围
    //  - checkInTasks 增加 groupId 索引（关联班课的打卡）
    //  - checkInRecords 增加 dayAt 索引（按打卡日查询）
    this.version(5).stores({
      checkInTasks:
        'id, courseId, groupId, createdAt, updatedAt, deletedAt, dirty',
      checkInRecords:
        'id, taskId, studentId, dayAt, status, updatedAt, deletedAt, dirty',
    })

    // v6：CheckInRecord 增加 aiFeedback 列（AI 生成的家长反馈，可空）
    this.version(6).stores({
      checkInRecords:
        'id, taskId, studentId, dayAt, status, updatedAt, deletedAt, dirty',
    })

    // v7：新增学生画像表（AI 从历史 aiFeedback 汇总生成学生特征）
    this.version(7).stores({
      studentProfiles:
        'id, studentId, profileUpdatedAt, updatedAt, deletedAt, dirty',
    })

    // v8：结构化反馈模板字段（模板 → 字段，字段可关联工作台资料）
    this.version(8).stores({
      feedbackTemplateFields:
        'id, templateId, order, updatedAt, deletedAt, dirty',
    })

    // v9：数据版本快照（本地滚动留存最近若干版；云端 data_snapshots 表另存）
    this.version(9).stores({
      snapshots: 'id, createdAt',
    })

    // v16：课堂积分（课堂活动 + 学生参与记录）
    this.version(10).stores({
      classActivities:
        'id, title, courseId, createdAt, updatedAt, deletedAt, dirty',
      classActivityRecords:
        'id, activityId, studentId, status, updatedAt, deletedAt, dirty',
    })

    // v17：课堂积分合并进打卡页；活动增加班课归属与活动日期索引
    // （支持「按班课排课当天自动生成」的按日去重查询）
    this.version(11).stores({
      classActivities:
        'id, title, courseId, groupId, activityDate, createdAt, updatedAt, deletedAt, dirty',
    })

    // v19：纯数据迁移（schema 不变），补全 v16 老数据缺失的 v17 字段。
    // 背景：v16 时期创建的课堂活动本地没有 auto / groupId / activityDate 等字段，
    //       而云端 "classActivities".auto 是 NOT NULL，PostgREST 批量 upsert 时
    //       会把数组里缺失的键补成 null → 违反 not-null 约束，整表推送失败。
    //       这里把本地真源补全，推送自然带上默认值。
    this.version(12).upgrade(async (tx) => {
      await tx
        .table('classActivities')
        .toCollection()
        .modify((a: Record<string, unknown>) => {
          if (typeof a.auto !== 'boolean') a.auto = false
          if (a.groupId === undefined) a.groupId = null
          if (a.activityDate === undefined) a.activityDate = null
          if (a.sourceCourseId === undefined) a.sourceCourseId = null
          if (!Array.isArray(a.rules)) a.rules = []
          if (typeof a.note !== 'string') a.note = ''
          if (typeof a.title !== 'string') a.title = ''
        })
      await tx
        .table('classActivityRecords')
        .toCollection()
        .modify((r: Record<string, unknown>) => {
          if (r.ledgerId === undefined) r.ledgerId = null
          if (typeof r.pointsAwarded !== 'number') r.pointsAwarded = 0
          if (typeof r.note !== 'string') r.note = ''
          if (typeof r.status !== 'string') r.status = 'pending'
        })
    })

    // v13（v30.3）：规则按钮改「全体叠加」模型 + 班课可指定自动活动规则。
    //  - classActivityRecords.manualRuleIds：手动叠加规则 id 列表；
    //    把旧版单一 selectedRuleId 迁移进来（语义由「覆盖」变「叠加」，历史档位选择不丢）；
    //  - groups.autoClassRuleIds：自动生成的课堂活动引用哪些规则（默认空 = 全部启用项）。
    // 提醒：这两个字段云端需要对应列（见 supabase/schema.sql 的 alter 段），
    //       本地先补全，推送时才会带上真实值而不是被 PostgREST 补成 null。
    this.version(13).upgrade(async (tx) => {
      await tx
        .table('classActivityRecords')
        .toCollection()
        .modify((r: Record<string, unknown>) => {
          const legacy = typeof r.selectedRuleId === 'string' ? r.selectedRuleId : null
          if (!Array.isArray(r.manualRuleIds)) {
            r.manualRuleIds = legacy ? [legacy] : []
          }
          if (r.selectedRuleId === undefined) r.selectedRuleId = null
        })
      await tx
        .table('groups')
        .toCollection()
        .modify((g: Record<string, unknown>) => {
          if (!Array.isArray(g.autoClassRuleIds)) g.autoClassRuleIds = []
        })
    })

    // v14（v30.4）：修复「PostgREST 批量 upsert 把缺失键补成 null」导致的整表推送失败。
    //  实测报错：[groups] 推送失败: null value in column "checkInWeekdays" violates not-null constraint
    //  根因：v8/v21 给班课陆续加了 checkInWeekdays 等可选字段，但更早创建的班课整键缺失；
    //        云端这些列是 NOT NULL DEFAULT，而 PostgREST 用「整批对象键的并集」拼 INSERT，
    //        缺键的行被填成 NULL（不是走 DEFAULT）→ 违反非空约束 → **整张表推送失败**。
    //  做法：本地是真源，先把这些字段补全，推送时自然带上真实值；
    //        sync.ts 的 PUSH_DEFAULTS 作为「其它设备尚未跑迁移」的第二道保险。
    //  填充逻辑抽到 SYNC_FIELD_FILLERS（同名导出），便于回归脚本直接测到**同一份**代码。
    this.version(14).upgrade(async (tx) => {
      for (const [table, fill] of Object.entries(SYNC_FIELD_FILLERS)) {
        await tx
          .table(table)
          .toCollection()
          .modify(fill as (r: Record<string, unknown>) => void)
      }
    })

    // v15（v30.5）：修复 pointRules.order 溢出 int4 导致的整表推送失败。
    //  实测报错：[pointRules] 推送失败: value "1789311709042" is out of range for type integer
    //  根因：RuleLibraryView 新建规则时用 `order: Date.now()`（本意是「排到最后」），
    //        而云端 pointRules."order" 是 **integer（int4，上限 2147483647）**，
    //        毫秒时间戳（约 1.8e12）远超上限 → PostgREST 拒绝整批 → **整张表推送失败**。
    //        （本地 IndexedDB 无类型限制，脏值能存下，所以是「本地好好的、同步一直失败」。）
    //  做法：① RuleLibraryView 改用 nextRuleOrder()（同范围最大 order + 1）——治根因；
    //        ② 这里把本地已存的脏 order 归一化（**只改脏行**，合法行原样不动，最小侵入），
    //           并置 dirty=1 把修正推回云端；
    //        ③ 归一化规则抽到 planPointRuleOrderFixes（同名导出），回归脚本测同一份代码。
    this.version(15).upgrade(async (tx) => {
      const rows = (await tx.table('pointRules').toArray()) as Array<Record<string, unknown>>
      const fixes = planPointRuleOrderFixes(rows)
      if (fixes.length === 0) return
      const byId = new Map(fixes.map((f) => [f.id, f.order]))
      await tx
        .table('pointRules')
        .toCollection()
        .modify((r: Record<string, unknown>) => {
          const fixed = byId.get(String(r.id))
          if (fixed === undefined) return
          r.order = fixed
          // 必须置脏，否则修正只留在本地、云端仍是旧值（推送按 dirty=1 选行）
          r.dirty = 1
        })
    })

    // v16（v30.8）：课堂积分改为「纯手动按钮」模型前，把历史自动算出 / 档位加的分全部清零。
    //  背景：v30.8 之前课堂分由「过关/名次/档位」自动条件算出，老师无法精细控制；
    //        新模型下课堂分只由老师点按钮产生。为彻底甩掉旧语义，发布时做一次全量重置：
    //          · 所有存活的课堂活动记录 → 分数/状态/选中规则一并归零（status 字段已 deprecated，统一置 'pending'）；
    //          · 历史「课堂积分」类流水（reason 以「课堂积分」开头）软删，把学生钱包里旧自动分一并清掉。
    //        这样老活动不迁移、不保留自动分，老师之后从 0 开始手动计分。
    //  注意：只改值、不加列，无需改 schema.sql；置 dirty=1 + 刷新 updatedAt 让清零推回云端。
    this.version(16).upgrade(async (tx) => {
      const now = Date.now()
      // 1) 清零所有存活的课堂活动记录
      await tx
        .table('classActivityRecords')
        .toCollection()
        .modify((r: Record<string, unknown>) => {
          if (r.deletedAt) return
          r.status = 'pending'
          r.pointsAwarded = 0
          r.ledgerId = null
          r.manualRuleIds = []
          r.selectedRuleId = null
          r.checkedAt = null
          r.updatedAt = now
          r.dirty = 1
        })
      // 2) 冲销历史「课堂积分」类流水（reason 以「课堂积分」开头）
      await tx
        .table('pointLedgers')
        .toCollection()
        .modify((r: Record<string, unknown>) => {
          if (r.deletedAt) return
          if (typeof r.reason === 'string' && r.reason.startsWith('课堂积分')) {
            r.deletedAt = now
            r.updatedAt = now
            r.dirty = 1
          }
        })
      // 3) 归一化既有课堂规则：一律转为「手动按钮」——清掉历史 condition / classCondition，
      //    否则规则库列表会按旧 mode 显示「自动累加」徽标，而实际已按手动按钮计分（自相矛盾）。
      //    仅改 scope='class' 的规则，打卡规则不受影响。
      await tx
        .table('pointRules')
        .toCollection()
        .modify((r: Record<string, unknown>) => {
          if (r.deletedAt) return
          if ((r.scope ?? 'checkin') !== 'class') return
          const alreadyClean =
            r.mode === 'manual' && r.classCondition == null && r.condition == null
          if (alreadyClean) return
          r.mode = 'manual'
          r.classCondition = null
          r.condition = null
          r.updatedAt = now
          r.dirty = 1
        })
    })

    // v17（v30.9）：pointLedgers.delta 的 **int4 溢出修复**。
    //  实测报错：`[pointLedgers] 推送失败: invalid input syntax for type integer: "0.5"`
    //  根因：云端 `pointLedgers.delta` 是 **integer（int4）**，而课堂规则允许小数分值
    //        （如「进步 +0.5」）→ 流水 delta 写入 0.5 → PostgREST 报整数语法错 →
    //        **整张 pointLedgers 推送失败** → 所有课堂积分同步卡住。
    //  做法：
    //    ① 表结构：`pointLedgers.delta` 由 integer 改为 **double precision**（见 schema.sql 第 2 段），
    //       让「小数课堂分」能正常存取 —— 这是治根因；
    //    ② 存量数据：把历史**小数** delta 按整数分制 ×2 换算（0.5→1、2.5→5），
    //       使整条链路的「最小单位 = 0.5 分」：
    //         · 小数 delta  → 向上取整到偶数（0.5→1、2.5→5、1.5→3）
    //         · 整数 delta  → ×2（1→2、-1→-2），保持各学生之间的**相对比例不变**
    //         · 非分制记录（兑换消耗等）→ 同步 ×2，金额关系不破
    //    ③ 同步：sync.ts 的 sanitizeInt4ForPush 扩大覆盖到 pointLedgers.delta + pointsAwarded +
    //       pointRules.points，做「推送前自愈」，杜绝同类复发。
    //
    //  ⚠ 副作用（可接受）：整数旧数据的绝对值被放大 2 倍。用户明确要求「历史分数全部重算清零」，
    //    且 v16 迁移已把课堂积分流水软删，故此处只影响零星其它积分，比例正确。
    //  注意：**改了列类型**，必须同步 schema.sql 第 2 段的
    //    `alter table "pointLedgers" alter column delta type double precision`。
    this.version(17).upgrade(async (tx) => {
      const now = Date.now()
      await tx
        .table('pointLedgers')
        .toCollection()
        .modify((r: Record<string, unknown>) => {
          const d = r.delta
          if (typeof d !== 'number' || !Number.isFinite(d)) return
          const converted = Number.isInteger(d)
            ? d * 2 // 整数旧记录 → ×2 进入新分制
            : Math.round(d * 2) // 小数记录 → ×2 后取整（0.5→1、1.5→3、2.5→5）
          if (converted === d) return
          r.delta = converted
          r.updatedAt = now
          r.dirty = 1
        })
    })
  }
}

/**
 * v30.4：把「云端 NOT NULL、但本地可能整键缺失」的字段补全（就地修改）。
 *
 * **为什么需要**：PostgREST 批量 upsert 用「整批对象键的并集」拼一条 INSERT，
 * 数组里缺某个键的行会被填成 `null`（而不是走列 DEFAULT）→ 若列是 NOT NULL，
 * 报 `null value in column "x" violates not-null constraint`，**整张表推送失败**。
 *
 * ⚠ 刻意**不**补 `classActivities.ruleIds` / `checkInTasks.ruleIds`：
 *   它们的 `undefined` 与 `[]` 语义不同（undefined = 沿用旧内嵌规则 / 回退全部启用规则；
 *   [] = 明确不引用任何规则），补 [] 会把历史活动的规则清空、积分算成 0。
 *   这两列改为让**云端列可空**（见 supabase/schema.sql），缺键补 null 后
 *   `Array.isArray(null) === false` 仍走旧回退分支，语义正确。
 */
export const SYNC_FIELD_FILLERS: Record<string, (r: Record<string, unknown>) => void> = {
  groups: (g) => {
    if (typeof g.checkInAuto !== 'boolean') g.checkInAuto = true
    if (typeof g.checkInDays !== 'number') g.checkInDays = 7
    if (typeof g.checkInStartOffset !== 'number') g.checkInStartOffset = 1
    if (!Array.isArray(g.checkInWeekdays)) g.checkInWeekdays = []
    if (typeof g.classActivityAuto !== 'boolean') g.classActivityAuto = true
    if (!Array.isArray(g.autoClassRuleIds)) g.autoClassRuleIds = []
  },
  checkInTasks: (t) => {
    if (!Array.isArray(t.days)) t.days = []
    if (typeof t.auto !== 'boolean') t.auto = false
  },
  classActivities: (a) => {
    if (!Array.isArray(a.rules)) a.rules = []
    if (typeof a.auto !== 'boolean') a.auto = false
    if (a.groupId === undefined) a.groupId = null
    if (a.activityDate === undefined) a.activityDate = null
    if (a.sourceCourseId === undefined) a.sourceCourseId = null
    if (typeof a.note !== 'string') a.note = ''
    if (typeof a.title !== 'string') a.title = ''
  },
  knowledgePoints: (k) => {
    if (!Array.isArray(k.tags)) k.tags = []
  },
  pointRules: (r) => {
    if (typeof r.scope !== 'string') r.scope = 'checkin'
    if (typeof r.mode !== 'string') r.mode = 'auto'
  },
}

/**
 * 规则排序值（`pointRules.order`）的**合理上限**。
 *
 * 背景：云端该列是 `integer`（int4，上限 2147483647）。早期新建规则用
 *   `order: Date.now()`（毫秒时间戳约 1.8e12）→ 溢出 →
 *   PostgREST 报 `value "1789311709042" is out of range for type integer`
 *   → **整张 pointRules 推送失败**（本地 IndexedDB 无类型限制，脏值能存下）。
 *
 * 阈值取 **100 万**：远大于任何真实规则数（不可能有上百万条规则），
 * 又远小于 int4 上限 —— 于是「最大 order + 1」永不溢出 int4，
 * 同时能把时间戳类脏值准确判出来。
 *
 * 不变量：`planPointRuleOrderFixes` 与 `nextRuleOrder` 的输出**必定**满足
 * `isRuleOrderSafe`（否则迁移不收敛，会反复改同一条数据）。
 */
export const MAX_RULE_ORDER = 1_000_000

/** order 是否为可用的合法序号（有限数、非负、不超上限） */
export function isRuleOrderSafe(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_RULE_ORDER
}

/**
 * v30.5：找出 `pointRules.order` 里「不可用」的脏值，给出归一化后的序号。
 *
 * **脏值怎么来的**：早期新建规则用 `order: Date.now()`（本意是「排到最后」），
 * 本地 IndexedDB 无类型限制照单全收，但云端该列是 `integer` →
 * PostgREST 报 `value "1789311709042" is out of range for type integer`，
 * **整张 pointRules 推送失败**（本地看着好好的，同步却一直失败）。
 *
 * **归一化策略（最小侵入）**：
 *  - 合法行（见 `isRuleOrderSafe`）**原样不动**，保留老师手动调整过的顺序；
 *  - 脏行按 `scope` 分组，接在该 scope 现有最大 order 之后依次编号，
 *    保持脏行之间的相对先后（原数组顺序 = 原有先后关系）；
 *  - 序号封顶 `MAX_RULE_ORDER`，保证结果一定合法（迁移收敛）。
 *
 * 返回需要写回的补丁列表；空数组表示没有脏值、无需迁移。
 */
export function planPointRuleOrderFixes(
  rows: ReadonlyArray<Record<string, unknown>>,
): Array<{ id: string; order: number }> {
  const scopeOf = (r: Record<string, unknown>): string =>
    typeof r.scope === 'string' && r.scope ? r.scope : 'checkin'

  // 1) 每个 scope 的合法最大 order（无合法行则为 -1 → 从 0 开始编号）
  const nextSeq = new Map<string, number>()
  for (const r of rows) {
    if (!isRuleOrderSafe(r.order)) continue
    const s = scopeOf(r)
    nextSeq.set(s, Math.max(nextSeq.get(s) ?? -1, r.order))
  }

  // 2) 脏行依次补号（封顶 MAX_RULE_ORDER，杜绝「+1 又超上限」）
  const fixes: Array<{ id: string; order: number }> = []
  for (const r of rows) {
    if (isRuleOrderSafe(r.order)) continue
    const s = scopeOf(r)
    const next = Math.min((nextSeq.get(s) ?? -1) + 1, MAX_RULE_ORDER)
    nextSeq.set(s, next)
    fixes.push({ id: String(r.id), order: next })
  }
  return fixes
}

export const db = new EduDB()

// ============================================================
// 同步辅助
// ============================================================

/** 生成 UUID，优先用原生 API */
export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  // 兜底实现
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/** 给记录打上同步字段（新建时用） */
export function withSyncFields<T>(record: Omit<T, keyof SyncFields>): T {
  const now = Date.now()
  return {
    ...record,
    id: newId(),
    updatedAt: now,
    deletedAt: null,
    dirty: 1,
  } as T
}

/** 更新记录时刷新同步字段 */
export function touch<T extends SyncFields>(record: T): T {
  return { ...record, updatedAt: Date.now(), dirty: 1 }
}

/** 软删除：保留记录以便同步传播删除状态 */
export function markDeleted<T extends SyncFields>(record: T): T {
  return { ...record, deletedAt: Date.now(), updatedAt: Date.now(), dirty: 1 }
}

/** 标记已同步（推送成功后调用） */
export function markSynced<T extends SyncFields>(record: T): T {
  return { ...record, dirty: 0 }
}

// ============================================================
// 默认设置
// ============================================================

export const DEFAULT_SETTINGS: AppSettings = {
  themeMode: 'system',
  subjectColors: [
    '#3b82f6',
    '#10b981',
    '#f59e0b',
    '#ef4444',
    '#8b5cf6',
    '#ec4899',
    '#06b6d4',
    '#84cc16',
  ],
  teacherName: '老师',
  defaultDurationMin: 60,
  dayStartHour: 8,
  dayEndHour: 21,
  aiEnabled: false,
  syncEnabled: false,
  supabaseUrl: '',
  supabaseAnonKey: '',
  lastSyncAt: 0,
  aiProvider: 'disabled',
  aiBaseUrl: '',
  aiApiKey: '',
  aiModel: '',
  aiProxyMode: 'direct',
  aiProxyUrl: '',
  aiProxyToken: '',
  aiVisionEnabled: false,
  aiVisionBaseUrl: '',
  aiVisionApiKey: '',
  aiVisionModel: '',
  aiVisionProxyMode: 'direct',
  aiVisionProxyUrl: '',
  aiVisionProxyToken: '',
  settingsUpdatedAt: 0,
}

// ============================================================
// 默认种子数据（首次使用时补齐，保证新功能开箱可用）
// ============================================================

/** 默认反馈模板：结构清晰、可直接被 AI 填充 */
export const DEFAULT_FEEDBACK_TEMPLATE_BODY = `【本次课程内容】
{{knowledge}}

【课堂表现】
（结合 {{student}} 在 {{date}} {{time}} 的 {{subject}} 课表现撰写，2-3 句，具体、积极）

【掌握情况】
（针对上面列出的知识点逐条说明掌握程度，标注「已掌握 / 需巩固」）

【课后建议】
（1-2 条可执行的练习建议，与本次知识点直接相关）`

/** 确保存在一条默认反馈模板 */
export async function ensureDefaultFeedbackTemplate(): Promise<void> {
  const all = await db.feedbackTemplates.toArray()
  const live = all.filter((t) => !t.deletedAt)
  if (live.some((t) => t.isDefault)) return
  if (live.length > 0) {
    // 有模板但都没设默认 → 把最早的一条设为默认
    const first = [...live].sort((a, b) => a.createdAt - b.createdAt)[0]!
    await db.feedbackTemplates.put(touch({ ...first, isDefault: true }))
    return
  }
  const tpl = withSyncFields<FeedbackTemplate>({
    name: '通用课后反馈',
    body: DEFAULT_FEEDBACK_TEMPLATE_BODY,
    isDefault: true,
    createdAt: Date.now(),
  })
  await db.feedbackTemplates.put(tpl)
}

/** 默认打卡积分规则：每次打卡 +1；连续打卡 7 天额外 +5；本批次全部完成 +3 */
export async function ensureDefaultPointRules(): Promise<void> {
  const all = await db.pointRules.toArray()
  if (all.some((r) => !r.deletedAt)) return
  const now = Date.now()
  const seeds = [
    withSyncFields<PointRule>({
      name: '完成一次打卡',
      points: 1,
      scope: 'checkin',
      mode: 'auto',
      condition: null,
      classCondition: null,
      enabled: true,
      order: 0,
      createdAt: now,
    }),
    withSyncFields<PointRule>({
      name: '连续打卡 7 天',
      points: 5,
      scope: 'checkin',
      mode: 'auto',
      condition: { metric: 'consecutive_days', operator: '>=', value: 7 },
      classCondition: null,
      enabled: true,
      order: 1,
      createdAt: now,
    }),
    withSyncFields<PointRule>({
      name: '批次全部完成',
      points: 3,
      scope: 'checkin',
      mode: 'auto',
      condition: { metric: 'all_done', operator: '==', value: 1 },
      classCondition: null,
      enabled: true,
      order: 2,
      createdAt: now,
    }),
  ]
  await db.pointRules.bulkPut(seeds)
}

const SETTINGS_KEY = 'app'

export async function loadSettings(): Promise<AppSettings> {
  const row = await db.settings.get(SETTINGS_KEY)
  if (!row) return { ...DEFAULT_SETTINGS }
  // 与默认值合并，保证新增字段有兜底
  return { ...DEFAULT_SETTINGS, ...row.value }
}

let _saveSettingsChain: Promise<AppSettings> | null = null

/**
 * 串行化设置保存：Settings 页每个 onChange 都触发 update→saveSettings，
 * 多次并发调用会互相覆盖（第 2 次读到第 1 次保存前的旧值并写回）。
 * 用 Promise 链确保顺序执行，每次 merge 基于最新已保存值。
 *
 * 除 lastSyncAt 外的任何变更都会顺带刷新 settingsUpdatedAt（云同步 LWW 依据）。
 */
export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const prev = _saveSettingsChain ?? loadSettings()
  const result = prev.then(async (prevSettings) => {
    const meaningful = Object.keys(patch).some((k) => k !== 'lastSyncAt')
    const next: AppSettings = {
      ...prevSettings,
      ...patch,
      ...(meaningful ? { settingsUpdatedAt: Date.now() } : {}),
    }
    await db.settings.put({ key: SETTINGS_KEY, value: next })
    return next
  })
  _saveSettingsChain = result
  return result
}

/**
 * 整体写入设置（不刷新 settingsUpdatedAt）。
 * 仅供同步引擎「远端设置胜出」时使用：写入的修订时间戳来自远端，
 * 若在这里再 bump 会让两端互相覆盖、形成同步风暴。
 */
export async function saveSettingsFull(next: AppSettings): Promise<void> {
  const prev = _saveSettingsChain ?? Promise.resolve(next)
  const result = prev.then(async () => {
    await db.settings.put({ key: SETTINGS_KEY, value: next })
    return next
  })
  _saveSettingsChain = result
  await result
}
