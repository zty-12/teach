/**
 * 知识库文件导入：把 PDF / DOCX / 图片（OCR）/ 文本 提取成纯文本，供 AI 分析归类。
 *
 *  - PDF：pdfjs-dist（先抽文本层；文本层为空 **或疑似乱码** 时，按需走
 *         ① 多模态大模型视觉识别 ② tesseract 本地 OCR 兜底）
 *  - DOCX：mammoth（纯 JS，无 worker）
 *  - 图片：tesseract.js（运行时从本地/CDN 拉取语言模型与 wasm；离线时可能失败，调用方需优雅降级）
 *  - 文本：.txt / .md / 手动粘贴
 *
 * 所有重依赖都用动态 import()，仅在实际需要时才加载，避免拖慢首屏。
 *
 * v8 改动（图片型 PDF 专项）：
 *  1. 文本层不再只看「有没有字」，还看「是不是人话」——PDF 字体缺 ToUnicode 映射时
 *     会抽出 `Qe eo @ wm Kc | S` 这类乱码，旧的字数检查会误判成功、OCR 永不触发。
 *  2. OCR 渲染分辨率提到 ~300dpi（原 scale=2 仅 ~144dpi，中文小字丢笔画）。
 *  3. OCR 页码模式改为 AUTO（原 SINGLE_BLOCK 会把整页插图当文字读）。
 *  4. OCR 结果按「行置信度 + 有效字符」过滤插图垃圾行（见 ocrLines.ts）。
 *  5. 文本层可读页数上限 30 → 80，并回报「已处理 N/M 页」，避免大教材静默截断。
 *
 * v9 改动（多模态视觉识别）：
 *  1. PDF 提取新增「视觉模型」优先路径：把每页渲染成 200dpi JPEG 后发给多模态大模型，
 *     由模型读出文字（保留 Unit 标题、题号、段落顺序）。识别率显著高于 tesseract，
 *     尤其擅长中文小字、彩色插图、复杂排版。
 *  2. 视觉失败时自动回退 tesseract，对用户完全透明。
 *
 * v10 改动（一次添加、自动分批识别全部页）：
 *  1. 取消视觉 10 页 / OCR 30 页的硬上限：选一次文件即自动识别 PDF 的**全部页**。
 *  2. 识别按 batchSize 内部切分（视觉 10 页/批、OCR 30 页/批），每批 / 每页前检查
 *     BatchRunner，支持「暂停 / 继续 / 取消」；进度 done/total 改为 PDF 总页数。
 *  3. 文本层路径同样读全部页（仅受字数上限保护内存），数字版 PDF 不再静默截断。
 *
 * v11 改动（视觉 + 本地 OCR 混合策略 / 自动择优）：
 *  1. 新增识别策略 ImportStrategy：auto（混合，默认）/ vision（仅视觉）/ ocr（仅本地 OCR）。
 *  2. 混合策略逐页独立决策：文本层可读的页直接采用（免费、快）；缺文本 / 乱码的页才调用识别。
 *  3. 识别时视觉模型优先；若视觉结果可读性偏低（疑似漏字/误读），自动用本地 OCR 二次识别，
 *     两路取可读性更高者（OCR 兜底），兼顾质量与速度，并避免「整本都烧视觉 API」。
 *
 * v12 改动（提速）：
 *  1. **页级并发**：识别不再逐页串行等待，而是按窗口并发处理 N 页（默认 3，可在导入弹窗选
 *     「极速 5 页 / 标准 3 页 / 稳妥 1 页」）。视觉识别是「渲染→上传→等模型」的网络等待型任务，
 *     并发后总耗时近似除以并发数（96 页串行十几分钟 → 并发 3 约几分钟）。
 *  2. **空白页跳过**：墨迹占比极低的页（封面 / 扉页 / 空白练习页）不调用任何识别，直接跳过。
 *  3. **本地 OCR 多 worker**：tesseract 单 worker 无法并发，改为惰性 worker 池（最多 2 个），
 *     OCR 兜底路径也能并行；池内 worker 空闲即复用。
 *  4. 进度 done/total 单调递增（页完成即 +1），供 UI 估算「已用时间 / 预计剩余时间」。
 *
 * v13 改动（把并发真正接进混合主路径）：
 *  1. 上一轮的 runPool / worker 池只做了基础设施，extractHybrid（混合策略真正的执行者）
 *     仍是逐页串行，导致纯扫描件整本走 OCR 时龟速。本轮用 runPool 对全部页做受限并发
 *     （默认 3，UI 可改），视觉与 OCR 都并发。
 *  2. 本地 OCR 由单 worker 改为惰性双 worker 池，每个 worker 配串行队列避免并发冲突，
 *     两个 worker 可同时处理不同页。
 *  3. 渲染时顺带 detectBlank，封面 / 空白练习页直接跳过（可关）。
 */
