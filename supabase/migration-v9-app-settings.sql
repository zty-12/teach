-- ============================================================
-- migration v9：设置云同步表
-- ------------------------------------------------------------
-- 用途：把工作台「全部设置」（称呼、主题、日程范围、AI 配置、
--       Supabase 连接配置等）同步到云端，多端一致。
-- 写入：syncNow 时 upsert 一行（id='app'），value 为完整设置 JSON。
-- 冲突：按 value 里的 settingsUpdatedAt（毫秒时间戳）last-write-wins。
--
-- 在 Supabase Dashboard → SQL Editor 里执行本文件即可。
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
