-- ============================================================
-- migration v10：结构化反馈模板字段 + 班课自动打卡配置
-- ------------------------------------------------------------
-- 背景（v13 代码新增的能力，云端需要配套存储）：
--   1) 结构化反馈模板：模板由「字段」组成，字段可关联工作台资料
--      → 新表 "feedbackTemplateFields"
--   2) 模板形态标记：FeedbackTemplate.kind = 'text' | 'structured'
--      → "feedbackTemplates" 补 kind 列
--   3) 班课「课后自动打卡」可在班课设置里编辑
--      → "groups" 补 checkInAuto / checkInDays / checkInStartOffset 列
--
-- 为什么必须一起补：
--   同步层（src/lib/sync.ts）是**整行 upsert 的列式写入**——把本地
--   记录对象原样推给云端。云端缺表会报 PGRST205（表不存在），
--   缺列会报 42703（列不存在），两种都会导致该表同步失败。
--   经实测，当前云端三项全部缺失，故需一次补齐。
--
-- 用法：Supabase Dashboard → SQL Editor → New query → 粘贴执行
-- 幂等：可重复执行，不会重复建表 / 建列 / 建策略。
-- ============================================================

-- ------------------------------------------------------------
-- 第 1 部分：新表 —— 结构化反馈模板字段
-- ------------------------------------------------------------
create table if not exists "feedbackTemplateFields" (
  id text primary key,
  "templateId" text not null default '',
  name text not null default '',
  hint text not null default '',
  source text not null default 'knowledge',
  -- order 是 SQL 保留字，必须加双引号
  "order" integer not null default 0,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);

create index if not exists "feedbackTemplateFields_template_idx"
  on "feedbackTemplateFields" ("templateId");
create index if not exists "feedbackTemplateFields_updated_idx"
  on "feedbackTemplateFields" ("updatedAt");

alter table "feedbackTemplateFields" enable row level security;

drop policy if exists "anon_all" on "feedbackTemplateFields";
create policy "anon_all" on "feedbackTemplateFields"
  for all to anon using (true) with check (true);

-- ------------------------------------------------------------
-- 第 2 部分：老表补列（幂等，仅在表存在且缺列时添加）
-- ------------------------------------------------------------
do $$
begin
  -- feedbackTemplates.kind：模板形态（'text' 旧文本 / 'structured' 结构化）
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'feedbackTemplates'
  ) then
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'feedbackTemplates'
        and column_name = 'kind'
    ) then
      alter table "feedbackTemplates" add column "kind" text;
    end if;
  end if;

  -- groups：班课后自动打卡配置
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'groups'
  ) then
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'groups'
        and column_name = 'checkInAuto'
    ) then
      alter table "groups" add column "checkInAuto" boolean;
    end if;

    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'groups'
        and column_name = 'checkInDays'
    ) then
      alter table "groups" add column "checkInDays" integer;
    end if;

    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'groups'
        and column_name = 'checkInStartOffset'
    ) then
      alter table "groups" add column "checkInStartOffset" integer;
    end if;
  end if;
end $$;

-- ------------------------------------------------------------
-- 第 3 部分：验证（执行后应各返回 1 行，且无报错）
-- ------------------------------------------------------------
-- select 'feedbackTemplateFields' as item, count(*) as ok
--   from information_schema.tables
--   where table_schema = 'public' and table_name = 'feedbackTemplateFields';
--
-- select column_name from information_schema.columns
--   where table_schema = 'public'
--     and ( (table_name = 'feedbackTemplates' and column_name = 'kind')
--        or (table_name = 'groups' and column_name in
--            ('checkInAuto','checkInDays','checkInStartOffset')) );
-- 上面这条应返回 4 行：kind / checkInAuto / checkInDays / checkInStartOffset
