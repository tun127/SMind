import type {
  AccessoryItem,
  AccessoryRow,
  LabelRow,
  MarkerStrip,
  MeasureResult,
  MeasuredLabel,
  MeasuredLine,
  StyledSegment
} from '@shared/layout/types'
import type { RichText, RichTextParagraph, RichTextRun, Topic } from '@shared/model/types'
import {
  BLOCK_GAP,
  // 指示图标行的尺寸/间距：测量、画布、导出三处共用一份（见 accessory.ts）
  ACCESSORY_ICON_GAP as ICON_GAP,
  ACCESSORY_ICON_SIZE as ICON_SIZE,
  ACCESSORY_ROW_GAP as ROW_GAP,
  codeBlockMetrics,
  imageBoxSize,
  markerStripSize,
  type Size
} from '@shared/layout/accessory'
import { fitLabelText } from '@shared/layout/label-fit'
import { SCRIPT_FONT_RATIO, richFromPlain } from '@shared/richtext'
import { splitInlineMath } from '@shared/formula'
import { formulaSize } from './formula'
import { defaultTextAlignOf } from './defaults'
import { evictOldest } from '@shared/cache'

export const FONT_FAMILY =
  '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Segoe UI", system-ui, sans-serif'

export const NODE_FONT_SIZES = [19, 15, 14] as const
const NODE_FONT_WEIGHTS = [700, 600, 500] as const

/** 文字宽度上限（中心主题更宽）。导出给编辑态用：编辑区的宽度必须与这里一致，断行位置才对得上 */
export const TEXT_MAX_ROOT = 320
export const TEXT_MAX = 240
const MIN_WIDTH_ROOT = 120
const MIN_WIDTH = 76
const PADDING_X_ROOT = 24
const PADDING_X = 14
const PADDING_Y_ROOT = 15
const PADDING_Y = 9
const LINE_HEIGHT_RATIO = 1.5
/** 项目符号的前缀，参与测量也参与渲染，保证所见即所得 */
const BULLET_PREFIX = '•  '

/* ---- 图标行与标签行的排版常量（与 styles.css 保持一致） ---- */
const LABEL_FONT_SIZE = 11
const LABEL_HEIGHT = 18
const LABEL_PADDING_X = 7
const LABEL_GAP = 4
const LABEL_MAX_WIDTH = 170

/** 一行放不下时换行，返回需要几行 */
function rowCount(widths: number[], gap: number, maxWidth: number): number {
  if (widths.length === 0) return 0
  let rows = 1
  let current = 0
  for (const width of widths) {
    const next = current === 0 ? width : current + gap + width
    if (next > maxWidth && current > 0) {
      rows += 1
      current = width
    } else {
      current = next
    }
  }
  return rows
}

/**
 * 顶部图标行：备注 / 链接 / 附件的指示图标。
 *
 * 标记图标**不再放这里** —— 它们现在竖排在节点左侧（见 markersOf）；
 * 图片与公式也不放指示图标：它们会直接在节点里画出来，再加图标就重复了。
 */
function accessoryOf(topic: Topic): AccessoryRow {
  const items: AccessoryItem[] = []

  if (topic.notes && topic.notes.length > 0) items.push({ kind: 'notes', width: ICON_SIZE })
  if (topic.href) items.push({ kind: 'link', width: ICON_SIZE })
  if ((topic.attachments?.length ?? 0) > 0) items.push({ kind: 'attachment', width: ICON_SIZE })

  if (items.length === 0) return { items, height: 0, width: 0 }

  const rows = rowCount(
    items.map((item) => item.width),
    ICON_GAP,
    TEXT_MAX
  )
  const natural = items.length * ICON_SIZE + (items.length - 1) * ICON_GAP
  return {
    items,
    height: rows * ICON_SIZE + (rows - 1) * ICON_GAP + ROW_GAP,
    width: Math.min(natural, TEXT_MAX)
  }
}

/** 左侧标记条：标记竖排（每列最多 4 个，多出来的换列） */
function markersOf(topic: Topic): MarkerStrip {
  const markerIds: string[] = []
  for (const marker of topic.markers ?? []) {
    const id = marker?.markerId
    if (typeof id === 'string' && id.length > 0) markerIds.push(id)
  }
  const size = markerStripSize(markerIds.length)
  return { markerIds, width: size.width, height: size.height }
}