import type { LlmConfig } from './llm'
import { assessTextQuality } from './textQuality'
import { pickOcrText } from './ocrLines'
import {
  DEFAULT_VISION_CONCURRENCY,
  renderPdfPageToImage,
  visionOcrPdfAllPages,
  visionRecognizePage,
} from './visionOcr'
import { BatchRunner, BatchCancelledError } from './batchRunner'
import { createLazyPool, createSerialQueue, runPool } from './pagePool'

export type ImportSourceKind = 'pdf' | 'docx' | 'image' | 'text'

/** 导入识别策略：auto=混合（每页自动择优，默认）；vision=仅视觉模型；ocr=仅本地 OCR */
export type ImportStrategy = 'auto' | 'vision' | 'ocr'

export interface ExtractProgress {
  phase: 'pdf-text' | 'vision' | 'ocr'
  /** 已完成页数（全局，1-based 到 total） */
  done: number
  /** PDF 总页数（不再被截断上限覆盖，便于显示「第 N/总 页」） */
  total: number
  /** 当前批次（0-based）与总批次数（分批识别时才有意义） */
  batchIndex?: number
  batchCount?: number
  /** 每批页数 */
  batchSize?: number
  /** 当前页采用的方法（hybrid 混合策略下每页可能不同） */
  method?: 'text' | 'vision' | 'ocr' | 'ocr-backstop' | 'blank'
}

/** 提速相关选项：并发页数、是否跳过空白页 */
export interface ExtractSpeedOptions {
  /** 识别并发页数（默认 3；1 表示回到串行） */
  concurrency?: number
  /** 是否跳过空白 / 纯插图页（默认 true） */
  skipBlankPages?: boolean
}

export interface ExtractedText {
  kind: ImportSourceKind
  fileName: string
  text: string
  chars: number
  pageCount?: number
  /** 提取路径：未走兜底则为空；'tesseract' / 'vision' 表示走了对应兜底 */
  viaOcr?: 'tesseract' | 'vision'
  /** 实际处理的页数 */
  pagesRead?: number
  /** 是否因页数上限被截断（pagesRead < pageCount） */
  truncated?: boolean
  /** 可读性评分 0~1（越低越像乱码） */
  quality?: number
  /** 直接展示给用户的诊断说明（提取路径 / 质量 / 截断提示） */
  note?: string
}

/** 文本层很便宜，直接读全部页；仅在总字数超过该上限时提前停止，保护内存 */
const MAX_TEXT_CHARS = 300_000
/** 视觉识别默认并发页数（v12 提速核心；导入弹窗可覆盖） */
const DEFAULT_CONCURRENCY = DEFAULT_VISION_CONCURRENCY
/** 本地 OCR 每批并发页数（也是进度里的「批」大小） */
const OCR_BATCH_SIZE = 30
/** 视觉识别结果达到该可读性评分即直接采用，否则本地 OCR 二次识别并择优（OCR 兜底） */
const VISION_ACCEPT_SCORE = 0.45
/** OCR 目标分辨率：tesseract 对中文小字在 300dpi 下明显更稳 */
const OCR_TARGET_DPI = 300
/** 单页像素上限，防止超大页面把 canvas 撑爆内存 */
const OCR_MAX_PIXELS = 12_000_000

function allowedImageType(t: string): boolean {
  return (
    t === 'image/png' ||
    t === 'image/jpeg' ||
    t === 'image/jpg' ||
    t === 'image/webp' ||
    t === 'image/bmp' ||
    t === 'image/gif'
  )
}

function fileKind(file: File): ImportSourceKind {
  const name = file.name.toLowerCase()
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf'
  if (
    name.endsWith('.docx') ||
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'docx'
  }
  if (allowedImageType(file.type) || /\.(png|jpe?g|webp|bmp|gif)$/.test(name)) {
    return 'image'
  }
  return 'text'
}

/** 提取且只保留可读字符，返回去空白后的文本 */
function clean(text: string): string {
  return text.replace(/\s*\n+\s*/g, '\n').replace(/[ \t]{2,}/g, ' ').trim()
}

