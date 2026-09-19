/**
 * 导出用的**绘制指令类型**（由 ./drawing.ts 按行范围搬出，行为零变化）。
 *
 * 拆出来的理由：svg.ts / raster.ts 只消费这些类型，而入口 drawing.ts 里是"构建逻辑"。
 * 类型独立成文件后，两个后端与构建器之间不再有隐式的整体依赖。
 */
import type { LayoutResult, StyledSegment } from '@shared/layout/types'
import type { ThemeColors } from '@shared/model/types'
import type { IconName } from '@shared/marker-art'

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
  /**
   * 虚线样式（`stroke-dasharray` 的写法，如 `'4 3'`）。画布上用 CSS `border: 1px dashed`
   * 表达的「这里本该有东西但缺了」（图片资源缺失的占位框），导出要用同一种笔触，
   * 否则同一份内容在画布与图片里长得不一样。与 `PathOp.dash` 是同一种表示法。
   */
  dash?: string
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
  glyph: IconName
  /** 线宽；缺省用标记图标的线宽（指示图标细一档） */
  strokeWidth?: number
  /** 整体不透明度；指示图标比正文浅一档 */
  opacity?: number
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