function labelStyle(): ResolvedStyle {
  return {
    bold: true,
    italic: false,
    underline: false,
    strike: false,
    fontSize: LABEL_FONT_SIZE,
    weight: 600,
    fontFamily: FONT_FAMILY
  }
}

/** 底部标签行 */
function labelsOf(topic: Topic): LabelRow {
  const style = labelStyle()
  const items: MeasuredLabel[] = []

  const maxTextWidth = LABEL_MAX_WIDTH - LABEL_PADDING_X * 2
  for (const raw of topic.labels ?? []) {
    const full = typeof raw === 'string' ? raw.trim() : ''
    if (full.length === 0) continue
    // 过长就截断成一个**完整的**短文本（带省略号），渲染照抄，不会出现半个字
    const fitted = fitLabelText(full, (ch) => widthOf({ ch, style }), maxTextWidth)
    items.push({
      text: fitted.text,
      width: Math.round(fitted.width) + LABEL_PADDING_X * 2,
      // 截断过就把原文带上：标签 hover 时能看全
      full: fitted.truncated ? full : undefined
    })
  }

  if (items.length === 0) return { items, height: 0, width: 0 }

  const rows = rowCount(
    items.map((item) => item.width),
    LABEL_GAP,
    TEXT_MAX
  )
  const natural = items.reduce((sum, item) => sum + item.width, 0) + (items.length - 1) * LABEL_GAP
  return {
    items,
    // 换行后的行间距必须与 styles.css 里 .topic__labels 的 gap 一致，否则多行标签会被裁掉
    height: rows * LABEL_HEIGHT + (rows - 1) * LABEL_GAP + ROW_GAP,
    width: Math.min(natural, TEXT_MAX)
  }
}

/**
 * 图标/标签的缓存签名。
 * 这些内容会改变节点尺寸，所以必须参与测量缓存的键，
 * 否则「加了一个标签但节点没变高」。
 * 没有任何附加元素时返回空串，保证绝大多数节点走最短路径。
 */
function accessoryKey(topic: Topic): string {
  const hasAny =
    (topic.markers?.length ?? 0) > 0 ||
    (topic.labels?.length ?? 0) > 0 ||
    Boolean(topic.notes) ||
    Boolean(topic.href) ||
    Boolean(topic.formula) ||
    Boolean(topic.image) ||
    Boolean(topic.code) ||
    (topic.attachments?.length ?? 0) > 0
  if (!hasAny) return ''

  return [
    (topic.markers ?? []).map((marker) => marker?.markerId ?? '').join(','),
    (topic.labels ?? []).join('\u0001'),
    topic.notes ? 'n' : '',
    topic.href ? 'h' : '',
    // 公式与图片、代码会直接影响节点尺寸，必须把内容本身写进缓存键
    topic.formula ?? '',
    topic.image ? `${topic.image.path}:${topic.image.width ?? ''}x${topic.image.height ?? ''}` : '',
    topic.code ? `${topic.code.language}\u0002${topic.code.text}` : '',
    topic.sizeOverride ? `${topic.sizeOverride.width}x${topic.sizeOverride.height}` : '',
    (topic.attachments?.length ?? 0) > 0 ? 'a' : ''
  ].join('|')
}

interface BaseStyle {
  fontSize: number
  weight: number
  paddingX: number
  paddingY: number
  maxTextWidth: number
  minWidth: number
}

interface ResolvedStyle {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  color?: string
  fontSize: number
  weight: number
  fontFamily: string
  highlight?: boolean
  script?: 'super' | 'sub'
}

interface StyledChar {
  ch: string
  style: ResolvedStyle
  /** 行内公式（`$…$`）：整段作为一个「原子」参与断行，宽度取 KaTeX 的实测值 */
  formula?: string
  /** 行内公式的实测宽高（有公式时用，避免再走单字测量） */
  formulaWidth?: number
  formulaHeight?: number
}

/** 行内公式的实测尺寸（拿不到 DOM 时退回估算） */
function inlineFormulaSize(source: string, fontSize: number): Size {
  return formulaSize(source, fontSize)
}

/**
 * 某层级的节点内边距。
 * 拉伸时的「最小尺寸」要按它算（框不能小于内容），所以对外暴露，
 * 保证"限制拖动"和"实际排版"用的是同一份内边距。
 */
