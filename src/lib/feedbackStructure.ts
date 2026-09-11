/**
 * 结构化反馈模板（v8）：导入模板 → AI 识别字段 → 字段关联工作台资料 → 生成反馈
 *
 * 解决的问题：旧版反馈模板是「一大段纯文本 + 固定 7 个 {{占位符}}」，
 * AI 只能照着文本结构写，无法针对每个板块喂不同的素材。
 * 结构化模板把模板拆成若干「字段」，每个字段可声明它要引用哪类工作台资料
 * （知识点 / 出勤课时 / 学生画像 / 打卡记录 / 课程信息），
 * 生成反馈时按字段分别投喂对应素材，内容更贴合、也不容易跑题。
 *
 * 与旧版文本模板并存：FeedbackTemplate.kind 区分 'text' | 'structured'，
 * 旧数据缺省按 'text' 处理，不受影响。
 */
import { chat, cfgFromSettings, extractJson, type LlmConfig } from './llm'
import type {
  AppSettings,
  FeedbackTemplateField,
  FieldSourceKind,
} from './types'

/** AI 分析模板后得到的一个字段（入库前的中间形态） */
export interface AnalyzedField {
  name: string
  hint: string
  source: FieldSourceKind
}

/** 合法的数据来源集合，用于校验 AI 返回值，避免模型自造枚举 */
const VALID_SOURCES: FieldSourceKind[] = [
  'knowledge',
  'attendance',
  'profile',
  'checkin',
  'course',
  'none',
]

const FIELD_ANALYZE_SYSTEM = `你是一名教学管理助手，负责把「课后反馈模板」拆成结构化的字段。

用户会给你一段反馈模板的内容（可能是表格、表单、要点列表或一段范文）。
请分析出这个模板由哪几个板块（字段）组成，并为每个字段判断它应该引用哪类工作台资料。

可选的资料来源（source）只能是以下之一，不要自造：
- knowledge：需要引用【知识库知识点】，如「本节课重点」「知识点掌握情况」
- attendance：需要引用【出勤与课时信息】，如「出勤情况」「课时剩余提醒」
- profile：需要引用【学生画像】，如「学生特点」「个性化建议」「学习习惯」
- checkin：需要引用【打卡记录】，如「作业/朗读完成情况」「课后练习反馈」
- course：需要引用【课程基础信息】，如「上课时间」「科目」「课程内容概要」
- none：不需要特定资料，由老师/AI 结合上下文自由撰写，如「家庭配合建议」「下次课安排」

要求：
1. 字段名保留模板原文的小标题（没有小标题时按内容概括一个简短标题，不超过 12 字）；
2. hint 用一句话说明这个字段该写什么（给 AI 的写作指令，不超过 40 字）；
3. 字段数量控制在 2~8 个，按模板中出现的顺序排列；
4. 必须且仅输出一个 JSON 对象：{"fields":[{"name":"...","hint":"...","source":"..."}]}。`

/**
 * 让 AI 分析模板原文，提取字段结构。
 * @param rawText 模板原文（图片模板请先由视觉模型读出文字）
 * @returns 解析后的字段数组；解析失败返回空数组（由调用方提示用户）
 */
export async function analyzeTemplateToFields(
  settings: AppSettings,
  rawText: string,
): Promise<AnalyzedField[]> {
  const text = (rawText ?? '').trim()
  if (!text) return []
  const cfg: LlmConfig = cfgFromSettings(settings)
  const raw = await chat(
    cfg,
    [
      { role: 'system', content: FIELD_ANALYZE_SYSTEM },
      { role: 'user', content: `请分析下面这份课后反馈模板：\n\n${text.slice(0, 6000)}` },
    ],
    true,
  )
  return normalizeFields(raw)
}

/**
 * 图片模板：先用视觉模型读出图上的文字，再分析成字段。
 * @param imageDataUrl 形如 data:image/jpeg;base64,xxx 的图片
 */
