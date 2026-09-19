import type { AppSettings, Course } from './types'

/**
 * LLM 适配层（前端直连 / 经 Supabase Edge Function 中转）
 *
 * 支持两种模式（通过 AppSettings.aiProxyMode 切换）：
 *  - direct：浏览器直接 fetch OpenAI 兼容 /chat/completions
 *  - proxy ：经 Supabase Edge Function llm-proxy 中转，规避 CORS 限制
 *
 * ⚠️ 安全提示：API Key 存在浏览器 IndexedDB 设置里，仅适用于「单人自用」。
 * 多人协作建议：把 key 放在 Supabase Edge Function Secrets，前端仅持有 LLM_PROXY_TOKEN。
 */

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** 是否走 Edge Function 中转（由调用方从 settings 派生） */
  proxyUrl?: string
  proxyToken?: string
  /**
   * Supabase anon key（可选）。
   * Supabase 函数网关默认要求 Authorization 携带合法 JWT，否则在进入函数代码前
   * 就被拒为 401。中转时用它作 Authorization 通过网关，把自定义共享密钥放到
   * `x-proxy-token` 头 —— 这样无论函数是否开启「Enforce JWT verification」都能调通。
   */
  proxyAnonKey?: string
}

/**
 * OpenAI 视觉格式的 content parts 数组中的单个元素。
 *  - text：纯文本提示
 *  - image_url.url：支持公网 URL，或形如 `data:image/jpeg;base64,xxxx` 的 dataURL
 *  - image_url.detail：传图精度（high=慢而准，low=快而粗），OCR 建议 high
 */
export type VisionContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  /** 文本消息或视觉 parts 数组（视觉格式见 VisionContentPart） */
  content: string | VisionContentPart[]
}

/**
 * AI 是否已配置。
 *
 * 历史坑（2026-09-08 修复）：旧版要求 `aiProvider !== 'disabled'`，而该字段
 * 只有点击预设按钮才会变为 'openai-compatible'——手动填写 sensenova 等不在
 * 预设里的服务时 provider 停留在 'disabled'，导致「测试连接成功但各页面
 * 提示尚未配置 AI / 打卡页 AI 入口不显示」。现以 aiEnabled 为总开关，
 * 只校验 Base URL 与 API Key 非空。
 */
export function isAiConfigured(
  settings: Pick<AppSettings, 'aiEnabled' | 'aiBaseUrl' | 'aiApiKey'>,
): boolean {
  return (
    settings.aiEnabled === true &&
    Boolean(settings.aiBaseUrl?.trim()) &&
    Boolean(settings.aiApiKey?.trim())
  )
}

/** 退避重试等待时长（ms），依次累加：2s → 5s → 12s → 25s */
const RETRY_DELAYS = [2000, 5000, 12000, 25000]

/** 统一错误，便于 UI 展示 */
export class LlmError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmError'
  }
}

/**
 * 单次请求超时（毫秒）。
 * ⚠ 没有超时的话，上游 TCP 黑洞会让 fetch 一直挂着 → UI 永远 loading（v26 审查：P4）。
 * 用 AbortController 手写，而非 AbortSignal.timeout —— 后者在旧 WebView 里缺失。
 */
const LLM_REQUEST_TIMEOUT_MS = 120_000

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = LLM_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 「该上游不支持 response_format: json_object」的本地记忆（key = baseUrl|model）。
 *
 * 背景：不少 OpenAI 兼容服务（部分中转、商汤等）不认 response_format，收到就返回 400。
 * 旧逻辑会先失败一次再降级重发 —— 每次 AI 调用都白白多一次往返（含网络 + 上游解析，
 * 实测多花 0.5~3s，且这种 400 在限流时还会叠加退避）。记住后就直接走普通模式，
 * 靠 prompt + extractJson 的容错解析兜底。
 */
const NO_JSON_FLAG_KEY = 'ew-llm-nojson'

function noJsonKey(cfg: LlmConfig): string {
  return `${cfg.baseUrl.trim().replace(/\/+$/, '')}|${cfg.model}`
}

function isJsonUnsupported(cfg: LlmConfig): boolean {
  try {
    return (localStorage.getItem(NO_JSON_FLAG_KEY) ?? '').split('\n').includes(noJsonKey(cfg))
  } catch {
    return false
  }
}

function markJsonUnsupported(cfg: LlmConfig): void {
  try {
    const cur = localStorage.getItem(NO_JSON_FLAG_KEY) ?? ''
    const key = noJsonKey(cfg)
    const lines = cur.split('\n').filter(Boolean)
    if (lines.includes(key)) return
    lines.push(key)
    // 只保留最近 8 条，避免无限增长
    localStorage.setItem(NO_JSON_FLAG_KEY, lines.slice(-8).join('\n'))
  } catch {
    /* 隐私模式 / 存储不可用：忽略即可，不影响主流程 */
  }
}

/**
 * 调用 LLM 的 chat completion。
 * jsonMode=true 时请求结构化 JSON 输出（部分服务商不支持，会兜底回退到普通模式重试）。
 * opts.maxTokens：输出长度硬上限 —— 生成 token 数直接决定等待时长，
 * 反馈 / 报告这类长文本场景显式设上限，能明显缩短等待，也避免模型自由发挥写超长。
 */
export async function chat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  jsonMode = false,
  opts?: { maxTokens?: number },
): Promise<string> {
  const doRequest = async (withJson: boolean, viaDevProxy = false): Promise<
    | { ok: true; content: string }
    | { ok: false; status: number; detail: string }
  > => {
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
      temperature: 0.7,
    }
    const maxTokens = Math.floor(opts?.maxTokens ?? 0)
    if (maxTokens > 0) body.max_tokens = maxTokens
    if (jsonMode && withJson) {
      body.response_format = { type: 'json_object' }
    }

    // 优先：Supabase Edge Function 中转（生产环境跨域场景）
    if (cfg.proxyUrl && cfg.proxyToken) {
      return requestViaProxy(cfg, body, withJson)
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    }
    // 直连失败（通常是网关不支持 CORS 预检，如商汤 SenseNova）时，
    // 改走本地同源代理 /_llm-proxy（由 vite dev/preview 服务端转发，无跨域限制）
    const base = cfg.baseUrl.trim().replace(/\/+$/, '')
    const endpoint = `${base}/chat/completions`
    const url = viaDevProxy
      ? `/_llm-proxy/${encodeURIComponent(endpoint)}`
      : endpoint
    let res: Response
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    } catch (e) {
      // 直连网络错误 → 自动尝试同源代理（仅浏览器环境）
      if (!viaDevProxy && typeof window !== 'undefined') {
        return doRequest(withJson, true)
      }
      throw new LlmError(`网络错误：${String(e)}`)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let detail = text.slice(0, 300)
      try {
        const j = JSON.parse(text)
        detail = j?.error?.message ?? j?.error ?? detail
      } catch {
        /* keep raw text */
      }
      return { ok: false as const, status: res.status, detail }
    }
    const data = await res.json().catch(() => null)
    const content: string | undefined = data?.choices?.[0]?.message?.content
    return { ok: true as const, content: content ?? '' }
  }

  // 请求循环：
  // 1) jsonMode 被 400 拒（response_format 不支持）→ 降级普通模式，不消耗重试额度，
  //    并记住该上游，后续调用直接跳过 json 模式
  // 2) 429 / 408 / 5xx / 网络中断 status=0（上游限流如 sensenova 免费 QPS、连接被掐断）
  //    → 自动退避重试，最多 4 次（2s / 5s / 12s / 25s，累计约 44s）
  let useJson = !isJsonUnsupported(cfg)
  let last: { ok: true; content: string } | { ok: false; status: number; detail: string } | null =
    null
  let retries = 0
  for (;;) {
    const r = await doRequest(useJson)
    if (r.ok) {
      if (!r.content) throw new LlmError('模型未返回内容')
      return r.content
    }
    last = r
    if (useJson && jsonMode && r.status === 400) {
      markJsonUnsupported(cfg)
      useJson = false
      continue
    }
    const retriable = r.status === 0 || r.status === 408 || r.status === 429 || r.status >= 500
    if (!retriable || retries >= RETRY_DELAYS.length) break
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[retries]))
    retries += 1
  }
  if (!last || last.ok) throw new LlmError('未知错误')
  const hint =
    last.status === 429
      ? `（已自动重试 ${retries} 次仍被限流，请等 1-2 分钟再试；免费额度 QPS 很低，长文档建议分段导入）`
      : last.status === 0
        ? `（已自动重试 ${retries} 次，连接被中断，请检查网络或稍后重试）`
        : ''
  throw new LlmError(
    last.status === 0 ? `网络错误：${last.detail}${hint}` : `API ${last.status}: ${last.detail}${hint}`,
  )
}

/**
 * 经 Supabase Edge Function 中转的请求。
 * 上游 LLM 的 baseUrl/apiKey 放在请求 body 里（不是 Header），
 * 由 Edge Function 服务端读取后调用真实 LLM——浏览器端不接触 CORS。
 */
