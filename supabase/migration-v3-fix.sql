-- ============================================================
-- 教务工作台 · v3 增量迁移脚本（修复旧表缺列问题）
--
-- 适用场景：你已经跑过旧版 schema.sql，students/groups 等表已存在，
--   但缺少 v3 新增的列（如 isTrial），导致 RLS/索引执行报
--   ERROR 42703: column "isTrial" does not exist。
--
-- 本脚本全部使用 IF NOT EXISTS，可【重复执行】而不会报错，
-- 也不会影响已有数据。直接在 Supabase → SQL Editor 粘帖执行即可。
-- ============================================================

-- ---------- students：补齐 v3 计费/试听列 ----------
alter table students add column if not exists "billingRule" text not null default 'postpaid';
alter table students add column if not exists "hourlyFeeCents" integer not null default 0;
alter table students add column if not exists "paidHours" integer not null default 0;
alter table students add column if not exists "remainingHours" integer not null default 0;
alter table students add column if not exists "remindHours" integer not null default 2;
alter table students add column if not exists "isTrial" boolean not null default false;
alter table students add column if not exists "trialAt" bigint;

-- ---------- groups：补齐 v3 每周时段/单价列 ----------
alter table groups add column if not exists "perStudentFeeCents" integer not null default 0;
alter table groups add column if not exists weekday integer not null default -1;
alter table groups add column if not exists "startTimeMin" integer not null default -1;
alter table groups add column if not exists "endTimeMin" integer not null default -1;

-- ---------- 课程出席表（v3 全新表，若不存在则创建） ----------
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

-- ---------- 补齐缺失索引（幂等） ----------
create index if not exists students_trial_idx on students ("isTrial");
create index if not exists students_updated_idx on students ("updatedAt");
create index if not exists groups_weekday_idx on groups (weekday);
create index if not exists groups_updated_idx on groups ("updatedAt");
create index if not exists "courseAttendances_updated_idx" on "courseAttendances" ("updatedAt");
create index if not exists "courseAttendances_course_idx" on "courseAttendances" ("courseId");
create index if not exists "courseAttendances_student_idx" on "courseAttendances" ("studentId");

-- ---------- 补齐 courseAttendances 的 RLS 策略 ----------
alter table "courseAttendances" enable row level security;
drop policy if exists "anon_all" on "courseAttendances";
create policy "anon_all" on "courseAttendances" for all to anon using (true) with check (true);

-- ============================================================
-- 校验（可选）：执行后应能看到 isTrial 列。若查询返回空则说明已成功。
-- select column_name, data_type from information_schema.columns
--   where table_name='students' and column_name='isTrial';
-- ============================================================
