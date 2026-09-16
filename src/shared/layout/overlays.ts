/**
 * 画布级元素（关系线 / 边界 / 概要）的几何计算。
 *
 * 这些元素不属于树结构，但依赖节点的最终坐标，所以必须在布局归一化之后计算。
 * 所有坐标都是最终坐标（含 padding 偏移），渲染层直接使用，不再做任何换算。
 */
import type { NodeStyle, Relationship, Sheet, Topic } from '../model/types'
import { readOverlayFontSize } from '../model/overlay-style'
import { RELATIONSHIP_CURVE_KEY } from '../xmind/constants'
import { round } from './core'
import type { BoundaryLayout, LayoutResult, RelationshipLayout, SummaryLayout } from './types'

/* ------------------------------------------------------------------ */
/* 关系线弯度偏移                                                      */
/* ------------------------------------------------------------------ */

export interface CurveOffset {
  x: number
  y: number
}

/** 读出关系线被拖动产生的弯度偏移；没有或格式不对时返回零偏移 */
export function readCurveOffset(style: NodeStyle | undefined): CurveOffset {
  const raw = style?.properties?.[RELATIONSHIP_CURVE_KEY]
  if (typeof raw !== 'string' || raw.length === 0) return { x: 0, y: 0 }
  const parts = raw.split(',')
  if (parts.length !== 2) return { x: 0, y: 0 }
  const x = Number(parts[0])
  const y = Number(parts[1])
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 }
  return { x, y }
}

/** 写回弯度偏移；零偏移时把键清掉，避免在文件里留下无用字段 */
export function withCurveOffset(
  style: NodeStyle | undefined,
  offset: CurveOffset
): NodeStyle | undefined {
  const properties: Record<string, string> = { ...(style?.properties ?? {}) }
  if (offset.x === 0 && offset.y === 0) delete properties[RELATIONSHIP_CURVE_KEY]
  else properties[RELATIONSHIP_CURVE_KEY] = `${round(offset.x)},${round(offset.y)}`

  const id = style?.id
  if (Object.keys(properties).length === 0 && id === undefined) return undefined
  return id === undefined ? { properties } : { id, properties }
}

/* ------------------------------------------------------------------ */
/* 区间（Xmind 用 (topicId1,topicId2) 表示一段连续的同级主题）           */
/* ------------------------------------------------------------------ */

export function parseRange(range: string | undefined): [string, string] | null {
  const text = typeof range === 'string' ? range.trim() : ''
  if (text.length === 0) return null
  const pair = /^\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)$/.exec(text)
  if (pair) return [pair[1] ?? '', pair[2] ?? '']
  const single = /^\(\s*([^,()]+?)\s*\)$/.exec(text)
  if (single) return [single[1] ?? '', single[1] ?? '']
  return null
}

export interface TreeIndex {
  byId: Map<string, Topic>
  /** 根主题没有父级，其值为 undefined */
  parentOf: Map<string, string | undefined>
}

export function indexTree(root: Topic): TreeIndex {
  const byId = new Map<string, Topic>()
  const parentOf = new Map<string, string | undefined>()
  const walk = (topic: Topic, parentId: string | undefined): void => {
    byId.set(topic.id, topic)
    parentOf.set(topic.id, parentId)
    for (const child of topic.children) walk(child, topic.id)
  }
  walk(root, undefined)
  return { byId, parentOf }
}

/**
 * 把区间还原成具体主题列表。
 * 只有在「同一父级下的连续兄弟」时才展开，否则退化成单个主题，
 * 避免文件里的异常区间把不相关的节点也框进来。
 */
export function resolveRange(index: TreeIndex, range: string | undefined): Topic[] {
  const parsed = parseRange(range)
  if (!parsed) return []
  const [firstId, lastId] = parsed
  const first = index.byId.get(firstId)
  if (!first) return []
  if (firstId === lastId) return [first]

  const last = index.byId.get(lastId)
  const parentId = index.parentOf.get(firstId)
  if (!last || parentId === undefined || parentId !== index.parentOf.get(lastId)) return [first]

  const siblings = index.byId.get(parentId)?.children ?? []
  const ia = siblings.findIndex((topic) => topic.id === firstId)
  const ib = siblings.findIndex((topic) => topic.id === lastId)
  if (ia < 0 || ib < 0) return [first]

  return siblings.slice(Math.min(ia, ib), Math.max(ia, ib) + 1)
}