async function requestViaProxy(
  cfg: LlmConfig,
  body: Record<string, unknown>,
  withJson: boolean,
): Promise<{ ok: true; content: string } | { ok: false; status: number; detail: string }> {
  let res: Response
  const anon = cfg.proxyAnonKey?.trim()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // 共享密钥走自定义头（新版函数读取）；同时兼容旧的 Authorization 协议
    'x-proxy-token': cfg.proxyToken ?? '',
  }
  if (anon) {
    // 携带 anon key 以通过 Supabase 函数网关的 JWT 校验（否则网关直接 401）
    headers.apikey = anon
    headers.Authorization = `Bearer ${anon}`
  } else {
    // 无 anon key（未配置 Supabase）：回退到共享密钥作 Authorization，
    // 此时需在 Supabase 函数设置里关闭「Enforce JWT verification」
    headers.Authorization = `Bearer ${cfg.proxyToken ?? ''}`
  }
  try {
    res = await fetchWithTimeout(cfg.proxyUrl!.trim(), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        messages: body.messages,
        temperature: body.temperature,
        jsonMode: withJson,
        // 输出长度上限：新版 llm-proxy 会透传给上游；旧版函数忽略该字段（向后兼容）
        maxTokens: body.max_tokens,
      }),
    })
  } catch (e) {
    // 网络层中断（如 ERR_CONNECTION_CLOSED）：返回 status=0，交给上层统一退避重试
    return { ok: false as const, status: 0, detail: `网络中断：${String(e)}` }
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const raw = (data?.error ?? data?.message ?? data?.msg) as string | undefined
    const detail =
      raw ??
      (res.status === 401
        ? 'Edge Function 网关鉴权失败：请部署新版函数（读取 x-proxy-token 头），或在 Supabase 函数设置中关闭「Enforce JWT verification」'
        : `Proxy ${res.status}`)
    return { ok: false as const, status: res.status, detail }
  }
  // 兼容「旧版 llm-proxy」：部分旧部署在 200 响应体里塞 { error: "..." }（假成功），
  // 前端误以为成功却拿到空内容 —— 表现为「模型无响应」/ 一直转圈。
  // 把这种假成功纠正为 400 失败返回，让上层 chat() 走 jsonMode 降级重试
  // （去掉 response_format 再请求一次），旧函数即可正常返回。
  // 新版函数永远用非 200 返回错误，不会进入此分支，故对新函数无副作用。
  if (data && (data as Record<string, unknown>).error && !(data as Record<string, unknown>).content) {
    return {
      ok: false as const,
      status: 400,
      detail: String((data as Record<string, unknown>).error),
    }
  }
  return { ok: true as const, content: (data?.content as string) ?? '' }
}

/** 跳过空白，返回下一个非空白字符（到末尾返回空串） */
function nextNonSpace(s: string, from: number): string {
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') continue
    return c
  }
  return ''
}

/** 去掉 ```json ... ``` 之类的包裹 */
function stripCodeFences(s: string): string {
  let t = s.trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
  return t.trim()
}

/** 截取最可能的 JSON 片段：从首个 { 或 [ 起，到对应最后闭合符止 */
function sliceJsonCandidate(s: string): string {
  const objStart = s.indexOf('{')
  const arrStart = s.indexOf('[')
  let start = -1
  let close = ''
  if (objStart !== -1 && (arrStart === -1 || objStart <= arrStart)) {
    start = objStart
    close = '}'
  } else if (arrStart !== -1) {
    start = arrStart
    close = ']'
  }
  if (start === -1) return s
  const end = s.lastIndexOf(close)
  return end > start ? s.slice(start, end + 1) : s.slice(start)
}

/**
 * 修复模型输出里最常见的 JSON 语法错误：
 *  - 字符串内的裸换行 / 制表符（→ \n / \t）
 *  - 全角引号、逗号、冒号
 *  - 数组/对象元素之间漏写的逗号（`}{`、`]{`、`}\n"key":`）
 *  - 结束前多余的逗号
 *  - 括号没闭合（多半是输出被 max_tokens 截断）
 */
function repairJsonText(input: string, normalizePunct = false): string {
  let s = input.replace(/^﻿/, '')
  if (normalizePunct) {
    // 全角标点归一化（有概率误伤正文里的全角逗号，故默认关闭，仅作为兜底候选）
    s = s
      .replace(/[“”„‟]/g, '"')
      .replace(/[‘’‛]/g, "'")
      .replace(/，/g, ',')
      .replace(/：/g, ':')
  }

  // 逐字符重建：把字符串里未转义的控制字符变成合法转义
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) {
        out += c
        esc = false
        continue
      }
      if (c === '\\') {
        out += c
        esc = true
        continue
      }
      if (c === '"') {
        // 关键：区分「字符串结束」与「正文里的裸引号」
        // 只有后面紧跟 , } ] : 或到结尾时，这个引号才是真正的结束符
        const nx = nextNonSpace(s, i + 1)
        if (nx === '' || nx === ',' || nx === '}' || nx === ']' || nx === ':') {
          inStr = false
          out += c
        } else {
          out += '\\"'
        }
        continue
      }
      if (c === '\n') {
        out += '\\n'
        continue
      }
      if (c === '\r') {
        out += '\\r'
        continue
      }
      if (c === '\t') {
        out += '\\t'
        continue
      }
      out += c
      continue
    }
    if (c === '"') inStr = true
    out += c
  }
  s = out
  if (inStr) s += '"' // 字符串未闭合

  // 元素之间漏写的逗号
  s = s.replace(/\}\s*(?=\{)/g, '},')
  s = s.replace(/\]\s*(?=\{)/g, '],')
  s = s.replace(/\}\s*\n(\s*")/g, '},\n$1')
  s = s.replace(/\]\s*\n(\s*")/g, '],\n$1')
  // 结束前多余逗号
  s = s.replace(/,(\s*[}\]])/g, '$1')

  // 括号补齐（字符串外统计）
  let depthObj = 0
  let depthArr = 0
  let q = false
  let qesc = false
  const stack: string[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (qesc) qesc = false
      else if (c === '\\') qesc = true
      else if (c === '"') q = false
      continue
    }
    if (c === '"') q = true
    else if (c === '{') {
      stack.push('}')
      depthObj++
    } else if (c === '[') {
      stack.push(']')
      depthArr++
    } else if (c === '}' && stack[stack.length - 1] === '}') {
      stack.pop()
      depthObj--
    } else if (c === ']' && stack[stack.length - 1] === ']') {
      stack.pop()
      depthArr--
    }
  }
  if (!q) for (let i = stack.length - 1; i >= 0; i--) s += stack[i]
  void depthObj
  void depthArr
  return s
}

/** 按括号配对切出所有 `{...}` 片段（忽略字符串内的括号） */
function extractBalancedObjects(s: string): string[] {
  const res: string[] = []
  let start = -1
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      continue
    }
    if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}' && depth > 0) {
      depth--
      if (depth === 0 && start !== -1) {
        res.push(s.slice(start, i + 1))
        start = -1
      }
    }
  }
  return res
}

/**
 * 从模型返回里稳健地抽 JSON 对象。
 * 四级容错：原文 → 切片 → 语法修复 → 逐个完整对象抢救。
 * （2026-09-08：sensenova 等模型常在 content 里塞未转义引号/换行，直接 JSON.parse 会抛
 *   "Expected ',' or ']' after array element"，这里统一兜住。）
 */
export function extractJson<T>(raw: string): T {
  const cleaned = stripCodeFences(raw)
  const candidate = sliceJsonCandidate(cleaned)

  const attempts = [
    cleaned,
    candidate,
    repairJsonText(candidate), // 保守修复：不动全角标点
    repairJsonText(candidate, true), // 进阶修复：全角标点归一化
  ]
  for (const a of attempts) {
    if (!a) continue
    try {
      const v = JSON.parse(a)
      if (v && typeof v === 'object') return v as T
    } catch {
      /* 继续尝试下一种 */
    }
  }

  // 抢救：逐个完整对象尝试（含修复后）
  for (const obj of extractBalancedObjects(candidate)) {
    for (const a of [obj, repairJsonText(obj), repairJsonText(obj, true)]) {
      try {
        const v = JSON.parse(a)
        if (v && typeof v === 'object') return v as T
      } catch {
        /* 继续 */
      }
    }
  }

  throw new LlmError('AI 返回不是有效的 JSON（已尝试自动修复，仍失败）')
}

/**
 * AI 生成课后反馈的 prompt 组装。
 */
function buildFeedbackPrompt(course: Course, who: string): Array<{ role: 'system' | 'user'; content: string }> {
  const subject = course.subject || '本门课程'
  const time = new Date(course.startAt).toLocaleString('zh-CN', {
    timeZone: localStorage.getItem('ew-timezone') ?? undefined,
  })
  return [
    {
      role: 'system',
      content:
        '你是一名专业的课外辅导老师。请根据以下课程信息，生成一份给家长的课后反馈。' +
        '必须且仅输出一个 JSON 对象，不要输出任何其它文字。JSON 结构：' +
        '{"summary":"一句话摘要（不超过40字，概括本节课重点或学生表现）","content":"详细课后反馈（150-220字，分3-4个方面的短段落，用清晰的小标题，措辞积极具体、有可操作建议）"}',
    },
    {
      role: 'user',
      content: `课程信息：
- 对象：${who}
- 科目：${subject}
- 上课时间：${time}
- 课程状态：已完成
${
  course.note
    ? `- 备注：${course.note}`
    : '- 备注：（无，请基于常见辅导场景合理默认）\n请基于以上信息生成一份专业、具体、可读的课后反馈。'
}`,
    },
  ]
}

export interface GeneratedFeedback {
  summary: string
  content: string
}

/** 生成课后反馈 */
export async function generateFeedback(
  settings: AppSettings,
  course: Course,
  who: string,
): Promise<GeneratedFeedback> {
  const messages = buildFeedbackPrompt(course, who)
  const raw = await chat(cfgFrom(settings), messages, true, { maxTokens: 700 })
  const parsed = extractJson<Partial<GeneratedFeedback>>(raw)
  return {
    summary: (parsed.summary ?? '').trim(),
    content: (parsed.content ?? '').trim(),
  }
}

// ============================================================
// AI 生成学习报告
// ============================================================

/** 生成学习报告所需的周期素材 */
export interface ReportInput {
  studentName: string
  grade: string
  periodStart: number
  periodEnd: number
  /** 周期内已完成课时数 */
  doneCount: number
  /** 周期内总课时数（含待上课/请假/取消） */
  totalCount: number
  /** 涉及科目（去重） */
  subjects: string[]
  /** 学生的已有学习标签 */
  tags: string[]
  /** 周期内课后反馈摘要列表 */
  feedbackSummaries: string[]
  /** 周期内打卡备注（含日期+AI家长反馈+对应打卡任务内容），按日期升序 */
  checkInNotes: Array<{ dayAt: number; note: string; aiFeedback: string; taskTitle?: string; taskNote?: string }>
}

export interface GeneratedReport {
  title: string
  content: string
}

