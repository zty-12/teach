-- ============================================================
-- migration v13：课堂积分表重建（列名对齐 camelCase）+ v17 新字段
-- ------------------------------------------------------------
-- 背景：
--   v12 建表时使用了 snake_case 列名（course_id / created_at …），
--   而同步引擎（src/lib/sync.ts）是把前端对象的 camelCase 字段
--   直接 upsert 到同名表，PostgREST 找不到对应列 → 课堂积分的
--   云端同步一直静默失败。本脚本把两张表重建为 camelCase 列名
--   （与 schema.sql 中其他表完全一致），并补上 v17 新增字段。
--
-- v17 新增字段：
--   classActivities.groupId        关联班课（下拉选「我添加过的班课」）
--   classActivities.activityDate   活动日期零点时间戳（按排课当天去重）
--   classActivities.auto           是否由排课自动生成
--   classActivities.sourceCourseId 自动生成时的来源课程
--   classActivityRecords.ledgerId  加分流水 id（撤销/改判时精确冲销）
--
-- 数据：云端这两张表此前写入一直失败，不存在有效数据可迁移；
--       本地 IndexedDB 仍保有真实数据，下次同步会自动重新上传。
-- 幂等：可重复执行。
-- 在 Supabase Dashboard → SQL Editor → New query 里粘贴执行。
-- ============================================================

drop table if exists "classActivityRecords";
drop table if exists "classActivities";

-- ---------- 课堂活动 ----------
create table if not exists "classActivities" (
  "id" text primary key,
  "title" text not null default '',
  "courseId" text,
  "groupId" text,
  "activityDate" bigint,
  "auto" boolean not null default false,
  "sourceCourseId" text,
  "rules" jsonb not null default '[]'::jsonb,
  "note" text not null default '',
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);

create index if not exists "classActivities_created_idx"
  on "classActivities" ("createdAt" desc);
create index if not exists "classActivities_group_date_idx"
  on "classActivities" ("groupId", "activityDate");
create index if not exists "classActivities_updated_idx"
  on "classActivities" ("updatedAt");

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
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);

create index if not exists "classActivityRecords_activity_idx"
  on "classActivityRecords" ("activityId");
create index if not exists "classActivityRecords_student_idx"
  on "classActivityRecords" ("studentId");
create index if not exists "classActivityRecords_updated_idx"
  on "classActivityRecords" ("updatedAt");

-- ---------- RLS：允许 anon 全量读写（与现有表一致） ----------
alter table "classActivities" enable row level security;
alter table "classActivityRecords" enable row level security;

drop policy if exists "anon_all_classActivities" on "classActivities";
create policy "anon_all_classActivities" on "classActivities"
  for all to anon using (true) with check (true);

drop policy if exists "anon_all_classActivityRecords" on "classActivityRecords";
create policy "anon_all_classActivityRecords" on "classActivityRecords"
  for all to anon using (true) with check (true);
