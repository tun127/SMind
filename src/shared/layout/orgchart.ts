/**
 * 组织架构图：子节点横向铺开并居中对齐，层级沿垂直方向递进。
 * 与「垂直堆叠」家族刚好转置，所以单独一组算法。
 */
import type { StructureClass, Topic } from '../model/types'
import type { LayoutResult } from './types'
import { LayoutBuilder, connectTree, verticalAnchors } from './core'
import { anchorsForChild, declaresOwnStructure, placeSubtree } from './subtree'

export function layoutOrgChart(
  root: Topic,
  builder: LayoutBuilder,
  direction: 'down' | 'up'
): LayoutResult {
  const size = builder.size(root.id)
  const inherited = root.structureClass
  builder.add(root, -size.width / 2, -size.height / 2, 0, 'root')
  placeOrgChartChildren(
    builder,
    root,
    -size.width / 2,
    -size.height / 2,
    0,
    direction,
    inherited
  )
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
    total += builder.subtreeExtent(kid, inherited).width + (i > 0 ? builder.gapX : 0)
  }

  let cursor = x + size.width / 2 - total / 2
  const rowY = direction === 'down' ? y + size.height + builder.gapY : y - builder.gapY

  for (const child of kids) {
    const extent = builder.subtreeExtent(child, inherited).width
    const childSize = builder.size(child.id)
    const childX = cursor + extent / 2 - childSize.width / 2 + (child.position?.x ?? 0)
    const childY =
      direction === 'down'
        ? rowY + (child.position?.y ?? 0)
        : rowY - childSize.height + (child.position?.y ?? 0)
    const side = direction === 'down' ? 'down' : 'up'

    if (declaresOwnStructure(builder, child, inherited)) {
      placeSubtree(builder, child, childX, childY, depth + 1, side, inherited)
    } else {
      builder.add(child, childX, childY, depth + 1, side)
      placeOrgChartChildren(builder, child, childX, childY, depth + 1, direction, inherited)
    }
    cursor += extent + builder.gapX
  }
}
