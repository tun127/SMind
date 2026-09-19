/**
 * 节点绘制（由 ./drawing.ts 按行范围搬出，行为零变化）。
 *
 * 这一块只回答"一个节点怎么画成指令"：文字/分段样式、图片框、公式、代码块、
 * 标记条、指示图标。整体拼装（每条连线、每个边界与概要）留在入口 buildDrawing。
 */
import type { AccessoryItem, LayoutResult, NodeLayout, StyledSegment } from '@shared/layout/types'
import {
  BLOCK_GAP,
  ACCESSORY_ICON_GAP,
  ACCESSORY_ICON_SIZE,
  CODE_CHAR_RATIO,
  CODE_FONT_FAMILY,
  MARKER_GAP,
  codeBlockMetrics,
  codeUnitLength,
  MARKER_MAX_COLUMNS,
  MARKER_PER_COLUMN,
  MARKER_SIZE,
  MARKER_STRIP_GAP,
  // 标签行的排版常量与测量共用一份（E1 收敛，见 accessory.ts）
  LABEL_FONT_SIZE,
  LABEL_GAP,
  LABEL_HEIGHT,
  imageBoxSize
} from '@shared/layout/accessory'
import type { ThemeColors, Topic } from '@shared/model/types'
import { CODE_TOKEN_COLORS, highlightCode } from '@shared/code/highlight'
import { measureTextWidth, TEXT_MAX } from '../render/measure'
import { HIGHLIGHT_BG } from '@shared/richtext'
import { formulaSize } from '../render/formula'
import { markerVisualOf } from '../render/markers'
import { INDICATOR_OPACITY, INDICATOR_STROKE_WIDTH, type IconName } from '@shared/marker-art'
import { branchColorOf, visualFor } from '../render/theme'
import type { BuildDrawingInput, DrawOp } from './ops'

/** 图片资源缺失时的占位提示：文案、字号与颜色都对齐画布 `.topic__image-missing` */
const MISSING_IMAGE_LABEL = '图片缺失'
const MISSING_IMAGE_FONT_SIZE = 11
const MISSING_IMAGE_COLOR = '#6b7280'

/** 文字基线：把字号换算成「垂直居中所需的基线偏移」 */
function baselineIn(boxTop: number, boxHeight: number, fontSize: number): number {
  return boxTop + boxHeight / 2 + fontSize * 0.36
}

/** 一行的最大字号（决定行高与基线） */
function maxFontSizeOf(segments: StyledSegment[], fallback: number): number {
  let max = 0
  for (const segment of segments) if (segment.fontSize > max) max = segment.fontSize
  return max > 0 ? max : fallback
}

export function textAnchorOf(align: 'left' | 'center' | 'right'): 'start' | 'middle' | 'end' {
  if (align === 'center') return 'middle'
  return align === 'right' ? 'end' : 'start'
}

/** 关系线箭头：把三角形按角度旋到目标位置（Canvas 里是 transform，导出直接算成坐标） */
export function arrowPath(x: number, y: number, angle: number): string {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const points: Array<[number, number]> = [
    [0, 0],
    [-10, -4],
    [-10, 4]
  ]
  const mapped = points.map(
    ([px, py]) => [x + px * cos - py * sin, y + px * sin + py * cos] as const
  )
  const [a, b, c] = mapped
  if (!a || !b || !c) return ''
  return `M ${a[0].toFixed(2)} ${a[1].toFixed(2)} L ${b[0].toFixed(2)} ${b[1].toFixed(2)} L ${c[0].toFixed(2)} ${c[1].toFixed(2)} Z`
}

/** 指示图标（备注 / 链接 / 附件）对应的矢量图形名 */
const INDICATOR_GLYPHS: Partial<Record<AccessoryItem['kind'], IconName>> = {
  notes: 'notes',
  link: 'link',
  attachment: 'attachment'
}

/**
 * 顶部指示图标行：备注 / 链接 / 附件。
 *
 * 画布上它是一行 `display:flex; flex-wrap:wrap; justify-content:center` 的 16px 图标；
 * 这里按**同一套常量**重算每一行的位置（尺寸与间距来自 `shared/layout/accessory.ts`，
 * 换行上限与测量用的 `TEXT_MAX` 相同）——否则会出现"测量按两行留了高度、导出只画一行"。
 *
 * 注意：以前这一整行**根本没画**，而且 `cursorY` 也没让出它的高度，
 * 于是有备注/链接/附件的节点在导出里正文偏上、底部空一块。
 */