/**
 * 报告素材的截断上限（v31.5）。
 * 学习报告的历史可能很长（几十条打卡 + 反馈），全量塞进 prompt 会让预填变慢、
 * 首字延迟高，而模型只需要代表性样本。超出的部分按「最近优先」截掉。
 */
const REPORT_CLIP = {
  feedbackCount: 12,
  feedbackChars: 80,
  checkInCount: 16,
  noteChars: 100,
  aiFeedbackChars: 100,
  taskNoteChars: 60,
}

export function buildReportPrompt(input: ReportInput): Array<{ role: 'system' | 'user'; content: string }> {
  const fmt = (t: number) =>
    new Date(t).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
  const feedbackList =
    input.feedbackSummaries.length > 0
      ? input.feedbackSummaries
          .filter(Boolean)
          .slice(-REPORT_CLIP.feedbackCount)
          .map((s, i) => `${i + 1}. ${clipText(s, REPORT_CLIP.feedbackChars)}`)
          .join('\n')
      : '（本周期内暂无课后反馈记录，请基于有限信息撰写，不要编造具体事件）'
  const checkInList =
    input.checkInNotes.length > 0
      ? input.checkInNotes
          .slice(-REPORT_CLIP.checkInCount)
          .map((n) => {
            const date = new Date(n.dayAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
            const parts = [`${date} 打卡备注：${clipText(n.note, REPORT_CLIP.noteChars)}`]
            if (n.taskTitle || n.taskNote) {
              const taskParts = [`打卡任务：${n.taskTitle ?? '（未命名任务）'}`]
              if (n.taskNote) taskParts.push(`要求：${clipText(n.taskNote, REPORT_CLIP.taskNoteChars)}`)
              parts.push(`  · ${taskParts.join('；')}`)
            }
            if (n.aiFeedback) parts.push(`  · 教师观察：${clipText(n.aiFeedback, REPORT_CLIP.aiFeedbackChars)}`)
            return parts.join('\n')
          })
          .join('\n')
      : '（本周期内暂无打卡备注）'

  return [
    {
      role: 'system',
      content:
        '你是一名专业的课外辅导老师，需要为家长撰写阶段性学习报告。' +
        '必须且仅输出一个 JSON 对象，不要输出任何其它文字。JSON 结构：' +
        '{"title":"报告标题（不超过20字，含学生名与阶段，如「小明 9月学习报告」）",' +
        '"content":"报告正文（Markdown 格式，300-450字，包含：学习概览、掌握情况、待改进点、下阶段建议 四个二级标题小节，语气客观具体、有可执行的建议）"}',
    },
    {
      role: 'user',
      content: `请为以下学生生成本阶段学习报告：

- 学生：${input.studentName}${input.grade ? `（${input.grade}）` : ''}
- 统计周期：${fmt(input.periodStart)} 至 ${fmt(input.periodEnd)}
- 课时：已完成 ${input.doneCount} 节 / 共排 ${input.totalCount} 节
- 涉及科目：${input.subjects.length > 0 ? input.subjects.join('、') : '未记录'}
- 学习标签：${input.tags.length > 0 ? input.tags.join('、') : '暂无'}
- 本周期课后反馈摘要：
${feedbackList}
- 本周期打卡备注（含对应打卡任务与教师观察）：
${checkInList}

请基于以上真实素材撰写，不要编造未提及的事实。`,
    },
  ]
}

/** AI 生成学习报告 */
export async function generateReport(
  settings: AppSettings,
  input: ReportInput,
): Promise<GeneratedReport> {
  const raw = await chat(cfgFrom(settings), buildReportPrompt(input), true, { maxTokens: 1400 })
  const parsed = extractJson<Partial<GeneratedReport>>(raw)
  return {
    title: (parsed.title ?? '').trim(),
    content: (parsed.content ?? '').trim(),
  }
}

/** 设置页「测试 AI 连接」：用一条极短消息打一次接口 */
export async function testLlm(
  settings: Pick<AppSettings, 'aiBaseUrl' | 'aiApiKey' | 'aiModel' | 'aiProxyMode' | 'aiProxyUrl' | 'aiProxyToken'>,
): Promise<string> {
  const cfg = cfgFromSettings(settings)
  const raw = await chat(cfg, [
    { role: 'user', content: '请只回复"OK"两个字母。' },
  ])
  return raw.trim().slice(0, 120) || 'OK'
}

/** 1x1 透明 PNG，仅用于「测试视觉模型连接」时附带一张极小图，验证多模态通道可用 */
const TINY_PNG = 'https://placehold.co/100x100.png'

/** 设置页「测试视觉模型连接」：用一条极短文本 + 一张极小图打一次接口，验证多模态通道 */
export async function testVisionLlm(settings: AppSettings): Promise<string> {
  const cfg = buildVisionCfg(settings)
  if (!cfg) throw new Error('请先在「视觉模型」配置区填写 Base URL、API Key 与模型名，并启用视觉模型')
  const raw = await chat(cfg, [
    {
      role: 'user',
      content: [
        { type: 'text', text: '请只回复"OK"两个字母。' },
        { type: 'image_url', image_url: { url: TINY_PNG } },
      ],
    },
  ])
  return raw.trim().slice(0, 120) || 'OK'
}

// ============================================================
// AI 知识库：知识点总结梳理
// ============================================================

/** 知识点总结的输入 */
export interface KnowledgeSummaryInput {
  /** 教材名（可为空） */
  textbookName: string
  /** 单元名（可为空） */
  unitName: string
  /** 科目（可为空） */
  subject: string
  /** 知识点 / 课文标题 */
  title: string
  /** 老师填写的原始内容 */
  content: string
}

export interface GeneratedKnowledgeSummary {
  /** 一句话定位（不超过 40 字） */
  gist: string
  /** 核心要点列表（3-6 条，每条不超过 30 字） */
  keyPoints: string[]
  /** 常见易错点（2-4 条，可为空数组） */
  pitfalls: string[]
}

function cfgFrom(settings: AppSettings): LlmConfig {
  const cfg: LlmConfig = {
    baseUrl: settings.aiBaseUrl,
    apiKey: settings.aiApiKey,
    model: settings.aiModel.trim() || 'gpt-4o-mini',
  }
  if (settings.aiProxyMode === 'proxy' && settings.aiProxyUrl && settings.aiProxyToken) {
    cfg.proxyUrl = settings.aiProxyUrl
    cfg.proxyToken = settings.aiProxyToken
    const anon = settings.supabaseAnonKey?.trim()
    if (anon) cfg.proxyAnonKey = anon
  }
  return cfg
}

/**
 * 构造「视觉模型」专用 LlmConfig：默认与文本模型共用 Base URL / API Key / 中转设置，
 * 仅切换 model 字段；若视觉区单独配置了可用的 Base URL / API Key / 中转，则优先使用。
 * 若未配置视觉模型或 AI 未启用，返回 null。
 */
export function buildVisionCfg(
  settings: Pick<
    AppSettings,
    | 'aiEnabled'
    | 'aiBaseUrl'
    | 'aiApiKey'
    | 'aiVisionModel'
    | 'aiProxyMode'
    | 'aiProxyUrl'
    | 'aiProxyToken'
    | 'supabaseAnonKey'
  > &
    Partial<
      Pick<
        AppSettings,
        | 'aiVisionBaseUrl'
        | 'aiVisionApiKey'
        | 'aiVisionProxyMode'
        | 'aiVisionProxyUrl'
        | 'aiVisionProxyToken'
      >
    >,
): LlmConfig | null {
  if (!settings.aiEnabled) return null
  const model = settings.aiVisionModel.trim()
  if (!model) return null

  // 视觉区若单独配置了 Base URL / API Key，则优先（否则沿用文本模型）
  const baseUrl = settings.aiVisionBaseUrl?.trim() || settings.aiBaseUrl?.trim()
  const apiKey = settings.aiVisionApiKey?.trim() || settings.aiApiKey?.trim()
  if (!baseUrl || !apiKey) return null

  // 视觉区若单独配置了「经中转」，则覆盖文本模型的中转设置
  const visionProxyOn =
    settings.aiVisionProxyMode === 'proxy' &&
    !!settings.aiVisionProxyUrl?.trim() &&
    !!settings.aiVisionProxyToken?.trim()
  const merged = {
    ...settings,
    aiModel: model,
    aiBaseUrl: baseUrl,
    aiApiKey: apiKey,
    ...(visionProxyOn
      ? {
          aiProxyMode: 'proxy' as const,
          aiProxyUrl: settings.aiVisionProxyUrl!.trim(),
          aiProxyToken: settings.aiVisionProxyToken!.trim(),
        }
      : {}),
  }
  return cfgFrom(merged as AppSettings)
}

/** 从 settings 派生 LlmConfig（供 generateFeedback / generateReport / testLlm 使用） */
export function cfgFromSettings(settings: Pick<AppSettings, 'aiBaseUrl' | 'aiApiKey' | 'aiModel' | 'aiProxyMode' | 'aiProxyUrl' | 'aiProxyToken'>): LlmConfig {
  return cfgFrom(settings as AppSettings)
}

/** AI 总结梳理单个知识点 */
export async function summarizeKnowledgePoint(
  settings: AppSettings,
  input: KnowledgeSummaryInput,
): Promise<GeneratedKnowledgeSummary> {
  const messages = [
    {
      role: 'system' as const,
      content:
        '你是一名资深教研老师，负责把教材知识点梳理成可复用的教学要点。' +
        '必须且仅输出一个 JSON 对象，不要输出任何其它文字。JSON 结构：' +
        '{"gist":"一句话定位这个知识点（不超过40字）",' +
        '"keyPoints":["核心要点1","核心要点2","核心要点3"],' +
        '"pitfalls":["常见易错点1","常见易错点2"]}',
    },
    {
      role: 'user' as const,
      content: `请把下面这个知识点梳理成教学要点：

- 教材：${input.textbookName || '（未指定）'}
- 单元：${input.unitName || '（未指定）'}
- 科目：${input.subject || '（未指定）'}
- 标题：${input.title}
- 原始内容：
${input.content || '（老师未填写内容，请仅根据标题与科目做合理梳理，并明确标注这是基于标题的推断）'}

要求：
1. keyPoints 3-6 条，每条不超过 30 字，具体可教学、可直接用于备课或课后反馈；
2. pitfalls 2-4 条，写学生在这个知识点上常见的错误或混淆点；
3. 不要编造与标题完全无关的内容；原始内容为空时请在 gist 里说明"推断"。`,
    },
  ]
  const raw = await chat(cfgFrom(settings), messages, true, { maxTokens: 500 })
  const parsed = extractJson<Partial<GeneratedKnowledgeSummary>>(raw)
  return {
    gist: (parsed.gist ?? '').trim(),
    keyPoints: Array.isArray(parsed.keyPoints)
      ? parsed.keyPoints.map((s) => String(s).trim()).filter(Boolean)
      : [],
    pitfalls: Array.isArray(parsed.pitfalls)
      ? parsed.pitfalls.map((s) => String(s).trim()).filter(Boolean)
      : [],
  }
}

/** 把总结结果渲染成可存储的摘要文本 */
export function renderKnowledgeSummary(s: GeneratedKnowledgeSummary): string {
  const parts: string[] = []
  if (s.gist) parts.push(s.gist)
  if (s.keyPoints.length > 0) {
    parts.push('核心要点：\n' + s.keyPoints.map((k, i) => `${i + 1}. ${k}`).join('\n'))
  }
  if (s.pitfalls.length > 0) {
    parts.push('易错点：\n' + s.pitfalls.map((k, i) => `${i + 1}. ${k}`).join('\n'))
  }
  return parts.join('\n\n')
}

// ============================================================
// AI 推荐本次课可能覆盖的知识点
// ============================================================

export interface KnowledgeCandidate {
  id: string
  title: string
  /** 教材名 + 单元名，便于模型判断相关性 */
  path: string
  /** 已有摘要（可能为空） */
  summary: string
}

export interface FeedbackContext {
  /** 学生 / 班课名 */
  who: string
  subject: string
  /** 上课时间的可读文本 */
  timeText: string
  /** 课程备注 */
  note: string
  /** 最近的课后反馈摘要（用于连贯性） */
  recentFeedbacks: string[]
}

/**
 * 候选知识点过多时，先在本地按「关键词相关性」粗排，只保留最相关的 limit 个。
 *
 * 为什么要做：调用方会把知识库靠前的 50 个知识点（含摘要）原样塞进 prompt，
 * 输入上千字 → 预填慢、首字延迟高，而模型真正能选中的只有几个。
 * 用课程备注 / 学生 / 科目 / 最近反馈里的字词（中文取 2-gram）打分排序，
 * 既缩短输入，也让剩下的候选更贴近本次课；全无命中时按原顺序截断，行为与原来一致。
 */
export function pickKnowledgeCandidates(
  candidates: KnowledgeCandidate[],
  ctx: FeedbackContext,
  limit: number,
): KnowledgeCandidate[] {
  if (candidates.length <= limit) return candidates
  const hay = [ctx.note, ctx.who, ctx.subject, ...ctx.recentFeedbacks].join(' ').toLowerCase()
  const grams = new Set<string>()
  for (const chunk of hay.split(/[^0-9a-z\u4e00-\u9fa5]+/)) {
    if (!chunk) continue
    if (/^[0-9a-z]+$/.test(chunk)) {
      if (chunk.length >= 2) grams.add(chunk)
      continue
    }
    for (let i = 0; i + 2 <= chunk.length; i++) grams.add(chunk.slice(i, i + 2))
  }
  const subject = ctx.subject.trim().toLowerCase()
  const scored = candidates.map((c, i) => {
    const text = `${c.title} ${c.path}`.toLowerCase()
    let score = 0
    for (const g of grams) if (text.includes(g)) score += 2
    if (subject && text.includes(subject)) score += 1
    return { c, i, score }
  })
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  return scored.slice(0, limit).map((x) => x.c)
}

/** 送进 prompt 的候选知识点上限（v31.5：50 → 30，缩短预填、降低首字延迟） */
const KNOWLEDGE_CANDIDATE_LIMIT = 30

/** 让 AI 从候选知识点里挑出本次课最可能覆盖的（返回 id 列表） */
export async function recommendKnowledgePoints(
  settings: AppSettings,
  ctx: FeedbackContext,
  candidates: KnowledgeCandidate[],
  limit = 6,
): Promise<string[]> {
  if (candidates.length === 0) return []
  const pool = pickKnowledgeCandidates(candidates, ctx, KNOWLEDGE_CANDIDATE_LIMIT)
  const recent = ctx.recentFeedbacks.filter(Boolean).slice(0, 3).map((s) => s.slice(0, 40))
  const list = pool
    .map((c, i) => `${i + 1}. [id=${c.id}] ${c.path} / ${c.title}${c.summary ? ` — ${c.summary.slice(0, 30)}` : ''}`)
    .join('\n')

  const messages = [
    {
      role: 'system' as const,
      content:
        '你是一名课外辅导老师，正在为一次刚上完的课挑选「本次覆盖的知识点」。' +
        '必须且仅输出一个 JSON 对象：{"ids":["<候选里的 id>","<候选里的 id>"]}。' +
        '只能从候选列表里选 id，不要创造新 id；不确定时宁可少选。',
    },
    {
      role: 'user' as const,
      content: `本次课程信息：
- 对象：${ctx.who}
- 科目：${ctx.subject}
- 上课时间：${ctx.timeText}
- 课程备注：${ctx.note || '（无）'}
${
  recent.length > 0
    ? `- 最近几次课的反馈摘要：\n${recent.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`
    : '- 最近几次课的反馈摘要：（暂无）'
}

可候选的知识点（共 ${pool.length} 个）：
${list}

请选出本次课最可能覆盖的，最多 ${limit} 个，按可能性从高到低排列。`,
    },
  ]
  const raw = await chat(cfgFrom(settings), messages, true, { maxTokens: 240 })
  const parsed = extractJson<{ ids?: unknown }>(raw)
  const ids = Array.isArray(parsed.ids) ? parsed.ids.map(String) : []
  const valid = new Set(pool.map((c) => c.id))
  return ids.filter((id) => valid.has(id)).slice(0, limit)
}

// ============================================================
// AI 按模板生成课后反馈
// ============================================================

export interface TemplateFeedbackInput {
  /** 模板正文（含 {{占位符}}） */
  templateBody: string
  ctx: FeedbackContext
  /** 本次勾选的知识点（标题 + 摘要） */
  knowledges: Array<{ title: string; summary: string; path: string }>
  /** 课程时长分钟 */
  durationMin: number
}

/**
 * 按模板 + 知识点 + 课程信息生成反馈。
 * 返回：可直接填充到编辑器里的正文（模板结构被保留，占位符位置被 AI 写好内容）。
 */
export async function generateFeedbackWithTemplate(
  settings: AppSettings,
  input: TemplateFeedbackInput,
): Promise<GeneratedFeedback> {
  const knowledgeText =
    input.knowledges.length > 0
      ? input.knowledges
          .slice(0, 12)
          .map(
            (k, i) =>
              `${i + 1}. ${k.title}${k.path ? `（${k.path}）` : ''}${
                k.summary ? `\n   要点：${k.summary.replace(/\n/g, ' ').slice(0, 120)}` : ''
              }`,
          )
          .join('\n')
      : '（本次未勾选知识点，请根据科目与备注合理推断本次可能的教学内容，并在文中说明这是基于有限信息的描述）'

  const messages = [
    {
      role: 'system' as const,
      content:
        '你是一名专业的课外辅导老师，需要按「老师给定的反馈模板」撰写课后反馈。' +
        '严格要求：\n' +
        '1. 必须保留模板的所有小节标题（【】括起来的部分）与整体结构；\n' +
        '2. 只把模板中括号占位符（如「（...）」里的提示性文字）替换成真实、具体的内容；\n' +
        '3. 措辞具体、积极、有可执行建议，避免空话；\n' +
        '4. 正文整体控制在 400 字以内，紧扣模板小节，不要额外扩写；\n' +
        '5. 必须且仅输出一个 JSON 对象：{"summary":"一句话摘要（不超过40字）","content":"按模板结构写好的完整反馈正文"}。',
    },
    {
      role: 'user' as const,
      content: `【反馈模板】
${input.templateBody}

【本次课程信息】
- 对象：${input.ctx.who}
- 科目：${input.ctx.subject}
- 上课时间：${input.ctx.timeText}
- 课程时长：${input.durationMin} 分钟
- 课程备注：${input.ctx.note || '（无）'}

【本次覆盖的知识点】
${knowledgeText}
${
  input.ctx.recentFeedbacks.length > 0
    ? `\n【最近几次课的反馈摘要（用于保持连贯、避免重复表述）】\n${input.ctx.recentFeedbacks
        .filter(Boolean)
        .slice(0, 3)
        .map((s, i) => `${i + 1}. ${s.slice(0, 60)}`)
        .join('\n')}`
    : ''
}

请严格按【反馈模板】的结构输出 content，并把本次知识点自然地写进去。`,
    },
  ]
  const raw = await chat(cfgFrom(settings), messages, true, { maxTokens: 900 })
  const parsed = extractJson<Partial<GeneratedFeedback>>(raw)
  return {
    summary: (parsed.summary ?? '').trim(),
    content: (parsed.content ?? '').trim(),
  }
}

/** 常用预设（可选，方便用户选择） */
export const LLM_PRESETS: Array<{ label: string; baseUrl: string; model: string }> = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { label: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
]

// ============================================================
// AI 导入文件：教材 / 讲义自动分析、总结、归类
// ============================================================

/** 一份文档拆解出的教材方案（AI 建议如何归入现有知识库） */
export interface ImportedDocClassification {
  /** 建议归属的教材名（若与已有教材匹配则用已有 name） */
  textbookName: string
  /** 科目（可为空） */
  subject: string
  /** 从文档提炼出的单元/章节列表 */
  units: ImportedUnit[]
}

export interface ImportedUnit {
  /** 单元/章节标题，如「Unit 1」「第三章」 */
  name: string
  /** 该单元下梳理出的知识点（一条=一份可存入知识库的要点） */
  points: ImportedPoint[]
}

export interface ImportedPoint {
  title: string
  content: string
}

interface ExistingTextbookBrief {
  name: string
  subject: string
}

function snippet(text: string, n = 6000): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) : t
}

