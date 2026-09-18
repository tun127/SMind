/**
 * 三类画布级元素的构建：关系线 / 边界 / 概要。
 *
 * 单一职责：把区间与包围盒翻译成可渲染的几何体，并把整体边界撑大
 * （避免「适应画布」把这些元素切掉）。形状拼装见 ./shapes.ts。
 */
import type { NodeStyle, Relationship, Sheet, Topic } from '../../model/types'
import type { FoldSide } from '../../model/tree'
import { readOverlayFontSize } from '../../model/overlay-style'
import { round } from '../core'
import type { BoundaryLayout, LayoutResult, RelationshipLayout, SummaryLayout } from '../types'
import {
  BOUNDARY_FONT_SIZE,
  BOUNDARY_PAD,
  BOUNDARY_RADIUS,
  BOUNDARY_TITLE_H,
  RELATIONSHIP_FONT_SIZE,
  SUMMARY_FONT_SIZE,
  SUMMARY_GAP,
  SUMMARY_NIB,
  SUMMARY_SPINE
} from './metrics'
import {
  boundsOfTopics,
  indexSubtreeBounds,
  sameBounds,
  summarySideOf,
  type Bounds
} from './reserves'
import { indexTree, readCurveOffset, resolveRange, type TreeIndex } from './range'
import {
  OVERLAY_TITLE_LINE_HEIGHT,
  bracePath,
  estimateOverlayLabelSize,
  labelRectOf,
  overlayTitleLines,
  roundedRectPath,
  unionBounds
} from './shapes'

/* ------------------------------------------------------------------ */
/* 三类元素的构建                                                      */
/* ------------------------------------------------------------------ */

/** 关系线：从 A 的边框连到 B 的边框，向外鼓出弧形并带箭头 */
function relationshipOf(
  relationship: Relationship,
  result: LayoutResult
): RelationshipLayout | null {
  const from = result.nodeMap.get(relationship.end1Id)
  const to = result.nodeMap.get(relationship.end2Id)
  if (!from || !to || from.id === to.id) return null

  const centerOf = (node: typeof from): { x: number; y: number } => ({
    x: node.x + node.width / 2,
    y: node.y + node.height / 2
  })

  /** 从节点中心朝目标方向射出，与节点边框的交点 */
  const borderPoint = (
    node: typeof from,
    target: { x: number; y: number }
  ): { x: number; y: number } => {
    const center = centerOf(node)
    const dx = target.x - center.x
    const dy = target.y - center.y
    if (dx === 0 && dy === 0) return center
    const hw = node.width / 2
    const hh = node.height / 2
    const scale = Math.min(
      dx !== 0 ? hw / Math.abs(dx) : Number.POSITIVE_INFINITY,
      dy !== 0 ? hh / Math.abs(dy) : Number.POSITIVE_INFINITY
    )
    return { x: round(center.x + dx * scale), y: round(center.y + dy * scale) }
  }

  const start = borderPoint(from, centerOf(to))
  const end = borderPoint(to, centerOf(from))

  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  if (length < 1) return null

  /**
   * 弯度：按长度成比例，并给一个**下限**。
   *
   * 早先上限是 70px —— 一条横跨 1200px 的关系线只鼓 6%，视觉上就是**一条直线**，
   * 用户看到的就是"这根线直接穿过去"（截图里那条跨国画布的长线）。
   * 参考里关系线是**明显的曲线**（贴着节点绕开），所以按长度的 ~1/4 鼓出、下限 70、上限 240。
   */
  const bulge = Math.min(240, Math.max(70, length * 0.25))
  const nx = -dy / length
  const ny = dx / length
  const midX = (start.x + end.x) / 2
  const midY = (start.y + end.y) / 2

  // 往「远离画布中心」的一侧鼓出：否则弧线容易横穿中心区域，压到中心主题上
  const centerX = result.bounds.width / 2
  const centerY = result.bounds.height / 2
  const outward = Math.hypot(midX + nx * bulge - centerX, midY + ny * bulge - centerY)
  const inward = Math.hypot(midX - nx * bulge - centerX, midY - ny * bulge - centerY)
  const sign = outward >= inward ? 1 : -1

  // 用户拖动线身产生的偏移，直接加在控制点上：弧线与标题会一起移动
  const offset = readCurveOffset(relationship.style)
  const controlX = round(midX + nx * bulge * sign + offset.x)
  const controlY = round(midY + ny * bulge * sign + offset.y)

  // 二次贝塞尔在 t=0.5 处的点，作为标题位置
  const labelX = round(0.25 * start.x + 0.5 * controlX + 0.25 * end.x)
  const labelY = round(0.25 * start.y + 0.5 * controlY + 0.25 * end.y)

  // 标题那一小块就是这条线的「可选中区域」：点标题能选中它（线身留给拖拽）
  const labelSize = estimateOverlayLabelSize(
    relationship.title,
    readOverlayFontSize(relationship.style, RELATIONSHIP_FONT_SIZE)
  )
  return {
    id: relationship.id,
    title: relationship.title,
    branchId: relationship.end2Id,
    d: `M ${round(start.x)} ${round(start.y)} Q ${controlX} ${controlY} ${round(end.x)} ${round(end.y)}`,
    start: { x: start.x, y: start.y },
    arrow: { x: end.x, y: end.y, angle: Math.atan2(end.y - controlY, end.x - controlX) },
    label: { x: labelX, y: labelY },
    style: relationship.style,
    labelSize,
    bounds: labelRectOf({ x: labelX, y: labelY }, 'middle', labelSize)
  }
}