function accessoryOps(node: NodeLayout, top: number, color: string): DrawOp[] {
  const items = node.accessory.items
  if (items.length === 0) return []

  // 先按换行上限分行（与 measure.ts 的 rowCount 同一口径）
  const rows: AccessoryItem[][] = []
  let row: AccessoryItem[] = []
  let rowWidth = 0
  for (const item of items) {
    const width = ACCESSORY_ICON_SIZE
    if (row.length > 0 && rowWidth + ACCESSORY_ICON_GAP + width > TEXT_MAX) {
      rows.push(row)
      row = []
      rowWidth = 0
    }
    rowWidth += row.length > 0 ? ACCESSORY_ICON_GAP + width : width
    row.push(item)
  }
  if (row.length > 0) rows.push(row)

  const step = ACCESSORY_ICON_SIZE + ACCESSORY_ICON_GAP
  /** 图标行的可用宽度＝节点内容宽（画布上它就在带内边距的 body 里、整行居中） */
  const contentWidth = Math.max(0, node.width - node.paddingX * 2)

  const ops: DrawOp[] = []
  rows.forEach((line, rowIndex) => {
    const lineWidth = line.length * ACCESSORY_ICON_SIZE + (line.length - 1) * ACCESSORY_ICON_GAP
    let x = node.x + node.paddingX + Math.max(0, (contentWidth - lineWidth) / 2)
    const y = top + rowIndex * step
    for (const item of line) {
      const glyph = INDICATOR_GLYPHS[item.kind]
      if (glyph) {
        ops.push({
          kind: 'glyph',
          x,
          y,
          size: ACCESSORY_ICON_SIZE,
          color,
          glyph,
          strokeWidth: INDICATOR_STROKE_WIDTH,
          opacity: INDICATOR_OPACITY
        })
      }
      x += step
    }
  })
  return ops
}

/** 图标行里的标记图标：优先/进度/图形三种画法 */
function markerOps(item: AccessoryItem, x: number, y: number, size: number): DrawOp[] {
  const markerId = item.markerId ?? ''
  if (markerId.length === 0) return []
  const visual = markerVisualOf(markerId)

  if (visual.kind === 'priority') {
    return [
      {
        kind: 'badge',
        x,
        y,
        size,
        color: visual.color,
        text: visual.text,
        fontSize: Math.round(size * 0.62)
      }
    ]
  }
  if (visual.kind === 'progress') {
    return [{ kind: 'pie', x, y, size, color: visual.color, ratio: visual.ratio }]
  }
  return [{ kind: 'glyph', x, y, size, color: visual.color, glyph: visual.glyph }]
}