/**
 * 保留换行的截断（用于教材归类）。
 *
 * 归类块的「=== 单元：X ===」标记与换行是模型判断单元边界的唯一依据；
 * 旧的 snippet() 用 replace(/\s+/g, ' ') 会把整块压成一行，
 * 模型看不到边界 → 表现为「知识点挂到错误的单元下」「多个单元被合并成一个」。
 */
function structuredSnippet(text: string, n = 6000): string {
  const t = text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return t.length > n ? t.slice(0, n) : t
}

/**
 * 让 AI 把导出的文档/图片文本分析、总结并归类成「教材 → 单元 → 知识点」结构。
 * @param settings AI 配置
 * @param docText 提取出的文档全文（可能较长，函数内部会截断）
 * @param fileName 原始文件名（作为文档类型提示）
 * @param existingTextbooks 已有教材（name/subject），供 AI 判断是新建还是并入已有
 */
/**
 * 兜底解析：JSON 彻底坏掉时，用正则从原始输出里抢救「教材名 / 单元名 / 知识点标题+内容」。
 * 只能救回部分内容，但总比整个导入失败好。
 */
export function salvageClassification(raw: string): ImportedDocClassification | null {
  const unq = (s: string): string => {
    try {
      return JSON.parse(`"${s}"`) as string
    } catch {
      return s.replace(/\\n/g, '\n').replace(/\\"/g, '"')
    }
  }
  const grab = (key: string): string => {
    const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))
    return m ? unq(m[1]).trim() : ''
  }

  type Tok = { i: number; kind: 'unit' | 'point'; name?: string; title?: string; content?: string }
  const toks: Tok[] = []
  const reUnit = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = reUnit.exec(raw))) {
    toks.push({ i: m.index, kind: 'unit', name: unq(m[1]).trim() })
  }
  const rePoint =
    /"title"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g
  while ((m = rePoint.exec(raw))) {
    toks.push({ i: m.index, kind: 'point', title: unq(m[1]).trim(), content: unq(m[2]).trim() })
  }
  if (toks.length === 0) return null
  toks.sort((a, b) => a.i - b.i)

  const units: ImportedUnit[] = []
  let cur: ImportedUnit | null = null
  for (const t of toks) {
    if (t.kind === 'unit') {
      if (cur && (cur.name || cur.points.length)) units.push(cur)
      const hit = units.find((u) => u.name === t.name)
      cur = hit ?? { name: t.name || '', points: [] }
      if (hit) cur = hit
    } else {
      if (!cur) cur = { name: '', points: [] }
      if (t.title) cur.points.push({ title: t.title, content: t.content ?? '' })
    }
  }
  if (cur && (cur.name || cur.points.length)) units.push(cur)

  // 已 push 过的单元若重复出现，合并知识点
  const merged: ImportedUnit[] = []
  for (const u of units) {
    const hit = merged.find((x) => unitKey(x.name) === unitKey(u.name))
    if (hit) {
      const seen = new Set(hit.points.map((p) => p.title))
      for (const p of u.points) if (!seen.has(p.title)) hit.points.push(p)
    } else {
      merged.push(u)
    }
  }
  const withPoints = merged.filter((u) => u.points.length > 0 || u.name)
  return {
    textbookName: grab('textbookName'),
    subject: grab('subject'),
    units: withPoints,
  }
}

