import { LAYOUT_DEFAULTS } from '@shared/layout'
import type { LayoutResult } from '@shared/layout/types'
import {
  perpendicularOf,
  stackDirection,
  zoneOf,
  type DropAxis,
  type DropMode,
  type DropPoint,
  type DropRect,
  type SiblingStack
} from '@shared/model/drop'
import { findParent, isSelfOrDescendant } from '@shared/model/tree'
import type { Topic } from '@shared/model/types'
import { DEFAULT_STRUCTURE, getStructureDef } from '@shared/xmind/constants'

/**
 * 画布的**落点几何**（自 `Canvas.tsx` 整块搬出，函数体逐字未改）。
 *
 * 这里全是纯计算：函数体原来读的是组件作用域里的 `layoutRef.current` / `rootRef.current` /
 * `dropIndex`，现在一律收成**显式入参**（`lay` / `rootTopic` / `dropIndex`）——
 * 调用方（`use-canvas-geometry.ts`）在调用那一刻读 ref 再传进来，读到的值与搬迁前同源。
 * 因此本模块不 import 任何 React 东西，可以被自检直接覆盖。
 *
 * 为什么要显式传 `lay` 而不是在这里读 ref：这些函数之间相互调用
 * （`snapRegionOf` → `axesOf` → `childGrowth`），全部走同一个入参 `lay`，
 * 才能保证一次判定里"看到的是同一份布局"。
 */

/**
 * 可吸附区域在**生长方向**上的外扩量——那里是新子主题会待的一整片区域，所以放得宽。
 *
 * 判定不能只用"到节点的直线距离"：那是**各向同性**的，而落点窗口天生是各向异性的——
 * 生长方向上能落进一整列，同级方向上只有"相邻兄弟之间那条缝"。
 * 一个半径去卡两件事，必然一边太松一边太紧，怎么调都不对
 * （这条结论来自成熟实现 simple-mind-map 的 Drag 插件：它也是分轴判定的）。
 */
export const GROWTH_REACH = Math.round(LAYOUT_DEFAULTS.gapX * 1.5)

/**
 * 沿**同级方向**（以及背向生长的那一侧）的外扩量：只留一点点容错，够盖住那条缝即可。
 * 缝隙更大时由 `nearestSiblingGap` 那条规则兜底（它专门管"插进两个同级之间"）。
 */
export const SIBLING_REACH = Math.round(LAYOUT_DEFAULTS.gapY * 1.6)

/**
 * 某一层**最外侧**（那一边没有相邻兄弟）向外多留的吸附带。
 *
 * 用途：把一个主题放到"最后一个子主题之后稍远一点的空白"时，仍然算
 * 「插到它后面」＝给父主题追加一个子主题——这正是大家最常用的追加动作。
 * 放在更远的地方才落到自由摆放。
 */
export const OUTER_REACH = Math.round(LAYOUT_DEFAULTS.gapY * 2.4)

/** 粗筛半径：任何方向的外扩都不会超过它，比它远的节点不必细算区域 */
export const SNAP_PREFILTER = Math.max(GROWTH_REACH, OUTER_REACH) + OUTER_REACH + 8

/**
 * 落点迟滞：指针要换到**另一个**落点前，必须先移动这么远。
 *
 * 单位是**屏幕像素**（直接比较 `clientX/clientY` 的位移）：
 * 手感取决于"手走了多远"，与画布缩放无关——早先乘过缩放系数，
 * 结果放大时异常黏、缩小时几乎失效。
 *
 * 没有它，指针停在"成为子主题"与"插到同级之间"的分界线上时，
 * 落点会一帧一个样地来回跳，看起来就是"吸附乱跳、提示乱闪"。
 * 有了它，同一个落点只要还够得着就保持不动，手感立刻稳定下来。
 */
export const DROP_HYSTERESIS = 14

/**
 * **换目标**（还是同一类落点，只是换了那个节点）需要的迟滞距离。
 *
 * 为什么要和上面那个分开：纵向拖动会**频繁跨过同级节点**，如果换目标也要求走够 14px，
 * 纵向就会明显"黏"——高亮和空位框慢半拍才跟过去（用户反馈：横向没问题、纵向欠缺）。
 * 而"类型"切换（成为子主题 ↔ 插到同级 ↔ 自由摆放）才是提示乱闪的来源，那里仍旧需要 14px。
 * 6px 已经够压住手指抖动，又不会让人觉得没反应。
 */
export const DROP_HYSTERESIS_TARGET = 6

export interface AxisPair {
  stack: DropAxis | null
  growth: DropAxis | null
}

