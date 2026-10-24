-- 修复「跨端同步不出去 / 一直显示有修改未同步」的云端缺列问题（v31.21）
--
-- 根因：本地旧版 withSyncFields 曾给所有记录写入 createdAt，但 groupMembers /
-- learningTags / studentTags 三张表的云端表在建表时未声明该列，导致推送 upsert
-- 整表失败、dirty 标记永久残留，归档/班课/标签等改动推不出去也清不掉。
--
-- 用法：在 Supabase 控制台 → SQL Editor 全选执行本文件即可。
-- 三行相互独立，已存在则自动跳过（if not exists）。

alter table "groupMembers" add column if not exists "createdAt" bigint not null default 0;
alter table "learningTags" add column if not exists "createdAt" bigint not null default 0;
alter table "studentTags" add column if not exists "createdAt" bigint not null default 0;