/**
 * 判断 PDF 文本层是否「实质为空」（可能为扫描件/图片型 PDF）。
 * 经验阈值：平均每页 < 5 个有效字符时，几乎可以确认是扫描件。
 * 注意：它只回答「有没有字」，不回答「字对不对」——后者交给 assessTextQuality。
 */
function isPdfTextLikelyEmpty(text: string, pages: number): boolean {
  if (!text) return true
  // 完全无汉字 / 无英文单词，可能是符号/坐标；进一步判定
  const stripped = text.replace(/[\s\p{P}]/gu, '')
  if (stripped.length === 0) return true
  if (pages <= 1) return stripped.length < 10
  return stripped.length / pages < 5
}

/** 主入口：根据文件类型提取文本。OCR / PDF 失败时会抛出带友好信息的错误。
 *  @param runner 分批控制器（可选）；传入后可在长任务中途暂停 / 继续 / 取消。
 *                 由视觉模型 / OCR 触发的「全部页」识别会在每页前 tick()。
 *  @param strategy 识别策略（auto 混合 / vision 仅视觉 / ocr 仅本地 OCR）
 *  @param speed 提速选项（并发页数、是否跳过空白页） */
export async function extractTextFromFile(
  file: File,
  onProgress?: (p: ExtractProgress) => void,
  visionCfg?: LlmConfig | null,
  runner?: BatchRunner | null,
  strategy: ImportStrategy = 'auto',
  speed: ExtractSpeedOptions = {},
): Promise<ExtractedText> {
  const kind = fileKind(file)
  switch (kind) {
    case 'pdf':
      return extractFromPdf(file, onProgress, visionCfg, runner, strategy, speed)
    case 'docx':
      return extractFromDocx(file)
    case 'image':
      return extractFromImage(file)
    default:
      return extractFromText(file)
  }
}