function boundaryOf(
  boundary: { id: string; range: string; title?: string; style?: NodeStyle },
  index: TreeIndex,
  boundsOf: Map<string, Bounds | null>
): BoundaryLayout | null {
  // 区间只解一次：以前这里解了两次（算包围盒一次、取 branchId 又一次）
  const topics = resolveRange(index, boundary.range)
  const bounds = boundsOfTopics(topics, boundsOf)
  if (!bounds) return null

  const hasTitle = Boolean(boundary.title && boundary.title.length > 0)
  const titleBand = hasTitle ? BOUNDARY_TITLE_H : 0
  const x = round(bounds.minX - BOUNDARY_PAD)
  const y = round(bounds.minY - BOUNDARY_PAD - titleBand)
  const width = round(bounds.maxX - bounds.minX + BOUNDARY_PAD * 2)
  const height = round(bounds.maxY - bounds.minY + BOUNDARY_PAD * 2 + titleBand)
  const labelSize = estimateOverlayLabelSize(
    boundary.title,
    readOverlayFontSize(boundary.style, BOUNDARY_FONT_SIZE)
  )

  return {
    id: boundary.id,
    title: boundary.title,
    branchId: topics[0]?.id,
    x,
    y,
    width,
    height,
    d: roundedRectPath(x, y, width, height, BOUNDARY_RADIUS),
    label: { x: round(x + 12), y: round(y + titleBand / 2 + 2) },
    labelSize,
    style: boundary.style,
    bounds: { x, y, width, height }
  }
}

