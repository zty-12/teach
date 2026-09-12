-- ============================================================
-- migration v11：数据版本快照表（data_snapshots）
-- ------------------------------------------------------------
-- 用途：每次「有变化的同步」成功后留档一份全量数据版本，本地 + 云端双份；
--       可在设置页「数据版本」里把一个历史版本整体恢复回来。
--
-- 写入：前端 `src/lib/snapshots.ts` 在 syncNow 成功后 upsert 一行（id=快照UUID）。
--   - counts/signature/payload/settings_row 均为 JSON
--   - 滚动保留最近 50 个（前端 pruneCloud 负责删旧）
--
-- 与业务表解耦：本表只被版本功能读写，缺失不影响业务表同步，
--   仅「云端版本留档 / 跨设备恢复」不可用（本地版本仍可正常使用）。
--
-- 在 Supabase Dashboard → SQL Editor → New query 里执行本文件。
-- 幂等：可重复执行，不会重复建表 / 建索引 / 建策略。
-- ============================================================

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

-- 按时间倒序取最近若干版（前端 pruneCloud / 列表查询用）
create index if not exists "data_snapshots_created_idx"
  on "data_snapshots" ("created_at" desc);

alter table "data_snapshots" enable row level security;

drop policy if exists "anon_all" on "data_snapshots";
create policy "anon_all" on "data_snapshots"
  for all to anon using (true) with check (true);

-- 让 PostgREST 立即刷新 schema 缓存（否则可能仍报 PGRST205）
notify pgrst, 'reload schema';
