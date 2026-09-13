/**
 * 教务工作台 —— 数据模型类型定义
 *
 * 同步约定：
 *  - 所有业务表主键为 UUID 字符串
 *  - updatedAt / deletedAt 为毫秒时间戳，用于 last-write-wins 冲突合并
 *  - deletedAt 非空表示软删除（保留记录以便同步传播）
 *  - dirty 为本地字段（不上传）：0=已同步，1=待推送
 */

/** 同步基础字段 */
export interface SyncFields {
  id: string
  updatedAt: number
  deletedAt: number | null
  dirty: 0 | 1
}

// ============================================================
// 学生
// ============================================================

export type StudentStatus = 'active' | 'paused' | 'finished' | 'archived'

export const STUDENT_STATUS_LABEL: Record<StudentStatus, string> = {
  active: '在读',
  paused: '暂停',
  finished: '结课',
  archived: '归档',
}

export type BillingRule = 'prepaid' | 'postpaid'

export const BILLING_RULE_LABEL: Record<BillingRule, string> = {
  prepaid: '预付课时',
  postpaid: '按次后付',
}

export interface Student extends SyncFields {
  name: string
  grade: string
  phone: string
  note: string
  status: StudentStatus
  /** 学籍水平，如「初三」「高一」 */
  academicLevel: string
  /** 头像底色（取 subject 配色槽 1-8） */
  colorSlot: number
  createdAt: number
  /** 收费规则：prepaid=预付课时 / postpaid=按次后付 */
  billingRule: BillingRule
  /** 1对1单次课酬（分）——用于按次后付结算 & 出席按人数计酬 */
  hourlyFeeCents: number
  /** 预付已缴课时数（整课时） */
  paidHours: number
  /** 剩余课时数（预付扣减后） */
  remainingHours: number
  /** 课时余量提醒阈值：剩余 ≤ 该值时提醒续费 */
  remindHours: number
  /** 是否试听学生 */
  isTrial: boolean
  /** 试听备注/开始时间 */
  trialAt: number | null
}

// ============================================================
// 班课 / 小组课
// ============================================================

export interface Group extends SyncFields {
  name: string
  subject: string
  /** 默认单次时长（分钟） */
  defaultDurationMin: number
  note: string
  colorSlot: number
  createdAt: number
  /** 班课每人单次课酬（分）：课酬 = perStudentFeeCents × 出席人数 */
  perStudentFeeCents: number
  /** 每周固定开课日 0(周日)~6(周六)；-1 表示未设每周时段（仅手动排课） */
  weekday: number
  /** 每周开课开始时间（当天第几分钟），-1 表示未设 */
  startTimeMin: number
  /** 每周开课结束时间（当天第几分钟），-1 表示未设 */
  endTimeMin: number
  // ---- v8：班课「课后自动打卡」配置（在班课设置里可调）----
  /** 该班课每次完成后是否自动生成周期打卡；缺省 true（向后兼容） */
  checkInAuto?: boolean
  /** 自动打卡的周期天数；缺省 7 天 */
  checkInDays?: number
  /**
   * 起始日偏移：0=下课当天开始，1=次日起（默认）。
   * 打卡日 = 下课日 + startOffset，共 checkInDays 天。
   */
  checkInStartOffset?: number
  /**
   * 打卡日限定的星期几（0=周日~6=周六）；为空表示不限制（按自然日连续）。
   * 设置后：从起始日起向后取「落在所选星期几」的日期，共 checkInDays 天。
   */
  checkInWeekdays?: number[]
  // ---- v21：班课「课堂积分活动」自动生成配置（与课后自动打卡并列）----
  /** 该班课每次完成后是否自动生成课堂积分活动；缺省 true（向后兼容） */
  classActivityAuto?: boolean
}

export interface GroupMember extends SyncFields {
  groupId: string
  studentId: string
  joinedAt: number
}

// ============================================================
// 课程
// ============================================================

export type CourseStatus = 'pending' | 'done' | 'cancelled' | 'leave'
export type CourseKind = 'one_on_one' | 'group'
export type TeachMethod = 'online' | 'offline'

export const COURSE_STATUS_LABEL: Record<CourseStatus, string> = {
  pending: '待上课',
  done: '已完成',
  cancelled: '已取消',
  leave: '请假',
}

