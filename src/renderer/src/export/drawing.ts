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
  CODE_FONT_FAMILY,
  CODE_FONT_SIZE,
  CODE_HEADER,
  CODE_LINE_RATIO,
  CODE_MAX_LINES,
  CODE_PADDING_X,
  CODE_PADDING_Y,
  codeBoxSize,
  imageBoxSize
} from '@shared/layout/accessory'
import type { ThemeColors, Topic } from '@shared/model/types'
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
  segments: Array<StyledSegment & { text: string }>
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
  | RectOp
  | PathOp
  | TextOp
  | LineTextOp
  | ImageOp
  | FormulaOp
  | BadgeOp
  | PieOp
  | GlyphOp

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

/** 图标行一行最多这么宽（与 measure.ts 里的 TEXT_MAX 一致） */
const ACCESSORY_MAX = 240
const ACCESSORY_GAP = 3
const LABEL_GAP = 4
const LABEL_HEIGHT = 18
const LABEL_PADDING_X = 7

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
  const mapped = points.map(([px, py]) => [x + px * cos - py * sin, y + px * sin + py * cos] as const)
  return `M ${mapped[0][0].toFixed(2)} ${mapped[0][1].toFixed(2)} L ${mapped[1][0].toFixed(2)} ${mapped[1][1].toFixed(2)} L ${mapped[2][0].toFixed(2)} ${mapped[2][1].toFixed(2)} Z`
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

  const includeMarkers = input.includeMarkers !== false
  if (includeMarkers && node.accessory.height > 0) {
    const items = node.accessory.items.filter((item) => item.kind === 'marker')
    const contentLeft = node.x + node.paddingX
    const contentRight = node.x + node.width - node.paddingX
    const limit = Math.max(16, Math.min(ACCESSORY_MAX, contentRight - contentLeft))

    // 先按「贪心换行、每行居中」把位置算出来，再统一生成指令——
    // 比先画后挪要清楚得多，也不会碰到已经生成的别的指令
    const rows: Array<Array<{ item: AccessoryItem; offset: number }>> = []
    let row: Array<{ item: AccessoryItem; offset: number }> = []
    let used = 0
    for (const item of items) {
      const next = row.length === 0 ? item.width : used + ACCESSORY_GAP + item.width
      if (row.length > 0 && next > limit) {
        rows.push(row)
        row = []
        used = 0
      }
      const offset = used === 0 ? 0 : used + ACCESSORY_GAP
      row.push({ item, offset })
      used = offset + item.width
    }
    if (row.length > 0) rows.push(row)

    let rowY = cursorY
    for (const current of rows) {
      const last = current[current.length - 1]
      const rowWidth = last ? last.offset + last.item.width : 0
      const shift = contentLeft + Math.max(0, (limit - rowWidth) / 2)
      for (const entry of current) {
        ops.push(...markerOps(entry.item, shift + entry.offset, rowY, entry.item.width))
      }
      rowY += 16 + ACCESSORY_GAP
    }
    cursorY = node.y + node.paddingY + node.accessory.height
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
      ops.push({
        kind: 'lineText',
        x: anchorX,
        y: cursorY,
        align: line.align,
        baseline: baselineIn(cursorY, line.height, fontSize),
        segments: line.segments.map((segment) => ({ ...segment })),
        color: visual.color
      })
    }
    cursorY += line.height
  }

  // 图片/公式的显示框优先用布局测量结果；个别测量实现没给时自己算一份，
  // 免得导出时整块内容凭空消失（与 TopicNode 的兜底逻辑保持一致）
  const imageBox = topic.image
    ? node.imageBox ?? imageBoxSize(topic.image)
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
    ? node.formulaBox ?? formulaSize(topic.formula, node.fontSize)
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

  // 代码块：底色圆角框 + 等宽文本逐行画（导出里不做语法高亮，保持可读即可）
  const codeBox = topic.code ? node.codeBox ?? codeBoxSize(topic.code) : { width: 0, height: 0 }
  if (topic.code && codeBox.height > 0) {
    cursorY += BLOCK_GAP
    const x = node.x + (node.width - codeBox.width) / 2
    ops.push({
      kind: 'rect',
      x,
      y: cursorY,
      w: codeBox.width,
      h: codeBox.height,
      r: 6,
      fill: 'rgba(15, 23, 42, 0.06)'
    })
    const codeLines = topic.code.text.length > 0 ? topic.code.text.split('\n') : ['']
    const lineH = Math.round(CODE_FONT_SIZE * CODE_LINE_RATIO)
    let textY = cursorY + CODE_HEADER + CODE_PADDING_Y + CODE_FONT_SIZE * 0.8
    for (const line of codeLines.slice(0, CODE_MAX_LINES)) {
      ops.push({
        kind: 'text',
        x: x + CODE_PADDING_X,
        y: textY,
        text: line,
        fontSize: CODE_FONT_SIZE,
        fontWeight: 400,
        fill: '#334155',
        anchor: 'start',
        baseline: 'alphabetic',
        fontFamily: CODE_FONT_FAMILY
      })
      textY += lineH
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
        stroke: decoration.branchId ? branchColorOf(colors, layout, decoration.branchId) : colors.deepText,
        strokeWidth: colors.edgeWidth * (decoration.widthScale ?? 1),
        opacity: decoration.dashed ? 0.5 : colors.edgeOpacity,
        dash: decoration.dashed ? '6 5' : undefined
      })
    }

    // 3. 边界：填充 + 描边
    for (const boundary of layout.boundaries) {
      const color = boundary.branchId ? branchColorOf(colors, layout, boundary.branchId) : colors.deepText
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
        ops.push({
          kind: 'text',
          x: boundary.label.x,
          y: boundary.label.y,
          text: boundary.title,
          fontSize: 12,
          fontWeight: 600,
          fill: color,
          anchor: 'start',
          baseline: 'middle'
        })
      }
    }

    // 4. 概要：大括号 + 文字（文字描一圈画布底色，压到别的内容上也读得清）
    for (const summary of layout.summaries) {
      const color = summary.branchId ? branchColorOf(colors, layout, summary.branchId) : colors.deepText
      ops.push({
        kind: 'path',
        d: summary.d,
        stroke: color,
        strokeWidth: 1.6,
        strokeOpacity: 0.75
      })
      if (summary.title) {
        ops.push({
          kind: 'text',
          x: summary.label.x,
          y: summary.label.y,
          text: summary.title,
          fontSize: 13,
          fontWeight: 600,
          fill: color,
          anchor: textAnchorOf(summary.anchor === 'middle' ? 'center' : summary.anchor === 'end' ? 'right' : 'left'),
          baseline: 'middle',
          stroke: input.background ?? '#ffffff',
          strokeWidth: 4
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
