/**
 * 多模态视觉识别：把 PDF 页面渲染成图片直接发给多模态大模型，
 * 由模型读出页面的全部文字。识别率显著高于 tesseract，尤其是：
 *  - 彩色背景/插图下的中文小字
 *  - 手写笔记
 *  - 复杂排版（标题、图文混排、练习题）
 *  - 字体不统一/老式教材
 *
 * 依赖 settings 中 `aiVisionModel` 非空（通过 buildVisionCfg 派生 LlmConfig）。
 */

import { chat, type LlmConfig } from './llm'
import type { ExtractProgress } from './fileImport'
import { BatchRunner } from './batchRunner'
import { runPool } from './pagePool'

/** 视觉识别目标分辨率：200dpi 兼顾清晰度与请求体积（LLM 不需要 300dpi） */
const VISION_TARGET_DPI = 200
const VISION_JPEG_QUALITY = 0.85
const VISION_MAX_PIXELS = 8_000_000
/**
 * 页面「墨迹占比」低于该值即视为空白 / 纯插图页：不调用识别，直接跳过。
 * 教材里封面、扉页、空白练习页很常见，跳过它们能省下可观的 API 时间。
 */
const BLANK_INK_RATIO = 0.004
/** 缺省并发页数：视觉模型调用是网络等待型，3 路并发约等于 3 倍速度 */
export const DEFAULT_VISION_CONCURRENCY = 3

/**
 * 把多模态大模型当作 OCR 用时的提示词。
 * 重点：要求原样保留教材结构（Unit 标题、题号、填空横线、段落顺序），
 * 这是 tesseract 几乎做不到、而 LLM 轻而易举的事。
 */
const VISION_PROMPT = `你是一名中文/英文教材识别助手。任务是**原样**读出这一页教材/讲义/笔记上所有可见的文字与插图说明，保留排版顺序与段落结构。

要求：
1. 保持原文语言（中文 / 英文 / 日文等），不要翻译、不要改写；
2. 用 Markdown 风格输出：标题 / 小节之间用空行分隔，重要短句可单行；
3. 遇到「Unit N」「第 N 单元」「Lesson N」之类的单元标题请**完整保留**并放在新行；
4. 课后练习题号、选项、填空题横线等**完整保留**；
5. 若页面上有大块装饰性插图且无可读文字，跳过该区域；
6. 不要加任何解释或前言；
7. 若整页都是插图/封面/留白等非文字内容，**只输出一行**：[空白页]。`

/** 估算 canvas 的「墨迹占比」：非白像素 / 总像素（0~1） */
export function inkRatioOfCanvas(canvas: HTMLCanvasElement): number {
  const W = 48
  const H = Math.max(1, Math.round((W * canvas.height) / Math.max(1, canvas.width)))
  const small = document.createElement('canvas')
  small.width = W
  small.height = H
  const ctx = small.getContext('2d')
  if (!ctx) return 1
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)
  ctx.drawImage(canvas, 0, 0, W, H)
  const data = ctx.getImageData(0, 0, W, H).data
  let ink = 0
  const n = W * H
  for (let i = 0; i < n; i++) {
    const r = data[i * 4]
    const g = data[i * 4 + 1]
    const b = data[i * 4 + 2]
    if (0.299 * r + 0.587 * g + 0.114 * b < 190) ink++
  }
  return ink / n
}

/** 是否为空白 / 纯插图页（可跳过识别） */
export function isBlankCanvas(canvas: HTMLCanvasElement): boolean {
  return inkRatioOfCanvas(canvas) < BLANK_INK_RATIO
}

export interface RenderedPage {
  /** JPEG dataURL；被判定为空白页时为空串（省掉一次编码与一次 API 调用） */
  dataUrl: string
  /** 墨迹占比 0~1 */
  inkRatio: number
  /** 是否空白 / 纯插图页 */
  blank: boolean
}

/**
 * 把单页 PDF 渲染成 JPEG dataURL（默认 200dpi, q=0.85），
 * 并可选地顺带判断是否为空白页（跳过识别能显著提速）。
 */
export async function renderPdfPageToImage(
  pdf: {
    getPage: (n: number) => Promise<unknown>
  },
  pageIndex: number,
  opts: { dpi?: number; quality?: number; detectBlank?: boolean } = {},
): Promise<RenderedPage> {
  const page = (await pdf.getPage(pageIndex)) as {
    getViewport: (opts: { scale: number }) => { width: number; height: number }
    render: (opts: {
      canvasContext: CanvasRenderingContext2D
      viewport: { width: number; height: number }
    }) => { promise: Promise<void> }
  }
  const vp1 = page.getViewport({ scale: 1 })
  const dpiScale = (opts.dpi ?? VISION_TARGET_DPI) / 72
  const capScale = Math.sqrt(VISION_MAX_PIXELS / Math.max(1, vp1.width * vp1.height))
  const scale = Math.max(1.5, Math.min(dpiScale, capScale, 4))
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 不可用，无法渲染 PDF 页')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport }).promise
  if (opts.detectBlank) {
    const inkRatio = inkRatioOfCanvas(canvas)
    if (inkRatio < BLANK_INK_RATIO) return { dataUrl: '', inkRatio, blank: true }
    return {
      dataUrl: canvas.toDataURL('image/jpeg', opts.quality ?? VISION_JPEG_QUALITY),
      inkRatio,
      blank: false,
    }
  }
  return {
    dataUrl: canvas.toDataURL('image/jpeg', opts.quality ?? VISION_JPEG_QUALITY),
    inkRatio: 1,
    blank: false,
  }
}