export function nodePaddingOf(depth: number): { x: number; y: number } {
  const isRoot = depth === 0
  return { x: isRoot ? PADDING_X_ROOT : PADDING_X, y: isRoot ? PADDING_Y_ROOT : PADDING_Y }
}

function baseOf(depth: number): BaseStyle {
  // index 已经 clamp 在 [0, 2]，而这两个数组都有 3 项
  const index = Math.min(depth, 2)
  const isRoot = depth === 0
  return {
    fontSize: NODE_FONT_SIZES[index]!,
    weight: NODE_FONT_WEIGHTS[index]!,
    paddingX: isRoot ? PADDING_X_ROOT : PADDING_X,
    paddingY: isRoot ? PADDING_Y_ROOT : PADDING_Y,
    maxTextWidth: isRoot ? TEXT_MAX_ROOT : TEXT_MAX,
    minWidth: isRoot ? MIN_WIDTH_ROOT : MIN_WIDTH
  }
}

/* ------------------------------------------------------------------ */
/* Canvas 文本测量                                                     */
/* ------------------------------------------------------------------ */

let measureCtx: CanvasRenderingContext2D | null = null
let lastFont = ''

function getCtx(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('当前环境不支持 Canvas 文本测量')
    measureCtx = ctx
  }
  return measureCtx
}

function fontOf(style: ResolvedStyle): string {
  return `${style.italic ? 'italic ' : ''}${style.weight} ${style.fontSize}px ${style.fontFamily}`
}

/** 单字符宽度缓存：富文本逐字符测量时必须缓存，否则 2000 节点会明显卡顿 */
const charWidthCache = new Map<string, number>()
const CHAR_CACHE_LIMIT = 60000

function widthOf(char: StyledChar): number {
  if (char.formula)
    return char.formulaWidth ?? inlineFormulaSize(char.formula, char.style.fontSize).width
  const ch = char.ch
  const style = char.style
  const font = fontOf(style)
  const key = `${font}\u0000${ch}`
  const cached = charWidthCache.get(key)
  if (cached !== undefined) return cached

  const ctx = getCtx()
  if (lastFont !== font) {
    ctx.font = font
    lastFont = font
  }
  const width = ctx.measureText(ch).width
  evictOldest(charWidthCache, CHAR_CACHE_LIMIT)
  charWidthCache.set(key, width)
  return width
}

/* ------------------------------------------------------------------ */
/* 断行                                                                */
/* ------------------------------------------------------------------ */

/**
 * 贪心断行，优先在空白处折行。
 * 逐字符测量而不是逐词，是因为中文没有词边界。
 */
function wrapChars(chars: StyledChar[], maxWidth: number): StyledChar[][] {
  if (chars.length === 0) return [[]]
  const lines: StyledChar[][] = []
  let start = 0
  let index = 0
  let width = 0
  let lastSpace = -1

  while (index < chars.length) {
    const char = chars[index]
    if (!char) break
    const charWidth = widthOf(char)
    if (width + charWidth > maxWidth && index > start) {
      const breakAt = lastSpace > start ? lastSpace + 1 : index
      lines.push(chars.slice(start, breakAt))
      start = breakAt
      // 行首空格不参与排版
      while (start < chars.length && chars[start]?.ch === ' ') start += 1
      index = start
      width = 0
      lastSpace = -1
      continue
    }
    if (char.ch === ' ') lastSpace = index
    width += charWidth
    index += 1
  }

  if (start < chars.length) lines.push(chars.slice(start))
  return lines.length > 0 ? lines : [[]]
}

function sameStyle(segment: StyledSegment, style: ResolvedStyle): boolean {
  return (
    segment.weight === style.weight &&
    Boolean(segment.italic) === style.italic &&
    Boolean(segment.underline) === style.underline &&
    Boolean(segment.strike) === style.strike &&
    Boolean(segment.highlight) === Boolean(style.highlight) &&
    segment.script === style.script &&
    segment.color === style.color &&
    segment.fontSize === style.fontSize &&
    segment.fontFamily === style.fontFamily
  )
}

function segmentOf(text: string, style: ResolvedStyle): StyledSegment {
  return {
    text,
    weight: style.weight,
    italic: style.italic || undefined,
    underline: style.underline || undefined,
    strike: style.strike || undefined,
    color: style.color,
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
    highlight: style.highlight,
    script: style.script
  }
}

