-- ============================================================
-- v6 迁移（v2）：CheckInRecord 加 aiFeedback 列 + studentProfiles 表
--               + 补齐 v5 未执行的 11 张表
--
-- 用法：在 Supabase 控制台 → SQL Editor 中粘贴执行（可幂等重复）。
--
-- ⚠️ 顺序说明：
--   ① 先建表（11 张 v5 + 1 张 v6），
--   ② 再给已有表补列（aiFeedback / 其他后续扩展），
--   ③ 最后统一 RLS。
--   之前版本把 ALTER 放在建表之前，导致 v5 从未跑过的用户第一次执行时
--   报 `relation "checkInRecords" does not exist`。已修正。
-- ============================================================

-- ==========================================================
-- 第 1 部分：建表（先建，避免后续 ALTER 找不到表）
-- ==========================================================

-- ---------- 知识库：教材 ----------
create table if not exists textbooks (
  id text primary key,
  name text not null default '',
  subject text not null default '',
  grade text not null default '',
  note text not null default '',
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists textbooks_updated_idx on textbooks ("updatedAt");

-- ---------- 知识库：单元 ----------
create table if not exists "textbookUnits" (
  id text primary key,
  "textbookId" text not null default '',
  name text not null default '',
  "order" integer not null default 0,
  note text not null default '',
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "textbookUnits_updated_idx" on "textbookUnits" ("updatedAt");
create index if not exists "textbookUnits_textbook_idx" on "textbookUnits" ("textbookId");

-- ---------- 知识库：知识点 ----------
create table if not exists "knowledgePoints" (
  id text primary key,
  "unitId" text not null default '',
  "textbookId" text not null default '',
  title text not null default '',
  content text not null default '',
  summary text not null default '',
  "summarizedAt" bigint,
  tags jsonb not null default '[]'::jsonb,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "knowledgePoints_updated_idx" on "knowledgePoints" ("updatedAt");
create index if not exists "knowledgePoints_textbook_idx" on "knowledgePoints" ("textbookId");
create index if not exists "knowledgePoints_unit_idx" on "knowledgePoints" ("unitId");

-- ---------- 反馈模板 ----------
create table if not exists "feedbackTemplates" (
  id text primary key,
  name text not null default '',
  body text not null default '',
  "isDefault" boolean not null default false,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "feedbackTemplates_updated_idx" on "feedbackTemplates" ("updatedAt");

-- ---------- 课程 ↔ 知识点 覆盖关系 ----------
create table if not exists "courseKnowledges" (
  id text primary key,
  "courseId" text not null default '',
  "knowledgePointId" text not null default '',
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "courseKnowledges_updated_idx" on "courseKnowledges" ("updatedAt");
create index if not exists "courseKnowledges_course_idx" on "courseKnowledges" ("courseId");

-- ---------- 打卡任务 ----------
create table if not exists "checkInTasks" (
  id text primary key,
  "courseId" text,
  "groupId" text,
  title text not null default '',
  "dueAt" bigint,
  scope text not null default 'all',
  days jsonb not null default '[]'::jsonb,
  "cadenceLabel" text not null default '',
  note text not null default '',
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "checkInTasks_updated_idx" on "checkInTasks" ("updatedAt");

-- ---------- 打卡记录（新建用户直接带 aiFeedback 列，老用户走下面 ALTER） ----------
create table if not exists "checkInRecords" (
  id text primary key,
  "taskId" text not null default '',
  "studentId" text not null default '',
  "dayAt" bigint,
  status text not null default 'pending',
  note text not null default '',
  "aiFeedback" text not null default '',
  "checkedAt" bigint,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "checkInRecords_updated_idx" on "checkInRecords" ("updatedAt");
create index if not exists "checkInRecords_task_idx" on "checkInRecords" ("taskId");
create index if not exists "checkInRecords_student_day_idx" on "checkInRecords" ("studentId", "dayAt");

-- ---------- 积分规则 ----------
create table if not exists "pointRules" (
  id text primary key,
  name text not null default '',
  kind text not null default 'base',
  points integer not null default 1,
  condition jsonb,
  enabled boolean not null default true,
  "order" integer not null default 0,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "pointRules_updated_idx" on "pointRules" ("updatedAt");

-- ---------- 积分流水 ----------
create table if not exists "pointLedgers" (
  id text primary key,
  "studentId" text not null default '',
  delta integer not null default 0,
  kind text not null default 'earn',
  reason text not null default '',
  "taskId" text,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "pointLedgers_updated_idx" on "pointLedgers" ("updatedAt");
create index if not exists "pointLedgers_student_idx" on "pointLedgers" ("studentId");

-- ---------- 兑换商城：奖励项 ----------
create table if not exists "rewardItems" (
  id text primary key,
  name text not null default '',
  "pointsCost" integer not null default 0,
  stock integer,
  note text not null default '',
  enabled boolean not null default true,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "rewardItems_updated_idx" on "rewardItems" ("updatedAt");

-- ---------- 兑换记录 ----------
create table if not exists redemptions (
  id text primary key,
  "studentId" text not null default '',
  "rewardItemId" text not null default '',
  "rewardName" text not null default '',
  "pointsSpent" integer not null default 0,
  status text not null default 'pending',
  "redeemedAt" bigint not null default 0,
  "fulfilledAt" bigint,
  note text not null default '',
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists redemptions_updated_idx on redemptions ("updatedAt");
create index if not exists redemptions_student_idx on redemptions ("studentId");

-- ---------- 学生画像（v6 新表）：每个学生一条，由 AI 从历史 aiFeedback 汇总 ----------
create table if not exists "studentProfiles" (
  id text primary key,
  "studentId" text not null default '',
  "summary" text not null default '',
  "strengths" text not null default '',
  "weaknesses" text not null default '',
  "teachingStyle" text not null default '',
  "profileUpdatedAt" bigint not null default 0,
  "sourceCount" integer not null default 0,
  "createdAt" bigint not null default 0,
  "updatedAt" bigint not null default 0,
  "deletedAt" bigint
);
create index if not exists "studentProfiles_student_idx" on "studentProfiles" ("studentId");
create index if not exists "studentProfiles_updated_idx" on "studentProfiles" ("updatedAt");

-- ==========================================================
-- 第 2 部分：给老用户已有的表补新列（幂等）
-- ==========================================================

-- checkInRecords.aiFeedback：v6 新加的家长反馈字段
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'checkInRecords'
  ) then
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'checkInRecords'
        and column_name = 'aiFeedback'
    ) then
      alter table "checkInRecords"
        add column "aiFeedback" text not null default '';
      raise notice 'v6: added column checkInRecords.aiFeedback';
    end if;
  else
    raise notice 'v6: table checkInRecords not present, skip';
  end if;
end $$;

-- ==========================================================
-- 第 3 部分：行级安全（单人自用：anon 全权读写，幂等可重复执行）
-- ==========================================================

do $$
declare
  t text;
begin
  foreach t in array array[
    'textbooks', 'textbookUnits', 'knowledgePoints',
    'feedbackTemplates', 'courseKnowledges',
    'checkInTasks', 'checkInRecords',
    'pointRules', 'pointLedgers',
    'rewardItems', 'redemptions',
    'studentProfiles'
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

-- ==========================================================
-- 迁移完成。
-- 下一步：部署 supabase/functions/llm-proxy 到 Supabase，
--         并在前端设置页填入 Edge Function URL。
-- ==========================================================
