-- ============================================================
-- migration v7：补齐 courses 表缺列（修复同步 400 Bad Request）
--
-- 背景：补课功能（isMakeup / makeupSourceCourseId）上线时只改了
-- 前端类型（types.ts Course），未同步云端表结构，导致每次自动同步
-- push courses 时 PostgREST 报 400（PGRST204 列不存在）。
--
-- 执行方式：Supabase Dashboard → SQL Editor → 粘贴全部 → Run
-- 幂等：可重复执行，已存在则跳过
-- ============================================================

alter table "courses" add column if not exists "isMakeup" boolean not null default false;
alter table "courses" add column if not exists "makeupSourceCourseId" text;

-- RLS 沿用 courses 表已有策略，无需新增。
-- 执行完成后回到工作台，等下一轮自动同步（约 1 分钟），
-- 或在「设置 → 云端同步」手动触发同步验证 400 消失。