/** 对单个文本块（≤5600 字，低于 snippet 的 6000 截断线）做一次归类请求。长文档由 classifyImportedDocument 分块后逐块调用 */
async function classifyTextChunk(
  settings: AppSettings,
  docText: string,
  fileName: string,
  existingList: string,
): Promise<ImportedDocClassification> {
  const messages = [
    {
      role: 'system' as const,
      content:
        '你是一名资深教研老师，负责把一份教材/讲义/备课笔记导入到知识库。' +
        '你必须：\n' +
        '1. 通读文档内容，提炼出教材名（若与给定已有教材同名则沿用已有 name，否则建议一个教材名）、科目、章节结构；\n' +
        '2. 按文本中标注的单元边界拆分「单元」，再为每个单元提炼「知识点」。' +
        '用户消息里出现的「=== 单元：XXX ===」是**单元边界标记**，必须严格遵守：\n' +
        '   (a) units[].name 原样使用标记内的完整名称（含编号与标题，如「Unit 3 Look at your red nose!」）；\n' +
        '   (b) 某个单元的知识点只能来自该标记之后的文本，严禁跨单元混放、严禁把 A 单元内容写到 B 单元；\n' +
        '   (c) 标记后的文本若没有可提炼的知识点，该单元 points 用空数组，但单元本身必须输出，不得省略；\n' +
        '3. 知识点要「拆细」：一个语法点、一类词汇、一个句型、一篇课文要点、一项练习活动，各算一条。' +
        '每个单元通常 3-8 条，覆盖该单元主要内容，不要只写 1-2 条就收尾；\n' +
        '4. 知识点 content 写入该知识点的原始要点、公式、例句或原文摘录（100-250 字，来自原文，不要凭空编造）；\n' +
        '5. content 只写「教的是什么知识」，严禁写关于文档本身的元描述——比如「原文目录」「原文页码信息不完整」「可识别为第 X 页」「本单元主题是…需按对应页码开展教学」这类话一律不要出现；\n' +
        '6. 若某段内容只是**目录 / 索引**（只有「单元名 + 页码」，没有实质教学内容），' +
        '不要为它生成单元或知识点，直接忽略该段；\n' +
        '7. 若文档内容过短或难以归类，units 可为空数组，textbookName 填文档疑似主题。\n' +
        '8. JSON 硬性要求（否则会被判为无效）：' +
        '   (a) content 里禁止出现英文双引号，需要引号时用「」或单引号；禁止出现真实换行，要分段就写 \\n；' +
        '   (b) 数组元素之间必须有英文逗号；\n' +
        '   (c) 每个单元知识点不超过 10 条，保证 JSON 能完整输出不被截断；\n' +
        '   (d) 只输出 JSON 本身，不要任何解释文字。\n' +
        '必须且仅输出一个 JSON 对象：' +
        '{"textbookName":"教材名","subject":"科目或空串","units":[{"name":"单元名","points":[{"title":"知识点标题","content":"要点内容"}]}]}',
    },
    {
      role: 'user' as const,
      content: `请把下面这份文档分析并归类为知识库结构。

【文档来源】
${fileName}

【已有教材（判断是否并入）】
${existingList}

【文档内容】
${structuredSnippet(docText)}

【分组规则（重要）】
- 文本里若出现「=== 单元：XXX ===」，那是单元边界标记，必须严格按它分组；
- 每个单元的知识点只能来自该标记之后的文本，禁止跨单元混放；
- 标记后没有可提炼内容时，该单元 points 输出空数组，但单元本身必须保留；
- 没有任何标记时，才按文档自身的章节/标题结构划分单元。

【提炼要求】
- 知识点粒度：一个语法点、一类词汇、一个句型、一篇课文要点、一项练习活动各算一条；
- 每个单元一般 3-8 条，覆盖该单元主要内容，不要只写 1-2 条就结束；
- content 写原始要点/例句/词汇清单，100-250 字，忠于原文。

输出必须是完整可解析的 JSON。`,
    },
  ]
  // 上限给足（4000）：这一块要输出多个单元的完整知识点，宁松勿断
  const raw = await chat(cfgFrom(settings), messages, true, { maxTokens: 4000 })
  let parsed: Partial<ImportedDocClassification>
  try {
    parsed = extractJson<Partial<ImportedDocClassification>>(raw)
  } catch {
    const salvaged = salvageClassification(raw)
    if (!salvaged || salvaged.units.length === 0) {
      throw new LlmError('AI 返回内容无法解析为 JSON（已自动尝试修复）。请重试一次，或换用输出更稳定的模型。')
    }
    parsed = salvaged
  }

  const units = Array.isArray(parsed.units)
    ? (parsed.units as ImportedUnit[])
        .map((u) => ({
          name: String(u?.name ?? '').trim(),
          points: Array.isArray(u.points)
            ? u.points
                .map((p) => ({
                  title: String(p?.title ?? '').trim(),
                  content: String(p?.content ?? '').trim(),
                }))
                .filter((p) => p.title)
            : [],
        }))
        .filter((u) => u.name || u.points.length > 0)
    : []
  return {
    textbookName: String(parsed.textbookName ?? '').trim(),
    subject: String(parsed.subject ?? '').trim(),
    units: sortUnits(units),
  }
}

/**
 * 单元名归一化成跨段合并的主键：
 * 不同分段里模型可能输出「Unit 3」和「Unit 3 My Name Is Gina」，
 * 按完整字符串匹配会重复入库，这里只比编号部分。
 */
function unitKey(name: string): string {
  const t = name.trim().toLowerCase()
  const m = t.match(
    /^(?:units?|lessons?|chapters?|modules?|parts?|books?|terms?|stages?)\s*(\d+)|第\s*(\d+|[一二三四五六七八九十百零两]+)\s*(?:单元|章|课|节|讲|课时)/,
  )
  if (m) return cnNumToDigits(m[1] ?? m[2] ?? '')
  return t
}

/** 中文序号转数字（第五章 ↔ Chapter 5 归一到同一个 key） */
function cnNumToDigits(s: string): string {
  if (/^\d+$/.test(s)) return s
  const map: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  }
  if (s.length <= 2 && s.split('').every((c) => c in map)) return String(map[s])
  // 含「十」的写法：十 / 十五 / 二十 / 二十三
  if (s.includes('十')) {
    const [a, b] = s.split('十')
    const tens = a === '' ? 1 : map[a] ?? 0
    const ones = b === '' ? 0 : map[b] ?? 0
    if (tens) return String(tens * 10 + ones)
  }
  return s
}

