/**
 * 布局内核。
 *
 * 约定：布局算法分两个阶段
 *   1. 摆放（place）：只确定每个节点的 x / y
 *   2. 连线（connect）：在坐标归一化之后，用最终坐标生成连线与装饰
 *
 * 这样拆分的原因是连线是 SVG path 字符串，无法随坐标平移，
 * 必须在最终坐标确定后再生成，才能避免反复换算偏移量。
 */
import type { StructureClass, Topic } from '../model/types'
import { DEFAULT_STRUCTURE, getStructureDef } from '../xmind/constants'
import type {
  Decoration,
  EdgeLayout,
  LayoutBounds,
  LayoutResult,
  MeasureFn,
  MeasureResult,
  NodeLayout,
  Side
} from './types'

export const LAYOUT_DEFAULTS = { gapX: 56, gapY: 18, padding: 60 }

export function round(n: number): number {
  return Math.round(n * 10) / 10
}

export type Anchor = 'left' | 'right' | 'top' | 'bottom' | 'center'

export interface Point {
  x: number
  y: number
}

export function anchorPoint(node: NodeLayout, anchor: Anchor): Point {
  switch (anchor) {
    case 'left':
      return { x: node.x, y: round(node.y + node.height / 2) }
    case 'right':
      return { x: round(node.x + node.width), y: round(node.y + node.height / 2) }
    case 'top':
      return { x: round(node.x + node.width / 2), y: node.y }
    case 'bottom':
      return { x: round(node.x + node.width / 2), y: round(node.y + node.height) }
    default:
      return { x: round(node.x + node.width / 2), y: round(node.y + node.height / 2) }
  }
}

/* ------------------------------------------------------------------ */
/* 连线路径                                                            */
/* ------------------------------------------------------------------ */

export type ConnectorKind = 'bezier' | 'elbow-h' | 'elbow-v' | 'line'