export interface Course extends SyncFields {
  /** 一对一课程的学生 ID；班课为 null */
  studentId: string | null
  /** 班课 ID；一对一为 null */
  groupId: string | null
  subject: string
  /** 开课时间（毫秒时间戳） */
  startAt: number
  /** 时长（分钟） */
  durationMin: number
  method: TeachMethod
  location: string
  note: string
  status: CourseStatus
  /** 科目配色槽 1-8 */
  colorSlot: number
  /** 单次课酬（分），用于结算与财务统计 */
  feeCents: number
  createdAt: number
  /** 是否补课：学生缺勤班课后，单独补的一对一课时（计 1 课时，时长可为原课时一半） */
  isMakeup?: boolean
  /** 补课对应的原课程（通常是被请假的班课）ID；非补课为 null/缺省 */
  makeupSourceCourseId?: string | null
  /**
   * v21：完成上课时对每位学生的「实际扣减课时」快照。
   * 「取消完成」据此精确返还——避免仅按当前余额重算时，
   * 把「余额正好扣到 0」的课返还成 0 课时的问题。
   * 旧数据无此字段时回退到按出席重算。
   */
  deductedHours?: Array<{ studentId: string; hours: number }> | null
}

// ============================================================
// 课程出席（用于按人数计酬 + 预付课时代扣）
// ============================================================

/** 一次课程中某位学生的出席记录 */
export interface CourseAttendance extends SyncFields {
  courseId: string
  studentId: string
  /** 是否出席（参与了本次课） */
  present: boolean
  /** 出席时间 */
  attendAt: number | null
  createdAt: number
}

// ============================================================
// 课后反馈
// ============================================================

export interface CourseFeedback extends SyncFields {
  courseId: string
  /** 正文（Markdown） */
  content: string
  /** 一句话摘要 */
  summary: string
  /** 草稿未发布 */
  isDraft: boolean
  publishedAt: number | null
  /** 是否由 AI 生成 */
  aiGenerated: boolean
  createdAt: number
}

// ============================================================
// 学习报告与标签
// ============================================================

export interface LearningReport extends SyncFields {
  studentId: string
  /** 报告标题，如「小明 9月学习报告」 */
  title: string
  periodStart: number
  periodEnd: number
  content: string
  aiGenerated: boolean
  createdAt: number
}

export interface LearningTag extends SyncFields {
  name: string
  /** 标签类型：知识点 / 习惯 / 表现 */
  type: string
  colorSlot: number
}

/** 学生 ↔ 标签 的关联（多对多） */
export interface StudentTag extends SyncFields {
  studentId: string
  tagId: string
  /** 打标签的时间 */
  assignedAt: number
}

/** 学习标签的常用类型 */
export const TAG_TYPES = ['知识点', '习惯', '表现'] as const

// ============================================================
// 财务
// ============================================================

/** 付款方：student=学生/家长付款；institution=机构向老师结算课酬 */
export type PayerType = 'student' | 'institution'

export interface Payment extends SyncFields {
  /** 学生 ID；机构结清时为 null */
  studentId: string | null
  /** 付款方（默认 'student'），为 'institution' 时表示机构向老师结算课酬 */
  payer?: PayerType
  /** 金额（分），正数=收款，负数=退款 */
  amountCents: number
  method: string
  paidAt: number
  note: string
  createdAt: number
}

export interface Settlement extends SyncFields {
  /** 结算对应的课程 */
  courseId: string
  studentId: string | null
  groupId: string | null
  amountCents: number
  settledAt: number
  note: string
  createdAt: number
}

// ============================================================
// 知识库（教材 → 单元 → 知识点）
// ============================================================

/** 教材（如《新概念英语》） */
export interface Textbook extends SyncFields {
  name: string
  subject: string
  /** 适用年级（可选） */
  grade: string
  note: string
  createdAt: number
}

/** 教材下的单元（如 Unit 1） */
export interface TextbookUnit extends SyncFields {
  textbookId: string
  name: string
  /** 单元内排序（从小到大） */
  order: number
  note: string
  createdAt: number
}

/** 知识点 / 课文（如 Unit 1 的第 1 篇课文） */
export interface KnowledgePoint extends SyncFields {
  unitId: string
  /** 冗余存教材 ID，便于按教材直接筛选 */
  textbookId: string
  title: string
  /** 原始内容（老师的备课笔记 / 课文要点） */
  content: string
  /** AI 总结梳理后的摘要 */
  summary: string
  /** 是否已被 AI 总结过 */
  summarizedAt: number | null
  tags: string[]
  createdAt: number
}

