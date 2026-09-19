// Supabase Edge Function: LLM Proxy
// ================================================================
// 目的：把前端浏览器跨域调不通的 LLM 端点（如 SenseNova、Ollama 本地）
//      通过 Supabase Edge Function 中转，规避 CORS 限制。
//
// 部署：
//   1. 在 Supabase 控制台 → Edge Functions → New Function，命名 llm-proxy，
//      粘贴本文件全部内容。
//   2. 项目 Secrets 里加两条：
//        LLM_PROXY_TOKEN  —— 你自己选一个随机串（前端设置页填同一串）
//   3. 部署后，前端「设置 → AI 辅助」勾选「经 Edge Function 中转」，
//      填入 Function URL 与 LLM_PROXY_TOKEN。
//
// ⚠️ 关于 401「Proxy 401」：
//   Supabase 函数网关默认开启 JWT 校验。若前端把 `<LLM_PROXY_TOKEN>` 直接放在
//   Authorization 头，网关会先判定它不是合法 JWT 并直接返回 401，函数代码根本
//   不会执行。因此新版前端改为：
//        Authorization: Bearer <Supabase anon key>   ← 通过网关 JWT 校验
//        apikey:        <Supabase anon key>
//        x-proxy-token: <LLM_PROXY_TOKEN>            ← 真正的共享密钥
//   本函数优先读取 x-proxy-token，并保留对旧协议（Authorization 携带共享密钥）
//   的兼容 —— 旧协议要求关闭「Enforce JWT verification」。
//
// 请求：POST /functions/v1/llm-proxy
//   Authorization: Bearer <anon key>（或 <LLM_PROXY_TOKEN>，需关闭 JWT 校验）
//   x-proxy-token: <LLM_PROXY_TOKEN>
//   body: { baseUrl, apiKey, model, messages, jsonMode }
//
// 响应：
//   { content: string }                —— 正常
//   { error: string, status: number }  —— 上游报错
// ================================================================

const TOKEN = Deno.env.get("LLM_PROXY_TOKEN") ?? ""

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, x-proxy-token, x-user-id, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
}

