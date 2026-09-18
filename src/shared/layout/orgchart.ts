/**
 * 组织架构图：子节点横向铺开并居中对齐，层级沿垂直方向递进。
 * 与「垂直堆叠」家族刚好转置，所以单独一组算法。
 */
import type { StructureClass, Topic } from '../model/types'
import type { LayoutResult } from './types'
import { LayoutBuilder, anchorsForChild, connectTree, verticalAnchors } from './core'

export function layoutOrgChart(
  root: Topic,
  builder: LayoutBuilder,
  direction: 'down' | 'up'
): LayoutResult {
  const size = builder.size(root.id)
  const inherited = root.structureClass
  builder.add(root, -size.width / 2, -size.height / 2, 0, 'root')
  placeOrgChartChildren(builder, root, -size.width / 2, -size.height / 2, 0, direction, inherited)
  const result = builder.finish(root)
  connectTree(result, root, 'elbow-v', (parent, child) =>
    anchorsForChild(parent, child, verticalAnchors(parent, child))
  )
  return result
}

/**
 * 把 topic 的可见子节点横向铺开成一行（向下或向上生长）。
 * 子主题若自己声明了别的结构，就把它的子树交给对应家族排布。
 */
export function placeOrgChartChildren(
  builder: LayoutBuilder,
  topic: Topic,
  x: number,
  y: number,
  depth: number,
  direction: 'down' | 'up',
  inherited?: StructureClass
): void {
  const size = builder.size(topic.id)
  const kids = builder.visibleChildren(topic)
  if (kids.length === 0) return

  let total = 0
  for (let i = 0; i < kids.length; i += 1) {
    const kid = kids[i]
    if (!kid) continue
    // 概要括号画在这一支右侧，同样要算进槽位宽度
    total +=
      builder.subtreeExtent(kid, inherited).width +
      builder.reserveRight(kid) +
      (i > 0 ? builder.gapX : 0)
  }

  let cursor = x + size.width / 2 - total / 2
  // 整行上方若有边界标题带（向下生长时它在父节点与这一行之间），整行往下让出这段高度
  let rowTopReserve = 0
  for (const kid of kids) rowTopReserve = Math.max(rowTopReserve, builder.reserveTop(kid))
  const rowY =
    direction === 'down' ? y + size.height + builder.gapY + rowTopReserve : y - builder.gapY

  /**
   * 两遍走：先算好同一行里每个子节点的最终 x（含手动偏移），再摆子树。
   *
   * 与竖直家族的下推避让是同一套思路的**转置**：子节点被手动拖过时，
   * 它的 `position.x` 偏移会越过按占用算出来的槽位、压到右边的兄弟身上
   * （用户看到的「新节点和老节点重合」在组织架构图里的样子）。
   * 这里按「上一个兄弟的右边 + 间距」做一次右推：偏移能保留就保留，
   * 只有真要撞上时才往右让一点——绝不允许同行兄弟重叠。
   * 没有偏移时这个判据恒不触发（子节点本来就排在槽位内），行为与以前完全一致。
   */
  const pending: Array<{ child: Topic; x: number; y: number; side: 'down' | 'up' }> = []
  let ceil = Number.NEGATIVE_INFINITY
  for (const child of kids) {
    const extent = builder.subtreeExtent(child, inherited).width
    const childSize = builder.size(child.id)
    let childX = cursor + extent / 2 - childSize.width / 2 + (child.position?.x ?? 0)
    if (childX < ceil) childX = ceil
    ceil = childX + childSize.width + builder.reserveRight(child) + builder.gapX
    /**
     * 行内**不认纵向偏移**——与矩阵「横向钳在列内」是同一套语义的转置。
     *
     * 一行里的兄弟必须坐在同一条基线上：认了纵向偏移，这一格就从那一行里挪出去
     * （用户截图里的"错位"），拖得狠一点还会直接压到父节点身上。
     * 横向偏移照旧生效（上一段就是为它写的右推避让）。
     */
    const childY = direction === 'down' ? rowY : rowY - childSize.height
    pending.push({ child, x: childX, y: childY, side: direction === 'down' ? 'down' : 'up' })
    cursor += extent + builder.reserveRight(child) + builder.gapX
  }

  for (const item of pending) {
    const { child, x: childX, y: childY, side } = item
    builder.add(child, childX, childY, depth + 1, side)
    placeOrgChartChildren(builder, child, childX, childY, depth + 1, direction, inherited)
  }
}