// ============================================================
// 课后反馈模板
// ============================================================

/**
 * 模板形态（v8）：
 *  - 'text'：旧版纯文本模板，用 {{占位符}}，AI 按文本结构生成
 *  - 'structured'：结构化字段模板，由字段列表驱动，每个字段可关联工作台资料
 * 缺省按 'text' 处理，保证旧数据向后兼容。
 */
export type FeedbackTemplateKind = 'text' | 'structured'

/** 反馈模板：正文支持占位符，见 FEEDBACK_PLACEHOLDERS */
export interface FeedbackTemplate extends SyncFields {
  name: string
  /** 模板正文（支持 {{占位符}}） */
  body: string
  /** 是否为默认模板（同时最多一个生效） */
  isDefault: boolean
  createdAt: number
  /** 模板形态；缺省为 'text'（旧数据向后兼容） */
  kind?: FeedbackTemplateKind
}

// ============================================================
// 结构化反馈模板字段（v8）
// ============================================================

/**
 * 字段的数据来源 —— 决定 AI 生成该字段时拿到哪些工作台资料作素材。
 * 由 AI 分析导入模板时自动判定，老师也可手动改。
 */
export type FieldSourceKind =
  /** 知识库知识点：本次课勾选的知识点标题 + 摘要 */
  | 'knowledge'
  /** 出勤与课时信息：出席状态、日期时长、剩余课时 */
  | 'attendance'
  /** 学生画像：AI 汇总的优势 / 待改进 / 教学建议 */
  | 'profile'
  /** 打卡记录：近期打卡完成情况、老师备注、AI 家长反馈 */
  | 'checkin'
  /** 课程基础信息：科目、日期、时长、课程备注 */
  | 'course'
  /** 不关联特定资料，由 AI 结合上下文自由撰写 */
  | 'none'

export const FIELD_SOURCE_LABEL: Record<FieldSourceKind, string> = {
  knowledge: '知识库知识点',
  attendance: '出勤与课时',
  profile: '学生画像',
  checkin: '打卡记录',
  course: '课程信息',
  none: '不关联（AI 自由撰写）',
}

/** 结构化模板的一个字段（如「本节课重点」「家庭配合建议」） */
export interface FeedbackTemplateField extends SyncFields {
  templateId: string
  /** 字段名 / 小标题 */
  name: string
  /** 该字段的写作要求（给 AI 的指令，也可为空） */
  hint: string
  /** 关联的资料来源 */
  source: FieldSourceKind
  /** 排序（从小到大） */
  order: number
  createdAt: number
}

/**
 * 反馈模板支持的占位符。
 * AI 生成时会拿到这些变量的真实值，并严格按模板结构组织内容。
 */
export const FEEDBACK_PLACEHOLDERS = [
  { key: 'student', label: '学生姓名', desc: '本次课的学生 / 班课名称' },
  { key: 'subject', label: '科目', desc: '课程科目' },
  { key: 'date', label: '上课日期', desc: '如 2026年9月6日' },
  { key: 'time', label: '上课时间', desc: '如 14:00–15:00' },
  { key: 'knowledge', label: '本次知识点', desc: '勾选的知识点标题 + 摘要，自动展开' },
  { key: 'duration', label: '课程时长', desc: '如 60 分钟' },
  { key: 'note', label: '课程备注', desc: '排课时填写的备注' },
] as const

/** 课程 ↔ 知识点 覆盖关系（这节课讲了哪些知识点） */
export interface CourseKnowledge extends SyncFields {
  courseId: string
  knowledgePointId: string
  createdAt: number
}

// ============================================================
// 打卡
// ============================================================