async function extractFromPdf(
  file: File,
  onProgress?: (p: ExtractProgress) => void,
  visionCfg?: LlmConfig | null,
  runner?: BatchRunner | null,
  strategy: ImportStrategy = 'auto',
  speed: ExtractSpeedOptions = {},
): Promise<ExtractedText> {
  const pdfjsLib = await import('pdfjs-dist')
  // 主线程 worker：避免生产构建里 worker 静态资源找不到的问题
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString()

  const buf = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise
  const pageCount = pdf.numPages
  // 混合策略：每页自动择优（文本层好的页直接用、缺文本的页才识别，识别时视觉优先 + OCR 兜底）
  if (strategy === 'auto') {
    return extractHybrid(pdf, pageCount, file, visionCfg, runner, onProgress, speed)
  }
  // 数字版 PDF 文本层很便宜，直接读全部页（仅受字数上限保护内存）；
  // 扫描 / 图片型 PDF 会落到下面的视觉 / OCR 全页识别分支。
  const textPageLimit = pageCount

  // 'vision' / 'ocr' 策略会对整本重新识别，文本层结果会被丢弃——没必要先跑一趟文本层。
  // 那一趟既浪费时间，又会让进度先冲到顶再被下一趟从 1 复位，视觉上就是「反复横跳」。
  const skipTextPrePass = strategy === 'vision' || strategy === 'ocr'

  let textLayerText = ''
  let textLayerQ = { score: 0, suspicious: false, reason: '' }
  let textPagesRead = 0

  // ---- 1) 文本层（仅 'text' 策略需要；auto 已在上面单独走 extractHybrid）----
  if (!skipTextPrePass) {
    const parts: string[] = []
    let textChars = 0
    for (let i = 1; i <= textPageLimit; i++) {
      if (runner) await runner.tick()
      try {
        const page = await pdf.getPage(i)
        const content = await page.getTextContent()
        const line = content.items.map((it) => ('str' in it && it.str ? it.str : '')).join(' ')
        parts.push(line)
        textChars += line.replace(/\s+/g, '').length
        textPagesRead = i
      } catch {
        /* 单页失败跳过 */
      }
      onProgress?.({ phase: 'pdf-text', done: i, total: pageCount })
      if (textChars >= MAX_TEXT_CHARS) break
    }
    textLayerText = clean(parts.join('\n\n'))
    textLayerQ = assessTextQuality(textLayerText)
    const textLayerOk =
      !isPdfTextLikelyEmpty(textLayerText, Math.max(1, textPagesRead)) && !textLayerQ.suspicious

    // 文本层又全又能读 → 直接用，不浪费视觉/OCR 时间
    if (textLayerOk) {
      return {
        kind: 'pdf',
        fileName: file.name,
        text: textLayerText,
        chars: textLayerText.length,
        pageCount,
        pagesRead: textPagesRead,
        truncated: textPagesRead < pageCount,
        quality: textLayerQ.score,
        note: buildNote({ pagesRead: textPagesRead, pageCount, quality: textLayerQ }),
      }
    }
  }

  const why = skipTextPrePass
    ? strategy === 'vision'
      ? '按所选「视觉模型」策略识别'
      : '按所选「本地 OCR」策略识别'
    : textLayerQ.suspicious
      ? `PDF 文本层疑似乱码（${textLayerQ.reason}）`
      : 'PDF 文本层为空（疑似扫描件）'

  // 进度延续：'text' 策略文本层不可用时，后续识别趟从「已读页数」继续计数，
  // total 用「两趟总页数」，避免进度数字从 1 复位（「反复横跳」）。
  // 'vision' / 'ocr' 无预读趟：baseDone=0、grandTotal=pageCount，单趟即全程。
  const baseDone = textPagesRead
  const grandTotal = textPagesRead + pageCount

  /** 视觉模型失败时，把错误原因带过去；tesseract 路径据此给出说明 */
  let visionErrMsg: string | undefined

  // ---- 2) 多模态视觉识别（如果配置了视觉模型，优先走）----
  //     全页分批识别：不再限 10 页，逐页渲染并发给视觉模型；中途可暂停 / 取消。
  if (visionCfg && strategy !== 'ocr') {
    try {
      const visionRes = await visionOcrPdfAllPages(pdf, visionCfg, {
        batchSize: DEFAULT_CONCURRENCY,
        runner,
        baseDone,
        // 仅覆盖 total 为两趟总页数；done 已由函数内部从 baseDone 起累加，勿再相加
        onProgress: (p) => onProgress?.({ ...p, total: grandTotal }),
      })
      const visionText = visionRes.text
      const visionQ = assessTextQuality(visionText)
      if (visionText.trim()) {
        return {
          kind: 'pdf',
          fileName: file.name,
          text: visionText,
          chars: visionText.length,
          pageCount,
          pagesRead: pageCount,
          truncated: false,
          viaOcr: 'vision',
          quality: visionQ.score,
          note: buildNote({
            pagesRead: pageCount,
            pageCount,
            quality: visionQ,
            prefix: `${why}，已用视觉模型（${visionCfg.model}）识别全部 ${pageCount} 页`,
          }),
        }
      }
      // 视觉完全空：落到 tesseract
    } catch (e) {
      if (e instanceof BatchCancelledError) throw e
      visionErrMsg = `视觉模型调用失败（${String(e)}）`
    }
  }

  // ---- 3) tesseract 兜底 ----
  //     同样全页分批识别：不再限 30 页，逐页渲染后本地 OCR；中途可暂停 / 取消。
  try {
    const ocrText = await ocrPdfAllPages(pdf, {
      batchSize: OCR_BATCH_SIZE,
      runner,
      baseDone,
      // 仅覆盖 total；done 已由函数内部从 baseDone 起累加
      onProgress: (p) => onProgress?.({ ...p, total: grandTotal }),
    })
    const ocrQ = assessTextQuality(ocrText)

    // tesseract 也没读出东西，但文本层有字 → 回退文本层，别把用户搞成空结果
    if (!ocrText.trim() && textLayerText.trim()) {
      const note = visionErrMsg
        ? `${why}；${visionErrMsg}；OCR 也未识别到文字，已回退使用原文本层。建议改用更清晰的 PDF，或用「粘贴文字」导入。`
        : `${why}；OCR 未识别到文字，已回退使用原文本层。建议改用更清晰的 PDF，或用「粘贴文字」导入。`
      return {
        kind: 'pdf',
        fileName: file.name,
        text: textLayerText,
        chars: textLayerText.length,
        pageCount,
        pagesRead: textPagesRead,
        truncated: textPagesRead < pageCount,
        quality: textLayerQ.score,
        note,
      }
    }

    // 择优：OCR 要有明显优势才替换文本层（避免「文本层其实没问题、被更差的 OCR 覆盖」）
    const takeOcr =
      !textLayerText.trim() ||
      ocrQ.score >= textLayerQ.score + 0.05 ||
      (textLayerQ.suspicious && ocrQ.score >= textLayerQ.score)
    if (!takeOcr && textLayerText.trim()) {
      return {
        kind: 'pdf',
        fileName: file.name,
        text: textLayerText,
        chars: textLayerText.length,
        pageCount,
        pagesRead: textPagesRead,
        truncated: textPagesRead < pageCount,
        quality: textLayerQ.score,
        note: visionErrMsg
          ? `${why}；${visionErrMsg}；OCR 结果也更差，已保留原文本层。`
          : `${why}；OCR 结果更差，已保留原文本层。`,
      }
    }

    const tPrefix = visionErrMsg
      ? `${why}；${visionErrMsg}，已改用 tesseract 识别`
      : `${why}，已自动改用 tesseract 识别`

    return {
      kind: 'pdf',
      fileName: file.name,
      text: ocrText,
      chars: ocrText.length,
      pageCount,
      pagesRead: pageCount,
      truncated: false,
      viaOcr: 'tesseract',
      quality: ocrQ.score,
      note: buildNote({ pagesRead: pageCount, pageCount, quality: ocrQ, prefix: tPrefix }),
    }
  } catch (e) {
    if (e instanceof BatchCancelledError) throw e
    if (textLayerText.trim()) {
      const base = visionErrMsg ?? why
      return {
        kind: 'pdf',
        fileName: file.name,
        text: textLayerText,
        chars: textLayerText.length,
        pageCount,
        pagesRead: textPagesRead,
        truncated: textPagesRead < pageCount,
        quality: textLayerQ.score,
        note: `${base}；tesseract 也失败（${String(e)}），已回退使用原文本层，识别质量可能不高。`,
      }
    }
    const base = visionErrMsg ?? why
    throw new Error(
      `${base}；tesseract 也失败：${String(e)}。请改用「粘贴文字」方式导入。`,
    )
  }
}

