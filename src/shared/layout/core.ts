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

/**
 * 连线形状。
 *
 * `spine` 是给**纵向列**用的：子节点在父节点的正上/正下方（时间轴的刻目、鱼骨的骨刺、
 * 矩阵的格位、树状表格的列）。这类子节点不能用"父下 → 子上"的直线连——
 * 兄弟排在同一列上，连到更远那个的线会从更近那个身上**穿过去**；
 * 正确形状是「父节点 → 侧边的竖脊 → 横着进子节点侧缘」：一条脊 + 一排短横线，
 * 读起来就是一份列表（Xmind 的时间轴 / 鱼骨也是这个形状）。
 */
export type ConnectorKind = 'bezier' | 'elbow-h' | 'elbow-v' | 'spine' | 'line'

/** 竖脊与子节点侧缘之间留的空隙 */
const SPINE_GAP = 8

/**
 * 列脊的折点：父节点锚点 → 先离开一小段 → 走到脊 → 沿脊走 → 横入子节点侧缘。
 *
 * 两个方向的列都走这一套：子节点在**正上/正下方**（时间轴刻目、鱼骨骨刺、矩阵格位）
 * 脊是竖的；在**正左/正右**（树状表格的列头与条目）脊是横的。
 *
 * 脊的位置按**这一列的所有子节点**算，而不是只看当前这个：某个兄弟被手动拖偏之后，
 * 按单个子节点算出来的脊会落在那个兄弟的范围里，连线又从它身上穿过去了。
 * 同理，"离开父节点的一小段"走在父节点与最近那个子节点之间的空档里，
 * 免得那条线贴着子节点的边缘蹭过去。
 */