/** 无法解析出单元编号时的哨兵值 */
export const NO_UNIT_NUMBER = Number.MAX_SAFE_INTEGER

/**
 * 单元排序键：取单元名中的编号（Unit 15 → 15，第五章 → 5）。
 * 识别不到编号的（如「绪论」「附录」）排到最后，保持原有相对顺序。
 */
function unitSortKey(name: string): number {
  const digits = unitKey(name).match(/\d+/)
  if (digits) {
    const n = Number(digits[0])
    if (Number.isFinite(n) && n > 0) return n
  }
  return NO_UNIT_NUMBER
}

/**
 * 按单元编号排序。
 * 分段归类是「块 1 → 块 N」顺序合并的，若某块内模型输出顺序错乱
 * （或目录块先返回），最终会出现「Unit 15 排在 Unit 8 前面」。
 * 这里统一按编号重排，保证与教材目录一致。
 */
function sortUnits(units: ImportedUnit[]): ImportedUnit[] {
  return units
    .map((u, i) => ({ u, i, k: unitSortKey(u.name) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.u)
}

/** 合并两个分段归类结果：单元同名则并入知识点（按标题去重），否则追加为新单元 */
function mergeClassification(base: ImportedDocClassification, next: ImportedDocClassification): void {
  if (!base.textbookName && next.textbookName) base.textbookName = next.textbookName
  if (!base.subject && next.subject) base.subject = next.subject
  for (const u of next.units) {
    const hit = base.units.find((x) => unitKey(x.name) === unitKey(u.name))
    if (hit) {
      const seen = new Set(hit.points.map((p) => p.title))
      for (const p of u.points) if (!seen.has(p.title)) hit.points.push(p)
    } else {
      base.units.push(u)
    }
  }
}

const CLASSIFY_CHUNK_CHARS = 6000
const CLASSIFY_CHUNK_OVERLAP = 300
/**
 * 按结构分块时的上限：每次请求最多 4 个单元、5600 字。
 * 5600 必须小于 snippet 的 6000 截断线，否则块内内容会在发请求前又被切掉。
 */
const CLASSIFY_UNITS_PER_REQUEST = 4
const CLASSIFY_CHARS_PER_REQUEST = 5600
const CLASSIFY_MAX_CHUNKS = 24

/**
 * 教材单元标题识别。
 * 命中「Unit 3」「第 4 单元」「第五章」「第 二 课」等，作为分块的自然边界。
 * 前面的负向前查用于排除「课文第 3 课」「课本第 2 单元」这类正文误命中。
 */
const UNIT_TITLE_RE =
  /(?<![A-Za-z0-9\u4e00-\u9fa5])(?:\b(?:Unit|Units|Lesson|Lessons|Chapter|Chapters|Module|Modules|Week|Stage|Part|Book|Term)\s*\d+\b|第\s*\d+\s*(?:单元|章节?|讲|课时|课(?!文|堂|本|程|点|后|间|目|前|外|表|件)|节(?!点|奏|击))|第\s*[一二三四五六七八九十百零两]+\s*(?:单元|章节?|讲|课时|课(?!文|堂|本|程|点|后|间|目|前|外|表|件)|节(?!点|奏|击)))/g

/** 按字数硬切（无结构信息时的兜底） */
function sliceByChars(text: string, maxChars: number, overlap = 300, maxPieces = 20): string[] {
  const step = Math.max(maxChars - overlap, 1000)
  const out: string[] = []
  for (let i = 0; i < text.length; i += step) {
    out.push(text.slice(i, i + maxChars))
    if (out.length >= maxPieces) break
  }
  return out
}

/**
 * 扫描标题命中位置。
 * lineStartOnly=true 时要求标题位于行首（前面只有空白）——教材的单元标题通常独占一行；
 * 同时把与上一个命中标题相距 <60 字的重复提及剔除（如标题行里「Unit 3 ... Unit 3 ...」）。
 */
interface UnitMark {
  idx: number
  /** 规范化后的标题（多空白压成一个空格） */
  title: string
  /** 原文中的匹配长度，用于截掉标题本体、保留其后正文 */
  rawLen: number
}

function pickUnitMarks(text: string, lineStartOnly: boolean): UnitMark[] {
  const re = new RegExp(UNIT_TITLE_RE.source, 'g')
  const marks: UnitMark[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (lineStartOnly) {
      let k = m.index - 1
      while (k >= 0 && (text[k] === ' ' || text[k] === '\t')) k--
      if (k >= 0 && text[k] !== '\n') continue // 正文里提到「Unit 3」不算新单元
    }
    const prev = marks[marks.length - 1]
    if (prev && m.index - prev.idx < 60) continue
    marks.push({ idx: m.index, title: m[0].replace(/\s+/g, ' '), rawLen: m[0].length })
  }
  return marks
}

/**
 * 剔除「目录页 / 书前索引」造成的假单元。
 *
 * 目录页里 `Unit 1 xxx ... 3 / Unit 2 yyy ... 5` 会连续命中十几次标题，
 * 且相邻标题间距极小、中间几乎没有正文。若不去掉：
 *  - 单元数量翻倍、顺序错乱（目录项排在正文之前，用户看到「Unit 15 排在 Unit 8 前面」）；
 *  - 目录项只有标题没有正文 → 知识点被挂到错误的单元下。
 *
 * 判据：连续 ≥4 个标题且两两间距 < 120 字 → 判定为目录区。
 * （真实单元至少几百字正文，间距远大于 120；若整篇都是短段，detectUnitSegments
 *   的 avg<200 检查会先判定为「无结构」而走硬切，不会误伤。）
 *
 * ⚠️ 只丢弃目录区中**除最后一项之外**的项：目录最后一项后面紧接的往往就是
 * 正文的第一个单元（间距同样 < 120），整段丢弃会把 Unit 1 一起吃掉，
 * 表现为「识别到的第一个单元是 Unit 2」。保留末项可让正文首单元存活。
 */
function dropTocRuns(marks: UnitMark[], minRun = 4, maxGap = 120): UnitMark[] {
  const out: UnitMark[] = []
  let i = 0
  while (i < marks.length) {
    let j = i
    while (j + 1 < marks.length && marks[j + 1]!.idx - marks[j]!.idx < maxGap) j++
    const runLen = j - i + 1
    if (runLen >= minRun) {
      console.info(
        `[llm] 疑似目录区 ${runLen} 项，保留末项作为正文起点：${marks
          .slice(i, j + 1)
          .map((m) => m.title)
          .join(' / ')}`,
      )
      out.push(marks[j]!)
    } else {
      for (let k = i; k <= j; k++) out.push(marks[k]!)
    }
    i = j + 1
  }
  return out
}

/** 识别「单元段」（标题 + 该单元原文）；结构不明显时返回 null。pre = 首个标题之前的正文（封面/目录/前言），也要送去归类，不能丢 */
function detectUnitSegments(
  text: string,
): { pre: string; segs: Array<{ title: string; body: string }> } | null {
  const strict = pickUnitMarks(text, true)
  const loose = pickUnitMarks(text, false)
  // 覆盖优先：宽松模式命中更多时用宽松——OCR 文本里单元标题常与页眉/页码挤在同一行，
  // 严格模式会把行首判定失败的前几个单元整段漏掉（表现为「从 Unit 7 才开始识别」）。
  // 宽松模式多切几块无害：误命中只是多一次请求，merge 阶段按单元编号去重。
  let marks = loose.length > strict.length ? loose : strict
  if (marks.length < 3) return null
  // 先剔除目录页：目录项会被当成"单元"，导致单元数量翻倍、顺序错乱、知识点挂错单元
  marks = dropTocRuns(marks)
  if (marks.length < 3) return null
  const rawSegs = marks.map((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].idx : text.length
    // body 从标题之后开始（标题另行用「=== 单元：X ===」标记输出，避免重复）
    return { title: mk.title, body: text.slice(mk.idx + mk.rawLen, end) }
  })
  // 相邻且同编号的段合并：目录残留（只有标题没正文）会和正文首个单元撞成同编号，
  // 不合并会多出一段「Unit 1 + 目录尾巴」白白发一次请求，也污染诊断列表。
  // 合并时保留更长的正文（短的几乎必然是目录残留）。
  const merged: Array<{ title: string; body: string }> = []
  for (const s of rawSegs) {
    const prev = merged[merged.length - 1]
    if (prev && unitKey(prev.title) === unitKey(s.title)) {
      if (s.body.length > prev.body.length) prev.body = s.body
    } else {
      merged.push({ ...s })
    }
  }
  // 丢弃 body 过短的段：目录残留只有「标题 + 页码」，没有教学内容，
  // 留着会白白多发一次请求，也会让诊断列表多出假单元。
  // 兜底：过滤后不足 3 段时保留原样（避免把短小文档清空）。
  const MIN_BODY_CHARS = 100
  const trimmed = merged.filter((s) => s.body.trim().length >= MIN_BODY_CHARS)
  const segs = trimmed.length >= 3 ? trimmed : merged
  // 每段平均不到 200 字 → 多半是纯目录页，按结构切没意义
  const avg = segs.reduce((n, s) => n + s.body.length, 0) / segs.length
  if (avg < 200) return null

  // 开头段落（封面/目录/前言）：若它本身就是目录（标题密集出现），
  // 只保留最后一次命中之后的文本。否则目录会被当成正文送去归类，
  // 模型会为目录生成「Unit 7 目录与课时页码」这类垃圾知识点
  // （历史数据里真实出现过）。
  const preRaw = text.slice(0, marks[0]!.idx)
  let pre = preRaw
  const preMarks = pickUnitMarks(preRaw, false)
  if (preMarks.length >= 3) {
    const span = preMarks[preMarks.length - 1]!.idx - preMarks[0]!.idx
    const dense = span / Math.max(preMarks.length - 1, 1) < 200
    if (dense) {
      const last = preMarks[preMarks.length - 1]!
      pre = preRaw.slice(last.idx + last.rawLen)
      console.info(`[llm] 开头段落判定为目录（${preMarks.length} 条标题），已裁掉，避免生成页码类垃圾知识点`)
    }
  }
  return { pre, segs }
}

/**
 * 只做「识别到的单元标题」预览，供导入弹窗展示诊断信息
 * （让老师一眼看出分块是否合理，而不是等导入完才发现单元错乱）。
 */
export function detectUnitTitles(text: string): string[] {
  const detected = detectUnitSegments(text)
  return detected ? detected.segs.map((s) => s.title) : []
}

// ------------------------------------------------------------
// AI 辅助结构识别（本地正则不可靠时的兜底）
// ------------------------------------------------------------

/**
 * 判断本地识别结果是否「可疑」——可疑时请 AI 帮忙重新列单元清单。
 *
 * 触发条件（任一）：
 *  - 完全没识别到单元；
 *  - 超过 30% 的标题解析不出编号（标题被 OCR 破坏，或模型把描述当标题）；
 *  - 最小编号 > 1 —— 教材一定从 1 开始，说明**前面的单元被整段漏掉**
 *    （历史现象：「从第 7 单元开始识别，1-6 单元全没有」）；
 *  - 编号不连续 —— 中间有单元漏识别；
 *  - 平均每个单元超过 9000 字 —— 漏识别把多个单元的内容并进了少数单元。
 */
function needsAiAssist(titles: string[], textLen: number): boolean {
  if (titles.length === 0) return true
  const nums = titles.map(unitSortKey).filter((n) => n !== NO_UNIT_NUMBER)
  if (nums.length < titles.length * 0.7) return true
  if (nums.length > 0) {
    const min = Math.min(...nums)
    const max = Math.max(...nums)
    if (min > 1) return true
    if (max - min + 1 > nums.length) return true
  }
  return textLen / titles.length > 9000
}

/** 模糊匹配用：匹配时忽略这些字符（空白、标点、常见 OCR 干扰符） */
const SEARCH_SKIP = new Set(
  Array.from(" \t\n\r-_.,:;!?·'\"“”‘’()（）【】[]{}…—～~/\\|+=*&^%$#@<>"),
)

/** 构建「规范化文本 → 原文索引」的检索索引（去空白与标点、统一小写） */
function buildSearchIndex(text: string): { hay: string; idx: number[] } {
  const chars: string[] = []
  const idx: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (SEARCH_SKIP.has(c)) continue
    chars.push(c.toLowerCase())
    idx.push(i)
  }
  return { hay: chars.join(''), idx }
}