/** 组装一句给用户看的诊断说明；没有问题时返回 undefined */
function buildNote(o: {
  pagesRead: number
  pageCount: number
  quality: { score: number; suspicious: boolean; reason: string }
  prefix?: string
}): string | undefined {
  const bits: string[] = []
  if (o.prefix) bits.push(o.prefix)
  if (o.pagesRead < o.pageCount) {
    bits.push(`仅处理了前 ${o.pagesRead}/${o.pageCount} 页`)
  }
  if (o.quality.suspicious || o.quality.score < 0.45) {
    bits.push('识别质量偏低，建议核对下方预览文本')
  }
  return bits.length ? bits.join('；') + '。' : undefined
}

/**
 * 对 PDF 每一页用 pdfjs render 成 canvas，再用 tesseract.js 识别。
 * 仅在文本层为空 / 疑似乱码时调用。
 *
 * 与旧版（限 30 页）不同：这里**处理全部页**，按 batchSize 分批，
 * 每批 / 每页前 `runner.tick()` 以支持暂停 / 继续 / 取消。
 * `onProgress.total` 为 PDF 总页数，batchIndex/batchCount 为批次号。
 */
async function ocrPdfAllPages(
  pdf: {
    numPages: number
    getPage: (n: number) => Promise<unknown>
  },
  opts: {
    batchSize?: number
    runner?: BatchRunner | null
    onProgress?: (p: ExtractProgress) => void
    /** 进度延续基数：多趟识别时，让本趟的 done 从「上一趟已计页数」继续，避免进度数字从 1 复位 */
    baseDone?: number
  } = {},
): Promise<string> {
  const batchSize = Math.max(1, opts.batchSize ?? OCR_BATCH_SIZE)
  const total = pdf.numPages
  const batchCount = Math.max(1, Math.ceil(total / batchSize))
  const runner = opts.runner ?? null
  const doneBase = opts.baseDone ?? 0
  const { createWorker, PSM } = await import('tesseract.js')
  const worker = await createWorker('chi_sim+eng')
  try {
    await worker.setParameters({
      // AUTO：先做版面分析，把插图与文字分开；SINGLE_BLOCK 会把整页插图也当文字读
      tessedit_pageseg_mode: PSM.AUTO,
      preserve_interword_spaces: '1',
    })
    const parts: string[] = []
    for (let b = 0; b < batchCount; b++) {
      if (runner) await runner.tick()
      const start = b * batchSize + 1
      const end = Math.min(total, start + batchSize - 1)
      for (let i = start; i <= end; i++) {
        if (runner) await runner.tick()
        try {
          const page = (await pdf.getPage(i)) as {
            getViewport: (opts: { scale: number }) => { width: number; height: number }
            render: (opts: {
              canvasContext: CanvasRenderingContext2D
              viewport: { width: number; height: number }
            }) => { promise: Promise<void> }
          }
          const base = page.getViewport({ scale: 1 })
          const dpiScale = OCR_TARGET_DPI / 72
          const capScale = Math.sqrt(OCR_MAX_PIXELS / Math.max(1, base.width * base.height))
          const scale = Math.max(1.5, Math.min(dpiScale, capScale, 6))
          const viewport = page.getViewport({ scale })
          const canvas = document.createElement('canvas')
          canvas.width = Math.ceil(viewport.width)
          canvas.height = Math.ceil(viewport.height)
          const ctx = canvas.getContext('2d')
          if (!ctx) continue
          // 透明底会让 tesseract 判成反色，先铺白底
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          await page.render({ canvasContext: ctx, viewport }).promise
          const res = await worker.recognize(canvas, {}, { blocks: true, text: true })
          const text = clean(pickOcrText(res.data.blocks, res.data.text ?? ''))
          if (text) parts.push(text)
        } catch {
          /* 单页 OCR 失败跳过 */
        }
        opts.onProgress?.({
          phase: 'ocr',
          done: doneBase + i,
          total,
          batchIndex: b,
          batchCount,
          batchSize,
        })
      }
    }
    return parts.join('\n\n')
  } finally {
    await worker.terminate()
  }
}