/** 打卡任务（一个任务可是一次性，也可是一段周期内多天打卡） */
export interface CheckInTask extends SyncFields {
  /** 关联课程；手动创建的批次可为 null */
  courseId: string | null
  /** 关联班课（scope='group' 时用）；手动创建可为 null */
  groupId: string | null
  title: string
  /** 截止时间戳（单次任务）；null 表示不限 */
  dueAt: number | null
  /** 参与范围：course=指定课程、group=指定班课成员、all=全体在读学生 */
  scope: 'course' | 'group' | 'all'
  /**
   * 打卡日集合：每天零点的时间戳。
   *  - 单次任务：[唯一一天]（即 dueAt 所在当天）
   *  - 周期任务：区间内每天
   *  - 自定义任务：区间内被选中的几天
   * 空数组表示未指定（向后兼容旧数据，用 dueAt 兜底）。
   */
  days: number[]
  /** 打卡节奏说明（用户友好文案，如“每天/每周二、四”） */
  cadenceLabel: string
  /** 额外说明（打卡要求） */
  note: string
  /**
   * 本任务适用的打卡规则 id（v20，引用 pointRules 中 scope='checkin' 的规则）。
   * 空数组 / undefined = 兼容旧数据：沿用所有启用的打卡规则。
   */
  ruleIds?: string[]
  /**
   * v21：是否由「完成课程」自动生成。
   * 「取消完成」时据此清理对应打卡任务（避免误删老师手动创建的课程打卡）。
   */
  auto?: boolean
  createdAt: number
}

export type CheckInStatus = 'pending' | 'done' | 'missed'

export const CHECKIN_STATUS_LABEL: Record<CheckInStatus, string> = {
  pending: '未打卡',
  done: '已打卡',
  missed: '未通过',
}

/** 单个学生在某个打卡任务、某个打卡日中的记录（一条=一个学生·一天） */
export interface CheckInRecord extends SyncFields {
  taskId: string
  studentId: string
  /** 所属打卡日（零点时间戳）；单次任务也可为 null（旧数据向后兼容） */
  dayAt: number | null
  status: CheckInStatus
  /** 老师备注（打卡内容、完成情况等） */
  note: string
  /** AI 生成的给家长看的反馈（可选，由「AI 生成家长反馈」按钮写入，可再次编辑） */
  aiFeedback: string
  checkedAt: number | null
  /** 手动档位规则选中的规则 id（v20）：mode='tier' 的规则据此计分 */
  selectedRuleId?: string | null
  createdAt: number
}

/**
 * 学生画像：AI 基于历史打卡备注 + AI 反馈汇总生成的学生特征。
 * 用于下次打卡时按画像生成个性化的家长反馈。
 * 一个学生对应一条画像记录（studentId 唯一键）。
 */
export interface StudentProfile extends SyncFields {
  studentId: string
  /** 综合学习特征（性格 / 习惯 / 优劣势），自然语言 */
  summary: string
  /** 优势 / 亮点，分号分隔 */
  strengths: string
  /** 待改进 / 弱点，分号分隔 */
  weaknesses: string
  /** 推荐的教学方式（如「多鼓励、少批评」「需要拆分任务」） */
  teachingStyle: string
  /** 最近一次 AI 更新的时间戳 */
  profileUpdatedAt: number
  /** 生成时使用的素材条数（备注+反馈） */
  sourceCount: number
}

// ============================================================
// 积分
// ============================================================

/** 积分规则类型：base=每次打卡基础分；bonus=满足条件额外奖励（v20 起仅作旧数据兼容） */
export type PointRuleKind = 'base' | 'bonus'

/**
 * 规则适用范围（v20）
 *  - checkin：打卡规则，用于打卡任务
 *  - class  ：课堂规则，用于课堂积分活动
 * 两套规则各自独立维护，互不干扰。
 */
export type RuleScope = 'checkin' | 'class'

export const RULE_SCOPE_LABEL: Record<RuleScope, string> = {
  checkin: '打卡规则',
  class: '课堂规则',
}

export const RULE_SCOPE_HINT: Record<RuleScope, string> = {
  checkin: '用于「打卡任务」，如「提交作业 +2」「连续打卡 7 天 +5」',
  class: '用于「课堂积分」活动，如「背诵熟练 +1」「第一个过关额外 +1」',
}

/**
 * 规则计分方式（v20）
 *  - auto：自动累加 —— 达标学生自动加分（如「提交作业 +2」，所有完成的学生都加）
 *  - tier：手动档位 —— 标记学生时从该活动的档位规则里选一条（如「熟练 +1 / 不熟练 +0.5」）
 * 两种方式可在同一个活动里混用。
 */
export type RuleMode = 'auto' | 'tier'

export const RULE_MODE_LABEL: Record<RuleMode, string> = {
  auto: '自动累加',
  tier: '手动档位',
}

export const RULE_MODE_HINT: Record<RuleMode, string> = {
  auto: '达标学生自动加，无需手动选',
  tier: '标记学生时手动选一条（如 熟练 +1 / 不熟练 +0.5）',
}