/** 落点判定用的一次性索引（原样搬自组件里的那个 `useMemo`） */
export interface DropIndex {
  childrenOf: Map<string, string[]>
  parentOf: Map<string, string | null>
  stackOf: Map<string, SiblingStack>
  stacks: SiblingStack[]
}

/** 屏幕坐标 → 世界坐标。`el` 是画布容器，`zoom`/`pan` 是当前视口值。 */
export function screenToWorld(
  clientX: number,
  clientY: number,
  el: HTMLDivElement | null,
  zoom: number,
  pan: { x: number; y: number }
): { x: number; y: number } {
  if (!el) return { x: 0, y: 0 }
  const rect = el.getBoundingClientRect()
  const z = zoom
  const p = pan
  return { x: (clientX - rect.left - p.x) / z, y: (clientY - rect.top - p.y) / z }
}

/**
 * 落点判定用的**一次性索引**，随布局重算（一次遍历）。
 *
 * 拖拽时每一帧、每个候选节点都要问「它的子节点往哪排、同级往哪排」，
 * 而这些答案只跟当前布局有关。原先每次都走 `findTopic` / `findParent` 全树遍历，
 * 复杂度是 O(每帧候选数 × 节点数)，节点一多就明显掉帧；
 * 换成查表后运行时全是 O(1)。
 *
 * 算法本身一行没改，只是把「现算」换成「预计算」。
 */
export function buildDropIndex(root: Topic, layout: LayoutResult): DropIndex {
  const childrenOf = new Map<string, string[]>()
  const parentOf = new Map<string, string | null>()
  const stackOf = new Map<string, SiblingStack>()
  const stacks: SiblingStack[] = []

  const visit = (topic: Topic, parentId: string | null): void => {
    parentOf.set(topic.id, parentId)
    childrenOf.set(
      topic.id,
      topic.children.map((child) => child.id)
    )
    for (const child of topic.children) visit(child, topic.id)

    // 同级节点堆：同一父级下 ≥2 个**有坐标**的子节点
    if (topic.children.length >= 2) {
      const children: Array<{ id: string; rect: DropRect }> = []
      for (const child of topic.children) {
        const rect = layout.nodeMap.get(child.id)
        if (rect) children.push({ id: child.id, rect })
      }
      if (children.length >= 2) {
        const stack: SiblingStack = { parentId: topic.id, children }
        stacks.push(stack)
        for (const child of children) stackOf.set(child.id, stack)
      }
    }
  }
  visit(root, null)

  return { childrenOf, parentOf, stackOf, stacks }
}

/** 命中测试：指针下方是哪个节点（`excludeId` 连同它的子树一起跳过） */
export function hitTest(
  lay: LayoutResult | null,
  root: Topic,
  wx: number,
  wy: number,
  excludeId = ''
): string | null {
  if (!lay) return null
  for (let i = lay.nodes.length - 1; i >= 0; i -= 1) {
    const node = lay.nodes[i]
    if (!node) continue
    if (node.x <= wx && wx <= node.x + node.width && node.y <= wy && wy <= node.y + node.height) {
      // excludeId 为空串时不会命中任何子树，等价于「不排除任何节点」
      if (isSelfOrDescendant(root, excludeId, node.id)) continue
      return node.id
    }
  }
  return null
}

/** 目标的子节点往哪个方向排（拿不到就返回 null，交给调用方兜底） */
export function childGrowth(
  lay: LayoutResult | null,
  dropIndex: DropIndex,
  targetId: string
): DropAxis | null {
  const targetRect = lay?.nodeMap.get(targetId)
  if (!lay || !targetRect) return null
  const childRects: DropRect[] = []
  for (const childId of dropIndex.childrenOf.get(targetId) ?? []) {
    const rect = lay.nodeMap.get(childId)
    if (rect) childRects.push(rect)
  }
  const last = childRects[childRects.length - 1]
  const secondLast = childRects[childRects.length - 2]
  if (last && secondLast) return stackDirection(secondLast, last)
  if (last) return stackDirection(targetRect, last)
  return null
}

/**
 * 目标节点周围的两条方向轴，**全部由实际坐标推出**：
 * - stack：同级节点往哪边排（"插到它后面"看这条）；
 * - growth：它的子节点往哪边长。
 * 平衡思维导图的子节点是竖着排的、组织架构图是横着排的，
 * 靠实际坐标推就不用按结构名写特例，也不会把落点画到错误的一侧。
 */