export function nodeOps(
  node: NodeLayout,
  layout: LayoutResult,
  colors: ThemeColors,
  input: BuildDrawingInput,
  ops: DrawOp[]
): void {
  const visual = visualFor(colors, node, layout)
  const branch = branchColorOf(colors, layout, node.id)
  const topic: Topic = node.topic

  // 节点底：中心主题有底色 + 投影，一级主题有底色 + 边框，更深的层级只有一条下划线
  if (visual.background !== 'transparent') {
    ops.push({
      kind: 'rect',
      x: node.x,
      y: node.y,
      w: node.width,
      h: node.height,
      r: visual.borderRadius,
      fill: visual.background,
      stroke: node.depth === 1 ? branch : undefined,
      strokeWidth: node.depth === 1 ? 1.5 : undefined,
      shadow: node.depth === 0
    })
  } else {
    ops.push({
      kind: 'path',
      d: `M ${node.x} ${node.y + node.height - 1} L ${node.x + node.width} ${node.y + node.height - 1}`,
      stroke: branch,
      strokeWidth: 2,
      cap: 'butt'
    })
  }

  // 内容自上而下：图标行 → 文字 → 图片 → 公式 → 标签
  let cursorY = node.y + node.paddingY

  /**
   * 顶部指示图标行先画、并把它的高度让出来。
   * 这一行的高度本来就计在节点尺寸里（见 measure 的 `accessoryOf`），
   * 不让出来就会把正文顶上去、底部空一块。
   */
  if (node.accessory.items.length > 0) {
    ops.push(...accessoryOps(node, cursorY, visual.color))
    cursorY += node.accessory.height
  }

  // 标记条挂在节点**外侧**竖排（与画布一致）：默认左侧，左向分支放右侧
  const includeMarkers = input.includeMarkers !== false
  const strip = node.markerStrip
  if (includeMarkers && strip && strip.markerIds.length > 0) {
    const columns = strip.markerIds.length <= MARKER_PER_COLUMN ? 1 : MARKER_MAX_COLUMNS
    const rows = Math.ceil(strip.markerIds.length / columns)
    const startY = node.y + (node.height - strip.height) / 2
    const leftSide = node.side !== 'left'
    const stripLeft = leftSide
      ? node.x - MARKER_STRIP_GAP - strip.width
      : node.x + node.width + MARKER_STRIP_GAP
    strip.markerIds.forEach((markerId, index) => {
      // 竖排是「先填满一列再换列」，所以列号只由行数决定（以前这里写成了
      // `leftSide ? … : …`，两个分支一模一样，属残留的死三元）
      const column = Math.floor(index / rows)
      const row = index % rows
      const x = stripLeft + column * (MARKER_SIZE + MARKER_GAP)
      const y = startY + row * (MARKER_SIZE + MARKER_GAP)
      ops.push(...markerOps({ kind: 'marker', markerId, width: MARKER_SIZE }, x, y, MARKER_SIZE))
    })
  }

  for (const line of node.lines) {
    if (line.segments.length > 0) {
      const fontSize = maxFontSizeOf(line.segments, node.fontSize)
      const anchorX =
        line.align === 'center'
          ? node.x + node.width / 2
          : line.align === 'right'
            ? node.x + node.width - node.paddingX
            : node.x + node.paddingX
      const baseline = baselineIn(cursorY, line.height, fontSize)

      // 行内公式（标题里的 $…$）在导出里以源码文本斜体呈现：
      // 导出后端只画文字/图形，塞不进 KaTeX 的 HTML；画布上仍是渲染后的公式
      const segments: Array<StyledSegment & { text: string; x?: number; width?: number }> =
        line.segments.map((segment) =>
          segment.formula
            ? { ...segment, text: segment.formula, formula: undefined, italic: true }
            : { ...segment }
        )

      // 逐段算绝对位置：高亮底色要按段画矩形，位置必须和文字严格对齐
      const widths = segments.map((segment) =>
        measureTextWidth(segment.text, {
          fontSize: segment.fontSize,
          weight: segment.weight,
          italic: segment.italic,
          fontFamily: segment.fontFamily
        })
      )
      const total = widths.reduce((sum, width) => sum + width, 0)
      let cursorX =
        line.align === 'center'
          ? anchorX - total / 2
          : line.align === 'right'
            ? anchorX - total
            : anchorX
      segments.forEach((segment, index) => {
        const width = widths[index] ?? 0
        segment.x = cursorX
        segment.width = width
        cursorX += width
      })

      // 高亮底色：先铺矩形，再让文字压在上面
      for (const segment of segments) {
        if (!segment.highlight) continue
        const box = segment.fontSize * 1.25
        ops.push({
          kind: 'rect',
          x: segment.x ?? 0,
          y: baseline - segment.fontSize * 0.95,
          w: segment.width ?? 0,
          h: box,
          r: 2,
          fill: HIGHLIGHT_BG
        })
      }

      ops.push({
        kind: 'lineText',
        x: anchorX,
        y: cursorY,
        align: line.align,
        baseline,
        segments,
        color: visual.color
      })
    }
    cursorY += line.height
  }

  // 图片/公式的显示框优先用布局测量结果；个别测量实现没给时自己算一份，
  // 免得导出时整块内容凭空消失（与 TopicNode 的兜底逻辑保持一致）
  const imageBox = topic.image
    ? (node.imageBox ?? imageBoxSize(topic.image))
    : { width: 0, height: 0 }
  if (topic.image && imageBox.height > 0) {
    cursorY += BLOCK_GAP
    const href = input.images?.get(topic.image.path)
    const x = node.x + (node.width - imageBox.width) / 2
    if (href) {
      ops.push({ kind: 'image', x, y: cursorY, w: imageBox.width, h: imageBox.height, href })
    } else {
      /**
       * 找不到图片资源时不要留空白：画一个**虚线占位框 + 「图片缺失」**，
       * 与画布上的 `.topic__image-missing`（`1px dashed` + 同一句提示）完全一致。
       * 以前这里只铺了一个实心浅灰块、还没有文字，用户会以为导出坏了或图本来就那么大。
       */
      ops.push({
        kind: 'rect',
        x,
        y: cursorY,
        w: imageBox.width,
        h: imageBox.height,
        r: 4,
        fill: 'rgba(140, 148, 160, 0.12)',
        stroke: 'rgba(140, 148, 160, 0.55)',
        strokeWidth: 1,
        dash: '4 3'
      })
      ops.push({
        kind: 'text',
        x: x + imageBox.width / 2,
        y: baselineIn(cursorY, imageBox.height, MISSING_IMAGE_FONT_SIZE),
        text: MISSING_IMAGE_LABEL,
        fontSize: MISSING_IMAGE_FONT_SIZE,
        fontWeight: 400,
        fill: MISSING_IMAGE_COLOR,
        anchor: 'middle',
        baseline: 'alphabetic'
      })
    }
    cursorY += imageBox.height
  }

  const formulaBox = topic.formula
    ? (node.formulaBox ?? formulaSize(topic.formula, node.fontSize))
    : { width: 0, height: 0 }
  if (topic.formula && formulaBox.height > 0) {
    cursorY += BLOCK_GAP
    ops.push({
      kind: 'formula',
      x: node.x + (node.width - formulaBox.width) / 2,
      y: cursorY,
      w: formulaBox.width,
      h: formulaBox.height,
      source: topic.formula,
      href: input.formulas?.get(topic.formula),
      fallbackText: topic.formula,
      fontSize: node.fontSize,
      color: visual.color
    })
    cursorY += formulaBox.height
  }

  // 代码块：底色圆角框 + 等宽文本逐行、逐 token 上色画。
  // 指标（字号/行高/内边距/缩放）与画布共用同一份，节点被拉伸时一起等比缩放。
  const codeMetrics = topic.code ? (node.codeMetrics ?? codeBlockMetrics(topic.code)) : null
  const codeBox = codeMetrics
    ? { width: codeMetrics.width, height: codeMetrics.height }
    : { width: 0, height: 0 }
  if (topic.code && codeMetrics && codeBox.height > 0) {
    cursorY += BLOCK_GAP
    const x = node.x + (node.width - codeBox.width) / 2
    ops.push({
      kind: 'rect',
      x,
      y: cursorY,
      w: codeBox.width,
      h: codeBox.height,
      r: 6,
      fill: '#f6f8fa',
      stroke: 'rgba(15, 23, 42, 0.14)',
      strokeWidth: 1
    })
    // 逐 token 画：颜色按语法种类取，横向偏移按「等宽字符数 × 单字宽」推进——
    // 单字宽随字号等比变化，保证导出与画布上的换行位置一致
    const charWidth = codeMetrics.fontSize * CODE_CHAR_RATIO
    const codeLines = highlightCode(topic.code.text, topic.code.language)
    let textY = cursorY + codeMetrics.header + codeMetrics.paddingY + codeMetrics.fontSize * 0.8
    for (const line of codeLines) {
      let offset = 0
      for (const token of line.tokens) {
        ops.push({
          kind: 'text',
          x: x + codeMetrics.paddingX + offset,
          y: textY,
          text: token.text,
          fontSize: codeMetrics.fontSize,
          fontWeight: 400,
          fill: CODE_TOKEN_COLORS[token.kind],
          italic: token.kind === 'comment' || undefined,
          anchor: 'start',
          baseline: 'alphabetic',
          fontFamily: CODE_FONT_FAMILY
        })
        offset += codeUnitLength(token.text) * charWidth
      }
      textY += codeMetrics.lineHeight
    }
    cursorY += codeBox.height
  }

  if (node.labelRow.items.length > 0) {
    let x = node.x + node.paddingX
    const right = node.x + node.width - node.paddingX
    let y = cursorY
    for (const label of node.labelRow.items) {
      if (x + label.width > right && x > node.x + node.paddingX) {
        y += LABEL_HEIGHT + LABEL_GAP
        x = node.x + node.paddingX
      }
      ops.push({
        kind: 'rect',
        x,
        y,
        w: label.width,
        h: LABEL_HEIGHT,
        r: 9,
        fill: 'rgba(140, 148, 160, 0.22)'
      })
      ops.push({
        kind: 'text',
        x: x + label.width / 2,
        y: y + LABEL_HEIGHT / 2,
        text: label.text,
        fontSize: LABEL_FONT_SIZE,
        fontWeight: 600,
        fill: visual.color,
        anchor: 'middle',
        baseline: 'middle'
      })
      x += label.width + LABEL_GAP
    }
  }
}

/** 把一次布局结果翻译成绘制指令 */
