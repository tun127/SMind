/**
 * 组织架构图：子节点横向铺开并居中对齐，层级沿垂直方向递进。
 * 与「垂直堆叠」家族刚好转置，所以单独一组算法。
 */
import type { Topic } from '../model/types'
import type { LayoutResult } from './types'
import { LayoutBuilder, connectTree, verticalAnchors } from './core'

export function layoutOrgChart(root: Topic, builder: LayoutBuilder, direction: 'down' | 'up'): LayoutResult {
  const place = (topic: Topic, centerX: number, y: number, depth: number): void => {
    const size = builder.size(topic.id)
    builder.add(topic, centerX - size.width / 2, y, depth, direction === 'down' ? 'down' : 'up')

    const kids = builder.visibleChildren(topic)
    if (kids.length === 0) return

    let total = 0
    for (let i = 0; i < kids.length; i += 1) {
      total += builder.horizontalExtent(kids[i]) + (i > 0 ? builder.gapX : 0)
    }

    let cursor = centerX - total / 2
    const rowY = direction === 'down' ? y + size.height + builder.gapY : y - builder.gapY

    for (const child of kids) {
      const extent = builder.horizontalExtent(child)
      const childSize = builder.size(child.id)
      const childCenterX = cursor + extent / 2 + (child.position?.x ?? 0)
      // 向上生长时按各自高度对齐底边，保证同一层的下沿齐平
      const childY =
        direction === 'down' ? rowY + (child.position?.y ?? 0) : rowY - childSize.height + (child.position?.y ?? 0)
      place(child, childCenterX, childY, depth + 1)
      cursor += extent + builder.gapX
    }
  }

  place(root, 0, 0, 0)
  const result = builder.finish(root)
  connectTree(result, root, 'elbow-v', verticalAnchors)
  return result
}
