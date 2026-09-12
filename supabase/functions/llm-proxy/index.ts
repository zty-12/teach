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
  }
  try {
    payload = await req.json()
  } catch (e) {
    return json({ error: `Invalid JSON body: ${String(e)}` }, 400)
  }

  const { baseUrl, apiKey, model, messages, jsonMode, temperature } = payload
  if (!baseUrl || !apiKey || !model || !Array.isArray(messages) || messages.length === 0) {
    return json({ error: "Missing required field: baseUrl, apiKey, model or messages" }, 400)
  }

  // 拼装上游 URL：兼容 baseUrl 已含 /chat/completions 或未含的情况
  const normalizedBase = baseUrl.replace(/\/+$/, "")
  const upstreamUrl = normalizedBase.endsWith("/chat/completions")
    ? normalizedBase
    : `${normalizedBase}/chat/completions`

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: typeof temperature === "number" ? temperature : 0.7,
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

  // jsonMode 被上游 400 时，降级重试一次
  if (upstream.status === 400 && jsonMode) {
    const retry = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: typeof temperature === "number" ? temperature : 0.7,
      }),
    }).catch((e) => ({ status: 502, text: async () => String(e) }))
    if (retry.ok) {
      const data = await retry.json().catch(() => null)
      const content: string | undefined = data?.choices?.[0]?.message?.content
      return json({ content: content ?? "" })
    }
  }

  const data = await upstream.json().catch(() => null)
  const content: string | undefined = data?.choices?.[0]?.message?.content
  return json({ content: content ?? "" })
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}