/** 加分条件的度量维度 */
export type PointMetric =
  | 'checkin_count'
  | 'consecutive_days'
  | 'on_time_rate'
  | 'all_done'

export const POINT_METRIC_LABEL: Record<PointMetric, string> = {
  checkin_count: '本批次打卡次数',
  consecutive_days: '连续打卡天数',
  on_time_rate: '准时打卡率(%)',
  all_done: '本批次全部完成',
}

export interface PointRuleCondition {
  metric: PointMetric
  operator: '>=' | '>' | '=='
  value: number
}

/**
 * 积分规则（规则库，v20 起统一维护打卡与课堂两套规则）
 *
 * 一条规则 = 名称 + 分值 + 适用范围 + 计分方式 +（可选）条件。
 * 规则只在这里定义；打卡任务 / 课堂活动通过 ruleIds 引用，可在活动内增减。
 */
export interface PointRule extends SyncFields {
  name: string
  /** 分值（可为小数，如 0.5；也可为负用于扣分） */
  points: number
  /** 适用范围：打卡 / 课堂 */
  scope: RuleScope
  /** 计分方式：自动累加 / 手动档位 */
  mode: RuleMode
  /** 打卡范围的条件（如连续打卡 7 天）；null = 无条件（所有已打卡学生都加） */
  condition: PointRuleCondition | null
  /** 课堂范围的名次/状态条件（如第一个过关、前 3 名）；null = 无条件（所有过关学生都加） */
  classCondition: ClassRuleConditionSpec | null
  enabled: boolean
  /** 排序（从小到大生效） */
  order: number
  createdAt: number
  /** 旧字段（v4~v19）：规则类型，保留兼容，新数据不再写入 */
  kind?: PointRuleKind
}

/** 积分流水（ earn / spend / adjust ） */
export interface PointLedger extends SyncFields {
  studentId: string
  /** 正数=获得，负数=消耗 */
  delta: number
  kind: 'earn' | 'spend' | 'adjust'
  /** 事由（如「9/6 课后朗读打卡」/「兑换：免作业一次」） */
  reason: string
  taskId: string | null
  createdAt: number
}

// ============================================================
// 课堂积分（v16）
// ============================================================

/**
 * 课堂活动计分规则的条件类型（v19 起支持自定义加分条件）。
 * - pass  ：每个过关的学生都加（如「过关 +1」）
 * - fail  ：未过关的学生加（如「参与鼓励 +1」）
 * - first ：仅第 1 名过关额外加
 * - topN  ：前 N 名过关额外加（配 rankN）
 * - rank  ：第 N 名过关额外加（配 rankN）
 * - range ：第 X ~ Y 名过关额外加（配 rankFrom / rankTo）
 * 旧的 pass / first 数据继续有效，无需迁移。
 */
export type ClassRuleCondition = 'pass' | 'fail' | 'first' | 'topN' | 'rank' | 'range'

export const CLASS_RULE_CONDITION_LABEL: Record<ClassRuleCondition, string> = {
  pass: '过关者都加',
  fail: '未过关者加',
  first: '仅第一个过关',
  topN: '前 N 名过关',
  rank: '第 N 名过关',
  range: '第 X~Y 名过关',
}

/** 各条件是否需要额外填写名次参数（用于新建弹窗按条件动态显示输入框） */
export const CLASS_RULE_CONDITION_PARAM: Record<
  ClassRuleCondition,
  'none' | 'single' | 'range'
> = {
  pass: 'none',
  fail: 'none',
  first: 'none',
  topN: 'single',
  rank: 'single',
  range: 'range',
}

/** 需要填写名次参数的条件（topN / rank 用 rankN，range 用 rankFrom~rankTo） */
export function conditionNeedsRank(condition: ClassRuleCondition): 'none' | 'single' | 'range' {
  return CLASS_RULE_CONDITION_PARAM[condition] ?? 'none'
}

/**
 * 课堂规则的条件描述（v20）：条件 + 名次参数。
 * 与旧版 ClassActivityRule 的字段形状一致，描述函数可同时接受两者。
 */
export interface ClassRuleConditionSpec {
  condition: ClassRuleCondition
  /** topN / rank：名次参数 N */
  rankN?: number
  /** range：起始名次 */
  rankFrom?: number
  /** range：结束名次 */
  rankTo?: number
}

