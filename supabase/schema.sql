-- ============================================================
-- 教务工作台 · Supabase 建表脚本（全量 / 幂等）
--
-- 用法：Supabase 控制台 → SQL Editor → New query → 粘贴 → Run
--
-- ✅ 新用户：一次执行即建齐全部 26 张业务表 + 2 张辅助表
-- ✅ 老用户：可反复执行，只会「补建缺的表 / 补加缺的列」，不删数据
--    —— 这正是修复「云端缺少数据表：groups 表缺少 checkInWeekdays 列」的方式
--
-- 说明：
--   1. 列名使用驼峰（与前端字段一一对应），因此必须用双引号包裹
--   2. updatedAt / deletedAt 为毫秒时间戳，用于 last-write-wins 冲突合并
--   3. deletedAt 非空表示软删除，记录保留以便同步传播
--   4. 数组 / 对象字段用 jsonb 存储（tags / days / condition / rules …）
--
-- ⚠️ 安全提示：本脚本为「单人自用」设计，策略允许 anon 角色全权读写。
--    若后续接入多人协作，务必改为基于 auth.uid() 的行级隔离策略。
-- ============================================================


-- ============================================================
-- 第 1 部分：建表（全部 26 张业务表 + 2 张辅助表）
-- ============================================================

-- ---------- 学生 ----------
create table if not exists students (
  id text primary key,
  name text not null default '',
  grade text not null default '',
  phone text not null default '',
  note text not null default '',
  status text not null default 'active',
  "academicLevel" text not null default '',
  "colorSlot" integer not null default 1,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint,
  -- v3：计费字段
  "billingRule" text not null default 'postpaid',
  "hourlyFeeCents" integer not null default 0,
  "paidHours" integer not null default 0,
  "remainingHours" integer not null default 0,
  "remindHours" integer not null default 2,
  "isTrial" boolean not null default false,
  "trialAt" bigint
);
create index if not exists students_updated_idx on students ("updatedAt");
create index if not exists students_trial_idx on students ("isTrial");

-- ---------- 班课 / 小组 ----------
create table if not exists groups (
  id text primary key,
  name text not null default '',
  subject text not null default '',
  "defaultDurationMin" integer not null default 60,
  note text not null default '',
  "colorSlot" integer not null default 1,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint,
  -- v3：每周固定时段 + 每人单价
  "perStudentFeeCents" integer not null default 0,
  weekday integer not null default -1,
  "startTimeMin" integer not null default -1,
  "endTimeMin" integer not null default -1,
  -- v8：班课「课后自动打卡」配置
  "checkInAuto" boolean not null default true,
  "checkInDays" integer not null default 7,
  "checkInStartOffset" integer not null default 1,
  "checkInWeekdays" jsonb not null default '[]'::jsonb,
  -- v21：完成课程后自动生成「课堂积分活动」
  "classActivityAuto" boolean not null default true,
  -- v30.3：自动生成的课堂积分活动引用哪些课堂规则（规则 id 数组）
  "autoClassRuleIds" jsonb not null default '[]'::jsonb
);
create index if not exists groups_updated_idx on groups ("updatedAt");
create index if not exists groups_weekday_idx on groups (weekday);