Deno.serve(async (req) => {
  // CORS 预检
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  // 校验共享密钥：优先自定义头，回退到 Authorization（兼容旧部署）
  const proxyToken = (req.headers.get("x-proxy-token") ?? "").trim()
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : ""
  const provided = proxyToken || bearer
  if (!TOKEN || provided !== TOKEN) {
    return new Response(
      JSON.stringify({
        error: proxyToken
          ? "Unauthorized: LLM_PROXY_TOKEN mismatch"
          : "Unauthorized: 未收到共享密钥。请更新前端到最新版（会在 x-proxy-token 头携带），或关闭本函数的 JWT 校验后用 Authorization 传共享密钥",
      }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    )
  }

  let payload: {
    baseUrl?: string
    apiKey?: string
    model?: string
    messages?: Array<{ role: string; content: string }>
    jsonMode?: boolean
    temperature?: number
    maxTokens?: number
  }
  try {
    payload = await req.json()
  } catch (e) {
    return json({ error: `Invalid JSON body: ${String(e)}` }, 400)
  }

  const { baseUrl, apiKey, model, messages, jsonMode, temperature, maxTokens } = payload
  if (!baseUrl || !apiKey || !model || !Array.isArray(messages) || messages.length === 0) {
    return json({ error: "Missing required field: baseUrl, apiKey, model or messages" }, 400)
  }

  // 拼装上游 URL：兼容 baseUrl 已含 /chat/completions 或未含的情况
  const normalizedBase = baseUrl.replace(/\/+$/, "")
  const upstreamUrl = normalizedBase.endsWith("/chat/completions")
    ? normalizedBase
    : `${normalizedBase}/chat/completions`

  // 将 messages 中的公网图片 URL 转为 base64 data URL（部分 API 如 SenseNova 只接受 base64）
  let resolvedMessages = messages
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as any
    if (Array.isArray(msg.content)) {
      const newContent: any[] = []
      for (const part of msg.content) {
        if (part.type === "image_url" && part.image_url?.url) {
          const url: string = part.image_url.url
          if (url.startsWith("http://") || url.startsWith("https://")) {
            try {
              const dataUrl = await fetchUrlToDataURL(url)
              newContent.push({ ...part, image_url: { ...part.image_url, url: dataUrl } })
              continue
            } catch {
              /* keep original URL if conversion fails */
            }
          }
        }
        newContent.push(part)
      }
      resolvedMessages = [...resolvedMessages]
      ;(resolvedMessages as any)[i] = { ...msg, content: newContent }
    }
  }

  const body: Record<string, unknown> = {
    model,
    messages: resolvedMessages,
    temperature: typeof temperature === "number" ? temperature : 0.7,
  }
  // 输出长度上限（新版前端会传；省略时不加，交给上游默认值）
  if (typeof maxTokens === "number" && maxTokens > 0) {
    body.max_tokens = Math.floor(maxTokens)
  }
  if (jsonMode) {
    body.response_format = { type: "json_object" }
  }

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    })
  } catch (e) {
    return json(
      { error: `Upstream network error: ${String(e)}`, upstreamUrl },
      502,
    )
  }

  // jsonMode 被上游 400 拒绝（不支持 response_format）时，在本函数内直接去掉该参数重试一次。
  // 注意：这段必须放在 !upstream.ok 分支之前 —— 否则 400 会先被上面拦下直接返回，
  // 前端只能自己再补一次完整往返（多一个 RTT + 一次网关调用）。
  if (upstream.status === 400 && jsonMode) {
    console.info("[llm-proxy] upstream rejected response_format, retrying without it")
    const retryBody: Record<string, unknown> = {
      model,
      messages: resolvedMessages,
      temperature: typeof temperature === "number" ? temperature : 0.7,
    }
    if (typeof maxTokens === "number" && maxTokens > 0) {
      retryBody.max_tokens = Math.floor(maxTokens)
    }
    const retry = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(retryBody),
    }).catch((e) => ({ ok: false, status: 502, text: async () => String(e) }))
    if (retry.ok) {
      const data = await retry.json().catch(() => null)
      const content = extractContent(data)
      if (content) return json({ content })
      // 降级重试拿到 200 但正文为空：绝不能静默返回 ""（前端只能报「模型未返回内容」，
      // 真实原因永远看不到）。按 400 返回可定位信息，前端立即给出可操作提示。
      return json({ error: emptyContentDetail(data), status: 400 }, 400)
    }
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "")
    let detail = text.slice(0, 500)
    try {
      const j = JSON.parse(text)
      detail = (j?.error?.message ?? j?.error ?? detail) as string
    } catch {
      /* keep raw */
    }
    return json({ error: detail, status: upstream.status }, upstream.status)
  }

  const data = await upstream.json().catch(() => null)
  const content = extractContent(data)
  if (content) return json({ content })
  return json({ error: emptyContentDetail(data), status: 400 }, 400)
})

/** 取上游正文；兼容少数网关把 content 返回成数组（多模态分片）的情形 */
function extractContent(data: any): string {
  const raw = data?.choices?.[0]?.message?.content
  if (typeof raw === "string" && raw.trim()) return raw
  if (Array.isArray(raw)) {
    const joined = raw
      .map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
      .join("")
    if (joined.trim()) return joined
  }
  return ""
}

/**
 * 上游返回 200 但正文为空时的可定位说明。
 * 最常见：推理模型把 max_tokens 全花在 reasoning_content 上；或上游静默截断（finish_reason=length）。
 */
function emptyContentDetail(data: any): string {
  const choice = data?.choices?.[0]
  const finish = choice?.finish_reason
  const reasoning = choice?.message?.reasoning_content
  const parts = ["上游返回了空正文"]
  if (finish) parts.push(`finish_reason=${finish}`)
  if (typeof reasoning === "string" && reasoning.trim()) {
    parts.push(
      "模型只产出了思考内容（reasoning_content），推理把 max_tokens 用光了：请提高 maxTokens 或换用非推理模型",
    )
  }
  const ct = data?.usage?.completion_tokens
  if (typeof ct === "number") parts.push(`completion_tokens=${ct}`)
  return parts.join("；")
}

/** 将公网图片 URL 下载并转为 base64 data URL */
async function fetchUrlToDataURL(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch image: HTTP ${res.status}`)
  const contentType = res.headers.get("content-type") ?? "image/png"
  const buf = await res.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ""
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  const b64 = btoa(binary)
  return `data:${contentType};base64,${b64}`
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}