function groupSegments(chars: StyledChar[]): StyledSegment[] {
  const segments: StyledSegment[] = []
  for (const char of chars) {
    // 行内公式自成一个段（不与前后文字合并，渲染时要整块交给 KaTeX）
    if (char.formula) {
      segments.push({ ...segmentOf(char.ch, char.style), formula: char.formula })
      continue
    }
    const previous = segments[segments.length - 1]
    if (previous && !previous.formula && sameStyle(previous, char.style)) previous.text += char.ch
    else segments.push(segmentOf(char.ch, char.style))
  }
  return segments
}

/* ------------------------------------------------------------------ */
/* 测量主流程                                                          */
/* ------------------------------------------------------------------ */

function baseResolved(base: BaseStyle): ResolvedStyle {
  return {
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    fontSize: base.fontSize,
    weight: base.weight,
    fontFamily: FONT_FAMILY
  }
}

function resolveRun(run: RichTextRun, base: BaseStyle): ResolvedStyle {
  const bold = Boolean(run.bold)
  const raw = run.fontSize && run.fontSize > 0 ? run.fontSize : base.fontSize
  return {
    bold,
    italic: Boolean(run.italic),
    underline: Boolean(run.underline),
    strike: Boolean(run.strike),
    // 上下标按比例缩小字号参与排版：渲染端直接画这个字号，只是再上下偏移
    fontSize: run.script ? Math.max(8, Math.round(raw * SCRIPT_FONT_RATIO)) : raw,
    weight: bold ? Math.max(base.weight, 700) : base.weight,
    fontFamily: run.fontFamily && run.fontFamily.length > 0 ? run.fontFamily : FONT_FAMILY,
    highlight: run.highlight || undefined,
    script: run.script
  }
}

function charsOfParagraph(paragraph: RichTextParagraph, base: BaseStyle): StyledChar[] {
  const chars: StyledChar[] = []
  if (paragraph.bullet) {
    const style = baseResolved(base)
    for (const ch of BULLET_PREFIX) chars.push({ ch, style })
  }
  for (const run of paragraph.runs) {
    const style = resolveRun(run, base)
    // 行内公式（`$…$`）拆成独立的「原子块」，宽度按 KaTeX 实测
    for (const segment of splitInlineMath(run.text)) {
      if (segment.formula) {
        const size = inlineFormulaSize(segment.formula, style.fontSize)
        chars.push({
          ch: `$${segment.formula}$`,
          style,
          formula: segment.formula,
          formulaWidth: size.width,
          formulaHeight: size.height
        })
        continue
      }
      for (const ch of segment.text ?? '') chars.push({ ch, style })
    }
  }
  return chars
}