export function axesOf(lay: LayoutResult | null, dropIndex: DropIndex, targetId: string): AxisPair {
  const targetRect = lay?.nodeMap.get(targetId)
  if (!lay || !targetRect) return { stack: null, growth: null }

  let stack: DropAxis | null = null
  const owningStack = dropIndex.stackOf.get(targetId)
  if (owningStack) {
    const index = owningStack.children.findIndex((child) => child.id === targetId)
    const next = owningStack.children[index + 1]
    const previous = index > 0 ? owningStack.children[index - 1] : undefined
    // 用相邻兄弟定方向，比用"父 → 子"可靠得多
    const neighbor = next ?? previous
    if (neighbor) {
      const toward = next
        ? stackDirection(targetRect, neighbor.rect)
        : stackDirection(neighbor.rect, targetRect)
      // 同级方向必须**垂直于生长方向**。平衡思维导图的一级主题分列左右，
      // 它们的坐标差只是"左右"，不是真正的同级排列方向，不能拿来当落点依据。
      const growthNow = childGrowth(lay, dropIndex, targetId)
      if (!growthNow || toward.axis !== growthNow.axis) stack = toward
    }
  }

  // 「成为它的子主题」时新节点往哪里长：同一个目标在**两处**都要用这个方向
  // （判断指针是否落在它外侧、以及把空位框摆在哪儿），抽出来才能保证两处一致。
  const growth = childGrowth(lay, dropIndex, targetId) ?? (stack ? perpendicularOf(stack) : null)

  return { stack, growth }
}

/**
 * 目标的父级那一层，子节点是往哪个方向排的。
 * 用在「目标自己还没有子节点、推不出生长方向」的时候：
 * 新子主题会排在目标的兄弟之后，所以父级那一层的排列方向的**垂直方向**才是它生长的方向。
 */
export function parentStackAxis(
  lay: LayoutResult | null,
  dropIndex: DropIndex,
  targetId: string
): DropAxis | null {
  const parentId = dropIndex.parentOf.get(targetId)
  const parentRect = parentId ? lay?.nodeMap.get(parentId) : undefined
  if (!parentRect) return null
  const kids = dropIndex.childrenOf.get(parentId ?? '') ?? []
  const a = kids.length > 1 ? lay?.nodeMap.get(kids[0]!) : undefined
  const b = kids.length > 1 ? lay?.nodeMap.get(kids[1]!) : undefined
  if (a && b) return stackDirection(a, b)
  // 只有一个子节点时，用"父 → 子"的方向当这一层的排列方向
  const only = lay?.nodeMap.get(kids[0] ?? '')
  return only ? stackDirection(parentRect, only) : null
}

/**
 * 「成为它的子主题」时新节点会往哪边长。注意这里**不拿子节点去推**：
 * 目标是折叠的、或还没有子节点时推不出方向，那就说明新节点会直接长在目标旁边——
 * 此时用「同级排列方向的垂直方向」，否则新版图里"落在中心主题身上"会把空位框
 * 画到第一个分支的正上方，看着像要排到它前面去。
 */
export function growthAxis(pair: AxisPair): DropAxis {
  if (pair.growth) return pair.growth
  if (pair.stack) return perpendicularOf(pair.stack)
  return { axis: 'x', forward: true }
}

/**
 * 「插到它前 / 后」时，**那一层**的排列方向轴。
 *
 * 必须和 `zoneForPointer` 用同一个答案：否则会出现"提示条画在一侧、松手却插到另一侧"
 * 这种自相矛盾的提示——研究文档里用户截图反映的正是这类问题。
 *
 * - 有同级：就是相邻兄弟的坐标差（比"父 → 子"可靠得多）；
 * - 没有同级（中心主题、独苗子主题）：退回**父级那一层的排列方向**的垂直方向，
 *   那恰好就是"它这个层级往哪边排"。
 */
export function insertAxis(
  lay: LayoutResult | null,
  dropIndex: DropIndex,
  targetId: string,
  pair: AxisPair
): DropAxis {
  if (pair.stack) return pair.stack
  return perpendicularOf(
    pair.growth ??
      parentStackAxis(lay, dropIndex, targetId) ??
      ({ axis: 'x', forward: true } as DropAxis)
  )
}

/**
 * 节点的「可吸附区域」＝本体按两条轴**分别**外扩：
 *
 * - 沿**生长方向**（子节点会待的那一侧）放宽到 `GROWTH_REACH`：
 *   在一个向右长的结构里，拖到某个主题右侧那一片空白本来就是"成为它的子主题"；
 * - 沿**同级方向**：朝相邻兄弟那一侧只留 `SIBLING_REACH`（刚好盖住那条缝）；
 *   而**最外侧**（那一边没有兄弟）留 `OUTER_REACH`——这样"放在最后一个子主题之后
 *   稍远一点"仍然算「插到它后面」＝给父主题追加一个子主题；
 * - 背向生长的一侧只用 `SIBLING_REACH`，别把父级那一带白白圈进来。
 *
 * 区域之间可以重叠，最终谁胜出由 `nearestInRegion` 按"离本体最近、更深优先"决定。
 */