/** 两个区间是否指向同一段主题（忽略书写顺序与空格差异） */
export function sameRange(a: string | undefined, b: string | undefined): boolean {
  const left = parseRange(a)
  const right = parseRange(b)
  if (!left || !right) return false
  return (
    (left[0] === right[0] && left[1] === right[1]) || (left[0] === right[1] && left[1] === right[0])
  )
}

/** 由一组选中的主题算出区间字符串（取同一父级下成员最多的那一组） */
export function buildRange(root: Topic, ids: string[]): string | null {
  const index = indexTree(root)
  const valid = ids.filter((id) => index.byId.has(id))
  if (valid.length === 0) return null

  const groups = new Map<string, string[]>()
  for (const id of valid) {
    const parentId = index.parentOf.get(id)
    if (parentId === undefined) continue
    const bucket = groups.get(parentId) ?? []
    bucket.push(id)
    groups.set(parentId, bucket)
  }

  let best: string[] = []
  for (const bucket of groups.values()) {
    if (bucket.length > best.length) best = bucket
  }
  if (best.length === 0) {
    // 只选中了中心主题：区间退化成它自己
    return `(${valid[0]},${valid[0]})`
  }
  if (best.length === 1) return `(${best[0]},${best[0]})`

  const firstBest = best[0]
  if (!firstBest) return ''
  const parentId = index.parentOf.get(firstBest)
  const siblings = parentId === undefined ? [] : (index.byId.get(parentId)?.children ?? [])
  const marks = best
    .map((id) => siblings.findIndex((topic) => topic.id === id))
    .filter((position) => position >= 0)
    .sort((a, b) => a - b)
  if (marks.length === 0) return `(${firstBest},${firstBest})`

  const firstMark = marks[0]
  const lastMark = marks[marks.length - 1]
  const firstSibling = firstMark === undefined ? undefined : siblings[firstMark]
  const lastSibling = lastMark === undefined ? undefined : siblings[lastMark]
  if (!firstSibling || !lastSibling) return `(${firstBest},${firstBest})`
  return `(${firstSibling.id},${lastSibling.id})`
}

/* ------------------------------------------------------------------ */
/* 几何工具                                                            */
/* ------------------------------------------------------------------ */

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const EMPTY_BOUNDS: Bounds = {
  minX: Number.POSITIVE_INFINITY,
  minY: Number.POSITIVE_INFINITY,
  maxX: Number.NEGATIVE_INFINITY,
  maxY: Number.NEGATIVE_INFINITY
}

/** 主题及其所有后代的包围盒；折叠的子树不参与 */
function accumulateBounds(topic: Topic, result: LayoutResult, acc: Bounds): void {
  const node = result.nodeMap.get(topic.id)
  if (node) {
    acc.minX = Math.min(acc.minX, node.x)
    acc.minY = Math.min(acc.minY, node.y)
    acc.maxX = Math.max(acc.maxX, node.x + node.width)
    acc.maxY = Math.max(acc.maxY, node.y + node.height)
  }
  if (topic.collapsed) return
  for (const child of topic.children) accumulateBounds(child, result, acc)
}

/**
 * 全树「子树包围盒」索引：一次后序遍历 O(n) 建好（键是主题 id）。
 *
 * 以前每个边界/概要都各自递归一遍自己区间的子树——B 个边界就是 O(B × 节点数)。
 * AI 一批加十几个边界/概要时这项会明显放大；建一次索引后，
 * 取任一区间的包围盒只花 O(区间长度)。
 */
function indexSubtreeBounds(root: Topic, result: LayoutResult): Map<string, Bounds | null> {
  const map = new Map<string, Bounds | null>()
  const visit = (topic: Topic): Bounds | null => {
    const node = result.nodeMap.get(topic.id)
    let acc: Bounds | null = node
      ? { minX: node.x, minY: node.y, maxX: node.x + node.width, maxY: node.y + node.height }
      : null
    if (!topic.collapsed) {
      for (const child of topic.children) {
        const childBounds = visit(child)
        if (childBounds) acc = acc ? sameBounds(acc, childBounds) : childBounds
      }
    }
    map.set(topic.id, acc)
    return acc
  }
  visit(root)
  return map
}

function boundsOfTopics(topics: Topic[], boundsOf: Map<string, Bounds | null>): Bounds | null {
  let acc: Bounds | null = null
  for (const topic of topics) {
    const item = boundsOf.get(topic.id)
    if (item) acc = acc ? sameBounds(acc, item) : item
  }
  return acc
}

function sameBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY)
  }
}

