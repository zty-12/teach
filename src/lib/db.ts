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
  }
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