function spinePoints(result: LayoutResult, parent: NodeLayout, child: NodeLayout): Point[] {
  const boxes = (parent.topic.collapsed ? [] : parent.topic.children)
    .map((topic) => result.nodeMap.get(topic.id))
    .filter((node): node is NodeLayout => node !== undefined)
  const column = boxes.length > 0 ? boxes : [child]

  const pcx = parent.x + parent.width / 2
  const pcy = parent.y + parent.height / 2
  const ccx = child.x + child.width / 2
  const ccy = child.y + child.height / 2
  const vertical = Math.abs(ccy - pcy) >= Math.abs(ccx - pcx)

  if (vertical) {
    const below = ccy >= pcy
    const anchorY = below ? round(parent.y + parent.height) : parent.y
    const from: Point = { x: round(pcx), y: anchorY }
    // 子节点在父节点中线的右侧 → 从它的左边进（脊总在整列的外侧）
    const enterLeft = ccx >= pcx
    const to: Point = { x: enterLeft ? child.x : round(child.x + child.width), y: round(ccy) }
    const spineX = enterLeft
      ? Math.min(from.x, Math.min(...column.map((node) => node.x)) - SPINE_GAP)
      : Math.max(from.x, Math.max(...column.map((node) => node.x + node.width)) + SPINE_GAP)
    const nearest = column.reduce(
      (acc, node) => (below ? Math.min(acc, node.y) : Math.max(acc, node.y)),
      anchorY
    )
    const gap = Math.abs(nearest - anchorY)
    const departY = round(anchorY + (below ? 1 : -1) * Math.max(2, Math.min(SPINE_GAP, gap / 2)))
    return [
      from,
      { x: from.x, y: departY },
      { x: round(spineX), y: departY },
      { x: round(spineX), y: to.y },
      to
    ]
  }

  /**
   * 子节点在**另一个列**里（树状表格：父在左列，子在同一右列里上下堆叠）。
   * 脊竖在父列与子列之间：父节点横出来接脊 → 沿脊上下 → 再逐格横进子节点侧缘。
   * 脊落在**所有子节点的外侧**，所以不会从任何一个兄弟身上穿过去。
   */
  const right = ccx >= pcx
  const near = right
    ? Math.min(...column.map((node) => node.x)) - SPINE_GAP
    : Math.max(...column.map((node) => node.x + node.width)) + SPINE_GAP
  const railX = right
    ? Math.max(near, round(parent.x + parent.width) + 4)
    : Math.min(near, parent.x - 4)
  const from: Point = { x: right ? round(parent.x + parent.width) : parent.x, y: round(pcy) }
  const to: Point = {
    x: right ? child.x : round(child.x + child.width),
    y: round(ccy)
  }
  return [from, { x: round(railX), y: from.y }, { x: round(railX), y: to.y }, to]
}

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
  private readonly depthCache = new Map<string, number>()
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
      codeBox: size.codeBox,
      codeMetrics: size.codeMetrics,
      markerStrip: size.markerStrip
    }
    this.nodes.push(node)
    this.nodeMap.set(topic.id, node)
    return node
  }

  /** 子树垂直占用的高度（含自身与间距、以及边界/概要的预留） */
  verticalExtent(topic: Topic): number {
    const cached = this.verticalCache.get(topic.id)
    if (cached !== undefined) return cached
    const size = this.size(topic.id)
    const kids = topic.collapsed ? [] : topic.children
    let total = 0
    for (let i = 0; i < kids.length; i += 1) {
      const kid = kids[i]
      if (!kid) continue
      // 预留量要一起往上传播：否则祖先那一层按「没有留白」估槽位，又会压回来
      total +=
        this.verticalExtent(kid) +
        this.reserveTop(kid) +
        this.reserveBottom(kid) +
        (i > 0 ? this.gapY : 0)
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
      const kid = kids[i]
      if (!kid) continue
      total += this.horizontalExtent(kid) + (i > 0 ? this.gapX : 0)
    }
    const value = Math.max(size.width, kids.length > 0 ? total : 0)
    this.horizontalCache.set(topic.id, value)
    return value
  }

  visibleChildren(topic: Topic): Topic[] {
    return topic.collapsed ? [] : topic.children
  }

  /**
   * 子树层数：叶子返回 1。
   *
   * 按 id 缓存：鱼骨图与时间轴会对**每个一级分支**问一次（用来定主脊长度），
   * 分支自己又声明同类结构时会层层再问——不缓存就退化成 O(节点数 × 深度)。
   * 只依赖树的形状（`collapsed` 只在跑布局前定好），一次布局里结果恒定。
   */
  maxDepth(topic: Topic): number {
    const cached = this.depthCache.get(topic.id)
    if (cached !== undefined) return cached
    let depth = 0
    for (const child of this.visibleChildren(topic)) {
      depth = Math.max(depth, this.maxDepth(child))
    }
    const value = depth + 1
    this.depthCache.set(topic.id, value)
    return value
  }

  /** 直接子节点纵向排列所需的总高度（不含自身） */
  childrenColumnHeight(topic: Topic): number {
    const kids = this.visibleChildren(topic)
    let total = 0
    for (let i = 0; i < kids.length; i += 1) {
      const kid = kids[i]
      if (!kid) continue
      total += this.size(kid.id).height + (i > 0 ? this.gapY : 0)
    }
    return total
  }

  /* ---- 边界 / 概要用掉的外侧空间（见 overlays.overlayReserves） ---- */
  private overlayTop = new Map<string, number>()
  private overlayBottom = new Map<string, number>()
  private overlayRight = new Map<string, number>()

  /**
   * 交给布局一份「哪些主题的外侧要留白」。
   *
   * 边界/概要画在区间外面，以前布局不为此留白 → 紧邻的分支会被标题带或括号压住。
   * 这里把留白量接进摆放算法（与绘制共用同一批常量，所以留白与图形一致）。
   */
  applyOverlayReserves(reserves: {
    top: Map<string, number>
    bottom: Map<string, number>
    right: Map<string, number>
  }): void {
    this.overlayTop = reserves.top
    this.overlayBottom = reserves.bottom
    this.overlayRight = reserves.right
  }

  /** 这个主题上方要为边界标题带留出的高度 */
  reserveTop(topic: Topic): number {
    return this.overlayTop.get(topic.id) ?? 0
  }

  /** 这个主题下方要为边界边框留出的高度 */
  reserveBottom(topic: Topic): number {
    return this.overlayBottom.get(topic.id) ?? 0
  }

  /** 这个主题右侧要为概要括号留出的宽度 */
  reserveRight(topic: Topic): number {
    return this.overlayRight.get(topic.id) ?? 0
  }

  /** 注册一个「坐标归一化之后」执行的钩子：嵌套结构的装饰与连线要在最终坐标上补画 */
  onFinish(hook: (result: LayoutResult) => void): void {
    this.finishHooks.push(hook)
  }

  /**
   * 家族感知的子树占用：按**这张画布的结构**计算宽高。
   *
   * 结构是画布级属性（由中心主题决定，见「结构▾」只作用于中心主题），所以占用一律
   * 按 `cls` 算：组织架构图横向铺行、鱼骨图沿主脊展开，不能套用「垂直堆叠」的公式，
   * 否则兄弟分支会互相重叠。
   *
   * @param cls 画布级结构，递归时原样传下去（**不再看子主题自己的 structureClass**）
   */
  subtreeExtent(topic: Topic, cls: StructureClass | undefined): { width: number; height: number } {
    const key = topic.id + '\u0000' + (cls ?? '')
    const cached = this.subtreeExtentCache.get(key)
    if (cached) return cached

    const effective = cls ?? DEFAULT_STRUCTURE
    const family = getStructureDef(effective).family
    const size = this.size(topic.id)
    const kids = this.visibleChildren(topic)

    let extent: { width: number; height: number }
    if (kids.length === 0) {
      extent = { width: size.width, height: size.height }
    } else if (family === 'orgchart') {
      // 横向铺行：宽 = 各子树宽之和；高 = 自身 + 一行里最高的子树
      // 边界/概要的预留同样计入：横向上给「右邻居」留出括号，纵向上给整行留出标题带
      let width = 0
      let childHeight = 0
      let topReserve = 0
      let bottomReserve = 0
      kids.forEach((child, index) => {
        width +=
          this.horizontalExtent(child) + this.reserveRight(child) + (index > 0 ? this.gapX : 0)
        childHeight = Math.max(childHeight, this.subtreeExtent(child, effective).height)
        topReserve = Math.max(topReserve, this.reserveTop(child))
        bottomReserve = Math.max(bottomReserve, this.reserveBottom(child))
      })
      extent = {
        width: Math.max(size.width, width),
        height: size.height + this.gapY + topReserve + childHeight + bottomReserve
      }
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

export function addEdge(
  result: LayoutResult,
  fromId: string,
  toId: string,
  from: Point,
  to: Point,
  kind: ConnectorKind
): void {
  /**
   * 列脊：由结构显式声明（它知道自己的子节点是不是排成一列）。
   * 锚点由这里重算——列脊要进的是子节点的**侧缘**，而不是结构原来给的上/下缘。
   */
  if (kind === 'spine') {
    const parent = result.nodeMap.get(fromId)
    const child = result.nodeMap.get(toId)
    if (parent && child) {
      result.edges.push({ fromId, toId, d: polyline(spinePoints(result, parent, child)) })
      return
    }
  }

  /**
   * 折线连线加一层**竖井绕行**：连线不许从别的节点身上穿过去。
   *
   * 为什么需要：各结构算锚点时只看父子两个节点，于是当兄弟排成一列时——
   * 矩阵的格位、时间轴的刻目、鱼骨的骨刺、树状表格的列——连到"更远那一格"的线
   * 会从"更近那一格"身上直插过去（用户截图：一条竖线穿过中间那个框）。
   */
  const d =
    kind === 'elbow-v' || kind === 'elbow-h'
      ? orthogonalPath(result, fromId, toId, from, to, kind)
      : pathFor(kind, from, to)
  const edge: EdgeLayout = { fromId, toId, d }
  result.edges.push(edge)
}

/** 离开锚点的小段：太短会贴着节点边框看不出转折 */
const LANE_STUB = 10
/** 竖井与挡路节点之间留的空隙 */
const LANE_GAP = 8
/** 判"穿过"时的容差：贴边不算穿过（连线本来就该贴着节点边缘走） */
const HIT_TOLERANCE = 2

function polyline(points: Point[]): string {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${round(point.x)} ${round(point.y)}`)
    .join(' ')
}

/** 轴对齐线段是否伸进了矩形内部（留容差，贴边不算） */
function segmentHitsRect(a: Point, b: Point, rect: NodeLayout): boolean {
  const x0 = Math.min(a.x, b.x)
  const x1 = Math.max(a.x, b.x)
  const y0 = Math.min(a.y, b.y)
  const y1 = Math.max(a.y, b.y)
  if (x1 <= rect.x + HIT_TOLERANCE || x0 >= rect.x + rect.width - HIT_TOLERANCE) return false
  if (y1 <= rect.y + HIT_TOLERANCE || y0 >= rect.y + rect.height - HIT_TOLERANCE) return false
  return true
}

/** 这条折线穿过了哪些节点（父子两端不算） */
function crossedNodes(
  result: LayoutResult,
  fromId: string,
  toId: string,
  points: Point[]
): NodeLayout[] {
  const out: NodeLayout[] = []
  for (const node of result.nodes) {
    if (node.id === fromId || node.id === toId) continue
    for (let i = 0; i + 1 < points.length; i += 1) {
      const a = points[i]
      const b = points[i + 1]
      if (a && b && segmentHitsRect(a, b, node)) {
        out.push(node)
        break
      }
    }
  }
  return out
}

function pathLength(points: Point[]): number {
  let total = 0
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]
    const b = points[i + 1]
    if (a && b) total += Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
  }
  return total
}

/**
 * 正交折线：默认走中位折角；被别的节点挡住时改走**竖井**。
 *
 * 竖井位置取「挡住路的那几个节点的外侧 ±8px」，左右（上下）各试一条，
 * 取更短的一条；两条都还挡着就退回默认路径——**宁可不好看，也不能绕出更乱的线**。
 */
function orthogonalPath(
  result: LayoutResult,
  fromId: string,
  toId: string,
  from: Point,
  to: Point,
  kind: 'elbow-v' | 'elbow-h'
): string {
  const vertical = kind === 'elbow-v'
  const mid = vertical ? round(from.y + (to.y - from.y) / 2) : round(from.x + (to.x - from.x) / 2)
  const direct: Point[] = vertical
    ? [from, { x: from.x, y: mid }, { x: to.x, y: mid }, to]
    : [from, { x: mid, y: from.y }, { x: mid, y: to.y }, to]

  const blockers = crossedNodes(result, fromId, toId, direct)
  if (blockers.length === 0) return polyline(direct)

  const lanes = vertical
    ? [
        Math.min(...blockers.map((n) => n.x)) - LANE_GAP,
        Math.max(...blockers.map((n) => n.x + n.width)) + LANE_GAP
      ]
    : [
        Math.min(...blockers.map((n) => n.y)) - LANE_GAP,
        Math.max(...blockers.map((n) => n.y + n.height)) + LANE_GAP
      ]

  // 离开锚点的小段：连线很短时按一半收窄，免得冲过子节点
  const span = vertical ? Math.abs(to.y - from.y) : Math.abs(to.x - from.x)
  const stub = Math.min(LANE_STUB, Math.max(span / 2, 0))
  const away = vertical ? Math.sign(mid - from.y) || 1 : Math.sign(mid - from.x) || 1

  let best: Point[] | null = null
  let bestLength = Number.POSITIVE_INFINITY
  for (const lane of lanes) {
    const path: Point[] = vertical
      ? [
          from,
          { x: from.x, y: round(from.y + away * stub) },
          { x: round(lane), y: round(from.y + away * stub) },
          { x: round(lane), y: to.y },
          to
        ]
      : [
          from,
          { x: round(from.x + away * stub), y: from.y },
          { x: round(from.x + away * stub), y: round(lane) },
          { x: to.x, y: round(lane) },
          to
        ]
    if (crossedNodes(result, fromId, toId, path).length > 0) continue
    const length = pathLength(path)
    if (length < bestLength) {
      best = path
      bestLength = length
    }
  }
  return polyline(best ?? direct)
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
  /**
   * 括号图：括号本身就是连线，父子边不再重复画（括号由 `layoutBrace` 的钩子补画）。
   *
   * 判断依据是**这张画布的结构**（＝中心主题的 structureClass），
   * 而不是当前走到的那一层：结构是画布级属性。
   */
  const braceCanvas = getStructureDef(root.structureClass ?? DEFAULT_STRUCTURE).family === 'brace'
  const walk = (topic: Topic): void => {
    const parent = result.nodeMap.get(topic.id)
    if (!parent) return
    for (const child of topic.collapsed ? [] : topic.children) {
      const childNode = result.nodeMap.get(child.id)
      if (!childNode) continue
      if (braceCanvas) {
        walk(child)
        continue
      }
      const anchors = anchorOf(parent, childNode)
      addEdge(
        result,
        parent.id,
        childNode.id,
        anchorPoint(parent, anchors.from),
        anchorPoint(childNode, anchors.to),
        kind
      )
      walk(child)
    }
  }
  walk(root)
}

/** 水平方向堆叠时的默认锚点：父的右/左边 -> 子的左/右边 */
export function horizontalAnchors(
  _parent: NodeLayout,
  child: NodeLayout
): { from: Anchor; to: Anchor } {
  return child.side === 'left' ? { from: 'left', to: 'right' } : { from: 'right', to: 'left' }
}

/**
 * 连接锚点：先看子节点落在父节点的哪一侧，再回落到各结构自己的默认锚点。
 *
 * 为什么需要这一层：纵向缩进列（鱼骨的骨刺、时间轴的分支、树状表格的列）里，
 * 子节点排在父节点**正下方**，若沿用父级家族的默认锚点（左右），连线会斜着穿过去。
 * `side` 是 up/down 就说明这是纵向列，改用上下锚点。
 */
export function anchorsForChild(
  parent: NodeLayout,
  child: NodeLayout,
  fallback: { from: Anchor; to: Anchor }
): { from: Anchor; to: Anchor } {
  if (child.side === 'up' || child.side === 'down') return verticalAnchors(parent, child)
  return fallback
}

/** 垂直方向堆叠时的默认锚点：父的下/上边 -> 子的上/下边 */
export function verticalAnchors(
  parent: NodeLayout,
  child: NodeLayout
): { from: Anchor; to: Anchor } {
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
