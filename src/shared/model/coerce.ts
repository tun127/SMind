/**
 * 把**外部数据**收敛成模型对象。
 *
 * 存在的理由只有一个：外部数据（别人的 .xmind、亿图文件、AI 返回）里字段缺失、
 * 类型不对都是常态。`as Topic['titleRich']` 这种强转在编译期很省事，但运行期等于撒谎——
 * 渲染与测量会拿着"说好是数组、实际是字符串"的东西去用，直接抛异常，
 * 而渲染期异常会连累整棵界面（虽然有错误边界兜底，但不该走到那一步）。
 *
 * 所以这里逐字段校验：对得上就收，对不上就**丢掉该字段**（纯文本兜底仍在）。
 * 宁可少显示一点格式，也不要带着坏数据往下走。
 *
 * 这些值还会被写进导出物（SVG / PDF 的属性、内联样式），
 * 所以字符串字段一律限定字符范围——不能给"逃逸出属性"留路。
 */
import { isRecord } from '../guards'
import type { RichText, RichTextParagraph, RichTextRun, Topic } from './types'

/** 颜色：`#rgb` / `#rrggbb(aa)` / CSS 颜色名 / `rgb()/hsl()` 这类函数写法 */
const COLOR_PATTERN = /^[a-zA-Z0-9#(),.%\s-]{1,64}$/
/** 字体名：字母数字与空格、逗号、引号、连字符 */
const FONT_PATTERN = /^[\w\s,'"-]{1,128}$/

function safeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return COLOR_PATTERN.test(trimmed) ? trimmed : undefined
}

function safeFontFamily(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return FONT_PATTERN.test(trimmed) ? trimmed : undefined
}

function safeFontSize(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value <= 0 || value > 512) return undefined
  return value
}

function coerceRun(value: unknown): RichTextRun | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.text !== 'string') return undefined

  const run: RichTextRun = { text: value.text }
  // 布尔格式字段只认真正的 true：`"true"`、1 之类的都不算，避免脏数据改变语义
  if (value.bold === true) run.bold = true
  if (value.italic === true) run.italic = true
  if (value.underline === true) run.underline = true
  if (value.strike === true) run.strike = true
  if (value.highlight === true) run.highlight = true
  if (value.script === 'super' || value.script === 'sub') run.script = value.script
  const color = safeColor(value.color)
  if (color) run.color = color
  const fontSize = safeFontSize(value.fontSize)
  if (fontSize !== undefined) run.fontSize = fontSize
  const fontFamily = safeFontFamily(value.fontFamily)
  if (fontFamily) run.fontFamily = fontFamily
  return run
}

function coerceParagraph(value: unknown): RichTextParagraph | undefined {
  if (!isRecord(value)) return undefined
  const rawRuns = Array.isArray(value.runs) ? value.runs : null
  if (!rawRuns) return undefined

  const runs: RichTextRun[] = []
  for (const raw of rawRuns) {
    const run = coerceRun(raw)
    if (run) runs.push(run)
  }

  const paragraph: RichTextParagraph = { runs }
  if (value.align === 'left' || value.align === 'center' || value.align === 'right') {
    paragraph.align = value.align
  }
  if (value.bullet === true) paragraph.bullet = true
  return paragraph
}

/**
 * 富文本。整段都不合法（例如 paragraphs 不是数组）时返回 undefined，
 * 调用方应退回纯文本，而不是硬塞一个空富文本把标题吃掉。
 */
export function coerceRichText(value: unknown): RichText | undefined {
  if (!isRecord(value)) return undefined
  if (!Array.isArray(value.paragraphs)) return undefined

  const paragraphs: RichTextParagraph[] = []
  for (const raw of value.paragraphs) {
    const paragraph = coerceParagraph(raw)
    if (paragraph) paragraphs.push(paragraph)
  }
  if (paragraphs.length === 0) return undefined
  return { paragraphs }
}

/** 代码块：`text` 必须是字符串；语言缺省时退回 `text`，不要因为语言字段缺失就丢掉整段代码 */
export function coerceCode(value: unknown): Topic['code'] | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.text !== 'string') return undefined
  const language =
    typeof value.language === 'string' && value.language.trim().length > 0 ? value.language : 'text'
  return { language, text: value.text }
}