function compute(topic: Topic, depth: number): MeasureResult {
  const base = baseOf(depth)
  const rich: RichText = topic.titleRich ?? richFromPlain(topic.title)
  /**
   * 内容型节点：标题为空、只有图片 / 公式 / 代码时，不再给空标题行留高度——
   * 那块内容就是节点的全部（从 Markdown 导进来的 `$$…$$` 公式节点正是这种）。
   */
  const contentOnly =
    topic.title.length === 0 &&
    !topic.titleRich &&
    (Boolean(topic.image) || Boolean(topic.formula) || Boolean(topic.code))
  const paragraphs: RichTextParagraph[] = contentOnly
    ? []
    : rich.paragraphs.length > 0
      ? rich.paragraphs
      : [{ runs: [] }]

  // 标记条挂在节点**外面**（左侧/右侧），不占节点自身宽度
  const markerStrip: MarkerStrip = markersOf(topic)

  // 手动拉伸过：宽度成为文本换行上限（文字按给定宽度重排）
  const override = topic.sizeOverride
  const textMax = override ? Math.max(40, override.width - base.paddingX * 2) : base.maxTextWidth

  const lines: MeasuredLine[] = []
  for (const paragraph of paragraphs) {
    const chars = charsOfParagraph(paragraph, base)
    for (const lineChars of wrapChars(chars, textMax)) {
      let width = 0
      let maxFontSize = 0
      let maxFormulaHeight = 0
      for (const char of lineChars) {
        width += widthOf(char)
        if (char.style.fontSize > maxFontSize) maxFontSize = char.style.fontSize
        if (char.formula) {
          const size =
            char.formulaHeight ?? inlineFormulaSize(char.formula, char.style.fontSize).height
          if (size > maxFormulaHeight) maxFormulaHeight = size
        }
      }
      if (maxFontSize === 0) maxFontSize = base.fontSize
      // 行内公式比文字高时行高要跟着长（否则公式会被上下裁掉）
      const lineHeight = Math.round(Math.max(maxFontSize * LINE_HEIGHT_RATIO, maxFormulaHeight + 2))
      lines.push({
        segments: groupSegments(lineChars),
        width: Math.round(width * 10) / 10,
        height: lineHeight,
        // 没有显式段落对齐时用「设置 → 默认对齐」
        align: paragraph.align ?? defaultTextAlignOf()
      })
    }
  }

  if (lines.length === 0 && !contentOnly) {
    lines.push({
      segments: [],
      width: 0,
      height: Math.round(base.fontSize * LINE_HEIGHT_RATIO),
      align: defaultTextAlignOf()
    })
  }

  const accessory = accessoryOf(topic)
  const labelRow = labelsOf(topic)

  // 图片块与公式块：尺寸规则与渲染层共用（图片用纯函数算，公式量 KaTeX 的真实排版结果）
  // 手动拉伸过：图片按节点可用空间等比放大/缩小（默认仍是「小图不放大」）
  const imageBounds: Size | undefined = override
    ? {
        width: Math.max(24, override.width - base.paddingX * 2),
        height: Math.max(24, override.height - base.paddingY * 2 - 24)
      }
    : undefined
  const imageBox: Size = imageBoxSize(topic.image, imageBounds)
  const formulaBox: Size = topic.formula
    ? formulaSize(topic.formula, base.fontSize)
    : { width: 0, height: 0 }
  // 代码块同样吃「手动拉伸」的可用空间：按空间等比缩放字号/行高/内边距，
  // 于是它永远待在节点框里（不给 bounds 时保持自然尺寸、完整展示整段代码）
  const codeMetrics = codeBlockMetrics(topic.code, imageBounds)
  const codeBox: Size = codeMetrics
    ? { width: codeMetrics.width, height: codeMetrics.height }
    : { width: 0, height: 0 }
  const imageBlock = imageBox.height > 0 ? imageBox.height + BLOCK_GAP : 0
  const formulaBlock = formulaBox.height > 0 ? formulaBox.height + BLOCK_GAP : 0
  const codeBlock = codeBox.height > 0 ? codeBox.height + BLOCK_GAP : 0

  let maxLineWidth = 0
  for (const line of lines) if (line.width > maxLineWidth) maxLineWidth = line.width

  // 图标行 / 标签行 / 图片 / 公式 / 代码都可能比文字宽，节点宽度取它们的最大值
  const contentWidth = Math.max(
    maxLineWidth,
    accessory.width,
    labelRow.width,
    imageBox.width,
    formulaBox.width,
    codeBox.width
  )
  let width = Math.max(Math.ceil(contentWidth) + base.paddingX * 2, base.minWidth)

  let height =
    base.paddingY * 2 + accessory.height + imageBlock + formulaBlock + codeBlock + labelRow.height
  for (const line of lines) height += line.height
  // 标记条可能比内容还高（标记多时），节点要能装下它
  height = Math.max(height, markerStrip.height + base.paddingY * 2)

  // 手动拉伸：宽度用给定值（不小于一个可读下限），高度只作**下限**——内容更高时长高，不裁切
  if (override) {
    width = Math.max(override.width, base.paddingX * 2 + 40)
    height = Math.max(override.height, height)
  }

  return {
    width,
    height,
    lines,
    fontSize: base.fontSize,
    lineHeight: Math.round(base.fontSize * LINE_HEIGHT_RATIO),
    paddingX: base.paddingX,
    paddingY: base.paddingY,
    accessory,
    labelRow,
    imageBox,
    formulaBox,
    codeBox,
    codeMetrics: codeMetrics ?? undefined,
    markerStrip
  }
}

/* ------------------------------------------------------------------ */
/* 缓存                                                                */
/* ------------------------------------------------------------------ */

const plainCache = new Map<string, MeasureResult>()
const PLAIN_CACHE_LIMIT = 20000
/** 富文本用对象身份做键：immer 每次修改都会产生新对象，天然就是版本号 */
const richCache = new WeakMap<RichText, Map<string, MeasureResult>>()