/** 把课堂规则条件描述成中文短句（含名次参数），用于规则标签 */
export function describeClassRuleCondition(spec: {
  condition: ClassRuleCondition
  rankN?: number
  rankFrom?: number
  rankTo?: number
}): string {
  switch (spec.condition) {
    case 'topN':
      return `前 ${Math.max(1, spec.rankN ?? 1)} 名过关`
    case 'rank':
      return `第 ${Math.max(1, spec.rankN ?? 1)} 名过关`
    case 'range': {
      const from = Math.max(1, spec.rankFrom ?? 1)
      const to = Math.max(from, spec.rankTo ?? from)
      return `第 ${from}~${to} 名过关`
    }
    default:
      return CLASS_RULE_CONDITION_LABEL[spec.condition] ?? spec.condition
  }
}

/** 课堂活动内的计分规则 */
export interface ClassActivityRule {
  name: string
  points: number
  condition: ClassRuleCondition
  enabled: boolean
  /** topN / rank：名次参数（N），默认 1 */
  rankN?: number
  /** range：起始名次，默认 1 */
  rankFrom?: number
  /** range：结束名次，默认与 rankFrom 相同 */
  rankTo?: number
}

/** 课堂活动 */
export interface ClassActivity extends SyncFields {
  title: string
  /** 关联课程（旧字段，保留兼容；一对一课程场景） */
  courseId: string | null
  /** 关联班课（v17：截图里的「关联班课」下拉，取 Group.name） */
  groupId?: string | null
  /** 活动日期（零点时间戳，v17）：用于「按排课当天自动生成」去重与按日归类 */
  activityDate?: number | null
  /** 是否由排课自动生成（v17） */
  auto?: boolean
  /** 自动生成时的来源课程 id（v17） */
  sourceCourseId?: string | null
  /**
   * 本活动适用的课堂规则 id（v20，引用 pointRules 中 scope='class' 的规则）。
   * 用于新建/自动生成的活动；为空时回退到下面的内嵌 rules（旧数据）。
   */
  ruleIds?: string[]
  /** 旧版内嵌计分规则（v16~v19），仅用于兼容历史活动 */
  rules?: ClassActivityRule[]
  note: string
  createdAt: number
}

/** 课堂活动记录（学生参与） */
export interface ClassActivityRecord extends SyncFields {
  activityId: string
  studentId: string
  status: 'pending' | 'pass' | 'fail'
  pointsAwarded: number
  note: string
  checkedAt: number | null
  createdAt: number
  /** 本次加分写入的积分流水 id（v17）：撤销/改判时用于冲销，避免积分残留 */
  ledgerId?: string | null
  /** 手动档位规则选中的规则 id（v20）：mode='tier' 的规则据此计分 */
  selectedRuleId?: string | null
}

// ============================================================
// 积分兑换
// ============================================================

/** 兑换商城里的奖励项 */
export interface RewardItem extends SyncFields {
  name: string
  /** 兑换所需积分 */
  pointsCost: number
  /** 库存；null=不限 */
  stock: number | null
  note: string
  enabled: boolean
  createdAt: number
}

export type RedemptionStatus = 'pending' | 'fulfilled' | 'cancelled'

export const REDEMPTION_STATUS_LABEL: Record<RedemptionStatus, string> = {
  pending: '待发放',
  fulfilled: '已发放',
  cancelled: '已取消',
}

/** 兑换记录（核销流水） */
export interface Redemption extends SyncFields {
  studentId: string
  rewardItemId: string
  /** 兑换时快照的奖励名（避免奖励项改名后查不到） */
  rewardName: string
  pointsSpent: number
  status: RedemptionStatus
  redeemedAt: number
  fulfilledAt: number | null
  note: string
  createdAt: number
}

// ============================================================
// 设置与同步
// ============================================================

