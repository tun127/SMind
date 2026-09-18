import type { Topic } from './types'
import { findParent, isSelfOrDescendant } from './tree'

/**
 * 落点语义：
 * - `child`：成为目标的最后一个子主题；
 * - `before`：插到目标**前面**，与它同级；
 * - `after`：插到目标**后面**，与它同级。
 */
export type DropMode = 'child' | 'before' | 'after'

export interface DropResult {
  /** 落点参照的主题 */
  targetId: string
  mode: DropMode
  /** 实际插入到哪个父级下；mode 为 child 时即 targetId */
  parentId: string
}

export interface DropRect {
  x: number
  y: number
  width: number
  height: number
}

export interface DropPoint {
  x: number
  y: number
}

/** 一条方向轴：沿 x 还是沿 y，朝正方向还是负方向 */
export interface DropAxis {
  axis: 'x' | 'y'
  forward: boolean
}

/**
 * 裁决一次拖拽的落点，是整套拖拽交互的**唯一**判定入口。
 *
 * `zone` 由指针落在目标的哪个位置决定（见 `zoneOf`）：
 * 上下边缘 → 插到它前 / 后，与它同级；中间 → 成为它的子主题。
 *
 * 返回 null 表示这次落点必须忽略（自己、自己的后代，或原地不动）。
 */
export function resolveDrop(
  root: Topic,
  draggedId: string,
  targetId: string,
  zone: DropMode,
  alsoDragged: readonly string[] = []
): DropResult | null {
  if (draggedId === targetId) return null
  // 拖到自己的后代里会把子树剪断
  if (isSelfOrDescendant(root, draggedId, targetId)) return null
  // 多选拖拽时也一样：被拖的**任意一个**主题都不能落进自己的子树
  for (const other of alsoDragged) {
    if (other === targetId) return null
    if (isSelfOrDescendant(root, other, targetId)) return null
  }

  const draggedParent = findParent(root, draggedId)
  if (!draggedParent) return null
  const targetParent = findParent(root, targetId)

  if (zone !== 'child' && targetParent) {
    return { targetId, mode: zone, parentId: targetParent.id }
  }

  // 目标是自己的父级时已经是它的子主题，等于原地不动
  if (draggedParent.id === targetId) return null

  // 多选时「成为目标的子主题」会被丢掉一部分：同一次拖拽里，作为参照的那个主题
  // 会成为目标的子主题，其余主题却只是落到同一个父级下、与目标同级——
  // 预览画的是一个位置、真正落的却不止一处，看起来就像"拖了但没反应"。
  // 与其给出一个会骗人的预览，不如明确禁止，让用户用同级插入来表达。
  if (alsoDragged.length > 0) return null

  return { targetId, mode: 'child', parentId: targetId }
}

/**
 * 落点被判为非法时，给用户一句能看懂的原因。
 *
 * 拖拽里"挨着了却什么都不发生"最容易被误当成卡死，所以原因要具体到**是哪种非法**，
 * 而不是笼统的"不能落"。（对应画布底部那条提示。）
 */
export function blockReasonOf(
  root: Topic,
  draggedId: string,
  targetId: string,
  zone: DropMode,
  alsoDragged: readonly string[] = []
): string {
  if (draggedId === targetId) return '不能落回自己身上'
  if (zone !== 'child') return '这里不能落'
  if (alsoDragged.length > 0) return '多选拖拽只能插到同级之间'
  if (findParent(root, draggedId)?.id === targetId) return '它已经是这个主题的子主题了'
  return '不能落进自己的子主题里'
}

/* ------------------------------------------------------------------ */
/* 方向推断                                                            */
/* ------------------------------------------------------------------ */

const centerOf = (rect: DropRect): DropPoint => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2
})

/**
 * 由「排在前面」和「排在后面」的两个节点，推出它们这一级的**排列方向**。
 *
 * 必须用**两个同级节点的实际坐标**来算：
 * 平衡思维导图的子节点其实是**竖着**排的，若按"父节点→子节点"的方向去猜，
 * 会把"插到下面那个兄弟后面"错画成"插到它右边"，看起来就像要连回根节点。
 */