/**
 * 按**主题对象身份**缓存测量结果（WeakMap，不阻碍旧对象回收）。
 *
 * immer 的不可变更新保证：没被改动的主题，对象引用不变。
 * 而"编辑某个节点"时每敲一个字都会重跑全量布局，其中绝大多数节点压根没变——
 * 以前仍要逐个重建缓存键（拼字符串 + 扫一遍标记/标签/备注/附件），节点一多就白烧 CPU。
 *
 * 失效跟测量代次绑定：代次一变（字体就绪、默认对齐/字号改变），旧条目直接作废，
 * 不需要也无法显式清空 WeakMap。
 */
interface IdentityEntry {
  epoch: number
  byDepth: Map<number, MeasureResult>
}
const identityCache = new WeakMap<Topic, IdentityEntry>()

/**
 * 测量代次。
 * 公式的真实尺寸依赖「字体是否已经加载」，字体就绪后必须让旧结果失效；
 * WeakMap 没法清空，所以用一个代次号参与缓存键。
 */
let epoch = 0

/** 字体等外部排版条件变化后调用，让所有测量结果重新计算 */
export function bumpMeasureEpoch(): void {
  epoch += 1
  plainCache.clear()
}

/**
 * 测量节点尺寸。
 * 无格式的节点走「标题 + 层级 + 附加元素」字符串缓存；
 * 有格式的节点走对象身份缓存，避免 JSON.stringify 带来的开销。
 * 附加元素（标记/标签/备注等）也必须进键，否则改了它们尺寸不会更新。
 */
/**
 * 量一段文字的宽度。
 *
 * 导出时画「高亮底色」需要按段算出精确位置，所以这里把内部那套字符宽度缓存
 * 开放出来——和节点测量共用同一份缓存，导出的宽度与画布上完全一致。
 *
 * 没有 DOM 时（自检在 Node 里跑导出指令）退回按字符类别的估算：
 * 估算只影响高亮底色的宽窄，不影响"能不能构建出指令"。
 */
export function measureTextWidth(
  text: string,
  style: { fontSize: number; weight?: number; italic?: boolean; fontFamily?: string }
): number {
  const resolved: ResolvedStyle = {
    bold: false,
    italic: Boolean(style.italic),
    underline: false,
    strike: false,
    fontSize: style.fontSize,
    weight: style.weight ?? 400,
    fontFamily: style.fontFamily && style.fontFamily.length > 0 ? style.fontFamily : FONT_FAMILY
  }

  if (typeof document === 'undefined') {
    let estimate = 0
    for (const ch of text)
      estimate += ch.charCodeAt(0) > 0xff ? resolved.fontSize : resolved.fontSize * 0.55
    return estimate
  }

  let width = 0
  for (const ch of text) width += widthOf({ ch, style: resolved })
  return width
}

export function measureTopic(topic: Topic, depth: number): MeasureResult {
  // 身份快路径：没被改动的主题引用不变，直接命中——连缓存键都不用拼
  const entry = identityCache.get(topic)
  if (entry && entry.epoch === epoch) {
    const hit = entry.byDepth.get(depth)
    if (hit) return hit
  }

  const result = measureByKey(topic, depth)

  const fresh =
    entry && entry.epoch === epoch ? entry : { epoch, byDepth: new Map<number, MeasureResult>() }
  fresh.byDepth.set(depth, result)
  if (fresh !== entry) identityCache.set(topic, fresh)
  return result
}

/**
 * 原有的字符串键缓存：同一份内容出现在不同节点上（复制粘贴出来的副本）也能复用。
 * 身份缓存已经挡掉绝大多数重复计算，这层是兜底。
 */
function measureByKey(topic: Topic, depth: number): MeasureResult {
  const extra = accessoryKey(topic)
  const rich = topic.titleRich

  if (rich) {
    let byKey = richCache.get(rich)
    if (!byKey) {
      byKey = new Map<string, MeasureResult>()
      richCache.set(rich, byKey)
    }
    const key = `${epoch}\u0000${depth}\u0000${extra}`
    const hit = byKey.get(key)
    if (hit) return hit
    const result = compute(topic, depth)
    byKey.set(key, result)
    return result
  }

  const key = `${epoch}\u0000${depth}\u0000${topic.title}\u0000${extra}`
  const cached = plainCache.get(key)
  if (cached) return cached
  const result = compute(topic, depth)
  evictOldest(plainCache, PLAIN_CACHE_LIMIT)
  plainCache.set(key, result)
  return result
}
