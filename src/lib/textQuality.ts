/**
 * 文本质量评估：判断「提取出来的文字」到底是不是人话。
 *
 * 背景（图片型 PDF / 扫描件的两种典型失败）：
 *   1) 文本层为空         → 走 OCR 兜底（fileImport 已有逻辑）；
 *   2) 文本层「有字但全是乱码」→ 字数检查会误判为「提取成功」，
 *      用户拿到的是 `Qe eo @ wm Kc | S eg \ ay o o` 这种字，而 OCR 根本没被触发。
 *      成因：PDF 嵌入字体缺 ToUnicode 映射、或带了一个错误的隐藏 OCR 层。
 *
 * 这里给出一个不依赖词典、纯统计的判据，供调用方决定「是否再走一次 OCR 并择优」。
 * 该模块零依赖，可被 Node 直接单测。
 */

export interface TextQuality {
  /** 0~1，越高越像自然语言 */
  score: number
  /** 是否判定为「疑似乱码 / 不可用」 */
  suspicious: boolean
  /** 汉字占非空白字符的比例 */
  cjkRatio: number
  /** 异常符号（@ | \ ® ° 之类）占非空白字符的比例 */
  noiseRatio: number
  /** 非空白字符数 */
  chars: number
  /** 判定依据（用于日志与界面提示；空串表示未发现问题） */
  reason: string
}

/** 汉字（含扩展 A 区与兼容区） */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g
const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const LATIN_TOKEN_RE = /[A-Za-z]{2,}/g

/**
 * 自然文本里会正常出现的标点，不计入「异常符号」。
 * 注意刻意不含 @ | \ ^ ` ~ ® © ° —— 这些在乱码里高频出现。
 */
const OK_PUNCT = new Set(
  `，。、；：！？（）《》【】「」『』“”‘’—…·,.!?;:()[]{}%+-*/=&<>#$€¥£№'"`.split(''),
)

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re)
  return m ? m.length : 0
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * 评估一段提取文本的「可读性」。
 *
 * 判据是两条互相独立的信号（任一条成立即判为可疑），都只在「几乎没有汉字」或
 * 「异常符号泛滥」时触发，因此对正常的中文/英文文本几乎不会误报：
 *   A. 异常符号占比 > 6% 且汉字占比 < 20%
 *   B. 无汉字、词数 ≥ 40，且 **同时** 满足「长度 ≥ 5 的完整单词占比 < 10%」
 *      与「1-2 字符碎片占比 > 50%」——真实英文（哪怕满是 cat/hat/sat 这类短词）
 *      不会同时满足；乱码则两者兼具。
 */
export function assessTextQuality(text: string): TextQuality {
  const compact = text.replace(/\s+/g, '')
  const n = compact.length

  if (n === 0) {
    return { score: 0, suspicious: true, cjkRatio: 0, noiseRatio: 0, chars: 0, reason: '未提取到任何文字' }
  }

  const cjk = countMatches(compact, CJK_RE)
  const cjkRatio = cjk / n

  let noise = 0
  for (const ch of compact) {
    if (ch >= 'A' && ch <= 'Z') continue
    if (ch >= 'a' && ch <= 'z') continue
    if (ch >= '0' && ch <= '9') continue
    if (CJK_CHAR_RE.test(ch)) continue
    if (OK_PUNCT.has(ch)) continue
    noise++
  }
  const noiseRatio = noise / n

  const tokens = text.match(LATIN_TOKEN_RE) ?? []
  const tokenCount = tokens.length
  const longCount = tokens.filter((t) => t.length >= 5).length
  const shortCount = tokens.filter((t) => t.length <= 2).length
  const longShare = tokenCount ? longCount / tokenCount : 0
  const shortShare = tokenCount ? shortCount / tokenCount : 0

  const reasons: string[] = []
  if (noiseRatio > 0.06 && cjkRatio < 0.2) {
    reasons.push(`异常符号占 ${Math.round(noiseRatio * 100)}%`)
  }
  if (cjkRatio < 0.02 && tokenCount >= 40 && longShare < 0.1 && shortShare > 0.5) {
    reasons.push(
      `英文碎片化（1-2 字母碎片占 ${Math.round(shortShare * 100)}%、完整单词仅 ${Math.round(longShare * 100)}%）`,
    )
  }

  // 语言字符（汉字 + 英文成词字母）占比，减去乱码惩罚
  const latinChars = tokens.reduce((s, t) => s + t.length, 0)
  const langRatio = (cjk + latinChars) / n
  const score = clamp01(langRatio - 1.8 * noiseRatio - 0.6 * shortShare)

  return {
    score: Number(score.toFixed(3)),
    suspicious: reasons.length > 0,
    cjkRatio: Number(cjkRatio.toFixed(3)),
    noiseRatio: Number(noiseRatio.toFixed(3)),
    chars: n,
    reason: reasons.join('；'),
  }
}
