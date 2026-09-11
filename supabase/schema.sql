-- ============================================================
-- 教务工作台 · Supabase 建表脚本
--
-- 用法：在 Supabase 控制台 → SQL Editor 中粘贴执行。
--
-- 说明：
--   1. 列名使用驼峰（与前端字段一一对应），因此必须用双引号包裹
--   2. updatedAt / deletedAt 为毫秒时间戳，用于 last-write-wins 冲突合并
--   3. deletedAt 非空表示软删除，记录保留以便同步传播
--
-- ⚠️ 安全提示：本脚本为「单人自用」设计，策略允许 anon 角色全权读写。
--    若后续接入多人协作，务必改为基于 auth.uid() 的行级隔离策略。
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
  "endTimeMin" integer not null default -1
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
  "deletedAt" bigint
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
-- 行级安全策略：单人自用，允许 anon 全权读写
-- ⚠️ 多人协作场景请改为基于 auth.uid() 的隔离策略
-- ============================================================

do $$
declare
  t text;
begin
  foreach t in array array[
    'students', 'groups', 'groupMembers', 'courses', 'courseAttendances',
    'courseFeedbacks', 'learningReports', 'learningTags',
    'studentTags', 'payments', 'settlements'
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
-- ============================================================
-- v9 追加：设置云同步表（app_settings，单行 id='app'）
-- ============================================================
create table if not exists "app_settings" (
  "id" text primary key,
  "value" jsonb not null,
  "updatedAt" bigint not null default 0
);
alter table "app_settings" enable row level security;
drop policy if exists "anon_all" on "app_settings";
create policy "anon_all" on "app_settings"
  for all to anon using (true) with check (true);
