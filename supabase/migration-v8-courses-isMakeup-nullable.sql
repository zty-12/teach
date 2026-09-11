-- ============================================================
-- migration v8：修正 v7 的 not null 约束（修复持续 400）
--
-- 背景：v7 建列时用了 `boolean not null default false`。
-- 但 supabase-js 的 upsert 会在 URL 上带 columns 参数（列出本次 payload
-- 所有键的并集），PostgREST 对「columns 里列了、但对象中缺失」的键
-- **填充 NULL，而不是套用列默认值**。
-- 于是本地老课程记录（isMakeup 字段根本不存在）上传时被填成 NULL，
-- 撞上 not null → 400：
--   {"code":"23502","message":"null value in column \"isMakeup\"
--    of relation \"courses\" violates not-null constraint"}
--
-- 解法：放开 not null，让缺失值可以落 NULL（前端 isMakeup 为可选字段，
-- null 与 false 等价，不影响补课逻辑）。
--
-- 执行方式：Supabase Dashboard → SQL Editor → 粘贴 → Run
-- 幂等：可重复执行
-- ============================================================

alter table "courses" alter column "isMakeup" drop not null;

-- 执行后回到工作台，等下一轮自动同步（约 1 分钟），
-- 控制台 POST /rest/v1/courses ... 400 即消失。