export function snapRegionOf(
  lay: LayoutResult | null,
  dropIndex: DropIndex,
  targetId: string
): DropRect | null {
  const rect = lay?.nodeMap.get(targetId)
  if (!rect) return null
  const pair = axesOf(lay, dropIndex, targetId)
  const growth = growthAxis(pair)
  const stack = pair.stack ?? insertAxis(lay, dropIndex, targetId, pair)
  const horizontal = growth.axis === 'x'
  const forward = growth.forward

  const owning = dropIndex.stackOf.get(targetId)
  let slackPrev = OUTER_REACH
  let slackNext = OUTER_REACH
  if (owning) {
    const index = owning.children.findIndex((c) => c.id === targetId)
    if (index > 0) slackPrev = SIBLING_REACH
    if (index + 1 < owning.children.length) slackNext = SIBLING_REACH
  }
  // 正方向到底是"下一个兄弟"还是"上一个兄弟"，由同级轴的朝向决定
  const negativeSlack = stack?.forward ? slackPrev : slackNext
  const positiveSlack = stack?.forward ? slackNext : slackPrev

  const left = horizontal ? (forward ? SIBLING_REACH : GROWTH_REACH) : negativeSlack
  const right = horizontal ? (forward ? GROWTH_REACH : SIBLING_REACH) : positiveSlack
  const top = horizontal ? negativeSlack : forward ? SIBLING_REACH : GROWTH_REACH
  const bottom = horizontal ? positiveSlack : forward ? GROWTH_REACH : SIBLING_REACH
  return {
    x: rect.x - left,
    y: rect.y - top,
    width: rect.width + left + right,
    height: rect.height + top + bottom
  }
}

/**
 * 指针落在目标节点的哪个分区（`child` / `before` / `after`）。
 *
 * - 有同级排列方向（`pair.stack`）：沿它分区，贴前/后段插到它前/后、中间成为它的子主题；
 * - 拿不到同级方向时退回 `insertAxis`——它是"这一层往哪边排"的正确答案
 *   （平衡思维导图的一级主题左右分列，兄弟坐标差只是"左右"、不能当落点依据，
 *   于是 `axesOf` 会给出 `stack = null`，此时正确的轴是竖排方向）。
 *
 * **这里必须和 `snapRegionOf` 用同一个答案**（它写的是 `pair.stack ?? insertAxis(...)`）：
 * 以前这里按"有没有同级"分支，于是"有同级但同级方向被否决"的节点永远走不到 `insertAxis`，
 * `zoneOf` 收到 null 后**恒返回 child**——表现就是有些节点怎么拖都只提示"成为子主题"。
 */
export function zoneForPointer(
  lay: LayoutResult | null,
  dropIndex: DropIndex,
  targetId: string,
  rect: DropRect,
  world: DropPoint
): DropMode {
  const pair = axesOf(lay, dropIndex, targetId)
  return zoneOf(rect, world, pair.stack ?? insertAxis(lay, dropIndex, targetId, pair))
}

/**
 * 一级主题被拖到中心主题**另一侧**的空白处时，返回要切到的那一侧。
 * 只有「向两侧展开」的思维导图才谈得上左右，逻辑图 / 树形图 / 组织架构图都是单侧的。
 *
 * 「另一侧」是按**中心主题的边框**判定的，不是它的中心线：
 * 节点本身有宽度，用中心线会让"贴着中心主题边缘"的那一大片区域被算成同一侧，
 * 于是往左拖一小段毫无反应——那正是「拖了没反应」的常见来源。
 */
export function sideFlipTarget(
  lay: LayoutResult | null,
  rootTopic: Topic,
  world: DropPoint,
  draggedId: string
): 'left' | 'right' | null {
  if (!lay) return null
  const rootRect = lay.nodeMap.get(rootTopic.id)
  const selfRect = lay.nodeMap.get(draggedId)
  const parent = findParent(rootTopic, draggedId)
  if (!rootRect || !selfRect || !parent || parent.id !== rootTopic.id) return null
  // 只有"向两侧展开"的思维导图结构才有左右可言；逻辑图、树形图、组织架构图都是单侧的
  if (getStructureDef(rootTopic.structureClass ?? DEFAULT_STRUCTURE).family !== 'mindmap')
    return null
  const current: 'left' | 'right' =
    selfRect.x + selfRect.width / 2 < rootRect.x + rootRect.width / 2 ? 'left' : 'right'
  // 指针落在中心主题的左右边框之外才算「换到那一侧」；压在中心主题身上时维持原侧
  const wanted: 'left' | 'right' =
    world.x < rootRect.x ? 'left' : world.x > rootRect.x + rootRect.width ? 'right' : current
  return wanted === current ? null : wanted
}
