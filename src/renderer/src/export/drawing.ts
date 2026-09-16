/**
 * 导出用的「绘图操作」构建器。
 *
 * 思路：把布局结果（node 坐标/尺寸/断行/分段样式/图片框/公式框 + 连线/边界/概要）
 * 翻译成一串与具体输出格式无关的绘制指令，然后由两个后端分别消费：
 *   - svg.ts：生成矢量 SVG
 *   - raster.ts：用 Canvas 2D 画成位图（供 PNG 与 PDF 用）
 * 这样「画布上看到的」与「导出的」用的是同一份布局数据，不会出现两套排版。
 *
 * 本文件是纯函数（不碰 DOM），可以在自检里直接断言生成的指令。
 */

import type { AccessoryItem, LayoutResult, NodeLayout, StyledSegment } from '@shared/layout/types'
import {
  BLOCK_GAP,
  CODE_CHAR_RATIO,
  CODE_FONT_FAMILY,
  MARKER_GAP,
  codeBlockMetrics,
  codeUnitLength,
  MARKER_MAX_COLUMNS,
  MARKER_PER_COLUMN,
  MARKER_SIZE,
  MARKER_STRIP_GAP,
  imageBoxSize
} from '@shared/layout/accessory'
import type { ThemeColors, Topic } from '@shared/model/types'
import { OVERLAY_TITLE_LINE_HEIGHT, overlayTitleLines } from '@shared/layout/overlays'
import { readOverlayTextStyle } from '@shared/model/overlay-style'
import { CODE_TOKEN_COLORS, highlightCode } from '@shared/code/highlight'
import { measureTextWidth } from '../render/measure'
import { HIGHLIGHT_BG } from '@shared/richtext'
import { formulaSize } from '../render/formula'
import { markerVisualOf, type MarkerGlyph } from '../render/markers'
import { branchColorOf, visualFor } from '../render/theme'

/* ------------------------------------------------------------------ */
/* 指令类型                                                            */
/* ------------------------------------------------------------------ */

export interface TextStyle {
  fontSize: number
  fontWeight: number
  italic?: boolean
  color?: string
  fontFamily?: string
}

export interface RectOp {
  kind: 'rect'
  x: number
  y: number
  w: number
  h: number
  r: number
  fill?: string
  stroke?: string
  strokeWidth?: number
  /** 是否绘制柔和投影（中心主题用） */
  shadow?: boolean
}

export interface PathOp {
  kind: 'path'
  d: string
  stroke?: string
  strokeWidth?: number
  fill?: string
  opacity?: number
  strokeOpacity?: number
  fillOpacity?: number
  dash?: string
  /** 端点样式，默认 round */
  cap?: 'round' | 'butt'
  fillRule?: 'nonzero' | 'evenodd'
}

export interface TextOp {
  kind: 'text'
  x: number
  y: number
  text: string
  fontSize: number
  fontWeight: number
  fill: string
  anchor: 'start' | 'middle' | 'end'
  /** middle 表示文字垂直居中于 y（SVG 的 dominant-baseline） */
  baseline: 'middle' | 'alphabetic'
  /** 斜体（画布元素的标题样式用得上） */
  italic?: boolean
  fontFamily?: string
  /** 描边（概要/关系线标题为了在别的图形上也读得清而描底色） */
  stroke?: string
  strokeWidth?: number
}

export interface LineTextOp {
  kind: 'lineText'
  /** 对齐基准点：align=center 时是行中心，start 是左边界，end 是右边界 */
  x: number
  y: number
  align: 'left' | 'center' | 'right'
  /** 该行文字的基线 y */
  baseline: number
  /**
   * 分段。`x`/`width` 是构建时按字符宽度算出的**绝对位置**：
   * 高亮底色要按段画矩形，两个后端都要用（SVG 那边没有 canvas 可量）。
   */
  segments: Array<StyledSegment & { text: string; x?: number; width?: number }>
  /** 兜底颜色（分段没指定 color 时用） */
  color: string
}

export interface ImageOp {
  kind: 'image'
  x: number
  y: number
  w: number
  h: number
  href: string
}

export interface FormulaOp {
  kind: 'formula'
  x: number
  y: number
  w: number
  h: number
  source: string
  /** 已栅格化的公式图片；拿不到时用 fallbackText 画源码 */
  href?: string
  fallbackText: string
  fontSize: number
  color: string
}

export interface BadgeOp {
  kind: 'badge'
  x: number
  y: number
  size: number
  color: string
  text: string
  fontSize: number
}

export interface PieOp {
  kind: 'pie'
  x: number
  y: number
  size: number
  color: string
  ratio: number
}

export interface GlyphOp {
  kind: 'glyph'
  x: number
  y: number
  size: number
  color: string
  glyph: MarkerGlyph
}

export type DrawOp =
  RectOp | PathOp | TextOp | LineTextOp | ImageOp | FormulaOp | BadgeOp | PieOp | GlyphOp

export interface Drawing {
  width: number
  height: number
  /** null 表示透明背景 */
  background: string | null
  ops: DrawOp[]
}

/* ------------------------------------------------------------------ */
/* 构建                                                                */
/* ------------------------------------------------------------------ */

export interface BuildDrawingInput {
  layout: LayoutResult
  colors: ThemeColors
  /** 包内资源路径 -> data URL */
  images?: Map<string, string>
  /** LaTeX 源码 -> 已栅格化的 data URL */
  formulas?: Map<string, string>
  /** 透明背景传 null */
  background: string | null
  includeOverlays?: boolean
  includeMarkers?: boolean
}

const LABEL_GAP = 4
const LABEL_HEIGHT = 18

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

