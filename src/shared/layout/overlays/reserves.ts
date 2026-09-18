/**
 * 子树包围盒与「外侧留白」预留。
 *
 * 单一职责：回答「这个区间占多大」和「它的边界/概要要往外占多少」——
 * 布局在摆放**之前**就要知道这两件事，否则紧邻分支会被标题带或括号压住。
 */
import type { Sheet, Topic } from '../../model/types'
import { childFoldSides, visibleChildren, type FoldSide } from '../../model/tree'
import { getStructureDef } from '../../xmind/constants'
import type { LayoutResult } from '../types'
import { BOUNDARY_PAD, BOUNDARY_TITLE_H, SUMMARY_GAP, SUMMARY_NIB } from './metrics'
import { indexTree, resolveRange } from './range'

/* ------------------------------------------------------------------ */
/* 几何工具                                                            */
/* ------------------------------------------------------------------ */

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * 全树「子树包围盒」索引：一次后序遍历 O(n) 建好（键是主题 id）。
 *
 * 以前每个边界/概要都各自递归一遍自己区间的子树——B 个边界就是 O(B × 节点数)。
 * AI 一批加十几个边界/概要时这项会明显放大；建一次索引后，
 * 取任一区间的包围盒只花 O(区间长度)。
 */
export function indexSubtreeBounds(root: Topic, result: LayoutResult): Map<string, Bounds | null> {
  const map = new Map<string, Bounds | null>()
  const visit = (topic: Topic): Bounds | null => {
    const node = result.nodeMap.get(topic.id)
    let acc: Bounds | null = node
      ? { minX: node.x, minY: node.y, maxX: node.x + node.width, maxY: node.y + node.height }
      : null
    for (const child of visibleChildren(topic)) {
      const childBounds = visit(child)
      if (childBounds) acc = acc ? sameBounds(acc, childBounds) : childBounds
    }
    map.set(topic.id, acc)
    return acc
  }
  visit(root)
  return map
}

export function boundsOfTopics(
  topics: Topic[],
  boundsOf: Map<string, Bounds | null>
): Bounds | null {
  let acc: Bounds | null = null
  for (const topic of topics) {
    const item = boundsOf.get(topic.id)
    if (item) acc = acc ? sameBounds(acc, item) : item
  }
  return acc
}

export function sameBounds(a: Bounds, b: Bounds): Bounds {
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
 * - `left` / `right` / `up` / `down`：概要括号在区间外侧，需要
 *   「间距 + 尖点 + 一点文字宽度」——**朝哪一侧由结构决定**（见 `summaryReserveSide`）。
 *
 * 与绘制共用同一批常量（`BOUNDARY_PAD` / `BOUNDARY_TITLE_H` / `SUMMARY_*`），
 * 所以「留出来的白」与「画出来的黑」不会各说各话。
 */
export interface OverlayReserves {
  top: Map<string, number>
  bottom: Map<string, number>
  left: Map<string, number>
  right: Map<string, number>
}

/**
 * 概要括号朝哪一侧留白。
 *
 * 判据只能是**结构家族**：布局要在摆放之前就知道往哪儿让空间，
 * 而此时还没有任何坐标（`summaryOf` 里那个「父节点 → 区间中心」的方向是摆放之后才算的）。
 * - 向左右生长的结构（逻辑 / 树形 / 括号 / 鱼骨 / 水平时间轴 / 树状表格）→ 让在生长侧；
 * - 多方向结构（平衡思维导图 / 放射图 / 垂直时间轴）→ 跟**这一支自己的方向**；
 * - 上下生长的（组织架构图）与矩阵图 → 让在区间下方（向上生长的让在上方）。
 */
function summaryReserveSide(root: Topic, branch: FoldSide): FoldSide {
  const def = getStructureDef(root.structureClass)
  switch (def.family) {
    case 'mindmap':
      // 平衡图左右各有分支：括号画在这一支的外侧（左支往左、右支往右）
      return branch
    case 'timeline':
      // 垂直时间轴的区间挂在主轴左右两侧 → 跟分支；水平时间轴是单向向右
      return def.class === 'org.xmind.ui.timeline.vertical' ? branch : 'right'
    case 'spreadsheet':
      // 「深度＝列」：括号接在区间那一行的右端（`grows: 'down'` 说的是徽标方向，不是括号）
      return 'right'
    default:
      // 其余单方向结构（逻辑 / 树形 / 括号 / 鱼骨 / 组织架构 / 矩阵）跟生长方向
      return def.grows ?? 'right'
  }
}

export function overlayReserves(root: Topic, sheet: Sheet): OverlayReserves {
  const index = indexTree(root)
  const top = new Map<string, number>()
  const bottom = new Map<string, number>()
  const left = new Map<string, number>()
  const right = new Map<string, number>()
  const bump = (map: Map<string, number>, id: string, value: number): void => {
    map.set(id, Math.max(map.get(id) ?? 0, value))
  }
  const bumpSide = (side: FoldSide, id: string, value: number): void => {
    if (side === 'left') bump(left, id, value)
    else if (side === 'up') bump(top, id, value)
    else if (side === 'down') bump(bottom, id, value)
    else bump(right, id, value)
  }

  /** 一级分支的展开方向（多方向结构才有；单方向结构返回空表） */
  const branchSides = childFoldSides(root)
  /** 一个主题属于哪一支、那一支朝哪儿展开 */
  const branchSideOf = (topicId: string): FoldSide => {
    const def = getStructureDef(root.structureClass)
    if (topicId === root.id) return def.grows ?? 'right'
    let current = topicId
    let parent = index.parentOf.get(current)
    while (parent !== undefined && parent !== root.id) {
      current = parent
      parent = index.parentOf.get(current)
    }
    return branchSides.get(current) ?? def.grows ?? 'right'
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
    bumpSide(
      summaryReserveSide(root, branchSideOf(last.id)),
      last.id,
      SUMMARY_GAP + SUMMARY_NIB + 48
    )
  }

  return { top, bottom, left, right }
}
