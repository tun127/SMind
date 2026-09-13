/**
 * 分支级结构：让「分支自己声明的结构类型」真正决定它子树的排布。
 *
 * 背景：此前 layoutSheet 只读中心主题的 structureClass，整张画布只能有一种结构；
 * 在分支上用「结构▾」切换虽然会写入数据，但布局完全忽略，
 * 表现成「分支上切换结构无效」。
 *
 * 做法：布局递归的每个「放子节点」的点上都会问一句——
 * 这个子主题自己声明了不同的结构吗？声明了就把它的子树交给对应家族的摆放函数。
 *
 * v1 支持作为分支结构：逻辑图（左/右）、树形图（左/右）、思维导图（平衡）、
 * 组织架构图（上/下）、鱼骨图。时间轴 / 括号图 / 树状表格 / 矩阵 / 放射状
 * 暂回落为当前家族的排布（数据不丢，README 已知限制有说明）。
 */
import type { StructureClass, Topic } from '../model/types'
import { getStructureDef, TOPIC_SIDE_KEY } from '../xmind/constants'
import type { NodeLayout, Side } from './types'
import type { Anchor, LayoutBuilder } from './core'
import { addDecoration, addEdge, anchorPoint, round, verticalAnchors } from './core'
import { placeVerticalChildren, placeVerticalColumn } from './stack'
import { placeOrgChartChildren } from './orgchart'
import { placeFishboneSubtree } from './fishbone-subtree'

/** 分支级支持的家族；其余（时间轴/括号图/树状表格/矩阵/放射状）回落为当前排布 */
const SUPPORTED_BRANCH_FAMILIES = new Set(['logic', 'tree', 'mindmap', 'orgchart', 'fishbone'])

/** 主题的有效结构：自己的 structureClass 优先，否则继承父链 */
export function effectiveStructure(
  topic: Topic,
  inherited: StructureClass | undefined
): StructureClass {
  return topic.structureClass ?? inherited ?? getStructureDef(undefined).class
}

/** 子主题是否声明了与当前家族不同、且分支级受支持的结构（有子树才有意义） */
export function declaresOwnStructure(
  builder: LayoutBuilder,
  child: Topic,
  current: StructureClass | undefined
): boolean {
  if (!child.structureClass || child.structureClass === current) return false
  const family = getStructureDef(child.structureClass).family
  if (family === getStructureDef(current).family) return false
  if (builder.visibleChildren(child).length === 0) return false
  return SUPPORTED_BRANCH_FAMILIES.has(family)
}

/** 连线锚点：子主题声明了「纵向家族」时改用上下锚点，其余用父级家族的默认锚点 */
export function anchorsForChild(
  parent: NodeLayout,
  child: NodeLayout,
  fallback: { from: Anchor; to: Anchor }
): { from: Anchor; to: Anchor } {
  if (!child.topic.structureClass) return fallback
  const family = getStructureDef(child.topic.structureClass).family
  if (family === 'orgchart' || family === 'fishbone' || family === 'matrix') {
    return verticalAnchors(parent, child)
  }
  return fallback
}

/**
 * 在 (x, y)（topic 的左上角）摆放以 topic 为根的子树：
 * topic 自身摆好后，子树内部按 topic 的有效结构家族排布。
 */
export function placeSubtree(
  builder: LayoutBuilder,
  topic: Topic,
  x: number,
  y: number,
  depth: number,
  side: Side,
  inherited: StructureClass | undefined
): void {
  builder.add(topic, x, y, depth, side)
  const cls = effectiveStructure(topic, inherited)
  const family = getStructureDef(cls).family

  if (family === 'orgchart') {
    placeOrgChartChildren(
      builder,
      topic,
      x,
      y,
      depth,
      cls === 'org.xmind.ui.org-chart.up' ? 'up' : 'down',
      cls
    )
    return
  }
  if (family === 'fishbone') {
    placeFishboneSubtree(builder, topic, depth, cls)
    return
  }
  if (family === 'mindmap') {
    placeMindmapChildren(builder, topic, depth, cls)
    return
  }
  // logic / tree（以及回落到逻辑图的家族）：沿单侧垂直堆叠
  const dir: 1 | -1 = side === 'left' ? -1 : 1
  const node = builder.nodeMap.get(topic.id)
  if (!node) return
  placeVerticalChildren(builder, node, builder.visibleChildren(topic), dir, depth, undefined, cls)
}

/** 平衡思维导图的分支摆放：按顺序交替分到左右，手动指定的侧优先 */
function placeMindmapChildren(
  builder: LayoutBuilder,
  topic: Topic,
  depth: number,
  inherited: StructureClass
): void {
  const node = builder.nodeMap.get(topic.id)
  if (!node) return
  const right: Topic[] = []
  const left: Topic[] = []
  builder.visibleChildren(topic).forEach((child, index) => {
    const manual = child.style?.properties?.[TOPIC_SIDE_KEY]
    if (manual === 'left') left.push(child)
    else if (manual === 'right' || index % 2 === 0) right.push(child)
    else left.push(child)
  })
  placeVerticalChildren(builder, node, right, 1, depth + 1, undefined, inherited)
  placeVerticalChildren(builder, node, left, -1, depth + 1, undefined, inherited)
}