/** 把单页 PDF 渲染成 JPEG dataURL（200dpi, q=0.85） */
export async function renderPdfPageToJpegDataUrl(
  pdf: {
    getPage: (n: number) => Promise<unknown>
  },
  pageIndex: number,
): Promise<string> {
  const r = await renderPdfPageToImage(pdf, pageIndex)
  return r.dataUrl
}

/** 调视觉模型识别一张图，返回模型读出的文字。失败抛 LlmError */
export async function visionRecognizePage(
  cfg: LlmConfig,
  pageDataUrl: string,
): Promise<string> {
  const text = await chat(
    cfg,
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT },
          { type: 'image_url', image_url: { url: pageDataUrl, detail: 'high' } },
        ],
      },
    ],
    false,
    // OCR 要完整读出整页文字，上限给足（3000）；设上限只为挡住模型额外的解释性输出
    { maxTokens: 3000 },
  )
  return text.trim()
}

/**
 * 整本 PDF 逐页用视觉模型识别；单页失败跳过；保留 [空白页] 标记以供调用方判断。
 *
 * v12 提速：
 *  - **窗口并发**：一次并发 `batchSize` 页（默认 3）。视觉识别是「渲染→上传→等模型」的
 *    网络等待型任务，并发能让总耗时近似除以并发数（96 页串行约十几分钟 → 并发 3 约几分钟）。
 *  - **空白页跳过**：墨迹占比过低（封面 / 扉页 / 空白练习页）的页直接跳过，不调用 API。
 *  - 每页处理前 `runner.tick()`，因此仍支持「暂停 / 继续 / 取消」。
 *
 * @param batchSize  并发页数（也是进度里的「批」大小），默认 3
 * @param skipBlank  是否跳过空白 / 纯插图页，默认 true
 * @param runner     分批控制器；传 null/undefined 则一次性跑完（向后兼容）
 * @param onProgress 进度回调，done/total 为全局页数（单调递增，可用于估算剩余时间）
 * @returns text 为按页序拼接的文本；blankSkipped 为跳过的空白页数
 */
export async function visionOcrPdfAllPages(
  pdf: {
    numPages: number
    getPage: (n: number) => Promise<unknown>
  },
  cfg: LlmConfig,
  opts: {
    batchSize?: number
    skipBlank?: boolean
    runner?: BatchRunner | null
    onProgress?: (p: ExtractProgress) => void
    /** 进度延续基数：多趟识别时，让本趟的 done 从「上一趟已计页数」继续，避免进度数字从 1 复位（反复横跳） */
    baseDone?: number
  } = {},
): Promise<{ text: string; blankSkipped: number }> {
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_VISION_CONCURRENCY) || 1)
  const total = pdf.numPages
  const batchCount = Math.max(1, Math.ceil(total / batchSize))
  const runner = opts.runner ?? null
  const skipBlank = opts.skipBlank ?? true
  // 按页号写入，保证最终文本仍按页序拼接（并发完成顺序是乱的）
  const perPage: string[] = new Array(total).fill('')
  // 进度延续：若由 extractFromPdf 多趟串联调用，从上一趟已计页数继续累加
  let done = opts.baseDone ?? 0
  let blankSkipped = 0

  const windows: number[][] = []
  for (let s = 1; s <= total; s += batchSize) {
    const w: number[] = []
    for (let i = s; i < s + batchSize && i <= total; i++) w.push(i)
    windows.push(w)
  }

  for (let b = 0; b < windows.length; b++) {
    // 每批开始前检查一次（批间隙可暂停 / 取消）
    if (runner) await runner.tick()
    await runPool(windows[b], batchSize, async (i) => {
      if (runner) await runner.tick()
      try {
        const rp = await renderPdfPageToImage(pdf, i, { detectBlank: skipBlank })
        if (rp.blank && skipBlank) {
          blankSkipped++
        } else {
          const text = await visionRecognizePage(cfg, rp.dataUrl)
          // 去掉「整页空白」标记，但保留其它内容
          const cleaned = text.replace(/^\[空白页\]\s*$/u, '').trim()
          if (cleaned) perPage[i - 1] = cleaned
        }
      } catch {
        /* 单页失败跳过，继续下一页 */
      }
      done++
      opts.onProgress?.({
        phase: 'vision',
        done,
        total,
        batchIndex: b,
        batchCount,
        batchSize,
        method: 'vision',
      })
    })
  }
  return { text: perPage.filter(Boolean).join('\n\n'), blankSkipped }
}