export function stackDirection(before: DropRect, after: DropRect): DropAxis {
  const a = centerOf(before)
  const b = centerOf(after)
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.abs(dx) >= Math.abs(dy)) return { axis: 'x', forward: dx >= 0 }
  return { axis: 'y', forward: dy >= 0 }
}

/** 垂直于某条轴。同级是竖着排的结构，子节点就是横着长的，反之亦然。 */
export function perpendicularOf(direction: DropAxis): DropAxis {
  return { axis: direction.axis === 'x' ? 'y' : 'x', forward: true }
}

/**
 * 指针落在目标节点的哪个语义区（Xmind / 亿图脑图都是这套分区）：
 * - 沿同级排列方向的**前段**（默认 28%）→ 插到它前面；
 * - **后段** → 插到它后面；
 * - **中间** → 成为它的子主题。
 *
 * 分区是沿"同级排列方向"算的，所以平衡导图里就是节点的上/下缘，
 * 组织架构图里则是节点的左/右缘，不需要为每种结构写特例。
 */
export function zoneOf(
  rect: DropRect,
  pointer: DropPoint,
  direction: DropAxis | null,
  edgeRatio = 0.28
): DropMode {
  if (!direction) return 'child'
  const raw =
    direction.axis === 'x'
      ? rect.width > 0
        ? (pointer.x - rect.x) / rect.width
        : 0.5
      : rect.height > 0
        ? (pointer.y - rect.y) / rect.height
        : 0.5
  // 归一化成"沿排列方向前进的比例"，这样方向朝上/朝左也一样成立
  const along = direction.forward ? raw : 1 - raw
  if (along >= 1 - edgeRatio) return 'after'
  if (along <= edgeRatio) return 'before'
  return 'child'
}

/** 矩形沿某方向「朝前 / 朝后」那条边的中点 */
function axisEdge(rect: DropRect, direction: DropAxis, alongForward: boolean): DropPoint {
  const front = direction.forward === alongForward
  if (direction.axis === 'x') {
    return { x: front ? rect.x + rect.width : rect.x, y: rect.y + rect.height / 2 }
  }
  return { x: rect.x + rect.width / 2, y: front ? rect.y + rect.height : rect.y }
}

/** 点到线段的距离 */
function pointToSegment(point: DropPoint, a: DropPoint, b: DropPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y)
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t))
}

/* ------------------------------------------------------------------ */
/* 同级空隙                                                            */
/* ------------------------------------------------------------------ */

/**
 * 一组同级节点（同一个父级下的兄弟） */
export interface SiblingStack {
  parentId: string
  children: Array<{ id: string; rect: DropRect }>
}

/** 参与命中测试的节点 */
export interface DropNode {
  id: string
  rect: DropRect
}

/** 点到矩形的距离（在矩形内部算 0） */
export function distanceToRect(point: DropPoint, rect: DropRect): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width))
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height))
  return Math.hypot(dx, dy)
}

/** 框选：两个矩形是否相交（**接触即算命中**，与框选手感一致） */
export function rectsIntersect(a: DropRect, b: DropRect): boolean {
  return (
    a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y
  )
}

/**
 * 框选命中了哪些节点（返回顺序与入参一致，便于"追加选择"直接拼接）。
 *
 * 抽成纯函数不是为了复用那几行数学，而是为了让「拖动中高亮谁」与「松手后选中谁」
 * **必然是同一套判定**——否则会出现"亮了却没选中 / 选中了却没亮"，
 * 那比完全没有高亮更让人不信任。抽出来之后它也能被自检钉住。
 */
export function topicsInBox(nodes: readonly DropNode[], box: DropRect): string[] {
  return nodes.filter((node) => rectsIntersect(node.rect, box)).map((node) => node.id)
}

/** 点是否落在矩形内（含边界） */
function pointInRect(point: DropPoint, rect: DropRect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
}

/**
 * 落点候选：**两个矩形**。
 *
 * - `rect`：节点本体，用来比较"谁离得近"；
 * - `region`：可吸附区域，由调用方按轴外扩得到，用来回答"指针在这里算不算相对它放置"。
 *
 * 之所以要分开，是因为外扩量必须**各向异性**（见 `nearestInRegion` 的注释），
 * 而"远近"只能按本体量——否则一个朝生长方向铺开的大区域会把不相干的节点排到前面。
 */