/** 读取单页文本层（失败返回空串，不中断整本提取） */
async function readPageTextLayer(
  pdf: { getPage: (n: number) => Promise<unknown> },
  i: number,
): Promise<string> {
  try {
    const page = (await pdf.getPage(i)) as {
      getTextContent: () => Promise<{ items: Array<{ str?: string }> }>
    }
    const content = await page.getTextContent()
    return content.items.map((it) => (it.str ?? '')).join(' ')
  } catch {
    return ''
  }
}

/** 用已创建的 tesseract worker 识别单页，返回清洗后的文本（失败返回空串） */
async function ocrOnePage(
  pdf: { getPage: (n: number) => Promise<unknown> },
  i: number,
  worker: {
    recognize: (
      c: HTMLCanvasElement,
      _o?: unknown,
      o2?: unknown,
    ) => Promise<{ data: { blocks?: any; text?: string } }>
  },
): Promise<string> {
  try {
    const page = (await pdf.getPage(i)) as {
      getViewport: (opts: { scale: number }) => { width: number; height: number }
      render: (opts: {
        canvasContext: CanvasRenderingContext2D
        viewport: { width: number; height: number }
      }) => { promise: Promise<void> }
    }
    const base = page.getViewport({ scale: 1 })
    const dpiScale = OCR_TARGET_DPI / 72
    const capScale = Math.sqrt(OCR_MAX_PIXELS / Math.max(1, base.width * base.height))
    const scale = Math.max(1.5, Math.min(dpiScale, capScale, 6))
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return ''
    // 透明底会让 tesseract 判成反色，先铺白底
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport }).promise
    const res = await worker.recognize(canvas, {}, { blocks: true, text: true })
    return clean(pickOcrText(res.data.blocks, res.data.text ?? ''))
  } catch {
    return ''
  }
}

/**
 * 混合策略（自动择优）：逐页独立决定识别方式，兼顾质量与速度。
 *  - 文本层可读 → 直接采用（免费又快，跳过昂贵的视觉 / OCR）
 *  - 缺文本 / 乱码 → 优先视觉模型；若视觉结果可读性偏低（疑似漏字 / 误读），
 *    再用本地 OCR 二次识别，两路结果取可读性更高者（OCR 兜底）
 *  - 未配置视觉模型 → 缺文本页直接走本地 OCR
 * 逐页处理，每页前 runner.tick()，进度 done/total 为全局页数（不重复计数）。
 */