/**
 * 边界/概要向外占用的空间（按「区间两端那个主题」记账）。
 *
 * 背景：边界与概要画在区间**外面**，以前布局完全不为此留白——紧邻的分支
 * （上一个/下一个兄弟，或组织架构图里的右邻居）就可能被标题带或括号压住。
 * Xmind 的布局引擎会预留，这里用同一套常量把「要留多少」交给布局：
 * - `top`：区间第一个主题上方 = 边框内边距 + （有标题时的）标题带；
 * - `bottom`：区间最后一个主题下方 = 边框内边距；
 * - `right`：概要括号在区间外侧，需要「间距 + 尖点 + 一点文字宽度」。
 *
 * 与绘制共用同一批常量（`BOUNDARY_PAD` / `BOUNDARY_TITLE_H` / `SUMMARY_*`），
 * 所以「留出来的白」与「画出来的黑」不会各说各话。
 */
export interface OverlayReserves {
  top: Map<string, number>
  bottom: Map<string, number>
  right: Map<string, number>
}

export function overlayReserves(root: Topic, sheet: Sheet): OverlayReserves {
  const index = indexTree(root)
  const top = new Map<string, number>()
  const bottom = new Map<string, number>()
  const right = new Map<string, number>()
  const bump = (map: Map<string, number>, id: string, value: number): void => {
    map.set(id, Math.max(map.get(id) ?? 0, value))
  }

  for (const boundary of sheet.boundaries) {
    const topics = resolveRange(index, boundary.range)
    const first = topics[0]
    const last = topics[topics.length - 1]
    if (!first || !last) continue
    const titleBand = boundary.title && boundary.title.length > 0 ? BOUNDARY_TITLE_H : 0
    bump(top, first.id, BOUNDARY_PAD + titleBand)
    bump(bottom, last.id, BOUNDARY_PAD)
  }

  for (const summary of sheet.summaries) {
    const topics = resolveRange(index, summary.range)
    const last = topics[topics.length - 1]
    if (!last) continue
    // 括号 → 尖点 → 文字；文字宽度不可预知，按一个保守的定值留一点
    bump(right, last.id, SUMMARY_GAP + SUMMARY_NIB + 48)
  }

  return { top, bottom, right }
}

export function boundsOfRange(
  result: LayoutResult,
  index: TreeIndex,
  range: string | undefined
): Bounds | null {
  const topics = resolveRange(index, range)
  if (topics.length === 0) return null
  const acc = { ...EMPTY_BOUNDS }
  for (const topic of topics) accumulateBounds(topic, result, acc)
  return Number.isFinite(acc.minX) ? acc : null
}

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
function bracePath(
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

  const bulge = Math.min(70, length * 0.24)
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

const BOUNDARY_PAD = 16
const BOUNDARY_TITLE_H = 22
const BOUNDARY_RADIUS = 12

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

const SUMMARY_GAP = 12
const SUMMARY_SPINE = 10
const SUMMARY_NIB = 20
/** 概要与边界标题的默认字号（与画布上的默认值一致，样式里写了就以样式为准） */
const SUMMARY_FONT_SIZE = 13
const BOUNDARY_FONT_SIZE = 12
const RELATIONSHIP_FONT_SIZE = 12
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
function unionBounds(
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
function labelRectOf(
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

function summaryOf(
  summary: { id: string; topicId: string; range: string; title?: string; style?: NodeStyle },
  result: LayoutResult,
  index: TreeIndex,
  boundsOf: Map<string, Bounds | null>
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

  // 朝哪个方向放括号：由「父节点 -> 区间中心」的主导轴决定
  const firstTopic = topics[0]
  const parentId = firstTopic ? index.parentOf.get(firstTopic.id) : undefined
  const parentNode = parentId === undefined ? undefined : result.nodeMap.get(parentId)
  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerY = (bounds.minY + bounds.maxY) / 2

  let axis: 'v' | 'h'
  let forward: boolean
  if (parentNode) {
    const dx = centerX - (parentNode.x + parentNode.width / 2)
    const dy = centerY - (parentNode.y + parentNode.height / 2)
    if (Math.abs(dx) >= Math.abs(dy)) {
      axis = 'v'
      forward = dx >= 0
    } else {
      axis = 'h'
      forward = dy >= 0
    }
  } else {
    axis = bounds.maxY - bounds.minY >= bounds.maxX - bounds.minX ? 'v' : 'h'
    forward = true
  }

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

  for (const boundary of sheet.boundaries) {
    const layout = boundaryOf(boundary, index, boundsOf)
    if (layout) result.boundaries.push(layout)
  }

  for (const summary of sheet.summaries) {
    const layout = summaryOf(summary, result, index, boundsOf)
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
