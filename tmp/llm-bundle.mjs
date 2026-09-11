// src/lib/llm.ts
function isAiConfigured(settings) {
  return settings.aiEnabled === true && Boolean(settings.aiBaseUrl?.trim()) && Boolean(settings.aiApiKey?.trim());
}
var RETRY_DELAYS = [2e3, 5e3, 12e3, 25e3];
var LlmError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "LlmError";
  }
};
async function chat(cfg, messages, jsonMode = false) {
  const doRequest = async (withJson, viaDevProxy = false) => {
    const body = {
      model: cfg.model,
      messages,
      temperature: 0.7
    };
    if (jsonMode && withJson) {
      body.response_format = { type: "json_object" };
    }
    if (cfg.proxyUrl && cfg.proxyToken) {
      return requestViaProxy(cfg, body, withJson);
    }
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`
    };
    const base = cfg.baseUrl.trim().replace(/\/+$/, "");
    const endpoint = `${base}/chat/completions`;
    const url = viaDevProxy ? `/_llm-proxy/${encodeURIComponent(endpoint)}` : endpoint;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      });
    } catch (e) {
      if (!viaDevProxy && typeof window !== "undefined") {
        return doRequest(withJson, true);
      }
      throw new LlmError(`\u7F51\u7EDC\u9519\u8BEF\uFF1A${String(e)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        detail = j?.error?.message ?? j?.error ?? detail;
      } catch {
      }
      return { ok: false, status: res.status, detail };
    }
    const data = await res.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    return { ok: true, content: content ?? "" };
  };
  let useJson = true;
  let last = null;
  let retries = 0;
  for (; ; ) {
    const r = await doRequest(useJson);
    if (r.ok) {
      if (!r.content) throw new LlmError("\u6A21\u578B\u672A\u8FD4\u56DE\u5185\u5BB9");
      return r.content;
    }
    last = r;
    if (useJson && jsonMode && r.status === 400) {
      useJson = false;
      continue;
    }
    const retriable = r.status === 0 || r.status === 408 || r.status === 429 || r.status >= 500;
    if (!retriable || retries >= RETRY_DELAYS.length) break;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[retries]));
    retries += 1;
  }
  if (!last || last.ok) throw new LlmError("\u672A\u77E5\u9519\u8BEF");
  const hint = last.status === 429 ? `\uFF08\u5DF2\u81EA\u52A8\u91CD\u8BD5 ${retries} \u6B21\u4ECD\u88AB\u9650\u6D41\uFF0C\u8BF7\u7B49 1-2 \u5206\u949F\u518D\u8BD5\uFF1B\u514D\u8D39\u989D\u5EA6 QPS \u5F88\u4F4E\uFF0C\u957F\u6587\u6863\u5EFA\u8BAE\u5206\u6BB5\u5BFC\u5165\uFF09` : last.status === 0 ? `\uFF08\u5DF2\u81EA\u52A8\u91CD\u8BD5 ${retries} \u6B21\uFF0C\u8FDE\u63A5\u88AB\u4E2D\u65AD\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u6216\u7A0D\u540E\u91CD\u8BD5\uFF09` : "";
  throw new LlmError(
    last.status === 0 ? `\u7F51\u7EDC\u9519\u8BEF\uFF1A${last.detail}${hint}` : `API ${last.status}: ${last.detail}${hint}`
  );
}
async function requestViaProxy(cfg, body, withJson) {
  let res;
  try {
    res = await fetch(cfg.proxyUrl.trim(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.proxyToken}`
      },
      body: JSON.stringify({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        messages: body.messages,
        temperature: body.temperature,
        jsonMode: withJson
      })
    });
  } catch (e) {
    return { ok: false, status: 0, detail: `\u7F51\u7EDC\u4E2D\u65AD\uFF1A${String(e)}` };
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.error ?? `Proxy ${res.status}`;
    return { ok: false, status: res.status, detail };
  }
  return { ok: true, content: data?.content ?? "" };
}
function stripCodeFences(s) {
  let t = s.trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  return t.trim();
}
function sliceJsonCandidate(s) {
  const objStart = s.indexOf("{");
  const arrStart = s.indexOf("[");
  let start = -1;
  let close = "";
  if (objStart !== -1 && (arrStart === -1 || objStart <= arrStart)) {
    start = objStart;
    close = "}";
  } else if (arrStart !== -1) {
    start = arrStart;
    close = "]";
  }
  if (start === -1) return s;
  const end = s.lastIndexOf(close);
  return end > start ? s.slice(start, end + 1) : s.slice(start);
}
function repairJsonText(input) {
  let s = input.replace(/^﻿/, "").replace(/[“”„‟]/g, '"').replace(/[‘’‛]/g, "'").replace(/，/g, ",").replace(/：/g, ":");
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) {
        out += c;
        esc = false;
        continue;
      }
      if (c === "\\") {
        out += c;
        esc = true;
        continue;
      }
      if (c === '"') {
        inStr = false;
        out += c;
        continue;
      }
      if (c === "\n") {
        out += "\\n";
        continue;
      }
      if (c === "\r") {
        out += "\\r";
        continue;
      }
      if (c === "	") {
        out += "\\t";
        continue;
      }
      out += c;
      continue;
    }
    if (c === '"') inStr = true;
    out += c;
  }
  s = out;
  if (inStr) s += '"';
  s = s.replace(/\}\s*(?=\{)/g, "},");
  s = s.replace(/\]\s*(?=\{)/g, "],");
  s = s.replace(/\}\s*\n(\s*")/g, "},\n$1");
  s = s.replace(/\]\s*\n(\s*")/g, "],\n$1");
  s = s.replace(/,(\s*[}\]])/g, "$1");
  let depthObj = 0;
  let depthArr = 0;
  let q = false;
  let qesc = false;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (qesc) qesc = false;
      else if (c === "\\") qesc = true;
      else if (c === '"') q = false;
      continue;
    }
    if (c === '"') q = true;
    else if (c === "{") {
      stack.push("}");
      depthObj++;
    } else if (c === "[") {
      stack.push("]");
      depthArr++;
    } else if (c === "}" && stack[stack.length - 1] === "}") {
      stack.pop();
      depthObj--;
    } else if (c === "]" && stack[stack.length - 1] === "]") {
      stack.pop();
      depthArr--;
    }
  }
  if (!q) for (let i = stack.length - 1; i >= 0; i--) s += stack[i];
  void depthObj;
  void depthArr;
  return s;
}
function extractBalancedObjects(s) {
  const res = [];
  let start = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        res.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return res;
}
function extractJson(raw) {
  const cleaned = stripCodeFences(raw);
  const candidate = sliceJsonCandidate(cleaned);
  const attempts = [cleaned, candidate, repairJsonText(candidate)];
  for (const a of attempts) {
    if (!a) continue;
    try {
      const v = JSON.parse(a);
      if (v && typeof v === "object") return v;
    } catch {
    }
  }
  for (const obj of extractBalancedObjects(candidate)) {
    for (const a of [obj, repairJsonText(obj)]) {
      try {
        const v = JSON.parse(a);
        if (v && typeof v === "object") return v;
      } catch {
      }
    }
  }
  throw new LlmError("AI \u8FD4\u56DE\u4E0D\u662F\u6709\u6548\u7684 JSON\uFF08\u5DF2\u5C1D\u8BD5\u81EA\u52A8\u4FEE\u590D\uFF0C\u4ECD\u5931\u8D25\uFF09");
}
function buildFeedbackPrompt(course, who) {
  const subject = course.subject || "\u672C\u95E8\u8BFE\u7A0B";
  const time = new Date(course.startAt).toLocaleString("zh-CN", {
    timeZone: localStorage.getItem("ew-timezone") ?? void 0
  });
  return [
    {
      role: "system",
      content: '\u4F60\u662F\u4E00\u540D\u4E13\u4E1A\u7684\u8BFE\u5916\u8F85\u5BFC\u8001\u5E08\u3002\u8BF7\u6839\u636E\u4EE5\u4E0B\u8BFE\u7A0B\u4FE1\u606F\uFF0C\u751F\u6210\u4E00\u4EFD\u7ED9\u5BB6\u957F\u7684\u8BFE\u540E\u53CD\u9988\u3002\u5FC5\u987B\u4E14\u4EC5\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u4E0D\u8981\u8F93\u51FA\u4EFB\u4F55\u5176\u5B83\u6587\u5B57\u3002JSON \u7ED3\u6784\uFF1A{"summary":"\u4E00\u53E5\u8BDD\u6458\u8981\uFF08\u4E0D\u8D85\u8FC740\u5B57\uFF0C\u6982\u62EC\u672C\u8282\u8BFE\u91CD\u70B9\u6216\u5B66\u751F\u8868\u73B0\uFF09","content":"\u8BE6\u7EC6\u8BFE\u540E\u53CD\u9988\uFF08150-220\u5B57\uFF0C\u52063-4\u4E2A\u65B9\u9762\u7684\u77ED\u6BB5\u843D\uFF0C\u7528\u6E05\u6670\u7684\u5C0F\u6807\u9898\uFF0C\u63AA\u8F9E\u79EF\u6781\u5177\u4F53\u3001\u6709\u53EF\u64CD\u4F5C\u5EFA\u8BAE\uFF09"}'
    },
    {
      role: "user",
      content: `\u8BFE\u7A0B\u4FE1\u606F\uFF1A
- \u5BF9\u8C61\uFF1A${who}
- \u79D1\u76EE\uFF1A${subject}
- \u4E0A\u8BFE\u65F6\u95F4\uFF1A${time}
- \u8BFE\u7A0B\u72B6\u6001\uFF1A\u5DF2\u5B8C\u6210
${course.note ? `- \u5907\u6CE8\uFF1A${course.note}` : "- \u5907\u6CE8\uFF1A\uFF08\u65E0\uFF0C\u8BF7\u57FA\u4E8E\u5E38\u89C1\u8F85\u5BFC\u573A\u666F\u5408\u7406\u9ED8\u8BA4\uFF09\n\u8BF7\u57FA\u4E8E\u4EE5\u4E0A\u4FE1\u606F\u751F\u6210\u4E00\u4EFD\u4E13\u4E1A\u3001\u5177\u4F53\u3001\u53EF\u8BFB\u7684\u8BFE\u540E\u53CD\u9988\u3002"}`
    }
  ];
}
async function generateFeedback(settings, course, who) {
  const messages = buildFeedbackPrompt(course, who);
  const raw = await chat(cfgFrom(settings), messages, true);
  const parsed = extractJson(raw);
  return {
    summary: (parsed.summary ?? "").trim(),
    content: (parsed.content ?? "").trim()
  };
}
function buildReportPrompt(input) {
  const fmt = (t) => new Date(t).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
  const feedbackList = input.feedbackSummaries.length > 0 ? input.feedbackSummaries.map((s, i) => `${i + 1}. ${s}`).join("\n") : "\uFF08\u672C\u5468\u671F\u5185\u6682\u65E0\u8BFE\u540E\u53CD\u9988\u8BB0\u5F55\uFF0C\u8BF7\u57FA\u4E8E\u6709\u9650\u4FE1\u606F\u64B0\u5199\uFF0C\u4E0D\u8981\u7F16\u9020\u5177\u4F53\u4E8B\u4EF6\uFF09";
  const checkInList = input.checkInNotes.length > 0 ? input.checkInNotes.map((n) => {
    const date = new Date(n.dayAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
    const parts = [`${date} \u6253\u5361\u5907\u6CE8\uFF1A${n.note}`];
    if (n.aiFeedback) parts.push(`  \xB7 \u6559\u5E08\u89C2\u5BDF\uFF1A${n.aiFeedback}`);
    return parts.join("\n");
  }).join("\n") : "\uFF08\u672C\u5468\u671F\u5185\u6682\u65E0\u6253\u5361\u5907\u6CE8\uFF09";
  return [
    {
      role: "system",
      content: '\u4F60\u662F\u4E00\u540D\u4E13\u4E1A\u7684\u8BFE\u5916\u8F85\u5BFC\u8001\u5E08\uFF0C\u9700\u8981\u4E3A\u5BB6\u957F\u64B0\u5199\u9636\u6BB5\u6027\u5B66\u4E60\u62A5\u544A\u3002\u5FC5\u987B\u4E14\u4EC5\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u4E0D\u8981\u8F93\u51FA\u4EFB\u4F55\u5176\u5B83\u6587\u5B57\u3002JSON \u7ED3\u6784\uFF1A{"title":"\u62A5\u544A\u6807\u9898\uFF08\u4E0D\u8D85\u8FC720\u5B57\uFF0C\u542B\u5B66\u751F\u540D\u4E0E\u9636\u6BB5\uFF0C\u5982\u300C\u5C0F\u660E 9\u6708\u5B66\u4E60\u62A5\u544A\u300D\uFF09","content":"\u62A5\u544A\u6B63\u6587\uFF08Markdown \u683C\u5F0F\uFF0C300-450\u5B57\uFF0C\u5305\u542B\uFF1A\u5B66\u4E60\u6982\u89C8\u3001\u638C\u63E1\u60C5\u51B5\u3001\u5F85\u6539\u8FDB\u70B9\u3001\u4E0B\u9636\u6BB5\u5EFA\u8BAE \u56DB\u4E2A\u4E8C\u7EA7\u6807\u9898\u5C0F\u8282\uFF0C\u8BED\u6C14\u5BA2\u89C2\u5177\u4F53\u3001\u6709\u53EF\u6267\u884C\u7684\u5EFA\u8BAE\uFF09"}'
    },
    {
      role: "user",
      content: `\u8BF7\u4E3A\u4EE5\u4E0B\u5B66\u751F\u751F\u6210\u672C\u9636\u6BB5\u5B66\u4E60\u62A5\u544A\uFF1A

- \u5B66\u751F\uFF1A${input.studentName}${input.grade ? `\uFF08${input.grade}\uFF09` : ""}
- \u7EDF\u8BA1\u5468\u671F\uFF1A${fmt(input.periodStart)} \u81F3 ${fmt(input.periodEnd)}
- \u8BFE\u65F6\uFF1A\u5DF2\u5B8C\u6210 ${input.doneCount} \u8282 / \u5171\u6392 ${input.totalCount} \u8282
- \u6D89\u53CA\u79D1\u76EE\uFF1A${input.subjects.length > 0 ? input.subjects.join("\u3001") : "\u672A\u8BB0\u5F55"}
- \u5B66\u4E60\u6807\u7B7E\uFF1A${input.tags.length > 0 ? input.tags.join("\u3001") : "\u6682\u65E0"}
- \u672C\u5468\u671F\u8BFE\u540E\u53CD\u9988\u6458\u8981\uFF1A
${feedbackList}
- \u672C\u5468\u671F\u6253\u5361\u5907\u6CE8\uFF08\u542B\u89C6\u9891\u89C2\u5BDF\uFF09\uFF1A
${checkInList}

\u8BF7\u57FA\u4E8E\u4EE5\u4E0A\u771F\u5B9E\u7D20\u6750\u64B0\u5199\uFF0C\u4E0D\u8981\u7F16\u9020\u672A\u63D0\u53CA\u7684\u4E8B\u5B9E\u3002`
    }
  ];
}
async function generateReport(settings, input) {
  const raw = await chat(cfgFrom(settings), buildReportPrompt(input), true);
  const parsed = extractJson(raw);
  return {
    title: (parsed.title ?? "").trim(),
    content: (parsed.content ?? "").trim()
  };
}
async function testLlm(settings) {
  const cfg = cfgFromSettings(settings);
  const raw = await chat(cfg, [
    { role: "user", content: '\u8BF7\u53EA\u56DE\u590D"OK"\u4E24\u4E2A\u5B57\u6BCD\u3002' }
  ]);
  return raw.trim().slice(0, 120) || "OK";
}
function cfgFrom(settings) {
  const cfg = {
    baseUrl: settings.aiBaseUrl,
    apiKey: settings.aiApiKey,
    model: settings.aiModel.trim() || "gpt-4o-mini"
  };
  if (settings.aiProxyMode === "proxy" && settings.aiProxyUrl && settings.aiProxyToken) {
    cfg.proxyUrl = settings.aiProxyUrl;
    cfg.proxyToken = settings.aiProxyToken;
  }
  return cfg;
}
function cfgFromSettings(settings) {
  return cfgFrom(settings);
}
async function summarizeKnowledgePoint(settings, input) {
  const messages = [
    {
      role: "system",
      content: '\u4F60\u662F\u4E00\u540D\u8D44\u6DF1\u6559\u7814\u8001\u5E08\uFF0C\u8D1F\u8D23\u628A\u6559\u6750\u77E5\u8BC6\u70B9\u68B3\u7406\u6210\u53EF\u590D\u7528\u7684\u6559\u5B66\u8981\u70B9\u3002\u5FC5\u987B\u4E14\u4EC5\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u4E0D\u8981\u8F93\u51FA\u4EFB\u4F55\u5176\u5B83\u6587\u5B57\u3002JSON \u7ED3\u6784\uFF1A{"gist":"\u4E00\u53E5\u8BDD\u5B9A\u4F4D\u8FD9\u4E2A\u77E5\u8BC6\u70B9\uFF08\u4E0D\u8D85\u8FC740\u5B57\uFF09","keyPoints":["\u6838\u5FC3\u8981\u70B91","\u6838\u5FC3\u8981\u70B92","\u6838\u5FC3\u8981\u70B93"],"pitfalls":["\u5E38\u89C1\u6613\u9519\u70B91","\u5E38\u89C1\u6613\u9519\u70B92"]}'
    },
    {
      role: "user",
      content: `\u8BF7\u628A\u4E0B\u9762\u8FD9\u4E2A\u77E5\u8BC6\u70B9\u68B3\u7406\u6210\u6559\u5B66\u8981\u70B9\uFF1A

- \u6559\u6750\uFF1A${input.textbookName || "\uFF08\u672A\u6307\u5B9A\uFF09"}
- \u5355\u5143\uFF1A${input.unitName || "\uFF08\u672A\u6307\u5B9A\uFF09"}
- \u79D1\u76EE\uFF1A${input.subject || "\uFF08\u672A\u6307\u5B9A\uFF09"}
- \u6807\u9898\uFF1A${input.title}
- \u539F\u59CB\u5185\u5BB9\uFF1A
${input.content || "\uFF08\u8001\u5E08\u672A\u586B\u5199\u5185\u5BB9\uFF0C\u8BF7\u4EC5\u6839\u636E\u6807\u9898\u4E0E\u79D1\u76EE\u505A\u5408\u7406\u68B3\u7406\uFF0C\u5E76\u660E\u786E\u6807\u6CE8\u8FD9\u662F\u57FA\u4E8E\u6807\u9898\u7684\u63A8\u65AD\uFF09"}

\u8981\u6C42\uFF1A
1. keyPoints 3-6 \u6761\uFF0C\u6BCF\u6761\u4E0D\u8D85\u8FC7 30 \u5B57\uFF0C\u5177\u4F53\u53EF\u6559\u5B66\u3001\u53EF\u76F4\u63A5\u7528\u4E8E\u5907\u8BFE\u6216\u8BFE\u540E\u53CD\u9988\uFF1B
2. pitfalls 2-4 \u6761\uFF0C\u5199\u5B66\u751F\u5728\u8FD9\u4E2A\u77E5\u8BC6\u70B9\u4E0A\u5E38\u89C1\u7684\u9519\u8BEF\u6216\u6DF7\u6DC6\u70B9\uFF1B
3. \u4E0D\u8981\u7F16\u9020\u4E0E\u6807\u9898\u5B8C\u5168\u65E0\u5173\u7684\u5185\u5BB9\uFF1B\u539F\u59CB\u5185\u5BB9\u4E3A\u7A7A\u65F6\u8BF7\u5728 gist \u91CC\u8BF4\u660E"\u63A8\u65AD"\u3002`
    }
  ];
  const raw = await chat(cfgFrom(settings), messages, true);
  const parsed = extractJson(raw);
  return {
    gist: (parsed.gist ?? "").trim(),
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.map((s) => String(s).trim()).filter(Boolean) : [],
    pitfalls: Array.isArray(parsed.pitfalls) ? parsed.pitfalls.map((s) => String(s).trim()).filter(Boolean) : []
  };
}
function renderKnowledgeSummary(s) {
  const parts = [];
  if (s.gist) parts.push(s.gist);
  if (s.keyPoints.length > 0) {
    parts.push("\u6838\u5FC3\u8981\u70B9\uFF1A\n" + s.keyPoints.map((k, i) => `${i + 1}. ${k}`).join("\n"));
  }
  if (s.pitfalls.length > 0) {
    parts.push("\u6613\u9519\u70B9\uFF1A\n" + s.pitfalls.map((k, i) => `${i + 1}. ${k}`).join("\n"));
  }
  return parts.join("\n\n");
}
async function recommendKnowledgePoints(settings, ctx, candidates, limit = 6) {
  if (candidates.length === 0) return [];
  const list = candidates.map((c, i) => `${i + 1}. [id=${c.id}] ${c.path} / ${c.title}${c.summary ? ` \u2014 ${c.summary.slice(0, 60)}` : ""}`).join("\n");
  const messages = [
    {
      role: "system",
      content: '\u4F60\u662F\u4E00\u540D\u8BFE\u5916\u8F85\u5BFC\u8001\u5E08\uFF0C\u6B63\u5728\u4E3A\u4E00\u6B21\u521A\u4E0A\u5B8C\u7684\u8BFE\u6311\u9009\u300C\u672C\u6B21\u8986\u76D6\u7684\u77E5\u8BC6\u70B9\u300D\u3002\u5FC5\u987B\u4E14\u4EC5\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF1A{"ids":["<\u5019\u9009\u91CC\u7684 id>","<\u5019\u9009\u91CC\u7684 id>"]}\u3002\u53EA\u80FD\u4ECE\u5019\u9009\u5217\u8868\u91CC\u9009 id\uFF0C\u4E0D\u8981\u521B\u9020\u65B0 id\uFF1B\u4E0D\u786E\u5B9A\u65F6\u5B81\u53EF\u5C11\u9009\u3002'
    },
    {
      role: "user",
      content: `\u672C\u6B21\u8BFE\u7A0B\u4FE1\u606F\uFF1A
- \u5BF9\u8C61\uFF1A${ctx.who}
- \u79D1\u76EE\uFF1A${ctx.subject}
- \u4E0A\u8BFE\u65F6\u95F4\uFF1A${ctx.timeText}
- \u8BFE\u7A0B\u5907\u6CE8\uFF1A${ctx.note || "\uFF08\u65E0\uFF09"}
${ctx.recentFeedbacks.length > 0 ? `- \u6700\u8FD1\u51E0\u6B21\u8BFE\u7684\u53CD\u9988\u6458\u8981\uFF1A
${ctx.recentFeedbacks.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}` : "- \u6700\u8FD1\u51E0\u6B21\u8BFE\u7684\u53CD\u9988\u6458\u8981\uFF1A\uFF08\u6682\u65E0\uFF09"}

\u53EF\u5019\u9009\u7684\u77E5\u8BC6\u70B9\uFF08\u5171 ${candidates.length} \u4E2A\uFF09\uFF1A
${list}

\u8BF7\u9009\u51FA\u672C\u6B21\u8BFE\u6700\u53EF\u80FD\u8986\u76D6\u7684\uFF0C\u6700\u591A ${limit} \u4E2A\uFF0C\u6309\u53EF\u80FD\u6027\u4ECE\u9AD8\u5230\u4F4E\u6392\u5217\u3002`
    }
  ];
  const raw = await chat(cfgFrom(settings), messages, true);
  const parsed = extractJson(raw);
  const ids = Array.isArray(parsed.ids) ? parsed.ids.map(String) : [];
  const valid = new Set(candidates.map((c) => c.id));
  return ids.filter((id) => valid.has(id)).slice(0, limit);
}
async function generateFeedbackWithTemplate(settings, input) {
  const knowledgeText = input.knowledges.length > 0 ? input.knowledges.map(
    (k, i) => `${i + 1}. ${k.title}${k.path ? `\uFF08${k.path}\uFF09` : ""}${k.summary ? `
   \u8981\u70B9\uFF1A${k.summary.replace(/\n/g, " ").slice(0, 200)}` : ""}`
  ).join("\n") : "\uFF08\u672C\u6B21\u672A\u52FE\u9009\u77E5\u8BC6\u70B9\uFF0C\u8BF7\u6839\u636E\u79D1\u76EE\u4E0E\u5907\u6CE8\u5408\u7406\u63A8\u65AD\u672C\u6B21\u53EF\u80FD\u7684\u6559\u5B66\u5185\u5BB9\uFF0C\u5E76\u5728\u6587\u4E2D\u8BF4\u660E\u8FD9\u662F\u57FA\u4E8E\u6709\u9650\u4FE1\u606F\u7684\u63CF\u8FF0\uFF09";
  const messages = [
    {
      role: "system",
      content: '\u4F60\u662F\u4E00\u540D\u4E13\u4E1A\u7684\u8BFE\u5916\u8F85\u5BFC\u8001\u5E08\uFF0C\u9700\u8981\u6309\u300C\u8001\u5E08\u7ED9\u5B9A\u7684\u53CD\u9988\u6A21\u677F\u300D\u64B0\u5199\u8BFE\u540E\u53CD\u9988\u3002\u4E25\u683C\u8981\u6C42\uFF1A\n1. \u5FC5\u987B\u4FDD\u7559\u6A21\u677F\u7684\u6240\u6709\u5C0F\u8282\u6807\u9898\uFF08\u3010\u3011\u62EC\u8D77\u6765\u7684\u90E8\u5206\uFF09\u4E0E\u6574\u4F53\u7ED3\u6784\uFF1B\n2. \u53EA\u628A\u6A21\u677F\u4E2D\u62EC\u53F7\u5360\u4F4D\u7B26\uFF08\u5982\u300C\uFF08...\uFF09\u300D\u91CC\u7684\u63D0\u793A\u6027\u6587\u5B57\uFF09\u66FF\u6362\u6210\u771F\u5B9E\u3001\u5177\u4F53\u7684\u5185\u5BB9\uFF1B\n3. \u63AA\u8F9E\u5177\u4F53\u3001\u79EF\u6781\u3001\u6709\u53EF\u6267\u884C\u5EFA\u8BAE\uFF0C\u907F\u514D\u7A7A\u8BDD\uFF1B\n4. \u5FC5\u987B\u4E14\u4EC5\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF1A{"summary":"\u4E00\u53E5\u8BDD\u6458\u8981\uFF08\u4E0D\u8D85\u8FC740\u5B57\uFF09","content":"\u6309\u6A21\u677F\u7ED3\u6784\u5199\u597D\u7684\u5B8C\u6574\u53CD\u9988\u6B63\u6587"}\u3002'
    },
    {
      role: "user",
      content: `\u3010\u53CD\u9988\u6A21\u677F\u3011
${input.templateBody}

\u3010\u672C\u6B21\u8BFE\u7A0B\u4FE1\u606F\u3011
- \u5BF9\u8C61\uFF1A${input.ctx.who}
- \u79D1\u76EE\uFF1A${input.ctx.subject}
- \u4E0A\u8BFE\u65F6\u95F4\uFF1A${input.ctx.timeText}
- \u8BFE\u7A0B\u65F6\u957F\uFF1A${input.durationMin} \u5206\u949F
- \u8BFE\u7A0B\u5907\u6CE8\uFF1A${input.ctx.note || "\uFF08\u65E0\uFF09"}

\u3010\u672C\u6B21\u8986\u76D6\u7684\u77E5\u8BC6\u70B9\u3011
${knowledgeText}
${input.ctx.recentFeedbacks.length > 0 ? `
\u3010\u6700\u8FD1\u51E0\u6B21\u8BFE\u7684\u53CD\u9988\u6458\u8981\uFF08\u7528\u4E8E\u4FDD\u6301\u8FDE\u8D2F\u3001\u907F\u514D\u91CD\u590D\u8868\u8FF0\uFF09\u3011
${input.ctx.recentFeedbacks.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : ""}

\u8BF7\u4E25\u683C\u6309\u3010\u53CD\u9988\u6A21\u677F\u3011\u7684\u7ED3\u6784\u8F93\u51FA content\uFF0C\u5E76\u628A\u672C\u6B21\u77E5\u8BC6\u70B9\u81EA\u7136\u5730\u5199\u8FDB\u53BB\u3002`
    }
  ];
  const raw = await chat(cfgFrom(settings), messages, true);
  const parsed = extractJson(raw);
  return {
    summary: (parsed.summary ?? "").trim(),
    content: (parsed.content ?? "").trim()
  };
}
var LLM_PRESETS = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { label: "\u901A\u4E49\u5343\u95EE", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { label: "Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { label: "\u667A\u8C31 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" }
];
function snippet(text, n = 6e3) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) : t;
}
function salvageClassification(raw) {
  const unq = (s) => {
    try {
      return JSON.parse(`"${s}"`);
    } catch {
      return s.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
  };
  const grab = (key) => {
    const m2 = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m2 ? unq(m2[1]).trim() : "";
  };
  const toks = [];
  const reUnit = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while (m = reUnit.exec(raw)) {
    toks.push({ i: m.index, kind: "unit", name: unq(m[1]).trim() });
  }
  const rePoint = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  while (m = rePoint.exec(raw)) {
    toks.push({ i: m.index, kind: "point", title: unq(m[1]).trim(), content: unq(m[2]).trim() });
  }
  if (toks.length === 0) return null;
  toks.sort((a, b) => a.i - b.i);
  const units = [];
  let cur = null;
  for (const t of toks) {
    if (t.kind === "unit") {
      if (cur && (cur.name || cur.points.length)) units.push(cur);
      const hit = units.find((u) => u.name === t.name);
      cur = hit ?? { name: t.name || "", points: [] };
      if (hit) cur = hit;
    } else {
      if (!cur) cur = { name: "", points: [] };
      if (t.title) cur.points.push({ title: t.title, content: t.content ?? "" });
    }
  }
  if (cur && (cur.name || cur.points.length)) units.push(cur);
  const merged = [];
  for (const u of units) {
    const hit = merged.find((x) => x.name === u.name);
    if (hit) {
      const seen = new Set(hit.points.map((p) => p.title));
      for (const p of u.points) if (!seen.has(p.title)) hit.points.push(p);
    } else {
      merged.push(u);
    }
  }
  const withPoints = merged.filter((u) => u.points.length > 0 || u.name);
  return {
    textbookName: grab("textbookName"),
    subject: grab("subject"),
    units: withPoints
  };
}
async function classifyTextChunk(settings, docText, fileName, existingList) {
  const messages = [
    {
      role: "system",
      content: '\u4F60\u662F\u4E00\u540D\u8D44\u6DF1\u6559\u7814\u8001\u5E08\uFF0C\u8D1F\u8D23\u628A\u4E00\u4EFD\u6559\u6750/\u8BB2\u4E49/\u8BB2\u4E49\u7B14\u8BB0\u5BFC\u5165\u5230\u77E5\u8BC6\u5E93\u3002\u4F60\u5FC5\u987B\uFF1A\n1. \u901A\u8BFB\u6587\u6863\u5185\u5BB9\uFF0C\u63D0\u70BC\u51FA\u6559\u6750\u540D\uFF08\u82E5\u4E0E\u7ED9\u5B9A\u5DF2\u6709\u6559\u6750\u540C\u540D\u5219\u6CBF\u7528\u5DF2\u6709 name\uFF0C\u5426\u5219\u5EFA\u8BAE\u4E00\u4E2A\u6559\u6750\u540D\uFF09\u3001\u79D1\u76EE\u3001\u7AE0\u8282\u7ED3\u6784\uFF1B\n2. \u628A\u5185\u5BB9\u62C6\u6210\u82E5\u5E72\u300C\u5355\u5143\u300D\u548C\u6BCF\u4E2A\u5355\u5143\u4E0B\u7684\u300C\u77E5\u8BC6\u70B9\u300D\uFF1B\u77E5\u8BC6\u70B9\u8981\u5177\u4F53\u53EF\u5907\u8BFE\uFF08\u4E00\u4E2A\u8BED\u6CD5\u70B9\u3001\u4E00\u7BC7\u8BFE\u6587\u3001\u4E00\u4E2A\u516C\u5F0F\u3001\u4E00\u4E2A\u8003\u70B9\uFF0C\u90FD\u5404\u7B97\u4E00\u6761\uFF09\uFF1B\n3. \u77E5\u8BC6\u70B9 content \u5199\u5165\u8BE5\u77E5\u8BC6\u70B9\u7684\u539F\u59CB\u8981\u70B9\u3001\u516C\u5F0F\u3001\u4F8B\u53E5\u6216\u539F\u6587\u6458\u5F55\uFF08100-250 \u5B57\uFF0C\u6765\u81EA\u539F\u6587\uFF0C\u4E0D\u8981\u51ED\u7A7A\u7F16\u9020\uFF09\uFF1B\n4. \u82E5\u6587\u6863\u5185\u5BB9\u8FC7\u77ED\u6216\u96BE\u4EE5\u5F52\u7C7B\uFF0Cunits \u53EF\u4E3A\u7A7A\u6570\u7EC4\uFF0CtextbookName \u586B\u6587\u6863\u7591\u4F3C\u4E3B\u9898\u3002\n5. JSON \u786C\u6027\u8981\u6C42\uFF08\u5426\u5219\u4F1A\u88AB\u5224\u4E3A\u65E0\u6548\uFF09\uFF1A   (a) content \u91CC\u7981\u6B62\u51FA\u73B0\u82F1\u6587\u53CC\u5F15\u53F7\uFF0C\u9700\u8981\u5F15\u53F7\u65F6\u7528\u300C\u300D\u6216\u5355\u5F15\u53F7\uFF1B\u7981\u6B62\u51FA\u73B0\u771F\u5B9E\u6362\u884C\uFF0C\u8981\u5206\u6BB5\u5C31\u5199 \\n\uFF1B   (b) \u6570\u7EC4\u5143\u7D20\u4E4B\u95F4\u5FC5\u987B\u6709\u82F1\u6587\u9017\u53F7\uFF1B\n   (c) \u6BCF\u4E2A\u5355\u5143\u77E5\u8BC6\u70B9\u4E0D\u8D85\u8FC7 8 \u6761\uFF0C\u5B81\u5C11\u52FF\u591A\uFF0C\u4FDD\u8BC1 JSON \u80FD\u5B8C\u6574\u8F93\u51FA\u4E0D\u88AB\u622A\u65AD\uFF1B\n   (d) \u53EA\u8F93\u51FA JSON \u672C\u8EAB\uFF0C\u4E0D\u8981\u4EFB\u4F55\u89E3\u91CA\u6587\u5B57\u3002\n\u5FC5\u987B\u4E14\u4EC5\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF1A{"textbookName":"\u6559\u6750\u540D","subject":"\u79D1\u76EE\u6216\u7A7A\u4E32","units":[{"name":"\u5355\u5143\u540D","points":[{"title":"\u77E5\u8BC6\u70B9\u6807\u9898","content":"\u8981\u70B9\u5185\u5BB9"}]}]}'
    },
    {
      role: "user",
      content: `\u8BF7\u628A\u4E0B\u9762\u8FD9\u4EFD\u6587\u6863\u5206\u6790\u5E76\u5F52\u7C7B\u4E3A\u77E5\u8BC6\u5E93\u7ED3\u6784\u3002

\u3010\u6587\u6863\u6765\u6E90\u3011
${fileName}

\u3010\u5DF2\u6709\u6559\u6750\uFF08\u5224\u65AD\u662F\u5426\u5E76\u5165\uFF09\u3011
${existingList}

\u3010\u6587\u6863\u5168\u6587\uFF08\u5DF2\u622A\u65AD\uFF09\u3011
${snippet(docText)}

\u8981\u6C42\uFF1A\u5355\u5143 order \u4ECE 1 \u5F00\u59CB\uFF1B\u6BCF\u4E2A\u5355\u5143\u77E5\u8BC6\u70B9\u6700\u591A 8 \u6761\uFF1B\u5C3D\u91CF\u5FE0\u5B9E\u4E8E\u539F\u6587\uFF1B\u8F93\u51FA\u5FC5\u987B\u662F\u5B8C\u6574\u53EF\u89E3\u6790\u7684 JSON\u3002`
    }
  ];
  const raw = await chat(cfgFrom(settings), messages, true);
  let parsed;
  try {
    parsed = extractJson(raw);
  } catch {
    const salvaged = salvageClassification(raw);
    if (!salvaged || salvaged.units.length === 0) {
      throw new LlmError("AI \u8FD4\u56DE\u5185\u5BB9\u65E0\u6CD5\u89E3\u6790\u4E3A JSON\uFF08\u5DF2\u81EA\u52A8\u5C1D\u8BD5\u4FEE\u590D\uFF09\u3002\u8BF7\u91CD\u8BD5\u4E00\u6B21\uFF0C\u6216\u6362\u7528\u8F93\u51FA\u66F4\u7A33\u5B9A\u7684\u6A21\u578B\u3002");
    }
    parsed = salvaged;
  }
  const units = Array.isArray(parsed.units) ? parsed.units.map((u) => ({
    name: String(u?.name ?? "").trim(),
    points: Array.isArray(u.points) ? u.points.map((p) => ({
      title: String(p?.title ?? "").trim(),
      content: String(p?.content ?? "").trim()
    })).filter((p) => p.title) : []
  })).filter((u) => u.name || u.points.length > 0) : [];
  return {
    textbookName: String(parsed.textbookName ?? "").trim(),
    subject: String(parsed.subject ?? "").trim(),
    units
  };
}
function mergeClassification(base, next) {
  if (!base.textbookName && next.textbookName) base.textbookName = next.textbookName;
  if (!base.subject && next.subject) base.subject = next.subject;
  for (const u of next.units) {
    const hit = base.units.find((x) => x.name === u.name);
    if (hit) {
      const seen = new Set(hit.points.map((p) => p.title));
      for (const p of u.points) if (!seen.has(p.title)) hit.points.push(p);
    } else {
      base.units.push(u);
    }
  }
}
var CLASSIFY_CHUNK_CHARS = 6e3;
var CLASSIFY_CHUNK_OVERLAP = 300;
async function classifyImportedDocument(settings, docText, fileName, existingTextbooks) {
  const existingList = existingTextbooks.length > 0 ? existingTextbooks.map((t, i) => `${i + 1}. ${t.name}${t.subject ? `\uFF08${t.subject}\uFF09` : ""}`).join("\n") : "\uFF08\u77E5\u8BC6\u5E93\u4E3A\u7A7A\uFF09";
  const clean = docText.replace(/\s+/g, " ").trim();
  if (clean.length <= CLASSIFY_CHUNK_CHARS) {
    return classifyTextChunk(settings, clean, fileName, existingList);
  }
  const step = CLASSIFY_CHUNK_CHARS - CLASSIFY_CHUNK_OVERLAP;
  const chunks = [];
  for (let i = 0; i < clean.length; i += step) {
    chunks.push(clean.slice(i, i + CLASSIFY_CHUNK_CHARS));
    if (chunks.length >= 20) break;
  }
  let merged = null;
  let failures = 0;
  let lastErr = null;
  for (let i = 0; i < chunks.length; i++) {
    try {
      const part = await classifyTextChunk(settings, chunks[i], fileName, existingList);
      if (!merged) {
        merged = part;
      } else {
        mergeClassification(merged, part);
      }
      failures = 0;
    } catch (e) {
      failures += 1;
      lastErr = e;
      console.warn(`[llm] \u7B2C ${i + 1}/${chunks.length} \u5757\u5F52\u7C7B\u5931\u8D25\uFF1A`, e);
      if (failures >= 3 && merged) break;
    }
    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, failures > 0 ? 6e3 : 3e3));
    }
  }
  if (!merged && lastErr) throw lastErr;
  return merged ?? { textbookName: "", subject: "", units: [] };
}
async function summarizeImportedPoint(settings, title, content) {
  const messages = [
    {
      role: "system",
      content: "\u4F60\u662F\u6559\u7814\u8001\u5E08\u3002\u8BF7\u628A\u4E0B\u9762\u8FD9\u4E2A\u77E5\u8BC6\u70B9\u6574\u7406\u6210\u4E00\u6BB5\u7ED3\u6784\u5316\u6458\u8981\uFF08\u4E00\u53E5\u8BDD\u5B9A\u4F4D + 3-5 \u6761\u8981\u70B9 + \u5E38\u89C1\u6613\u9519\u70B9\uFF09\uFF0C\u76F4\u63A5\u8F93\u51FA Markdown \u6587\u672C\uFF0C\u4E0D\u8981\u8F93\u51FA JSON \u6216\u5176\u5B83\u8BF4\u660E\u3002"
    },
    {
      role: "user",
      content: `\u77E5\u8BC6\u70B9\u6807\u9898\uFF1A${title}
\u539F\u59CB\u8981\u70B9\uFF1A
${snippet(content, 2e3)}

\u8BF7\u6574\u7406\u6210\u53EF\u590D\u7528\u6458\u8981\u3002`
    }
  ];
  const raw = await chat(cfgFrom(settings), messages, false);
  return raw.trim();
}
async function generateCheckInFeedback(settings, note, studentName, profile) {
  const profileBlock = profile && (profile.summary || profile.strengths || profile.weaknesses || profile.teachingStyle) ? `
\u3010\u8BE5\u5B66\u5458\u5386\u53F2\u753B\u50CF\uFF08AI \u4ECE\u8FC7\u5F80\u6253\u5361\u53CD\u9988\u6C47\u603B\uFF09\u3011
- \u7EFC\u5408\u7279\u5F81\uFF1A${profile.summary || "\uFF08\u6682\u65E0\uFF09"}
- \u4F18\u52BF\u4EAE\u70B9\uFF1A${profile.strengths || "\uFF08\u6682\u65E0\uFF09"}
- \u5F85\u6539\u8FDB\u70B9\uFF1A${profile.weaknesses || "\uFF08\u6682\u65E0\uFF09"}
- \u63A8\u8350\u6559\u5B66\u65B9\u5F0F\uFF1A${profile.teachingStyle || "\uFF08\u6682\u65E0\uFF09"}
- \u753B\u50CF\u57FA\u4E8E ${profile.sourceCount} \u6761\u5386\u53F2\u7D20\u6750\uFF08\u66F4\u65B0\u4E8E ${new Date(profile.profileUpdatedAt).toLocaleDateString("zh-CN")}\uFF09

\u8BF7\u7ED3\u5408\u4EE5\u4E0A\u753B\u50CF\u64B0\u5199\u4E2A\u6027\u5316\u53CD\u9988\uFF1A
1) \u547C\u5E94\u753B\u50CF\u4E2D\u8BE5\u5B66\u5458\u7684\u56FA\u6709\u7279\u70B9\uFF08\u6027\u683C / \u5B66\u4E60\u8282\u594F / \u5E38\u89C1\u8868\u73B0\uFF09\uFF0C\u907F\u514D\u91CD\u590D\u5DF2\u7ECF\u7ED9\u8FC7\u7684\u5EFA\u8BAE\uFF1B
2) \u82E5\u753B\u50CF\u663E\u793A\u67D0\u4E2A\u4F18\u70B9\uFF0C\u672C\u6B21\u4E5F\u8868\u73B0\u597D\uFF0C\u53EF\u5728\u53CD\u9988\u91CC\u70B9\u540D\u80AF\u5B9A\uFF1B
3) \u82E5\u753B\u50CF\u663E\u793A\u67D0\u4E2A\u5F31\u70B9\uFF0C\u672C\u6B21\u4ECD\u672A\u89E3\u51B3\uFF0C\u53EF\u4EE5\u6E29\u548C\u590D\u8FF0\u5E76\u7ED9\u51FA\u65B0\u7684\u5207\u5165\u65B9\u5F0F\uFF1B
4) \u82E5\u753B\u50CF\u4E0E\u672C\u6B21\u8868\u73B0\u4E0D\u7B26\uFF0C\u4EE5\u672C\u6B21\u8868\u73B0\u4E3A\u51C6\uFF0C\u753B\u50CF\u53EA\u4F5C\u53C2\u8003\u3002` : "";
  const messages = [
    {
      role: "system",
      content: "\u4F60\u662F\u4E00\u4F4D\u8D44\u6DF1\u5B66\u79D1\u6559\u5E08\u3002\u6839\u636E\u8001\u5E08\u5BF9\u5B66\u5458\u6253\u5361\u89C6\u9891\u7684\u7B80\u77ED\u8BB0\u5F55\uFF0C\u751F\u6210\u4E00\u6BB5\u9762\u5411\u5BB6\u957F\u7684\u81EA\u7136\u3001\u6E29\u6696\u3001\u5177\u4F53\u7684\u53CD\u9988\u3002\u8981\u6C42\uFF1A1) \u8BED\u6C14\u4EB2\u5207\u4F46\u4E13\u4E1A\uFF1B2) \u5148\u80AF\u5B9A\u8868\u73B0\uFF0C\u518D\u6307\u51FA\u53EF\u6539\u8FDB\u70B9\uFF08\u5982\u6709\uFF09\uFF1B3) \u7ED9\u51FA 1-2 \u6761\u53EF\u64CD\u4F5C\u7684\u5BB6\u5EAD\u7EC3\u4E60\u5EFA\u8BAE\uFF1B4) 200 \u5B57\u4EE5\u5185\uFF1B5) \u76F4\u63A5\u8F93\u51FA\u53CD\u9988\u6B63\u6587\uFF0C\u4E0D\u8981\u52A0\u6807\u9898\u6216\u524D\u7F00\u3002" + (profileBlock ? '\u6CE8\u610F\uFF1A\u672C\u6B21\u53CD\u9988\u5FC5\u987B\u7ED3\u5408\u3010\u5B66\u5458\u5386\u53F2\u753B\u50CF\u3011\u505A\u4E2A\u6027\u5316\u5904\u7406\uFF0C\u907F\u514D"\u6BCF\u6B21\u53CD\u9988\u90FD\u957F\u5F97\u4E00\u6837"\u3002' : "")
    },
    {
      role: "user",
      content: `\u5B66\u5458\uFF1A${studentName ?? "\u5B66\u751F"}
\u8001\u5E08\u89C2\u5BDF\u8BB0\u5F55\uFF1A${note}
${profileBlock}`
    }
  ];
  const raw = await chat(cfgFrom(settings), messages, false);
  return raw.trim();
}
export {
  LLM_PRESETS,
  LlmError,
  cfgFromSettings,
  chat,
  classifyImportedDocument,
  extractJson,
  generateCheckInFeedback,
  generateFeedback,
  generateFeedbackWithTemplate,
  generateReport,
  isAiConfigured,
  recommendKnowledgePoints,
  renderKnowledgeSummary,
  summarizeImportedPoint,
  summarizeKnowledgePoint,
  testLlm
};