function summaryOf(
  summary: { id: string; topicId: string; range: string; title?: string; style?: NodeStyle },
  index: TreeIndex,
  boundsOf: Map<string, Bounds | null>,
  sideOf: (topicId: string) => FoldSide
): SummaryLayout | null {
  const topics = resolveRange(index, summary.range)
  const bounds = boundsOfTopics(topics, boundsOf)
  if (!bounds) return null

  // 概要文字：优先用概要对象自带的标题，
  // 真实的 Xmind 文件里标题可能挂在 topicId 指向的主题上，需要回查。
  // 用 `!== undefined` 判断而不是「非空即真」：
  // 这样用户把文字清空（空串）时就是空，不会又冒出主题的文字。
  const topicTitle = summary.topicId ? index.byId.get(summary.topicId)?.title : undefined
  const title = summary.title !== undefined ? summary.title : topicTitle
  const fontSize = readOverlayFontSize(summary.style, SUMMARY_FONT_SIZE)
  const labelSize = estimateOverlayLabelSize(title, fontSize)

  /**
   * 朝哪个方向放括号：**必须与布局预留用同一判据**（结构家族，见 `summarySideOf`）。
   *
   * 这里以前按「父节点 → 区间中心」的主导轴算（`|dx| >= |dy|` 定横竖），
   * 于是把节点手动拉大——图片跟着等比放大、区间包围盒的重心明显偏移——
   * 就会在某一刻从「横向为主」翻成「纵向为主」，括号从左侧跳到上方。
   * 而且留白是按结构算的、画出来却按几何算，两者会各说各话：
   * 括号可能压在邻居身上，或落在根本没有留白的那一侧。
   */
  const firstTopic = topics[0]
  const side = sideOf(firstTopic?.id ?? '')
  const axis: 'v' | 'h' = side === 'left' || side === 'right' ? 'v' : 'h'
  const forward = side === 'right' || side === 'down'

  if (axis === 'v') {
    const spanStart = bounds.minY
    const spanEnd = bounds.maxY
    const base = forward ? bounds.maxX + SUMMARY_GAP : bounds.minX - SUMMARY_GAP
    const spine = forward ? base + SUMMARY_SPINE : base - SUMMARY_SPINE
    const nib = forward ? base + SUMMARY_NIB : base - SUMMARY_NIB
    // 括号朝右时文字接在右侧，朝左时接在左侧——否则文字会压在括号上
    const label = { x: round(forward ? nib + 10 : nib - 10), y: round((spanStart + spanEnd) / 2) }
    const anchor = forward ? 'start' : 'end'
    return {
      id: summary.id,
      title,
      branchId: firstTopic?.id ?? '',
      d: bracePath('v', spanStart, spanEnd, base, spine, nib),
      label,
      anchor,
      labelSize,
      style: summary.style,
      bounds: unionBounds([
        {
          x: Math.min(base, nib),
          y: spanStart,
          width: Math.abs(nib - base) + 4,
          height: spanEnd - spanStart
        },
        labelRectOf(label, anchor, labelSize)
      ])
    }
  }

  const spanStart = bounds.minX
  const spanEnd = bounds.maxX
  const base = forward ? bounds.maxY + SUMMARY_GAP : bounds.minY - SUMMARY_GAP
  const spine = forward ? base + SUMMARY_SPINE : base - SUMMARY_SPINE
  const nib = forward ? base + SUMMARY_NIB : base - SUMMARY_NIB
  const label = { x: round((spanStart + spanEnd) / 2), y: round(forward ? nib + 16 : nib - 8) }
  return {
    id: summary.id,
    title,
    branchId: firstTopic?.id ?? '',
    d: bracePath('h', spanStart, spanEnd, base, spine, nib),
    label,
    anchor: 'middle',
    labelSize,
    style: summary.style,
    bounds: unionBounds([
      {
        x: spanStart,
        y: Math.min(base, nib),
        width: spanEnd - spanStart,
        height: Math.abs(nib - base) + 4
      },
      labelRectOf(label, 'middle', labelSize)
    ])
  }
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 把画布级元素补进布局结果。
 * 同时把整体边界撑大，避免「适应画布」把这些元素切掉。
 */
export function addOverlays(result: LayoutResult, root: Topic, sheet: Sheet): void {
  const index = indexTree(root)
  // 子树包围盒只建一次：所有边界/概要共用（以前每个都各递归一遍自己的区间）
  const boundsOf = indexSubtreeBounds(root, result)
  // 括号朝哪一侧：与布局预留共用同一份结构判据（别各自算一套）
  const sideOf = summarySideOf(root, index.parentOf)

  for (const boundary of sheet.boundaries) {
    const layout = boundaryOf(boundary, index, boundsOf)
    if (layout) result.boundaries.push(layout)
  }

  for (const summary of sheet.summaries) {
    const layout = summaryOf(summary, index, boundsOf, sideOf)
    if (layout) result.summaries.push(layout)
  }

  for (const relationship of sheet.relationships) {
    const layout = relationshipOf(relationship, result)
    if (layout) result.relationships.push(layout)
  }

  let extent: Bounds | null = null
  for (const boundary of result.boundaries) {
    extent = extent
      ? sameBounds(extent, {
          minX: boundary.x,
          minY: boundary.y,
          maxX: boundary.x + boundary.width,
          maxY: boundary.y + boundary.height
        })
      : {
          minX: boundary.x,
          minY: boundary.y,
          maxX: boundary.x + boundary.width,
          maxY: boundary.y + boundary.height
        }
  }
  for (const relationship of result.relationships) {
    const points = [
      relationship.label,
      relationship.arrow,
      { x: relationship.label.x, y: relationship.label.y }
    ]
    for (const point of points) {
      const box = { minX: point.x - 60, minY: point.y - 24, maxX: point.x + 60, maxY: point.y + 24 }
      extent = extent ? sameBounds(extent, box) : box
    }
  }
  for (const summary of result.summaries) {
    // 多行标题要把上下都算进去，否则换行后的文字会跑出画布边界
    const lines = Math.max(1, overlayTitleLines(summary.title).length)
    const half = Math.max(20, (lines * OVERLAY_TITLE_LINE_HEIGHT) / 2 + 6)
    const box = {
      minX: summary.label.x - 80,
      minY: summary.label.y - half,
      maxX: summary.label.x + 200,
      maxY: summary.label.y + half
    }
    extent = extent ? sameBounds(extent, box) : box
  }

  if (extent) {
    result.bounds.width = round(Math.max(result.bounds.width, extent.maxX + 40))
    result.bounds.height = round(Math.max(result.bounds.height, extent.maxY + 40))
  }
}