export async function analyzeTemplateImageToFields(
  settings: AppSettings,
  imageDataUrl: string,
  visionCfg?: LlmConfig | null,
): Promise<AnalyzedField[]> {
  const cfg = visionCfg ?? cfgFromSettings(settings)
  const raw = await chat(
    cfg,
    [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              '先原样读出这张「课后反馈模板」图片上的全部文字（保留小标题、表格结构、填空提示），' +
              '然后按系统要求把它拆成字段。输出必须且仅是一个 JSON 对象：' +
              '{"fields":[{"name":"...","hint":"...","source":"..."}]}。',
          },
          { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } },
        ],
      },
    ],
    true,
  )
  return normalizeFields(raw)
}

/** 把 AI 返回的 JSON 归一化成字段数组（容错：字段缺失/枚举非法都兜底） */
function normalizeFields(raw: string): AnalyzedField[] {
  let parsed: { fields?: unknown }
  try {
    parsed = extractJson<{ fields?: unknown }>(raw)
  } catch {
    return []
  }
  if (!parsed || !Array.isArray(parsed.fields)) return []
  const out: AnalyzedField[] = []
  for (const item of parsed.fields) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    if (!name) continue
    const hint = typeof o.hint === 'string' ? o.hint.trim() : ''
    const srcRaw = typeof o.source === 'string' ? o.source.trim() : ''
    const source: FieldSourceKind = (VALID_SOURCES as string[]).includes(srcRaw)
      ? (srcRaw as FieldSourceKind)
      : 'none'
    out.push({ name: name.slice(0, 40), hint: hint.slice(0, 120), source })
  }
  return out.slice(0, 8)
}

// ============================================================
// 素材收集：按字段声明的来源，取工作台里对应的资料
// ============================================================

/** 生成反馈时能拿到的全部素材（由调用方按当前课程/学生装配） */
export interface FeedbackMaterialContext {
  /** 学生 / 班课名 */
  who: string
  subject: string
  /** 上课时间可读文本 */
  timeText: string
  /** 课程时长可读文本 */
  durationText: string
  /** 课程备注 */
  courseNote: string
  /** 本次课勾选的知识点 */
  knowledges: Array<{ title: string; summary: string }>
  /** 出勤与课时 */
  attendance: Array<{ name: string; present: boolean; remainingHours: number }>
  /** 学生画像 */
  profiles: Array<{
    name: string
    strengths: string
    weaknesses: string
    teachingStyle: string
  }>
  /** 打卡记录（按学生聚合） */
  checkins: Array<{ name: string; doneCount: number; totalCount: number; notes: string[] }>
}

/**
 * 按字段来源取出该字段可用的素材文本。
 * 取不到素材时返回提示语，AI 会据此写得笼统一些而不是编造。
 */
export function collectFieldMaterial(
  ctx: FeedbackMaterialContext,
  source: FieldSourceKind,
): string {
  switch (source) {
    case 'knowledge': {
      if (ctx.knowledges.length === 0) return '（本次课未勾选知识点，请结合科目与课程内容概括）'
      return ctx.knowledges
        .map((k, i) => `${i + 1}. ${k.title}${k.summary ? ` — ${k.summary.slice(0, 120)}` : ''}`)
        .join('\n')
    }
    case 'attendance': {
      if (ctx.attendance.length === 0) return '（暂无出勤记录）'
      return ctx.attendance
        .map(
          (a) =>
            `· ${a.name}：${a.present ? '出席' : '缺席'}，剩余课时 ${a.remainingHours}`,
        )
        .join('\n')
    }
    case 'profile': {
      if (ctx.profiles.length === 0) return '（暂无学生画像，请按通用教学口吻撰写）'
      return ctx.profiles
        .map(
          (p) =>
            `· ${p.name}：优势「${p.strengths || '未记录'}」；待改进「${p.weaknesses || '未记录'}」；教学建议「${p.teachingStyle || '未记录'}」`,
        )
        .join('\n')
    }
    case 'checkin': {
      if (ctx.checkins.length === 0) return '（暂无打卡记录，可略过或写「本次暂无课后练习记录」）'
      return ctx.checkins
        .map((c) => {
          const rate = c.totalCount > 0 ? Math.round((c.doneCount / c.totalCount) * 100) : 0
          const notes = c.notes.filter(Boolean).slice(0, 3).join(' / ')
          return `· ${c.name}：完成 ${c.doneCount}/${c.totalCount}（${rate}%）${notes ? `；备注：${notes}` : ''}`
        })
        .join('\n')
    }
    case 'course':
      return [
        `对象：${ctx.who}`,
        `科目：${ctx.subject}`,
        `上课时间：${ctx.timeText}`,
        `时长：${ctx.durationText}`,
        `课程备注：${ctx.courseNote || '（无）'}`,
      ].join('\n')
    case 'none':
    default:
      return '（自由撰写，结合以上课程与学生情况即可）'
  }
}