create table if not exists "groupMembers" (
  id text primary key,
  "groupId" text not null default '',
  "studentId" text not null default '',
  "joinedAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "groupMembers_updated_idx" on "groupMembers" ("updatedAt");
create index if not exists "groupMembers_group_idx" on "groupMembers" ("groupId");

-- ---------- 课程 ----------
create table if not exists courses (
  id text primary key,
  "studentId" text,
  "groupId" text,
  subject text not null default '',
  "startAt" bigint not null default 0,
  "durationMin" integer not null default 60,
  method text not null default 'offline',
  location text not null default '',
  note text not null default '',
  status text not null default 'pending',
  "colorSlot" integer not null default 1,
  "feeCents" integer not null default 0,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint,
  -- v7：补课标记
  "isMakeup" boolean not null default false,
  "makeupSourceCourseId" text,
  -- v21：完成上课时的扣减课时快照（取消完成时据此精确返还）
  "deductedHours" jsonb,
  -- v26：单位课酬基准快照（分）——首次完成时固定，历史课酬不随单价变更被追溯改写
  "feeUnitCents" integer
);
create index if not exists courses_updated_idx on courses ("updatedAt");
create index if not exists courses_start_idx on courses ("startAt");

-- ---------- 课程出席（v3 新增） ----------
create table if not exists "courseAttendances" (
  id text primary key,
  "courseId" text not null default '',
  "studentId" text not null default '',
  present boolean not null default true,
  "attendAt" bigint,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "courseAttendances_updated_idx" on "courseAttendances" ("updatedAt");
create index if not exists "courseAttendances_course_idx" on "courseAttendances" ("courseId");
create index if not exists "courseAttendances_student_idx" on "courseAttendances" ("studentId");

-- ---------- 课后反馈 ----------
create table if not exists "courseFeedbacks" (
  id text primary key,
  "courseId" text not null default '',
  content text not null default '',
  summary text not null default '',
  "isDraft" boolean not null default true,
  "publishedAt" bigint,
  "aiGenerated" boolean not null default false,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "courseFeedbacks_updated_idx" on "courseFeedbacks" ("updatedAt");
create index if not exists "courseFeedbacks_course_idx" on "courseFeedbacks" ("courseId");

-- ---------- 学习报告 ----------
create table if not exists "learningReports" (
  id text primary key,
  "studentId" text not null default '',
  title text not null default '',
  "periodStart" bigint not null default 0,
  "periodEnd" bigint not null default 0,
  content text not null default '',
  "aiGenerated" boolean not null default false,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "learningReports_updated_idx" on "learningReports" ("updatedAt");

-- ---------- 学习标签 ----------
create table if not exists "learningTags" (
  id text primary key,
  name text not null default '',
  type text not null default '',
  "colorSlot" integer not null default 1,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "learningTags_updated_idx" on "learningTags" ("updatedAt");

-- ---------- 学生 ↔ 标签 关联（v2 新增） ----------
create table if not exists "studentTags" (
  id text primary key,
  "studentId" text not null default '',
  "tagId" text not null default '',
  "assignedAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "studentTags_updated_idx" on "studentTags" ("updatedAt");
create index if not exists "studentTags_student_idx" on "studentTags" ("studentId");

-- ---------- 收款 ----------
create table if not exists payments (
  id text primary key,
  "studentId" text not null default '',
  payer text not null default 'student',
  "amountCents" integer not null default 0,
  method text not null default '',
  "paidAt" bigint not null default 0,
  note text not null default '',
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists payments_updated_idx on payments ("updatedAt");

-- ---------- 课时结算 ----------
create table if not exists settlements (
  id text primary key,
  "courseId" text not null default '',
  "studentId" text,
  "groupId" text,
  "amountCents" integer not null default 0,
  "settledAt" bigint not null default 0,
  note text not null default '',
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists settlements_updated_idx on settlements ("updatedAt");

-- ============================================================
-- v5：知识库 / 反馈模板 / 打卡 / 积分 / 兑换
-- ============================================================

-- ---------- 知识库：教材 ----------
create table if not exists textbooks (
  id text primary key,
  name text not null default '',
  subject text not null default '',
  grade text not null default '',
  note text not null default '',
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists textbooks_updated_idx on textbooks ("updatedAt");

-- ---------- 知识库：单元 ----------
create table if not exists "textbookUnits" (
  id text primary key,
  "textbookId" text not null default '',
  name text not null default '',
  "order" integer not null default 0,
  note text not null default '',
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "textbookUnits_updated_idx" on "textbookUnits" ("updatedAt");
create index if not exists "textbookUnits_textbook_idx" on "textbookUnits" ("textbookId");

-- ---------- 知识库：知识点 ----------
create table if not exists "knowledgePoints" (
  id text primary key,
  "unitId" text not null default '',
  "textbookId" text not null default '',
  title text not null default '',
  content text not null default '',
  summary text not null default '',
  "summarizedAt" bigint,
  tags jsonb not null default '[]'::jsonb,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "knowledgePoints_updated_idx" on "knowledgePoints" ("updatedAt");
create index if not exists "knowledgePoints_textbook_idx" on "knowledgePoints" ("textbookId");
create index if not exists "knowledgePoints_unit_idx" on "knowledgePoints" ("unitId");

-- ---------- 反馈模板 ----------
create table if not exists "feedbackTemplates" (
  id text primary key,
  name text not null default '',
  body text not null default '',
  "isDefault" boolean not null default false,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint,
  -- v8：模板形态 text（占位符文本）/ structured（结构化字段）
  kind text not null default 'text'
);
create index if not exists "feedbackTemplates_updated_idx" on "feedbackTemplates" ("updatedAt");

-- ---------- 结构化反馈模板字段（v8） ----------
create table if not exists "feedbackTemplateFields" (
  id text primary key,
  "templateId" text not null default '',
  name text not null default '',
  hint text not null default '',
  source text not null default 'none',
  "order" integer not null default 0,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "feedbackTemplateFields_updated_idx" on "feedbackTemplateFields" ("updatedAt");
create index if not exists "feedbackTemplateFields_template_idx" on "feedbackTemplateFields" ("templateId");

-- ---------- 课程 ↔ 知识点 覆盖关系 ----------
create table if not exists "courseKnowledges" (
  id text primary key,
  "courseId" text not null default '',
  "knowledgePointId" text not null default '',
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "courseKnowledges_updated_idx" on "courseKnowledges" ("updatedAt");
create index if not exists "courseKnowledges_course_idx" on "courseKnowledges" ("courseId");

-- ---------- 打卡任务 ----------
create table if not exists "checkInTasks" (
  id text primary key,
  "courseId" text,
  "groupId" text,
  title text not null default '',
  "dueAt" bigint,
  scope text not null default 'all',
  days jsonb not null default '[]'::jsonb,
  "cadenceLabel" text not null default '',
  note text not null default '',
  "ruleIds" jsonb not null default '[]'::jsonb,
  "auto" boolean not null default false,
  "deletedReason" text,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "checkInTasks_updated_idx" on "checkInTasks" ("updatedAt");

-- ---------- 打卡记录 ----------
create table if not exists "checkInRecords" (
  id text primary key,
  "taskId" text not null default '',
  "studentId" text not null default '',
  "dayAt" bigint,
  status text not null default 'pending',
  note text not null default '',
  "aiFeedback" text not null default '',
  "checkedAt" bigint,
  "selectedRuleId" text,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "checkInRecords_updated_idx" on "checkInRecords" ("updatedAt");
create index if not exists "checkInRecords_task_idx" on "checkInRecords" ("taskId");

-- ---------- 积分规则 ----------
create table if not exists "pointRules" (
  id text primary key,
  name text not null default '',
  kind text not null default 'base',
  points integer not null default 1,
  condition jsonb,
  scope text not null default 'checkin',
  mode text not null default 'auto',
  "classCondition" jsonb,
  enabled boolean not null default true,
  "order" integer not null default 0,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "pointRules_updated_idx" on "pointRules" ("updatedAt");

-- ---------- 积分流水 ----------
create table if not exists "pointLedgers" (
  id text primary key,
  "studentId" text not null default '',
  delta integer not null default 0,
  kind text not null default 'earn',
  reason text not null default '',
  "taskId" text,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "pointLedgers_updated_idx" on "pointLedgers" ("updatedAt");
create index if not exists "pointLedgers_student_idx" on "pointLedgers" ("studentId");

-- ---------- 兑换商城：奖励项 ----------
create table if not exists "rewardItems" (
  id text primary key,
  name text not null default '',
  "pointsCost" integer not null default 0,
  stock integer,
  note text not null default '',
  enabled boolean not null default true,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "rewardItems_updated_idx" on "rewardItems" ("updatedAt");

-- ---------- 兑换记录 ----------
create table if not exists redemptions (
  id text primary key,
  "studentId" text not null default '',
  "rewardItemId" text not null default '',
  "rewardName" text not null default '',
  "pointsSpent" integer not null default 0,
  status text not null default 'pending',
  "redeemedAt" bigint not null default 0,
  "fulfilledAt" bigint,
  note text not null default '',
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists redemptions_updated_idx on redemptions ("updatedAt");
create index if not exists redemptions_student_idx on redemptions ("studentId");

-- ---------- 学生画像（v7，AI 汇总生成） ----------
create table if not exists "studentProfiles" (
  id text primary key,
  "studentId" text not null default '',
  summary text not null default '',
  strengths text not null default '',
  weaknesses text not null default '',
  "teachingStyle" text not null default '',
  "profileUpdatedAt" bigint not null default 0,
  "sourceCount" integer not null default 0,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "studentProfiles_updated_idx" on "studentProfiles" ("updatedAt");
create index if not exists "studentProfiles_student_idx" on "studentProfiles" ("studentId");

-- ============================================================
-- v16/v17：课堂积分
-- ============================================================

-- ---------- 课堂活动 ----------
create table if not exists "classActivities" (
  "id" text primary key,
  "title" text not null default '',
  "courseId" text,
  "groupId" text,
  "activityDate" bigint,
  -- 允许 null：v16 老数据没有该字段，PostgREST 批量 upsert 会补 null，
  --           若强制 NOT NULL 会导致整批推送失败（前端已补全，此处兜底）
  "auto" boolean default false,
  "sourceCourseId" text,
  "rules" jsonb not null default '[]'::jsonb,
  "ruleIds" jsonb not null default '[]'::jsonb,
  "classRuleSnapshot" jsonb,
  "deletedReason" text,
  "note" text not null default '',
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "classActivities_created_idx" on "classActivities" ("createdAt" desc);
create index if not exists "classActivities_group_date_idx" on "classActivities" ("groupId", "activityDate");
create index if not exists "classActivities_updated_idx" on "classActivities" ("updatedAt");

-- ---------- 课堂活动记录（学生参与） ----------
create table if not exists "classActivityRecords" (
  "id" text primary key,
  "activityId" text not null,
  "studentId" text not null,
  "status" text not null default 'pending',  -- pending | pass | fail
  "pointsAwarded" integer not null default 0,
  "note" text not null default '',
  "checkedAt" bigint,
  "ledgerId" text,
  "selectedRuleId" text,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "classActivityRecords_activity_idx" on "classActivityRecords" ("activityId");
create index if not exists "classActivityRecords_student_idx" on "classActivityRecords" ("studentId");
create index if not exists "classActivityRecords_updated_idx" on "classActivityRecords" ("updatedAt");

-- ============================================================
-- 辅助表
-- ============================================================

-- ---------- v9：设置云同步（单行 id='app'） ----------
create table if not exists "app_settings" (
  "id" text primary key,
  "value" jsonb not null,
  "updatedAt" bigint not null default 0
);

-- ---------- v11：数据版本快照 ----------
create table if not exists "data_snapshots" (
  "id" text primary key,
  "created_at" bigint not null default 0,
  "label" text not null default '',
  "auto" boolean not null default false,
  "device" text not null default '',
  "counts" jsonb not null default '{}'::jsonb,
  "signature" text not null default '',
  "payload" jsonb not null default '{}'::jsonb,
  "settings_row" jsonb
);
create index if not exists "data_snapshots_created_idx" on "data_snapshots" ("created_at" desc);


-- ============================================================
-- 第 2 部分：给「已存在的旧表」补加后续版本新增的列
-- （create table if not exists 不会动旧表，这一段才是修复缺列的关键）
-- ============================================================

-- v8：班课课后自动打卡配置
alter table groups add column if not exists "checkInAuto" boolean not null default true;
alter table groups add column if not exists "checkInDays" integer not null default 7;
alter table groups add column if not exists "checkInStartOffset" integer not null default 1;
alter table groups add column if not exists "checkInWeekdays" jsonb not null default '[]'::jsonb;

-- v7：课程补课标记
alter table courses add column if not exists "isMakeup" boolean not null default false;
alter table courses add column if not exists "makeupSourceCourseId" text;

-- 财务：付款方（student=家长 / institution=机构结算）
alter table payments add column if not exists payer text not null default 'student';

-- v6：打卡记录的 AI 家长反馈
alter table "checkInRecords" add column if not exists "aiFeedback" text not null default '';

-- v8：反馈模板形态
alter table "feedbackTemplates" add column if not exists kind text not null default 'text';

-- v17：课堂积分后期字段（若表由旧版 v12 以 snake_case 建过，这里补 camelCase 列）
alter table "classActivities" add column if not exists "groupId" text;
alter table "classActivities" add column if not exists "activityDate" bigint;
alter table "classActivities" add column if not exists "auto" boolean default false;
alter table "classActivities" add column if not exists "sourceCourseId" text;
-- v29：课堂规则快照（jsonb 数组，可空）。历史活动补写入后固化分值，杜绝追溯改写。
alter table "classActivities" add column if not exists "classRuleSnapshot" jsonb;
alter table "classActivityRecords" add column if not exists "ledgerId" text;

-- 兜底：已按旧脚本建库时 auto 带 NOT NULL 约束，这里放宽，
--       避免历史脏数据（auto 为 null）把整表推送卡死。
alter table "classActivities" alter column "auto" drop not null;

-- v20：积分规则库（打卡/课堂两套）+ 活动对规则的引用（ruleIds）
--       与逐人档位选择（selectedRuleId）。旧版内嵌规则（classActivities.rules）
--       保留兼容，新数据均走规则库引用。
alter table "pointRules" add column if not exists scope text not null default 'checkin';
alter table "pointRules" add column if not exists mode text not null default 'auto';
alter table "pointRules" add column if not exists "classCondition" jsonb;
alter table "checkInTasks" add column if not exists "ruleIds" jsonb not null default '[]'::jsonb;
alter table "checkInRecords" add column if not exists "selectedRuleId" text;
-- v-next：打卡记录固化「当天对应打卡任务」内容快照（jsonb，可空），供 AI 生成备注/报告时提供任务上下文
alter table "checkInRecords" add column if not exists "taskSnapshot" jsonb;
alter table "classActivities" add column if not exists "ruleIds" jsonb not null default '[]'::jsonb;
alter table "classActivityRecords" add column if not exists "selectedRuleId" text;

-- v21：班课「自动生成课堂活动」开关 + 完成课程自动生成的打卡任务标记
--       + 课程完成时的课时扣减慢照（「取消完成」据此精确返还/回收）
alter table groups add column if not exists "classActivityAuto" boolean not null default true;
alter table "checkInTasks" add column if not exists "auto" boolean not null default false;
alter table courses add column if not exists "deductedHours" jsonb;

-- v23：软删来源（区分「老师手动删除」与「取消完成时的自动回收」）。
--      自动生成的打卡任务 / 课堂活动据此决定「重新完成时可否重建」；
--      同时所有物理删除改为软删（保留墓碑），删除才能真正同步到云端。
alter table "checkInTasks" add column if not exists "deletedReason" text;
alter table "classActivities" add column if not exists "deletedReason" text;

-- v26：课程「单位课酬基准」快照（分）。首次完成结算时写入当时单价，
--      之后班课 / 学生单价变更不再改写这节课的历史课酬（重算只随出席人数变化）。
alter table courses add column if not exists "feeUnitCents" integer;

-- v30.3：规则按钮改「全体叠加」+ 班课可指定自动活动的计分规则
--       · classActivityRecords.manualRuleIds：该生手动叠加的规则 id 列表（jsonb）
--       · groups.autoClassRuleIds：自动生成的课堂积分活动引用哪些课堂规则（jsonb）
alter table "classActivityRecords" add column if not exists "manualRuleIds" jsonb;
alter table groups add column if not exists "autoClassRuleIds" jsonb not null default '[]'::jsonb;


-- ============================================================
-- 第 3 部分：行级安全策略（单人自用：anon 全权读写）
-- ⚠️ 多人协作场景请改为基于 auth.uid() 的隔离策略
-- ============================================================

do $$
declare
  t text;
begin
  foreach t in array array[
    -- 基础业务
    'students', 'groups', 'groupMembers', 'courses', 'courseAttendances',
    'courseFeedbacks', 'learningReports', 'learningTags',
    'studentTags', 'payments', 'settlements',
    -- v5：知识库 / 模板 / 打卡 / 积分 / 兑换
    'textbooks', 'textbookUnits', 'knowledgePoints',
    'feedbackTemplates', 'feedbackTemplateFields', 'courseKnowledges',
    'checkInTasks', 'checkInRecords',
    'pointRules', 'pointLedgers',
    'rewardItems', 'redemptions',
    -- v7：学生画像
    'studentProfiles',
    -- v16/v17：课堂积分
    'classActivities', 'classActivityRecords',
    -- 辅助表
    'app_settings', 'data_snapshots'
  ]
  loop
    execute format('alter table %I enable row level security', t);

    execute format('drop policy if exists "anon_all" on %I', t);
    execute format(
      'create policy "anon_all" on %I for all to anon using (true) with check (true)',
      t
    );
  end loop;
end $$;


-- 让 PostgREST 立即刷新 schema 缓存（否则新建的列可能仍报 PGRST204 / PGRST205）
notify pgrst, 'reload schema';