async function extractHybrid(
  pdf: { numPages: number; getPage: (n: number) => Promise<unknown> },
  pageCount: number,
  file: File,
  visionCfg: LlmConfig | null | undefined,
  runner?: BatchRunner | null,
  onProgress?: (p: ExtractProgress) => void,
  speed: ExtractSpeedOptions = {},
): Promise<ExtractedText> {
  const concurrency = Math.max(1, Math.min(6, speed.concurrency ?? DEFAULT_CONCURRENCY))
  const skipBlank = speed.skipBlankPages !== false
  const perPage: string[] = new Array(pageCount).fill('')
  const methodOf: Array<ExtractProgress['method']> = new Array(pageCount)

  let textCount = 0
  let visionCount = 0
  let ocrCount = 0
  let backstopCount = 0
  let blankCount = 0
  let done = 0

  // 本地 OCR worker 池：tesseract 单 worker 不能并发，开 2 个近似翻倍；
  // 每个 worker 配一条串行队列，保证同一 worker 不并发 recognize（并发会报错/退化成串行）。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type OcrSlot = { wk: any; run: <T>(thunk: () => Promise<T>) => Promise<T> }
  type OcrPoolHandle = {
    dispose: (fn: (v: OcrSlot) => Promise<void> | void) => Promise<void>
  }
  // 注意：初始化用 `null as OcrPoolHandle | null`（而非裸 null），避免 TS 把本变量
  // 收窄成 null——否则后续在闭包内赋值、闭包外读取得到的真值分支会被推断成 never。
  let ocrPool: OcrPoolHandle | null = null as OcrPoolHandle | null
  async function getOcrPool(): Promise<{
    acquire: () => Promise<OcrSlot>
    release: (v: OcrSlot) => void
    dispose: (fn: (v: OcrSlot) => Promise<void> | void) => Promise<void>
  }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('tesseract.js')
    const queueOf = createSerialQueue()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = createLazyPool<OcrSlot>(2, async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wk: any = await mod.createWorker('chi_sim+eng')
      await wk.setParameters({
        tessedit_pageseg_mode: mod.PSM.AUTO,
        preserve_interword_spaces: '1',
      })
      // 识别走串行队列：同一 worker 不并发；run 接收一个「惰性」thunk 并入队执行
      const run = queueOf as <T>(thunk: () => Promise<T>) => Promise<T>
      return { wk, run }
    })
    ocrPool = pool as OcrPoolHandle
    return pool as {
      acquire: () => Promise<OcrSlot>
      release: (v: OcrSlot) => void
      dispose: (fn: (v: OcrSlot) => Promise<void> | void) => Promise<void>
    }
  }

  /** 给某页选一个已就绪的 OCR worker，串行执行 ocrOnePage */
  async function ocrPage(i: number): Promise<string> {
    const pool = await getOcrPool()
    const slot = await pool.acquire()
    try {
      return await slot.run(() => ocrOnePage(pdf, i, slot.wk))
    } finally {
      pool.release(slot)
    }
  }

  const pageTasks = Array.from({ length: pageCount }, (_, idx) => idx)
  await runPool(pageTasks, concurrency, async (idx) => {
    const i = idx + 1
    if (runner) await runner.tick()

    // 1) 文本层可读 → 直接采用（便宜又快）
    const tl = clean(await readPageTextLayer(pdf, i))
    const tlg = assessTextQuality(tl)
    if (tl.trim() && !tlg.suspicious) {
      perPage[idx] = tl
      methodOf[idx] = 'text'
      textCount++
      done++
      onProgress?.({ phase: 'pdf-text', done, total: pageCount, method: 'text' })
      return
    }

    // 2) 缺文本 / 乱码 → 识别。先渲染（顺带判空白，空白直接跳过）
    let dataUrl = ''
    try {
      const r = await renderPdfPageToImage(pdf, i, { detectBlank: skipBlank })
      if (r.blank) {
        perPage[idx] = ''
        methodOf[idx] = 'blank'
        blankCount++
        done++
        onProgress?.({ phase: 'ocr', done, total: pageCount, method: 'blank' })
        return
      }
      dataUrl = r.dataUrl
    } catch {
      /* 渲染失败，继续尝试识别（dataUrl 为空时走 OCR） */
    }

    let chosen = ''
    let src: 'vision' | 'ocr' | '' = ''
    const visionAttempted = !!visionCfg && !!dataUrl
    if (visionAttempted) {
      try {
        const vt = await visionRecognizePage(visionCfg!, dataUrl)
        const cleaned = vt.replace(/^\[空白页\]\s*$/u, '').trim()
        const vg = assessTextQuality(cleaned)
        if (cleaned && vg.score >= VISION_ACCEPT_SCORE) {
          chosen = cleaned
          src = 'vision'
        } else {
          const ot = await ocrPage(i)
          const og = assessTextQuality(ot)
          if (ot.trim() && og.score >= vg.score) {
            chosen = ot
            src = 'ocr'
          } else if (cleaned) {
            chosen = cleaned
            src = 'vision'
          } else if (ot.trim()) {
            chosen = ot
            src = 'ocr'
          }
        }
      } catch {
        try {
          const ot = await ocrPage(i)
          if (ot.trim()) {
            chosen = ot
            src = 'ocr'
          }
        } catch {
          /* 视觉与 OCR 均失败，本页留空 */
        }
      }
    } else {
      try {
        const ot = await ocrPage(i)
        if (ot.trim()) {
          chosen = ot
          src = 'ocr'
        }
      } catch {
        /* OCR 失败，本页留空 */
      }
    }

    perPage[idx] = chosen
    methodOf[idx] = src === 'ocr' && visionAttempted ? 'ocr-backstop' : src || 'ocr'
    if (src === 'vision') visionCount++
    else if (src === 'ocr') {
      ocrCount++
      if (visionAttempted) backstopCount++
    }
    done++
    onProgress?.({
      phase: src === 'vision' ? 'vision' : 'ocr',
      done,
      total: pageCount,
      method: methodOf[idx],
    })
  })

  await (ocrPool ? ocrPool.dispose(async (slot: any) => {
    try {
      await slot.wk.terminate()
    } catch {
      /* ignore */
    }
  }) : Promise.resolve())

  const text = perPage.join('\n\n')
  const chars = text.length
  const quality = assessTextQuality(text)

  if (chars === 0) {
    return {
      kind: 'pdf',
      fileName: file.name,
      text: '',
      chars: 0,
      pageCount,
      pagesRead: 0,
      truncated: false,
      quality: 0,
      note: '整本 PDF 都未能提取到文字（可能是加密文档，或纯图片且识别失败）。请改用「粘贴文字」方式导入。',
    }
  }

  const viaOcr: ExtractedText['viaOcr'] =
    visionCount > 0 ? 'vision' : ocrCount > 0 ? 'tesseract' : undefined
  const bits = [
    `混合策略：文本层直接采用 ${textCount} 页`,
    `视觉模型识别 ${visionCount} 页`,
    `本地 OCR ${ocrCount} 页`,
  ]
  if (backstopCount > 0) bits.push(`其中 ${backstopCount} 页视觉偏弱已自动改用 OCR 兜底`)
  if (blankCount > 0) bits.push(`空白页跳过 ${blankCount} 页`)
  if (quality.suspicious || quality.score < 0.45) {
    bits.push('整体识别质量偏低，建议核对下方预览文本')
  }
  return {
    kind: 'pdf',
    fileName: file.name,
    text,
    chars,
    pageCount,
    pagesRead: pageCount,
    truncated: false,
    viaOcr,
    quality: quality.score,
    note: bits.join('；') + '。',
  }
}


