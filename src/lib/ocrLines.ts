/**
 * OCR 结果后处理：把 tesseract 的分块结果压成「文本行」，并滤掉插图/装饰产生的垃圾行。
 *
 * 为什么需要：教材页常有大幅插图，tesseract 会把插图纹理当成文字，吐出一堆
 * `Qe eo @`、`wm Kc | S` 这样的碎片行，混进正文后既污染预览也让 AI 归类跑偏。
 * 这些行有两个稳定特征：**置信度极低** 且 **几乎没有有效字符**。
 *
 * 纯函数、零依赖，可被 Node 直接单测。
 */

export interface OcrLineLike {
  text: string
  confidence: number
}

export interface OcrBlockLike {
  paragraphs?: Array<{ lines?: OcrLineLike[] }> | null
}

/** 低于该置信度的行直接丢弃（实测：正常正文行一般 ≥70，插图噪声行多为 0-37） */
export const OCR_MIN_LINE_CONFIDENCE = 45

const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** 一行里既没汉字也没成词字母，或只剩零星碎片，即视为垃圾行 */
export function isJunkOcrLine(text: string): boolean {
  const s = text.replace(/\s+/g, '')
  if (!s) return true
  let cjk = 0
  let latin = 0
  let digit = 0
  for (const ch of s) {
    if (CJK_CHAR_RE.test(ch)) cjk++
    else if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) latin++
    else if (ch >= '0' && ch <= '9') digit++
  }
  // 完全没有汉字/字母：页码、题号、插图符号都属此类。
  // 但较长的算式（如 "12 + 8 = ?"）要保留，避免误删数学练习。
  if (cjk + latin === 0) return digit === 0 || s.length <= 3
  if (cjk === 0 && latin <= 1 && digit <= 1) return true
  return false
}

export function flattenOcrLines(blocks: OcrBlockLike[] | null | undefined): OcrLineLike[] {
  const out: OcrLineLike[] = []
  for (const b of blocks ?? []) {
    for (const p of b?.paragraphs ?? []) {
      for (const l of p?.lines ?? []) {
        out.push({ text: l?.text ?? '', confidence: Number(l?.confidence) || 0 })
      }
    }
  }
  return out
}

function compactLength(s: string): number {
  return s.replace(/\s+/g, '').length
}

/**
 * 从 tesseract 的结果里挑出可信文本。
 *
 * - 块结构缺失或行数过少 → 不做判断，直接用原始 text（结构不足时乱动更危险）
 * - 过滤后留存过少时：
 *   · 原始行里垃圾行占多数（>50%）→ 判定整页是插图，返回空串（宁可丢这页，也不要把噪声喂给 AI）
 *   · 否则 → 判定是「低质量扫描件」，保留原始 text 兜底，避免整页正文被误删
 */
export function pickOcrText(
  blocks: OcrBlockLike[] | null | undefined,
  rawText: string,
  minConfidence: number = OCR_MIN_LINE_CONFIDENCE,
): string {
  const lines = flattenOcrLines(blocks)
  if (lines.length < 5) return rawText

  const rawLines = rawText.split('\n').map((s) => s.trim()).filter(Boolean)
  const rawJunkShare = rawLines.length ? rawLines.filter(isJunkOcrLine).length / rawLines.length : 1

  const kept = lines.filter((l) => l.confidence >= minConfidence && !isJunkOcrLine(l.text))

  const keptChars = kept.reduce((n, l) => n + compactLength(l.text), 0)
  const allChars = lines.reduce((n, l) => n + compactLength(l.text), 0)

  if (kept.length === 0 || keptChars < 0.2 * allChars) {
    return rawJunkShare > 0.5 ? '' : rawText
  }
  return kept.map((l) => l.text.trim()).filter(Boolean).join('\n')
}