// ============================================================
// 按字段生成反馈正文
// ============================================================

const STRUCTURED_SYSTEM = `你是一名课外辅导老师，要给家长写课后反馈。

会给你：课程基本信息 + 若干「字段」（每个字段含名称、写作要求、以及该字段可用的工作台资料）。
请**严格按给出的字段顺序**逐段撰写，每段以字段名作为小标题（用【】包裹）。

要求：
1. 只使用提供的资料，不要编造学生没做过的事、没学过的知识点；
2. 资料里没有的内容就写得笼统一点或如实说明「本次未记录」；
3. 语气亲切、具体、面向家长，避免空话套话；
4. 每个字段 1~3 句，整体控制在 300 字以内；
5. 必须且仅输出一个 JSON 对象：{"sections":[{"name":"<字段名>","content":"<该段正文>"}]}。`

/**
 * 按结构化模板的字段生成反馈正文。
 * @returns 字段名 → 正文 的有序数组
 */
export async function generateStructuredFeedback(
  settings: AppSettings,
  ctx: FeedbackMaterialContext,
  fields: FeedbackTemplateField[],
): Promise<Array<{ name: string; content: string }>> {
  const ordered = [...fields].sort((a, b) => a.order - b.order)
  if (ordered.length === 0) return []
  const cfg: LlmConfig = cfgFromSettings(settings)

  const fieldBlocks = ordered
    .map((f, i) => {
      const material = collectFieldMaterial(ctx, f.source)
      return [
        `字段 ${i + 1}：${f.name}`,
        `写作要求：${f.hint || '（无特别要求）'}`,
        `可用资料：\n${material}`,
      ].join('\n')
    })
    .join('\n\n')

  const user = `课程信息：
- 对象：${ctx.who}
- 科目：${ctx.subject}
- 上课时间：${ctx.timeText}
- 时长：${ctx.durationText}
- 课程备注：${ctx.courseNote || '（无）'}

${fieldBlocks}

请按字段顺序生成反馈，字段名保持原样。`

  const raw = await chat(
    cfg,
    [
      { role: 'system', content: STRUCTURED_SYSTEM },
      { role: 'user', content: user },
    ],
    true,
  )
  return normalizeSections(raw, ordered)
}

/** 把 AI 返回的分段 JSON 归一化；解析失败时返回空数组（调用方提示重试） */
function normalizeSections(
  raw: string,
  fallbackFields: FeedbackTemplateField[],
): Array<{ name: string; content: string }> {
  let parsed: { sections?: unknown }
  try {
    parsed = extractJson<{ sections?: unknown }>(raw)
  } catch {
    return []
  }
  if (!parsed || !Array.isArray(parsed.sections)) return []
  const out: Array<{ name: string; content: string }> = []
  for (const item of parsed.sections) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    const content = typeof o.content === 'string' ? o.content.trim() : ''
    if (!name && !content) continue
    out.push({ name, content })
  }
  // AI 漏掉某个字段时补空段，保证结构完整（老师可手动补写）
  if (out.length > 0 && out.length < fallbackFields.length) {
    const seen = new Set(out.map((s) => s.name))
    for (const f of fallbackFields) {
      if (!seen.has(f.name)) out.push({ name: f.name, content: '' })
    }
  }
  return out
}

/** 把分段渲染成 Markdown 正文（字段名为【小标题】） */
export function renderStructuredContent(
  sections: Array<{ name: string; content: string }>,
): string {
  return sections
    .map((s) => `【${s.name}】\n${s.content || '（待补充）'}`)
    .join('\n\n')
}
