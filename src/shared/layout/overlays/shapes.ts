/**
 * path 形状与标题尺寸估算。
 *
 * 单一职责：只做「把数字变成 SVG path」和「按字数估一块文字占多大」，
 * 不做语义判断（哪个区间、什么方向），因此可以独立验证。
 */
import { round } from '../core'

/* ------------------------------------------------------------------ */
/* 括号形状                                                            */
/* ------------------------------------------------------------------ */

/**
 * 生成大括号路径。
 * @param axis 'v' 表示括号竖向站立（跨度沿 y）、'h' 表示横躺（跨度沿 x）
 * @param spanStart/spanEnd 跨度范围（已排序）
 * @param base 两端勾的位置（竖向时是 x 坐标，横向时是 y 坐标）
 * @param spine 主干位置；nib 是中间尖点位置
 */
export function bracePath(
  axis: 'v' | 'h',
  spanStart: number,
  spanEnd: number,
  base: number,
  spine: number,
  nib: number
): string {
  const mid = (spanStart + spanEnd) / 2
  const r = Math.max(2, Math.min(14, (spanEnd - spanStart) / 4))
  const p = (s: number, t: number): string =>
    axis === 'v' ? `${round(t)} ${round(s)}` : `${round(s)} ${round(t)}`
  return [
    `M ${p(spanStart, base)}`,
    `Q ${p(spanStart, spine)} ${p(spanStart + r, spine)}`,
    `L ${p(mid - r, spine)}`,
    `Q ${p(mid, spine)} ${p(mid, nib)}`,
    `Q ${p(mid, spine)} ${p(mid + r, spine)}`,
    `L ${p(spanEnd - r, spine)}`,
    `Q ${p(spanEnd, spine)} ${p(spanEnd, base)}`
  ].join(' ')
}

/** 圆角矩形的 path；所有矩形都按同一方向走，保证合并后重叠区域只填一次 */
export function roundedRectPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): string {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  const right = x + width
  const bottom = y + height
  return [
    `M ${round(x + r)} ${round(y)}`,
    `H ${round(right - r)}`,
    `A ${r} ${r} 0 0 1 ${round(right)} ${round(y + r)}`,
    `V ${round(bottom - r)}`,
    `A ${r} ${r} 0 0 1 ${round(right - r)} ${round(bottom)}`,
    `H ${round(x + r)}`,
    `A ${r} ${r} 0 0 1 ${round(x)} ${round(bottom - r)}`,
    `V ${round(y + r)}`,
    `A ${r} ${r} 0 0 1 ${round(x + r)} ${round(y)}`,
    'Z'
  ].join(' ')
}

/** 概要 / 边界标题的行高（多行时按它排布，画布与导出共用） */
export const OVERLAY_TITLE_LINE_HEIGHT = 15

/** 概要 / 边界标题按显式换行拆行（渲染与导出共用，空行保留以便对齐） */
export function overlayTitleLines(title: string | undefined): string[] {
  if (!title) return []
  return title.split(/\r?\n/)
}

/**
 * 标题文字块的**尺寸估算**。
 *
 * 布局层拿不到 DOM（不能真要一次文本测量，否则布局就依赖渲染了），
 * 这里按「CJK 记双宽 × 字号的 0.55」粗估——它只用于**命中区与选中框**，
 * 不参与排版，所以粗一点没关系；标题为空时给一个最小占位尺寸，
 * 保证「删空文字后仍能点到概要」。
 */
export function estimateOverlayLabelSize(
  title: string | undefined,
  fontSize: number,
  minWidth = 48
): { width: number; height: number } {
  const lines = overlayTitleLines(title)
  if (lines.length === 0) return { width: minWidth, height: OVERLAY_TITLE_LINE_HEIGHT }
  let units = 0
  for (const line of lines) {
    let count = 0
    for (const ch of line) count += ch.charCodeAt(0) > 0xff ? 2 : 1
    units = Math.max(units, count)
  }
  return {
    width: Math.max(minWidth, Math.round(units * fontSize * 0.55) + 8),
    height: lines.length * OVERLAY_TITLE_LINE_HEIGHT
  }
}

/** 由若干矩形求并集包围盒 */
export function unionBounds(
  boxes: Array<{ x: number; y: number; width: number; height: number }>
): { x: number; y: number; width: number; height: number } | undefined {
  if (boxes.length === 0) return undefined
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const box of boxes) {
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
    maxX = Math.max(maxX, box.x + box.width)
    maxY = Math.max(maxY, box.y + box.height)
  }
  return { x: round(minX), y: round(minY), width: round(maxX - minX), height: round(maxY - minY) }
}

/** 以锚点方式摆放的标题所占矩形 */
export function labelRectOf(
  label: { x: number; y: number },
  anchor: 'start' | 'middle' | 'end',
  size: { width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const left =
    anchor === 'start'
      ? label.x
      : anchor === 'end'
        ? label.x - size.width
        : label.x - size.width / 2
  return { x: left, y: label.y - size.height / 2, width: size.width, height: size.height }
}