function textAnchorOf(align: 'left' | 'center' | 'right'): 'start' | 'middle' | 'end' {
  if (align === 'center') return 'middle'
  return align === 'right' ? 'end' : 'start'
}

/** 关系线箭头：把三角形按角度旋到目标位置（Canvas 里是 transform，导出直接算成坐标） */
function arrowPath(x: number, y: number, angle: number): string {
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

function nodeOps(
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
      const column = leftSide ? Math.floor(index / rows) : Math.floor(index / rows)
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
      // 找不到图片资源时不要留空白：画一个虚线占位框
      ops.push({
        kind: 'rect',
        x,
        y: cursorY,
        w: imageBox.width,
        h: imageBox.height,
        r: 4,
        fill: 'rgba(140, 148, 160, 0.12)'
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
        fontSize: 11,
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
export function buildDrawing(input: BuildDrawingInput): Drawing {
  const { layout, colors } = input
  const ops: DrawOp[] = []

  // 1. 连线（在节点下面）
  for (const edge of layout.edges) {
    const target = layout.nodeMap.get(edge.toId)
    const firstLevel = Boolean(target && target.depth === 1)
    ops.push({
      kind: 'path',
      d: edge.d,
      stroke: branchColorOf(colors, layout, edge.toId),
      strokeWidth: firstLevel ? colors.edgeWidth * 1.5 : colors.edgeWidth,
      opacity: colors.edgeOpacity
    })
  }

  if (input.includeOverlays !== false) {
    // 2. 结构装饰线（时间轴主轴、鱼骨主脊、括号）
    for (const decoration of layout.decorations) {
      ops.push({
        kind: 'path',
        d: decoration.d,
        stroke: decoration.branchId
          ? branchColorOf(colors, layout, decoration.branchId)
          : colors.deepText,
        strokeWidth: colors.edgeWidth * (decoration.widthScale ?? 1),
        opacity: decoration.dashed ? 0.5 : colors.edgeOpacity,
        dash: decoration.dashed ? '6 5' : undefined
      })
    }

    // 3. 边界：填充 + 描边
    for (const boundary of layout.boundaries) {
      const color = boundary.branchId
        ? branchColorOf(colors, layout, boundary.branchId)
        : colors.deepText
      ops.push({
        kind: 'path',
        d: boundary.d,
        fill: color,
        fillOpacity: 0.08,
        stroke: color,
        strokeWidth: 1.5,
        strokeOpacity: 0.6
      })
      if (boundary.title) {
        const boundaryStyle = readOverlayTextStyle(boundary.style, { fontSize: 12, bold: true })
        ops.push({
          kind: 'text',
          x: boundary.label.x,
          y: boundary.label.y,
          text: boundary.title,
          fontSize: boundaryStyle.fontSize,
          fontWeight: boundaryStyle.bold ? 700 : 400,
          italic: boundaryStyle.italic || undefined,
          fill: boundaryStyle.color ?? color,
          anchor: 'start',
          baseline: 'middle'
        })
      }
    }

    // 4. 概要：大括号 + 文字（文字描一圈画布底色，压到别的内容上也读得清）
    for (const summary of layout.summaries) {
      const color = summary.branchId
        ? branchColorOf(colors, layout, summary.branchId)
        : colors.deepText
      ops.push({
        kind: 'path',
        d: summary.d,
        stroke: color,
        strokeWidth: 1.6,
        strokeOpacity: 0.75
      })
      if (summary.title) {
        // 多行标题逐行画，整体以 label.y 为中线居中（与画布上的 tspan 排法一致）
        const lines = overlayTitleLines(summary.title)
        const textStyle = readOverlayTextStyle(summary.style, { fontSize: 13, bold: true })
        const startY = summary.label.y - ((lines.length - 1) * OVERLAY_TITLE_LINE_HEIGHT) / 2
        lines.forEach((line, index) => {
          if (line.length === 0) return
          ops.push({
            kind: 'text',
            x: summary.label.x,
            y: startY + index * OVERLAY_TITLE_LINE_HEIGHT,
            text: line,
            fontSize: textStyle.fontSize,
            fontWeight: textStyle.bold ? 700 : 400,
            italic: textStyle.italic || undefined,
            fill: textStyle.color ?? color,
            anchor: textAnchorOf(
              summary.anchor === 'middle' ? 'center' : summary.anchor === 'end' ? 'right' : 'left'
            ),
            baseline: 'middle',
            stroke: input.background ?? '#ffffff',
            strokeWidth: 4
          })
        })
      }
    }
  }

  // 5. 节点
  for (const node of layout.nodes) nodeOps(node, layout, colors, input, ops)

  if (input.includeOverlays !== false) {
    // 6. 关系线画在节点之上
    for (const relationship of layout.relationships) {
      const color = relationship.branchId
        ? branchColorOf(colors, layout, relationship.branchId)
        : colors.deepText
      ops.push({ kind: 'path', d: relationship.d, stroke: color, strokeWidth: 1.8 })
      ops.push({
        kind: 'path',
        d: arrowPath(relationship.arrow.x, relationship.arrow.y, relationship.arrow.angle),
        fill: color
      })
      if (relationship.title) {
        ops.push({
          kind: 'text',
          x: relationship.label.x,
          y: relationship.label.y,
          text: relationship.title,
          fontSize: 12,
          fontWeight: 600,
          fill: color,
          anchor: 'middle',
          baseline: 'middle',
          stroke: input.background ?? '#ffffff',
          strokeWidth: 4
        })
      }
    }
  }

  return {
    width: layout.bounds.width,
    height: layout.bounds.height,
    background: input.background,
    ops
  }
}