function normalizeForMatch(s: string): string {
  let out = ''
  for (const c of s) if (!SEARCH_SKIP.has(c)) out += c.toLowerCase()
  return out
}

/**
 * 把 AI 给出的单元标题回定位到原文位置。
 * 容忍 OCR 的行内噪声（标题与页码同行、多余空格、大小写差异），
 * 找不到的标题直接跳过（其内容由相邻单元吸收）。
 */
function locateTitles(text: string, titles: string[]): UnitMark[] {
  const { hay, idx } = buildSearchIndex(text)
  const marks: UnitMark[] = []
  let cursor = 0
  for (const title of titles) {
    const needle = normalizeForMatch(title)
    if (needle.length < 3) continue
    const at = hay.indexOf(needle, cursor)
    if (at < 0) continue
    const rawStart = idx[at]!
    const rawEnd = idx[Math.min(at + needle.length - 1, idx.length - 1)]!
    marks.push({
      idx: rawStart,
      title,
      rawLen: Math.max(rawEnd - rawStart + 1, needle.length),
    })
    cursor = rawEnd + 1
  }
  return marks
}

/**
 * 请 AI 列出文档里的全部单元标题（只列标题，不提炼知识点）。
 * OCR 噪声让本地正则失效时（「Unlt 1」「Unit1Hello!」「标题连页码」），
 * 由模型理解结构，再由 locateTitles 回原文定位。
 */
async function aiDetectUnitTitles(
  settings: AppSettings,
  fileName: string,
  text: string,
  existingList: string,
): Promise<string[]> {
  const messages = [
    {
      role: 'system' as const,
      content:
        '你是文档结构分析助手。任务：按文档中出现的先后顺序，列出这份教材/讲义包含的**全部**单元（或章节）标题。' +
        '要求：\n' +
        '1) 标题保持原文写法（含编号，如「Unit 3 Look at your red nose!」「第三章 函数」）；\n' +
        '2) 一个单元一条，**禁止把两个单元合并成一条**（不要出现「A / B」这种写法）；\n' +
        '3) 不要输出正文、不要总结、不要臆造原文没有出现的单元；\n' +
        '4) 忽略目录页的重复条目，但**目录里出现过、正文里也有的单元必须列出**；\n' +
        '5) 一个都不能漏——若文档从 Unit 1 开始就要从 Unit 1 列起。\n' +
        '必须且仅输出 JSON：{"units":["标题1","标题2"]}。',
    },
    {
      role: 'user' as const,
      content: `【文档名】${fileName}

【已有教材（仅作参考）】
${existingList}

【文档内容】
${structuredSnippet(text, 12000)}

请列出这份文档包含的全部单元标题。`,
    },
  ]
  const raw = await chat(cfgFrom(settings), messages, true, { maxTokens: 900 })
  try {
    const parsed = extractJson<{ units?: unknown }>(raw)
    if (!Array.isArray(parsed.units)) return []
    return parsed.units
      .map((x) => String(x ?? '').trim())
      .filter((s) => s.length >= 2 && s.length <= 120)
      .slice(0, 40)
  } catch {
    return []
  }
}

/** @internal 仅供单测调用，业务代码请用 detectUnitTitles / classifyImportedDocument */
export function __testNeedsAiAssist(titles: string[], textLen: number): boolean {
  return needsAiAssist(titles, textLen)
}

/** @internal 仅供单测调用 */
export function __testLocateTitles(text: string, titles: string[]): Array<{ idx: number; title: string }> {
  return locateTitles(text, titles).map((m) => ({ idx: m.idx, title: m.title }))
}

/** @internal 仅供单测：查看分块结果（含开头段落长度，用于验证目录是否被裁掉） */
export function __testDetectSegments(text: string): { preLen: number; titles: string[] } | null {
  const d = detectUnitSegments(text)
  return d ? { preLen: d.pre.trim().length, titles: d.segs.map((s) => s.title) } : null
}

/**
 * 结合「本地正则识别」与「AI 结构识别」得到最终分块。
 * 本地结果可信时直接用（省一次 AI 请求）；可疑时用 AI 列出的标题
 * 回原文定位，得到覆盖更完整的单元边界。
 * 返回 null 表示无结构，调用方退化为按字数硬切。
 */
async function resolveSegments(
  settings: AppSettings,
  fileName: string,
  docText: string,
  existingList: string,
): Promise<{ pre: string; segs: Array<{ title: string; body: string }> } | null> {
  const local = detectUnitSegments(docText)
  const localTitles = local ? local.segs.map((s) => s.title) : []
  if (!needsAiAssist(localTitles, docText.length)) return local

  console.info('[llm] 本地单元识别可疑，尝试 AI 辅助识别文档结构：', localTitles)
  try {
    const aiTitles = await aiDetectUnitTitles(settings, fileName, docText, existingList)
    if (aiTitles.length >= 2) {
      const marks = locateTitles(docText, aiTitles)
      if (marks.length >= 2) {
        const segs = marks.map((mk, i) => {
          const end = i + 1 < marks.length ? marks[i + 1]!.idx : docText.length
          return { title: mk.title, body: docText.slice(mk.idx + mk.rawLen, end) }
        })
        const avg = segs.reduce((n, s) => n + s.body.length, 0) / segs.length
        if (avg >= 100) {
          console.info(
            `[llm] AI 辅助识别到 ${marks.length} 个单元（本地只有 ${localTitles.length} 个）`,
          )
          return { pre: docText.slice(0, marks[0]!.idx), segs }
        }
      }
    }
  } catch (e) {
    console.warn('[llm] AI 辅助识别失败，沿用本地结果：', e)
  }
  return local
}

/** 单元边界标记：模型据此严格分组，避免知识点挂错单元 */
function unitMark(title: string): string {
  return `=== 单元：${title} ===`
}

/**
 * 贪心打包：每块 ≤maxUnits 段且 ≤maxChars 字；单段过长则按字数二次切。
 *
 * 每段前显式插入「=== 单元：X ===」标记：模型不必猜测边界，
 * 直接按标记分组，显著降低「归属单元不对」的概率。
 */
function packSegments(
  segs: Array<{ title: string; body: string }>,
  maxUnits: number,
  maxChars: number,
): string[] {
  const chunks: string[] = []
  let buf: string[] = []
  let units = 0
  let chars = 0
  const flush = () => {
    if (buf.length) {
      chunks.push(buf.join('\n\n'))
      buf = []
      units = 0
      chars = 0
    }
  }
  for (const seg of segs) {
    const head = `${unitMark(seg.title)}\n`
    const budget = Math.max(maxChars - head.length, 800)
    const pieces =
      seg.body.length > budget ? sliceByChars(seg.body, budget, 300, 8) : [seg.body]
    for (const piece of pieces) {
      const text = `${head}${piece}`
      if (buf.length && (units + 1 > maxUnits || chars + text.length > maxChars)) flush()
      buf.push(text)
      units += 1
      chars += text.length
    }
  }
  flush()
  return chunks.length > CLASSIFY_MAX_CHUNKS ? chunks.slice(0, CLASSIFY_MAX_CHUNKS) : chunks
}


/**
 * 让 AI 把导出的文档/图片文本分析、总结并归类成「教材 → 单元 → 知识点」结构。
 * 长文档自动分块，优先按「单元标题」切（Unit 1 / 第 3 单元 / 第五章…）：
 *   每块最多 5 个单元、9000 字，避免一块塞进 15 个单元导致模型输出被截断、
 *   只有前几个单元有知识点；识别不到结构时退回按字数硬切（6000 字 + 300 字重叠）。
 * 逐块顺序请求（不并发，避免触发上游限流 429），结果按单元名合并。
 * @param settings AI 配置
 * @param docText 提取出的文档全文（任意长度）
 * @param fileName 原始文件名（作为文档类型提示）
 * @param existingTextbooks 已有教材（name/subject），供 AI 判断是新建还是并入已有
 * @param onProgress 可选：分段进度回调（done=已完成块数，total=总块数，failed=累计失败块数，retrying=正在补试失败块）
 */