export interface SnapNode {
  id: string
  rect: DropRect
  /** 已按轴外扩好的可吸附区域 */
  region: DropRect
  /** 层级：距离相同时优先落进更深的那一个 */
  depth: number
}

/** 点是否落在候选的「可吸附区域」内 */
function inSnapRegion(node: SnapNode, point: DropPoint): boolean {
  return pointInRect(point, node.region)
}

/**
 * 在「可吸附区域」命中指针的候选里，取**离节点本体最近**的那一个，同距取更深的。
 *
 * 为什么要用"区域"而不是"半径"：
 * 成熟实现（simple-mind-map 的 Drag 插件）判定落点时，**先要求指针落在节点垂直于
 * 同级方向的投影范围内**，再沿线比较——也就是容错窗口是**分轴**的：
 * 同级方向只有"相邻兄弟之间的那条缝"那么宽，生长方向（新子节点会待的地方）则是一整片。
 * 用一个各向同性的半径去卡，必然一边太松、一边太紧，怎么调都不对。
 */
export function nearestInRegion(
  nodes: readonly SnapNode[],
  pointer: DropPoint,
  exclude: ReadonlySet<string> = new Set()
): SnapNode | null {
  let best: SnapNode | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const node of nodes) {
    if (exclude.has(node.id)) continue
    if (!inSnapRegion(node, pointer)) continue
    const distance = distanceToRect(pointer, node.rect)
    const better =
      distance < bestDistance ||
      (distance === bestDistance && best !== null && node.depth > best.depth)
    if (better) {
      bestDistance = distance
      best = node
    }
  }
  return best
}

/**
 * 找距指针最近的节点，超过 `maxDistance` 就当作"这里真的是空白"。
 *
 * 指针压在节点身上时命中测试已经处理了，这个函数管的是**指针落在空白处**的情况：
 * 落在节点的上/下/左/右一点点，语义上仍然是"相对这个节点插入"，
 * 不该被当成自由摆放——那正是"拖过去不吸附、线到处穿"的来源。
 */
export function closestNodeWithin(
  nodes: readonly DropNode[],
  pointer: DropPoint,
  exclude: ReadonlySet<string>,
  maxDistance = 260
): DropNode | null {
  let best: DropNode | null = null
  let bestDistance = maxDistance
  for (const node of nodes) {
    if (exclude.has(node.id)) continue
    const distance = distanceToRect(pointer, node.rect)
    if (distance < bestDistance) {
      bestDistance = distance
      best = node
    }
  }
  return best
}

export interface GapHit {
  /** 插到它后面 */
  targetId: string
  parentId: string
  mode: 'after'
  distance: number
}

/**
 * 找距指针最近的**同级空隙**，也就是"可以插进去的两个相邻节点之间"。
 *
 * 节点的上/下缘分区已经覆盖了"插到最前/最后"，这里只需要管两个节点**之间**那块空白：
 * 把节点拖到两个兄弟中间的缝里，语义比"贴到某一个上"更清楚。
 */
export function nearestSiblingGap(
  stacks: readonly SiblingStack[],
  pointer: DropPoint,
  maxDistance = 80
): GapHit | null {
  let best: GapHit | null = null
  for (const stack of stacks) {
    for (let i = 0; i + 1 < stack.children.length; i += 1) {
      const before = stack.children[i]
      const after = stack.children[i + 1]
      // 循环条件已经保证 i 与 i+1 都在范围内，这里只是让类型收窄
      if (!before || !after) continue
      const direction = stackDirection(before.rect, after.rect)
      const a = axisEdge(before.rect, direction, true)
      const b = axisEdge(after.rect, direction, false)
      const distance = pointToSegment(pointer, a, b)
      if (distance <= maxDistance && (!best || distance < best.distance)) {
        best = { targetId: before.id, parentId: stack.parentId, mode: 'after', distance }
      }
    }
  }
  return best
}