export function pathFor(kind: ConnectorKind, from: Point, to: Point): string {
  const x1 = round(from.x)
  const y1 = round(from.y)
  const x2 = round(to.x)
  const y2 = round(to.y)

  switch (kind) {
    case 'line':
      return `M ${x1} ${y1} L ${x2} ${y2}`
    case 'elbow-h': {
      const midX = round(x1 + (x2 - x1) / 2)
      return `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`
    }
    case 'elbow-v': {
      const midY = round(y1 + (y2 - y1) / 2)
      return `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`
    }
    default: {
      const midX = round(x1 + (x2 - x1) / 2)
      return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`
    }
  }
}

/* ------------------------------------------------------------------ */
/* 布局构建器                                                          */
/* ------------------------------------------------------------------ */

export class LayoutBuilder {
  readonly nodes: NodeLayout[] = []
  readonly nodeMap = new Map<string, NodeLayout>()

  private readonly sizes = new Map<string, MeasureResult>()
  private readonly verticalCache = new Map<string, number>()
  private readonly horizontalCache = new Map<string, number>()
  private readonly subtreeExtentCache = new Map<string, { width: number; height: number }>()
  private readonly finishHooks: Array<(result: LayoutResult) => void> = []

  constructor(
    private readonly measure: MeasureFn,
    readonly gapX: number = LAYOUT_DEFAULTS.gapX,
    readonly gapY: number = LAYOUT_DEFAULTS.gapY,
    readonly padding: number = LAYOUT_DEFAULTS.padding
  ) {}

  measureAll(root: Topic): void {
    const walk = (topic: Topic, depth: number): void => {
      this.sizes.set(topic.id, this.measure(topic, depth))
      for (const child of topic.children) walk(child, depth + 1)
    }
    walk(root, 0)
  }

  size(id: string): MeasureResult {
    const size = this.sizes.get(id)
    if (!size) throw new Error(`布局：节点 ${id} 尚未测量`)
    return size
  }

  add(topic: Topic, x: number, y: number, depth: number, side: Side): NodeLayout {
    const size = this.size(topic.id)
    const node: NodeLayout = {
      id: topic.id,
      topic,
      x: round(x),
      y: round(y),
      width: size.width,
      height: size.height,
      depth,
      side,
      lines: size.lines,
      fontSize: size.fontSize,
      lineHeight: size.lineHeight,
      paddingX: size.paddingX,
      paddingY: size.paddingY,
      accessory: size.accessory,
      labelRow: size.labelRow,
      imageBox: size.imageBox,
      formulaBox: size.formulaBox,
      codeBox: size.codeBox
    }
    this.nodes.push(node)
    this.nodeMap.set(topic.id, node)
    return node
  }

  /** 子树垂直占用的高度（含自身与间距） */
  verticalExtent(topic: Topic): number {
    const cached = this.verticalCache.get(topic.id)
    if (cached !== undefined) return cached
    const size = this.size(topic.id)
    const kids = topic.collapsed ? [] : topic.children
    let total = 0
    for (let i = 0; i < kids.length; i += 1) {
      total += this.verticalExtent(kids[i]) + (i > 0 ? this.gapY : 0)
    }
    const value = Math.max(size.height, kids.length > 0 ? total : 0)
    this.verticalCache.set(topic.id, value)
    return value
  }

  /** 子树水平占用的宽度（含自身与间距） */
  horizontalExtent(topic: Topic): number {
    const cached = this.horizontalCache.get(topic.id)
    if (cached !== undefined) return cached
    const size = this.size(topic.id)
    const kids = topic.collapsed ? [] : topic.children
    let total = 0
    for (let i = 0; i < kids.length; i += 1) {
      total += this.horizontalExtent(kids[i]) + (i > 0 ? this.gapX : 0)
    }
    const value = Math.max(size.width, kids.length > 0 ? total : 0)
    this.horizontalCache.set(topic.id, value)
    return value
  }

  visibleChildren(topic: Topic): Topic[] {
    return topic.collapsed ? [] : topic.children
  }

  /** 子树层数：叶子返回 1 */
  maxDepth(topic: Topic): number {
    let depth = 0
    for (const child of this.visibleChildren(topic)) {
      depth = Math.max(depth, this.maxDepth(child))
    }
    return depth + 1
  }

  /** 直接子节点纵向排列所需的总高度（不含自身） */
  childrenColumnHeight(topic: Topic): number {
    const kids = this.visibleChildren(topic)
    let total = 0
    for (let i = 0; i < kids.length; i += 1) {
      total += this.size(kids[i].id).height + (i > 0 ? this.gapY : 0)
    }
    return total
  }

  /** 注册一个「坐标归一化之后」执行的钩子：嵌套结构的装饰与连线要在最终坐标上补画 */
  onFinish(hook: (result: LayoutResult) => void): void {
    this.finishHooks.push(hook)
  }

  /**
   * 家族感知的子树占用：按 topic 声明的结构家族计算宽高。
   *
   * 与 verticalExtent / horizontalExtent 的区别：当分支自己声明了不同结构时，
   * 它的子树可能是横向铺行（组织架构图）或沿主脊展开（鱼骨图），
   * 占用不能再套用「垂直堆叠」的公式——否则兄弟分支会与它重叠。
   *
   * @param cls 从父链继承下来的有效结构（topic 自己的 structureClass 优先）
   */
  subtreeExtent(topic: Topic, cls: StructureClass | undefined): { width: number; height: number } {
    const key = topic.id + '\u0000' + (cls ?? '')
    const cached = this.subtreeExtentCache.get(key)
    if (cached) return cached

    const effective = topic.structureClass ?? cls ?? DEFAULT_STRUCTURE
    const family = getStructureDef(effective).family
    const size = this.size(topic.id)
    const kids = this.visibleChildren(topic)

    let extent: { width: number; height: number }
    if (kids.length === 0) {
      extent = { width: size.width, height: size.height }
    } else if (family === 'orgchart') {
      // 横向铺行：宽 = 各子树宽之和；高 = 自身 + 一行里最高的子树
      let width = 0
      let childHeight = 0
      kids.forEach((child, index) => {
        width += this.horizontalExtent(child) + (index > 0 ? this.gapX : 0)
        childHeight = Math.max(childHeight, this.subtreeExtent(child, effective).height)
      })
      extent = { width: Math.max(size.width, width), height: size.height + this.gapY + childHeight }
    } else if (family === 'fishbone') {
      // 沿主脊向右展开：宽 = 自身 + 各分支横向占用；高 = 上下骨刺 + 最深一列
      const boneOffset = Math.max(size.height / 2 + this.gapY * 3, 46)
      let width = size.width + this.gapX * 2
      let columnHeight = 0
      for (const child of kids) {
        width += this.horizontalExtent(child) + this.gapX
        columnHeight = Math.max(columnHeight, this.verticalExtent(child))
      }
      extent = { width, height: size.height + boneOffset * 2 + columnHeight + this.gapY * 2 }
    } else {
      // 垂直堆叠家族（以及暂不支持的家族按逻辑图回落）
      let height = 0
      kids.forEach((child, index) => {
        height += this.subtreeExtent(child, effective).height + (index > 0 ? this.gapY : 0)
      })
      extent = { width: size.width, height: Math.max(size.height, height) }
    }

    this.subtreeExtentCache.set(key, extent)
    return extent
  }

  /** 归一化坐标、计算边界与分支配色索引 */
  finish(root: Topic): LayoutResult {
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const node of this.nodes) {
      if (node.x < minX) minX = node.x
      if (node.y < minY) minY = node.y
      if (node.x + node.width > maxX) maxX = node.x + node.width
      if (node.y + node.height > maxY) maxY = node.y + node.height
    }
    if (!Number.isFinite(minX)) {
      minX = 0
      minY = 0
      maxX = 0
      maxY = 0
    }

    const dx = this.padding - minX
    const dy = this.padding - minY
    for (const node of this.nodes) {
      node.x = round(node.x + dx)
      node.y = round(node.y + dy)
    }

    const bounds: LayoutBounds = {
      x: 0,
      y: 0,
      width: round(maxX - minX + this.padding * 2),
      height: round(maxY - minY + this.padding * 2)
    }

    const branchIndex = new Map<string, number>()
    branchIndex.set(root.id, -1)
    root.children.forEach((child, index) => {
      const mark = (topic: Topic): void => {
        branchIndex.set(topic.id, index)
        for (const grand of topic.children) mark(grand)
      }
      mark(child)
    })

    const result: LayoutResult = {
      nodes: this.nodes,
      nodeMap: this.nodeMap,
      edges: [],
      decorations: [],
      bounds,
      branchIndex,
      relationships: [],
      boundaries: [],
      summaries: []
    }
    // 嵌套结构（如分支上的鱼骨图）的主脊、骨刺要在最终坐标上补画
    for (const hook of this.finishHooks) hook(result)
    return result
  }
}

/* ------------------------------------------------------------------ */
/* 连线与装饰的收集                                                    */
/* ------------------------------------------------------------------ */

export function addEdge(result: LayoutResult, fromId: string, toId: string, from: Point, to: Point, kind: ConnectorKind): void {
  const edge: EdgeLayout = { fromId, toId, d: pathFor(kind, from, to) }
  result.edges.push(edge)
}

export function addDecoration(result: LayoutResult, decoration: Decoration): void {
  result.decorations.push(decoration)
}

/**
 * 沿树生成父子连线。
 * @param anchorOf 由各结构决定从父节点/子节点的哪个锚点连出
 */
export function connectTree(
  result: LayoutResult,
  root: Topic,
  kind: ConnectorKind,
  anchorOf: (parent: NodeLayout, child: NodeLayout) => { from: Anchor; to: Anchor }
): void {
  const walk = (topic: Topic): void => {
    const parent = result.nodeMap.get(topic.id)
    if (!parent) return
    for (const child of topic.collapsed ? [] : topic.children) {
      const childNode = result.nodeMap.get(child.id)
      if (!childNode) continue
      // 括号图：括号本身就是连线，父子边不再重复画（括号由 placeBraceChildren 的钩子补）
      if (topic.structureClass && getStructureDef(topic.structureClass).family === 'brace') {
        walk(child)
        continue
      }
      const anchors = anchorOf(parent, childNode)
      addEdge(result, parent.id, childNode.id, anchorPoint(parent, anchors.from), anchorPoint(childNode, anchors.to), kind)
      walk(child)
    }
  }
  walk(root)
}

/** 水平方向堆叠时的默认锚点：父的右/左边 -> 子的左/右边 */
export function horizontalAnchors(parent: NodeLayout, child: NodeLayout): { from: Anchor; to: Anchor } {
  return child.side === 'left' ? { from: 'left', to: 'right' } : { from: 'right', to: 'left' }
}

/** 垂直方向堆叠时的默认锚点：父的下/上边 -> 子的上/下边 */
export function verticalAnchors(parent: NodeLayout, child: NodeLayout): { from: Anchor; to: Anchor } {
  return child.y + child.height / 2 < parent.y + parent.height / 2
    ? { from: 'top', to: 'bottom' }
    : { from: 'bottom', to: 'top' }
}

/** 曲线圆角括号 {@code (} 形状，用于括号图；竖直列在 x，尖端向左突出 */
export function bracePath(x: number, yTop: number, yBottom: number, tipX: number): string {
  const span = yBottom - yTop
  const r = Math.max(2, Math.min(12, span / 4))
  const yMid = round((yTop + yBottom) / 2)
  return [
    `M ${round(x)} ${round(yTop)}`,
    `Q ${round(tipX)} ${round(yTop)}, ${tipX} ${round(yTop + r)}`,
    `L ${tipX} ${round(yMid - r)}`,
    `Q ${tipX} ${yMid}, ${round(tipX - r)} ${yMid}`,
    `Q ${tipX} ${yMid}, ${tipX} ${round(yMid + r)}`,
    `L ${tipX} ${round(yBottom - r)}`,
    `Q ${round(tipX)} ${round(yBottom)}, ${round(x)} ${round(yBottom)}`
  ].join(' ')
}