export async function classifyImportedDocument(
  settings: AppSettings,
  docText: string,
  fileName: string,
  existingTextbooks: ExistingTextbookBrief[],
  onProgress?: (p: { done: number; total: number; failed: number; retrying?: boolean }) => void,
): Promise<ImportedDocClassification> {
  const existingList =
    existingTextbooks.length > 0
      ? existingTextbooks.map((t, i) => `${i + 1}. ${t.name}${t.subject ? `（${t.subject}）` : ''}`).join('\n')
      : '（知识库为空）'

  const clean = docText.replace(/\s+/g, ' ').trim()
  if (clean.length <= CLASSIFY_CHUNK_CHARS) {
    return classifyTextChunk(settings, clean, fileName, existingList)
  }

  // 优先按单元标题切分：一块塞进 15 个单元会让模型输出被截断，只剩前几个单元有知识点。
  // 本地正则识别可疑时（漏掉前几个单元 / 编号不连续 / 标题被 OCR 破坏），
  // resolveSegments 会先请 AI 列出完整单元清单，再回原文模糊定位锚点。
  const detected = await resolveSegments(settings, fileName, docText, existingList)
  let chunks: string[]
  if (detected) {
    chunks = packSegments(detected.segs, CLASSIFY_UNITS_PER_REQUEST, CLASSIFY_CHARS_PER_REQUEST)
    // 首个单元标题之前的正文（封面/目录/前言/被漏识别的单元）不能丢——
    // 直接作为第一块送去归类，否则表现为「从第 7 单元才开始识别」。
    // 过长时切成最多 2 片，避免整段塞进一次请求被截断导致知识点缺失。
    const pre = detected.pre.trim()
    if (pre.length >= 200) {
      chunks.unshift(
        ...sliceByChars(pre, CLASSIFY_CHARS_PER_REQUEST, 300, pre.length > CLASSIFY_CHARS_PER_REQUEST ? 2 : 1),
      )
    }
  } else {
    chunks = sliceByChars(clean, CLASSIFY_CHUNK_CHARS, CLASSIFY_CHUNK_OVERLAP)
  }
  console.info(
    detected
      ? `[llm] 识别到 ${detected.segs.length} 个单元标题，打包为 ${chunks.length} 块`
      : `[llm] 未识别到单元结构，按字数切为 ${chunks.length} 块`,
  )

  let merged: ImportedDocClassification | null = null
  let failures = 0
  let lastErr: unknown = null
  const failedIdx: number[] = []
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.({ done: i, total: chunks.length, failed: failedIdx.length })
    const chunkStart = Date.now()
    try {
      const part = await classifyTextChunk(settings, chunks[i]!, fileName, existingList)
      if (!merged) {
        merged = part
      } else {
        mergeClassification(merged, part)
      }
      failures = 0
    } catch (e) {
      // 单块失败（429 限流 / 输出不可解析）不再让整次导入全挂：跳过该块继续，结尾再补试一轮
      failures += 1
      lastErr = e
      failedIdx.push(i)
      console.warn(`[llm] 第 ${i + 1}/${chunks.length} 块归类失败：`, e)
      if (failures >= 3 && merged) break // 连续失败过多，保留已得结果提前收尾
    }
    if (i < chunks.length - 1) {
      // 块间等待是为了降低免费额度 QPS 限流风险；刚失败过则多等一会。
      // v31.5 自适应：上一块本身就很慢时说明上游在排队，再等满 3s 纯属白等；
      // 只有上一块很快（<3s）才需要拉长间隔防限流。
      const cost = Date.now() - chunkStart
      const wait = failures > 0 ? 6000 : cost < 3000 ? 3000 : cost < 8000 ? 1200 : 500
      await new Promise((r) => setTimeout(r, wait))
    }
  }

  // 补试轮：首轮失败的块（最多 6 块）间隔更久后再试一次，挽救「12-14 单元没知识点」这类尾部缺失
  const retryIdx = failedIdx.slice(0, 6)
  for (let j = 0; j < retryIdx.length; j++) {
    const i = retryIdx[j]!
    onProgress?.({ done: chunks.length, total: chunks.length, failed: failedIdx.length - j, retrying: true })
    console.info(`[llm] 补试第 ${i + 1}/${chunks.length} 块…`)
    await new Promise((r) => setTimeout(r, 8000))
    try {
      const part = await classifyTextChunk(settings, chunks[i]!, fileName, existingList)
      if (!merged) merged = part
      else mergeClassification(merged, part)
    } catch (e) {
      lastErr = e
      console.warn(`[llm] 补试第 ${i + 1} 块仍失败：`, e)
    }
  }

  onProgress?.({ done: chunks.length, total: chunks.length, failed: 0 })
  if (!merged && lastErr) throw lastErr
  if (merged && failedIdx.length > 0) {
    console.warn(`[llm] 归类完成，首轮有 ${failedIdx.length} 个分段失败（已补试），结果可能不完整`)
  }
  if (!merged) return { textbookName: '', subject: '', units: [] }
  // 各块按「块顺序」合并，可能出现单元乱序（如目录块、超长单元被切片后回填），
  // 统一按单元编号重排，保证与教材目录一致。
  return { ...merged, units: sortUnits(merged.units) }
}

/** 用 AI 生成一段要点式的摘要（作为知识点的 summary） */
export async function summarizeImportedPoint(
  settings: AppSettings,
  title: string,
  content: string,
): Promise<string> {
  const messages = [
    {
      role: 'system' as const,
      content:
        '你是教研老师。请把下面这个知识点整理成一段结构化摘要（一句话定位 + 3-5 条要点 + 常见易错点），直接输出 Markdown 文本，不要输出 JSON 或其它说明。',
    },
    {
      role: 'user' as const,
      content: `知识点标题：${title}\n原始要点：\n${snippet(content, 2000)}\n\n请整理成可复用摘要。`,
    },
  ]
  const raw = await chat(cfgFrom(settings), messages, false, { maxTokens: 400 })
  return raw.trim()
}

/** 学生画像快照：由 studentProfile.ts 从 DB 读取后传入 */
export interface StudentProfileSnapshot {
  summary: string
  strengths: string
  weaknesses: string
  teachingStyle: string
  profileUpdatedAt: number
  sourceCount: number
}

/** 画像各字段塞进 prompt 前的截断长度（v31.4：控制输入 token，缩短预填耗时） */
const PROMPT_CLIP = { summary: 120, strengths: 70, weaknesses: 70, style: 50, taskTitle: 40, taskNote: 120 }

function clipText(s: string | undefined, n: number): string {
  const t = (s ?? '').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 根据打卡备注生成给家长看的反馈（用于 CheckIn QuickNoteModal） */
export async function generateCheckInFeedback(
  settings: AppSettings,
  note: string,
  studentName?: string,
  profile?: StudentProfileSnapshot,
  task?: { title: string; note?: string; cadenceLabel?: string },
): Promise<string> {
  const profileBlock = profile && (profile.summary || profile.strengths || profile.weaknesses || profile.teachingStyle)
    ? `
【该学员历史画像（AI 从过往打卡反馈汇总）】
- 综合特征：${clipText(profile.summary, PROMPT_CLIP.summary) || '（暂无）'}
- 优势亮点：${clipText(profile.strengths, PROMPT_CLIP.strengths) || '（暂无）'}
- 待改进点：${clipText(profile.weaknesses, PROMPT_CLIP.weaknesses) || '（暂无）'}
- 推荐教学方式：${clipText(profile.teachingStyle, PROMPT_CLIP.style) || '（暂无）'}
- 画像基于 ${profile.sourceCount} 条历史素材（更新于 ${new Date(profile.profileUpdatedAt).toLocaleDateString('zh-CN')}）

请结合以上画像撰写个性化反馈：
1) 呼应画像中该学员的固有特点（性格 / 学习节奏 / 常见表现），避免重复已经给过的建议；
2) 若画像显示某个优点，本次也表现好，可在反馈里点名肯定；
3) 若画像显示某个弱点，本次仍未解决，可以温和复述并给出新的切入方式；
4) 若画像与本次表现不符，以本次表现为准，画像只作参考。`
    : ''

  const taskBlock = task && (task.title || task.note)
    ? `
【本次打卡对应的任务】
- 任务名称：${clipText(task.title, PROMPT_CLIP.taskTitle) || '（未命名）'}
${task.note ? `- 任务要求：${clipText(task.note, PROMPT_CLIP.taskNote)}` : ''}
${task.cadenceLabel ? `- 打卡节奏：${task.cadenceLabel}` : ''}

请结合任务要求判断学员完成情况：1) 是否达成了任务目标；2) 反馈里点明"完成了任务的哪一部分"或"还差哪里"；3) 家庭练习建议尽量贴合任务要求。`
    : ''

  const messages = [
    {
      role: 'system' as const,
      content:
        '你是一位资深学科教师。根据老师对学员打卡视频的简短记录，生成一段面向家长的自然、温暖、具体的反馈。' +
        '要求：1) 语气亲切但专业；2) 先肯定表现，再指出可改进点（如有）；3) 给出 1-2 条可操作的家庭练习建议；4) 160-180 字，不要超长；5) 直接输出反馈正文，不要加标题或前缀。' +
        (profileBlock
          ? '注意：本次反馈必须结合【学员历史画像】做个性化处理，避免"每次反馈都长得一样"。'
          : '') +
        (taskBlock
          ? '注意：本次反馈必须结合【本次打卡对应的任务】判断完成度，避免空泛。'
          : ''),
    },
    {
      role: 'user' as const,
      content: `学员：${studentName ?? '学生'}\n老师观察记录：${note}\n${taskBlock}${profileBlock}`,
    },
  ]
  const raw = await chat(cfgFrom(settings), messages, false, { maxTokens: 600 })
  return raw.trim()
}
