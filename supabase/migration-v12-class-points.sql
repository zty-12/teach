-- ============================================================
-- migration v12：课堂积分表（class_activities / class_activity_records）
-- ------------------------------------------------------------
-- 用途：课上检查背诵等场景，教师标记学生「过关/未过关」，
--       按自定义规则（过关=1分、第一个额外+1分等）自动记录积分。
--
-- 与业务表解耦：缺失不影响其他业务，仅「课堂积分」功能不可用。
-- 在 Supabase Dashboard → SQL Editor → New query 里执行本文件。
-- 幂等：可重复执行，不会重复建表 / 建索引 / 建策略。
-- ============================================================

-- 课堂活动：教师创建的课上计分活动
create table if not exists "class_activities" (
  "id" text primary key,
  "title" text not null default '',
  "course_id" text,
  "rules" jsonb not null default '[]'::jsonb,
  "note" text not null default '',
  "created_at" bigint not null default 0,
  "updated_at" bigint not null default 0,
  "deleted_at" bigint
);

create index if not exists "class_activities_created_idx"
  on "class_activities" ("created_at" desc);
create index if not exists "class_activities_course_idx"
  on "class_activities" ("course_id") where course_id is not null;

-- 课堂活动记录：学生参与某次课堂活动的情况
create table if not exists "class_activity_records" (
  "id" text primary key,
  "activity_id" text not null,
  "student_id" text not null,
  "status" text not null default 'pending',  -- pending | pass | fail
  "points_awarded" integer not null default 0,
  "note" text not null default '',
  "checked_at" bigint,
  "created_at" bigint not null default 0,
  "updated_at" bigint not null default 0,
  "deleted_at" bigint
);

create index if not exists "car_activity_idx"
  on "class_activity_records" ("activity_id");
create index if not exists "car_student_idx"
  on "class_activity_records" ("student_id");
create index if not exists "car_status_idx"
  on "class_activity_records" ("status") where status = 'pending';

-- RLS：允许 anon 全量读写（与现有表一致）
alter table "class_activities" enable row level security;
alter table "class_activity_records" enable row level security;

drop policy if exists "anon_all_ca" on "class_activities";
create policy "anon_all_ca" on "class_activities"
  for all to anon using (true) with check (true);

drop policy if exists "anon_all_car" on "class_activity_records";
create policy "anon_all_car" on "class_activity_records"
  for all to anon using (true) with check (true);

notify pgrst, 'reload schema';
