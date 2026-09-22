/**
 * 连线（SVG path）与装饰线的收集。
 *
 * 单一职责：把「父→子」关系与结构声明翻译成 path，并按「节点几何版本」决定
 * 哪些线能跨轮复用。摆放阶段不在这里（见 core.ts 的 LayoutBuilder）。
 */
import type { Topic } from '../../model/types'
import { visibleChildren as visibleChildrenOf } from '../../model/tree'
import { DEFAULT_STRUCTURE, getStructureDef } from '../../xmind/constants'
import { activeRuntimeOf, type LayoutMemo } from './cache'
import { anchorPoint, round, type Anchor, type Point } from './geometry'
import type { Decoration, LayoutResult, NodeLayout, Side } from '../types'

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
  const boxes = visibleChildrenOf(parent.topic)
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
    /**
     * 正上/正下的**单链**：就是一条竖线。
     *
     * 这类父子在布局里本来就在同一条竖线上（列摆放不做逐层缩进），
     * 再"绕到脊上"就画成了没必要的 Z 形——用户要的就是「直接垂直」。
     *
     * 必须限定**只有一个子节点**：列里有多个格子时，第二个格子的中心 x 往往也和父节点
     * 相同，直连就会从上面那个格子身上穿过去（自检的"穿框"当场抓到过）。
     */
    if (column.length === 1 && Math.abs(ccx - pcx) < 2) {
      // 终点落在子节点**近侧边框**上（落在中心就会插进框里、压住文字）
      return [from, { x: from.x, y: below ? child.y : round(child.y + child.height) }]
    }
    /**
     * 同一父节点下的所有子节点**永远从左边进**（脊在整列的左侧）。
     *
     * 不能按"这个子节点相对父节点中线在哪边"逐个决定：那样拖偏一个子节点就会让它翻到
     * 另一边去，同一列里一半脊在左、一半在右——用户看到的正是"两边格式不一样"。
     * 结构化的东西就该给出与内容无关的稳定形状。
     */
    const to: Point = { x: child.x, y: round(ccy) }
    const spineX = Math.min(from.x, Math.min(...column.map((node) => node.x)) - SPINE_GAP)
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
/* 连线与装饰的收集                                                    */
/* ------------------------------------------------------------------ */

/**
 * 连线的复用键与依赖签名。
 *
 * 一条线的 path 依赖哪些几何，各形状不一样，这里必须一个个说清楚——
 * 判据放宽就会画出一条**指向旧位置**的线（比不缓存更糟）：
 * - `line` / `bezier`：只依赖两个端点，端点版本一致就能沿用；
 * - `spine`（列脊）：脊的位置按**父节点 + 它这一列的全部可见子节点**算，都要进签名；
 * - `elbow-*`（正交折线）：要看全图有没有节点挡路（`crossedNodes`），
 *   所以它依赖**整图**几何哈希——全图一点没动才敢复用。
 */
function edgeMemoKey(
  result: LayoutResult,
  fromId: string,
  toId: string,
  kind: ConnectorKind
): { key: string; sig: string } | null {
  const runtime = activeRuntimeOf()
  if (!runtime) return null
  const version = (id: string): number => runtime.versions.get(id) ?? -1
  const parts = [String(version(fromId)), String(version(toId))]
  if (kind === 'elbow-h' || kind === 'elbow-v') parts.push(String(runtime.geometryHash))
  if (kind === 'spine') {
    const parent = result.nodeMap.get(fromId)
    if (parent) {
      for (const sibling of visibleChildrenOf(parent.topic)) parts.push(String(version(sibling.id)))
    }
  }
  return { key: `${fromId}|${toId}|${kind}`, sig: parts.join(',') }
}