async function extractFromDocx(file: File): Promise<ExtractedText> {
  try {
    const mammoth = (await import('mammoth')).default as typeof import('mammoth')
    const buf = await file.arrayBuffer()
    const result = await mammoth.extractRawText({ arrayBuffer: buf })
    const text = clean(result.value ?? '')
    return { kind: 'docx', fileName: file.name, text, chars: text.length }
  } catch (e) {
    throw new Error(`Word 解析失败：${String(e)}`)
  }
}

async function extractFromImage(file: File): Promise<ExtractedText> {
  try {
    const { createWorker, PSM } = await import('tesseract.js')
    const worker = await createWorker('chi_sim+eng')
    try {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.AUTO,
        preserve_interword_spaces: '1',
      })
      // 图片直传识别（含置信度分块），同样过滤插图垃圾行
      const res = await worker.recognize(file, {}, { blocks: true, text: true })
      const text = clean(pickOcrText(res.data.blocks, res.data.text ?? ''))
      return {
        kind: 'image',
        fileName: file.name,
        text,
        chars: text.length,
        viaOcr: 'tesseract',
        quality: assessTextQuality(text).score,
        note: text ? undefined : '未能从图片中识别出可读文字，建议换更清晰、字更大的图片。',
      }
    } finally {
      await worker.terminate()
    }
  } catch (e) {
    throw new Error(
      `图片 OCR 失败（可能离线无法加载识别模型）。请改用「粘贴文字」方式导入：${String(e)}`,
    )
  }
}

async function extractFromText(file: File): Promise<ExtractedText> {
  const raw = await file.text()
  const text = clean(raw)
  return { kind: 'text', fileName: file.name, text, chars: text.length }
}
