/**
 * 时间轴。
 *  - 一级主题沿主轴依次排列，左右（上下）交替
 *  - 每个一级主题的后续内容沿「远离主轴」的方向排成缩进列表
 *  - 主轴本身作为装饰线绘制，一级主题的连线直接从主轴上连出
 */
import type { Topic } from '../model/types'
import type { LayoutResult, NodeLayout } from './types'
import { LayoutBuilder, addDecoration, addEdge, anchorPoint, round } from './core'
import { placeHorizontalColumn, placeVerticalColumn } from './stack'

/** 水平时间轴 */
export function layoutTimelineHorizontal(root: Topic, builder: LayoutBuilder): LayoutResult {
  const rootSize = builder.size(root.id)
  const rootNode = builder.add(root, -rootSize.width / 2, -rootSize.height / 2, 0, 'root')

  const kids = builder.visibleChildren(root)
  const indent = Math.max(18, builder.gapX * 0.5)
  const spineGap = Math.max(rootSize.height / 2 + builder.gapY, 26)
  const spineCenterY = rootNode.y + rootNode.height / 2

  let cursor = rootNode.x + rootNode.width + builder.gapX * 1.6
  kids.forEach((child, index) => {
    const extent = builder.horizontalExtent(child)
    const size = builder.size(child.id)
    const centerX = cursor + extent / 2
    const side: -1 | 1 = index % 2 === 0 ? -1 : 1
    const childY = side < 0 ? spineCenterY - spineGap - size.height : spineCenterY + spineGap

    builder.add(child, centerX - size.width / 2, childY, 1, side < 0 ? 'up' : 'down')
    placeVerticalColumn(builder, child, centerX - size.width / 2, childY, side, 1, indent)
    // 逐层缩进会往外多占宽度，推进量里要把它算进去，否则会和下一个分支重叠
    cursor += extent + builder.gapX + indent * (builder.maxDepth(child) - 1)
  })

  const result = builder.finish(root)
  const rootFinal = result.nodeMap.get(root.id)!
  const spineY = round(rootFinal.y + rootFinal.height / 2)

  if (kids.length > 0) {
    const lastNode = result.nodeMap.get(kids[kids.length - 1].id)
    const endX = lastNode ? round(lastNode.x + lastNode.width + 40) : round(rootFinal.x + rootFinal.width + 80)
    addDecoration(result, {
      d: `M ${round(rootFinal.x + rootFinal.width)} ${spineY} L ${endX} ${spineY}`,
      widthScale: 1.3
    })
  }

  const connect = (topic: Topic): void => {
    const parent = result.nodeMap.get(topic.id)
    if (!parent) return
    for (const child of builder.visibleChildren(topic)) {
      const childNode = result.nodeMap.get(child.id)
      if (!childNode) continue

      if (parent.depth === 0) {
        const anchorX = round(childNode.x + childNode.width / 2)
        const above = childNode.y + childNode.height / 2 < spineY
        const nearY = above ? round(childNode.y + childNode.height) : childNode.y
        addEdge(result, parent.id, childNode.id, { x: anchorX, y: spineY }, { x: anchorX, y: nearY }, 'line')
      } else {
        const above = childNode.y + childNode.height / 2 < parent.y + parent.height / 2
        addEdge(
          result,
          parent.id,
          childNode.id,
          anchorPoint(parent, above ? 'top' : 'bottom'),
          anchorPoint(childNode, above ? 'bottom' : 'top'),
          'elbow-v'
        )
      }
      connect(child)
    }
  }
  connect(root)
  return result
}

/** 垂直时间轴 */
export function layoutTimelineVertical(root: Topic, builder: LayoutBuilder): LayoutResult {
  const rootSize = builder.size(root.id)
  const rootNode = builder.add(root, -rootSize.width / 2, -rootSize.height / 2, 0, 'root')

  const kids = builder.visibleChildren(root)
  const indent = Math.max(16, builder.gapY * 1.4)
  const spineGap = Math.max(rootSize.width / 2 + builder.gapX * 0.7, 72)
  const spineCenterX = rootNode.x + rootNode.width / 2

  let cursor = rootNode.y + rootNode.height + builder.gapY * 2
  kids.forEach((child, index) => {
    const extent = builder.verticalExtent(child)
    const size = builder.size(child.id)
    const centerY = cursor + extent / 2
    const side: -1 | 1 = index % 2 === 0 ? -1 : 1
    const childX = side < 0 ? spineCenterX - spineGap - size.width : spineCenterX + spineGap

    builder.add(child, childX, centerY - size.height / 2, 1, side < 0 ? 'left' : 'right')
    const outerX = side < 0 ? childX : childX + size.width
    // 子节点列在分支中心上下居中，保证整列落在本分支占用的纵向区间内
    const columnHeight = builder.childrenColumnHeight(child)
    placeHorizontalColumn(builder, child, outerX, centerY - columnHeight / 2, side, 1, indent)
    cursor += extent + builder.gapY * 2
  })

  const result = builder.finish(root)
  const rootFinal = result.nodeMap.get(root.id)!
  const spineX = round(rootFinal.x + rootFinal.width / 2)

  if (kids.length > 0) {
    const lastNode = result.nodeMap.get(kids[kids.length - 1].id)
    const endY = lastNode ? round(lastNode.y + lastNode.height + 40) : round(rootFinal.y + rootFinal.height + 80)
    addDecoration(result, {
      d: `M ${spineX} ${round(rootFinal.y + rootFinal.height)} L ${spineX} ${endY}`,
      widthScale: 1.3
    })
  }

  const connect = (topic: Topic): void => {
    const parent = result.nodeMap.get(topic.id)
    if (!parent) return
    for (const child of builder.visibleChildren(topic)) {
      const childNode = result.nodeMap.get(child.id)
      if (!childNode) continue

      if (parent.depth === 0) {
        const anchorY = round(childNode.y + childNode.height / 2)
        const left = childNode.x + childNode.width / 2 < spineX
        const nearX = left ? round(childNode.x + childNode.width) : childNode.x
        addEdge(result, parent.id, childNode.id, { x: spineX, y: anchorY }, { x: nearX, y: anchorY }, 'line')
      } else {
        const left = childNode.x + childNode.width / 2 < parent.x + parent.width / 2
        addEdge(
          result,
          parent.id,
          childNode.id,
          anchorPoint(parent, left ? 'left' : 'right'),
          anchorPoint(childNode, left ? 'right' : 'left'),
          'elbow-h'
        )
      }
      connect(child)
    }
  }
  connect(root)
  return result
}