export function addEdge(
  result: LayoutResult,
  fromId: string,
  toId: string,
  from: Point,
  to: Point,
  kind: ConnectorKind
): void {
  const memo = activeRuntimeOf()?.memo
  const reuse = edgeMemoKey(result, fromId, toId, kind)
  if (memo && reuse) {
    const cached = memo.edgePaths.get(reuse.key)
    if (cached && cached.sig === reuse.sig) {
      result.edges.push({ fromId, toId, d: cached.d })
      memo.stats.edgesReused += 1
      return
    }
  }

  /**
   * 列脊：由结构显式声明（它知道自己的子节点是不是排成一列）。
   * 锚点由这里重算——列脊要进的是子节点的**侧缘**，而不是结构原来给的上/下缘。
   */
  if (kind === 'spine') {
    const parent = result.nodeMap.get(fromId)
    const child = result.nodeMap.get(toId)
    if (parent && child) {
      storeEdge(memo, reuse, polyline(spinePoints(result, parent, child)), result, fromId, toId)
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
  storeEdge(memo, reuse, d, result, fromId, toId)
}

function storeEdge(
  memo: LayoutMemo | undefined,
  reuse: { key: string; sig: string } | null,
  d: string,
  result: LayoutResult,
  fromId: string,
  toId: string
): void {
  if (memo && reuse) memo.edgePaths.set(reuse.key, { sig: reuse.sig, d })
  result.edges.push({ fromId, toId, d })
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
  /**
   * 装饰线（主脊、网格线、大括号）每条都要按最终坐标拼字符串。
   * 条数由形状决定、坐标由节点决定，所以「形状没变 + 全图几何没变」时
   * 整批沿用上一轮的结果，连字符串都不必再拼。
   */
  const runtime = activeRuntimeOf()
  const memo = runtime?.memo
  if (runtime && memo && runtime.shapeStable && memo.decorations.hash === runtime.geometryHash) {
    const cached = memo.decorations.items[result.decorations.length]
    if (cached) {
      result.decorations.push(cached)
      memo.stats.decorationsReused += 1
      return
    }
  }
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
    for (const child of visibleChildrenOf(topic)) {
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
  // 独立主题没有树内父边；但它们的子树仍需要连线（否则浮出来的只是一堆散框）。
  for (const floating of root.detachedChildren) walk(floating)
}

/** 水平方向堆叠时的默认锚点：父的右/左边 -> 子的左/右边 */
export function horizontalAnchors(
  _parent: NodeLayout,
  child: NodeLayout
): { from: Anchor; to: Anchor } {
  return child.side === 'left' ? { from: 'left', to: 'right' } : { from: 'right', to: 'left' }
}

/** 折叠徽标贴在节点的哪条边上（与子节点的展开方向一致） */
export type CollapseSide = 'left' | 'right' | 'up' | 'down'

/** 中心主题之外的节点：布局给的 `side` 就是它的展开方向 */
function sideToCollapseSide(side: Side): CollapseSide {
  if (side === 'left') return 'left'
  if (side === 'up') return 'up'
  if (side === 'down') return 'down'
  return 'right'
}

/**
 * 折叠徽标贴在节点的哪条边上：**跟着分支的展开方向走**（左右 / 上下都跟）。
 *
 * 判定用**可见子节点的实际位置**——它们全部落在哪一边，徽标就贴哪一边：
 * - 全部在下方（组织架构图：向下、矩阵、树状表格、垂直时间轴）→ 贴下缘；
 * - 全部在上方（组织架构图：向上）→ 贴上缘；
 * - 全部在左侧（逻辑图/树形图：向左）→ 贴左缘；
 * - 其余（右侧，或左右都有分支的平衡思维导图）→ 贴右缘。
 *
 * 为什么用几何而不是子节点的 `side`：`side` 表达的是"这个节点相对父节点的位置"，
 * 不是"它的子节点往哪长"——鱼骨图里子节点排在一列却带 `up`/`down`，按 `side`
 * 判断会把徽标挂到上方。用最终坐标则各种结构都成立。
 *
 * 中心主题折叠后（以及无可见子节点时）退回自身方向；中心主题自己没有方向
 * （`side` 恒为 `'root'`），退回**结构方向** `grows`，否则「向下的图、徽标挂在右边」。
 */
export function collapseBadgeSide(
  node: NodeLayout,
  nodeMap: ReadonlyMap<string, NodeLayout>
): CollapseSide {
  const centerX = node.x + node.width / 2
  const centerY = node.y + node.height / 2
  /** 半个像素的容差：恰好居中（如父节点只有一个居中的子节点）不算"在上下" */
  const EPS = 0.5

  const kids: NodeLayout[] = []
  for (const child of node.topic.children) {
    const childNode = nodeMap.get(child.id)
    if (childNode) kids.push(childNode)
  }

  if (kids.length > 0) {
    if (kids.every((kid) => kid.y + kid.height / 2 > centerY + EPS)) return 'down'
    if (kids.every((kid) => kid.y + kid.height / 2 < centerY - EPS)) return 'up'
    if (kids.every((kid) => kid.x + kid.width / 2 < centerX - EPS)) return 'left'
    return 'right'
  }

  if (node.side !== 'root') return sideToCollapseSide(node.side)
  return getStructureDef(node.topic.structureClass).grows ?? 'right'
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
