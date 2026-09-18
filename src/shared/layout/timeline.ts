/**
 * 时间轴。
 *  - 一级主题沿主轴依次排列，左右（上下）交替
 *  - 每个一级主题的后续内容沿「远离主轴」的方向排成缩进列表
 *  - 主轴本身作为装饰线绘制，一级主题的连线直接从主轴上连出
 */
import type { Topic } from '../model/types'
import { childFoldSides } from '../model/tree'
import type { LayoutResult } from './types'
import { LayoutBuilder, addDecoration, addEdge, anchorPoint, round } from './core'
import { placeHorizontalColumn, placeVerticalColumn } from './stack'

/** 水平时间轴 */
export function layoutTimelineHorizontal(root: Topic, builder: LayoutBuilder): LayoutResult {
  const rootSize = builder.size(root.id)
  const rootNode = builder.add(root, -rootSize.width / 2, -rootSize.height / 2, 0, 'root')

  const kids = builder.visibleChildren(root)
  const spineGap = Math.max(rootSize.height / 2 + builder.gapY, 26)
  const spineCenterY = rootNode.y + rootNode.height / 2
  /**
   * 事件在轴的哪一侧，取 `childFoldSides`（唯一来源）：
   * 按**全部**事件算，与折叠无关——收起一侧后剩下的若按新序号重新交替，
   * 会当场跳到收起来的那一侧去。
   */
  const sides = childFoldSides(root)
  /**
   * 靠主轴那一侧的边界留白要额外让开。
   * 边界标题带画在刻目的「近轴侧」，主轴若不让位就会被标题带压住。
   */
  const nearReserve = (side: -1 | 1): number => {
    let worst = 0
    for (const child of kids) {
      if ((sides.get(child.id) === 'up' ? -1 : 1) !== side) continue
      worst = Math.max(worst, side < 0 ? builder.reserveBottom(child) : builder.reserveTop(child))
    }
    return worst
  }
  const upGap = spineGap + nearReserve(-1)
  const downGap = spineGap + nearReserve(1)

  let cursor = rootNode.x + rootNode.width + builder.gapX * 1.6
  kids.forEach((child) => {
    // 这一列占的宽度要含概要在它右侧留出的括号位
    const extent = builder.horizontalExtent(child) + builder.reserveSpanX(child)
    const size = builder.size(child.id)
    const centerX = cursor + extent / 2
    const side: -1 | 1 = sides.get(child.id) === 'up' ? -1 : 1
    const childY = side < 0 ? spineCenterY - upGap - size.height : spineCenterY + downGap

    builder.add(child, centerX - size.width / 2, childY, 1, side < 0 ? 'up' : 'down')
    placeVerticalColumn(builder, child, centerX - size.width / 2, childY, side, 1)
    // 一列占的宽度就是这一列里最宽的那个（不再逐层缩进，所以不用再额外加余量）
    cursor += extent + builder.gapX
  })

  const result = builder.finish(root)
  const rootFinal = result.nodeMap.get(root.id)!
  const spineY = round(rootFinal.y + rootFinal.height / 2)

  if (kids.length > 0) {
    const lastKid = kids[kids.length - 1]
    const lastNode = lastKid ? result.nodeMap.get(lastKid.id) : undefined
    const endX = lastNode
      ? round(lastNode.x + lastNode.width + 40)
      : round(rootFinal.x + rootFinal.width + 80)
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
        addEdge(
          result,
          parent.id,
          childNode.id,
          { x: anchorX, y: spineY },
          { x: anchorX, y: nearY },
          'line'
        )
      } else {
        // 刻目下面的内容是**一列**：用列脊（竖脊 + 短横线），
        // 不能用"父下→子上"，否则连到第二个的线会穿过第一个
        addEdge(
          result,
          parent.id,
          childNode.id,
          anchorPoint(parent, 'top'),
          anchorPoint(childNode, 'bottom'),
          'spine'
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
  /** 事件在轴的哪一侧：与折叠无关的稳定归属（见 `childFoldSides`） */
  const sides = childFoldSides(root)
  /**
   * 靠主轴那一侧的留白要额外让开：左支的边界向右长（冲向主轴）、右支的向左长，
   * 主轴不让位就会被边框压住。
   */
  const nearReserve = (side: -1 | 1): number => {
    let worst = 0
    for (const child of kids) {
      if ((sides.get(child.id) === 'left' ? -1 : 1) !== side) continue
      worst = Math.max(worst, side < 0 ? builder.reserveRight(child) : builder.reserveLeft(child))
    }
    return worst
  }
  const leftGap = spineGap + nearReserve(-1)
  const rightGap = spineGap + nearReserve(1)

  let cursor = rootNode.y + rootNode.height + builder.gapY * 2
  kids.forEach((child) => {
    const extent = builder.verticalExtent(child)
    const size = builder.size(child.id)
    const centerY = cursor + extent / 2
    const side: -1 | 1 = sides.get(child.id) === 'left' ? -1 : 1
    const childX = side < 0 ? spineCenterX - leftGap - size.width : spineCenterX + rightGap

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
    const lastKid = kids[kids.length - 1]
    const lastNode = lastKid ? result.nodeMap.get(lastKid.id) : undefined
    const endY = lastNode
      ? round(lastNode.y + lastNode.height + 40)
      : round(rootFinal.y + rootFinal.height + 80)
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
        addEdge(
          result,
          parent.id,
          childNode.id,
          { x: spineX, y: anchorY },
          { x: nearX, y: anchorY },
          'line'
        )
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