export interface AppSettings {
  /** 浅色 / 深色 / 跟随系统 */
  themeMode: 'light' | 'dark' | 'system'
  /** 8 个科目配色槽 */
  subjectColors: string[]
  /** 教师姓名，用于界面问候 */
  teacherName: string
  /** 默认课时时长（分钟） */
  defaultDurationMin: number
  /** 每日开始 / 结束时间（小时），用于周视图时间轴范围 */
  dayStartHour: number
  dayEndHour: number
  /** AI 功能开关 */
  aiEnabled: boolean
  /** Supabase 同步开关 */
  syncEnabled: boolean
  /** Supabase 项目 URL，在工作台设置页填写（也可由 .env VITE_SUPABASE_URL 兜底） */
  supabaseUrl: string
  /** Supabase anon key，在工作台设置页填写（也可由 .env VITE_SUPABASE_ANON_KEY 兜底） */
  supabaseAnonKey: string
  /** 上次成功同步的时间戳；0 表示尚未同步 */
  lastSyncAt: number
  /** AI 服务提供方；'disabled' 表示关闭 */
  aiProvider: 'openai-compatible' | 'disabled'
  /** LLM Base URL（OpenAI 兼容 /v1 接口），如 https://api.openai.com/v1 */
  aiBaseUrl: string
  /** LLM API Key，运行时从设置读取，不写入构建产物 */
  aiApiKey: string
  /** 模型名，如 gpt-4o-mini / deepseek-chat / qwen-plus */
  aiModel: string
  /** AI 请求中转模式：direct=前端直连 LLM；proxy=经 Supabase Edge Function 中转（规避 CORS） */
  aiProxyMode: 'direct' | 'proxy'
  /** Edge Function URL（如 https://xxx.supabase.co/functions/v1/llm-proxy） */
  aiProxyUrl: string
  /** Edge Function 鉴权 Token（对应 Supabase Secret LLM_PROXY_TOKEN） */
  aiProxyToken: string
  /**
   * 视觉模型（图片识别）配置 —— 与「通用 AI」完全独立的一组设置，
   * 可指向不同的 Base URL / API Key / 中转（例如把图片识别单独走一个多模态服务）。
   * 留空表示未配置；设置后导入图片型 PDF 时可走「视觉识别」分支。
   */
  aiVisionEnabled: boolean
  aiVisionBaseUrl: string
  aiVisionApiKey: string
  /** 视觉模型名，如 sensenova-6.8-flash-lite、gpt-4o-mini、qwen-vl-max */
  aiVisionModel: string
  aiVisionProxyMode: 'direct' | 'proxy'
  aiVisionProxyUrl: string
  aiVisionProxyToken: string
  /** 设置最后修改时间戳（内部字段）：用于设置云同步的 last-write-wins 比较 */
  settingsUpdatedAt: number
}

export interface SyncMeta {
  table: string
  lastPulledAt: number
  lastPushedAt: number
}

/**
 * 数据版本快照（v15）——同步成功后自动生成，本地 + 云端双份，支持回滚到任意历史版本。
 *  - payload：{ [表名]: 该表全量行数组 }
 *  - settingsRow：设置行快照（key='app'），可能为 null
 *  - signature：内容签名，数据未变化时不重复建版本（避免自动同步刷出大量重复版本）
 */
export interface DataSnapshot {
  id: string
  createdAt: number
  /** 展示标签：自动版本为时间描述，手动版本可自定义 */
  label: string
  /** 是否自动生成 */
  auto: boolean
  /** 生成端简要标识（区分设备） */
  device: string
  /** 每张表行数统计（列表快速展示，免读大 payload） */
  counts: Record<string, number>
  /** 内容签名（counts + 各表最大 updatedAt + 设置修订号） */
  signature: string
  /** 全量数据 */
  payload: Record<string, unknown[]>
  /** 设置快照 */
  settingsRow: { key: string; value: AppSettings } | null
}

/** 所有可同步表的名称 */
export type SyncTableName =
  | 'students'
  | 'groups'
  | 'groupMembers'
  | 'courses'
  | 'courseAttendances'
  | 'courseFeedbacks'
  | 'learningReports'
  | 'learningTags'
  | 'studentTags'
  | 'payments'
  | 'settlements'
  // v4/v5：知识库 / 反馈模板 / 打卡 / 积分 / 兑换
  | 'textbooks'
  | 'textbookUnits'
  | 'knowledgePoints'
  | 'feedbackTemplates'
  | 'courseKnowledges'
  | 'checkInTasks'
  | 'checkInRecords'
  | 'pointRules'
  | 'pointLedgers'
  | 'rewardItems'
  | 'redemptions'
  // v6：学生画像（AI 汇总历史 aiFeedback 生成的学生特征）
  | 'studentProfiles'
  // v8：结构化反馈模板的字段
  | 'feedbackTemplateFields'
  // v16：课堂积分
  | 'classActivities'
  | 'classActivityRecords'
