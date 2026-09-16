/**
 * 图形类结构：鱼骨图、矩阵图、放射状（顺时针）思维导图。
 * 这三种的排布规则差异较大，不适合归入堆叠家族。
 */
import type { Topic } from '../model/types'
import type { LayoutResult } from './types'
import { LayoutBuilder, addDecoration, addEdge, anchorPoint, round } from './core'
import { placeVerticalColumn } from './stack'

/* ------------------------------------------------------------------ */
/* 鱼骨图                                                              */
/* ------------------------------------------------------------------ */

/**
 * 主脊水平，一级主题作为「骨刺」左右交替斜向伸出，
 * 更深层内容沿远离主脊的方向堆成缩进列表。
 */
export function layoutFishbone(root: Topic, builder: LayoutBuilder): LayoutResult {
  const rootSize = builder.size(root.id)
  const rootNode = builder.add(root, 0, -rootSize.height / 2, 0, 'root')
  const spineCenterY = rootNode.y + rootNode.height / 2

  const kids = builder.visibleChildren(root)
  const indent = Math.max(18, builder.gapX * 0.5)
  const boneOffset = Math.max(rootSize.height / 2 + builder.gapY * 3, 46)
  // 骨刺斜度：让骨刺看起来是斜的，而不是垂直的
  const boneSlant = Math.round(boneOffset * 0.45)

  const anchors: Array<{ id: string; x: number; side: -1 | 1 }> = []
  let cursor = rootNode.x + rootNode.width + builder.gapX * 2

  kids.forEach((child, index) => {
    const extent = builder.horizontalExtent(child)
    const size = builder.size(child.id)
    const nodeCenterX = cursor + boneSlant + extent / 2
    const anchorX = nodeCenterX - boneSlant
    const side: -1 | 1 = index % 2 === 0 ? -1 : 1
    const childY = side < 0 ? spineCenterY - boneOffset - size.height : spineCenterY + boneOffset

    builder.add(child, nodeCenterX - size.width / 2, childY, 1, side < 0 ? 'up' : 'down')
    placeVerticalColumn(builder, child, nodeCenterX - size.width / 2, childY, side, 1, indent)

    anchors.push({ id: child.id, x: round(anchorX), side })
    cursor += extent + builder.gapX + boneSlant + indent * (builder.maxDepth(child) - 1)
  })

  const result = builder.finish(root)
  const rootFinal = result.nodeMap.get(root.id)!
  const spineY = round(rootFinal.y + rootFinal.height / 2)

  // 主脊
  const lastAnchor = anchors[anchors.length - 1]
  const spineEnd = lastAnchor
    ? round(lastAnchor.x + 60)
    : round(rootFinal.x + rootFinal.width + 120)
  addDecoration(result, {
    d: `M ${round(rootFinal.x + rootFinal.width)} ${spineY} L ${spineEnd} ${spineY}`,
    widthScale: 1.3
  })

  // 骨刺：从主脊斜向连到一级主题
  for (const anchor of anchors) {
    const childNode = result.nodeMap.get(anchor.id)
    if (!childNode) continue
    const nearY = anchor.side < 0 ? round(childNode.y + childNode.height) : childNode.y
    const nearX = round(childNode.x + childNode.width / 2)
    addEdge(result, root.id, anchor.id, { x: anchor.x, y: spineY }, { x: nearX, y: nearY }, 'line')
  }

  // 骨刺上的后续层级
  const connect = (topic: Topic): void => {
    for (const child of builder.visibleChildren(topic)) {
      const parent = result.nodeMap.get(topic.id)
      const childNode = result.nodeMap.get(child.id)
      if (parent && childNode && parent.depth >= 1) {
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
  for (const child of kids) connect(child)

  return result
}

/* ------------------------------------------------------------------ */
/* 矩阵图                                                              */
/* ------------------------------------------------------------------ */

/** 某一棵子树里最宽的节点，用于决定列的宽度 */
function maxWidthOf(builder: LayoutBuilder, topic: Topic): number {
  let width = builder.size(topic.id).width
  for (const child of builder.visibleChildren(topic)) {
    width = Math.max(width, maxWidthOf(builder, child))
  }
  return width
}

/**
 * 矩阵图：一级主题横向排成表头，每个表头下面的所有后代在同一列里逐行排列，
 * 形成「列 = 分支、行 = 条目」的表格观感。
 */
export function layoutMatrix(root: Topic, builder: LayoutBuilder): LayoutResult {
  const rootSize = builder.size(root.id)
  const rootNode = builder.add(root, 0, 0, 0, 'root')
  const kids = builder.visibleChildren(root)

  const headerTop = rootNode.y + rootSize.height + builder.gapY * 2.6
  let cursor = 0

  /**
   * 单元格的横向位置：居中对齐 + 手动偏移，但**钳在列内**。
   *
   * 表格语义下「一格挪到隔壁列上面」说不通（列宽是按子树算好的，
   * 越界就会压住右边的列）；纵向的偏移仍然完全生效，并按下推避让处理。
   */
  const cellX = (colLeft: number, colWidth: number, size: { width: number }, x: number): number => {
    const centered = colLeft + (colWidth - size.width) / 2 + x
    const max = colLeft + Math.max(0, colWidth - size.width)
    return Math.min(Math.max(centered, colLeft), max)
  }

  for (const header of kids) {
    const colLeft = cursor
    const colWidth = maxWidthOf(builder, header)
    const headerSize = builder.size(header.id)

    builder.add(
      header,
      cellX(colLeft, colWidth, headerSize, header.position?.x ?? 0),
      headerTop + (header.position?.y ?? 0),
      1,
      'down'
    )

    let rowY = headerTop + headerSize.height + builder.gapY * 1.6
    const walk = (topic: Topic, depth: number): void => {
      for (const child of builder.visibleChildren(topic)) {
        const size = builder.size(child.id)
        const y = rowY + (child.position?.y ?? 0)
        builder.add(child, cellX(colLeft, colWidth, size, child.position?.x ?? 0), y, depth, 'down')
        // 手动偏移过的格子不许压到同列的下一个格位（与其它家族同一套避让）
        rowY = y + size.height + builder.gapY
        walk(child, depth + 1)
      }
    }
    walk(header, 2)

    cursor = colLeft + colWidth + builder.gapX * 1.8
  }

  const result = builder.finish(root)
  // 表头从根节点用「下-横-下」的母线连出，避免多根线互相穿过
  const connect = (topic: Topic): void => {
    const parent = result.nodeMap.get(topic.id)
    if (!parent) return
    for (const child of builder.visibleChildren(topic)) {
      const childNode = result.nodeMap.get(child.id)
      if (childNode) {
        addEdge(
          result,
          parent.id,
          childNode.id,
          anchorPoint(parent, 'bottom'),
          anchorPoint(childNode, 'top'),
          'elbow-v'
        )
      }
      connect(child)
    }
  }
  connect(root)

  return result
}

/* ------------------------------------------------------------------ */
/* 放射状（顺时针）思维导图                                            */
/* ------------------------------------------------------------------ */

/**
 * 以中心为圆心把一级分支均分到各个方向，逐层向外扩展。
 * 每层的半径会按「该层最宽节点所需的弧长」自动外扩，避免同环节点重叠。
 */
export function layoutRadial(root: Topic, builder: LayoutBuilder): LayoutResult {
  const rootSize = builder.size(root.id)
  const rootNode = builder.add(root, -rootSize.width / 2, -rootSize.height / 2, 0, 'root')
  const kids = builder.visibleChildren(root)

  /** 每一层节点的最大边长，用于决定环间距 */
  const maxSizeByDepth: number[] = []
  const scan = (topic: Topic, depth: number): void => {
    const size = builder.size(topic.id)
    maxSizeByDepth[depth] = Math.max(maxSizeByDepth[depth] ?? 0, Math.max(size.width, size.height))
    for (const child of builder.visibleChildren(topic)) scan(child, depth + 1)
  }
  scan(root, 0)

  /**
   * 环间距。
   * 轴对齐矩形在半径方向上互不重叠，需要中心距 d 满足
   * d·|cosθ| ≥ w 或 d·|sinθ| ≥ h；最坏情况（45°）下 d ≥ √2·max(w,h)，
   * 这里取 1.5 倍留安全余量。
   */
  const ringStep = (depth: number): number => {
    const current = maxSizeByDepth[depth] ?? 40
    const next = maxSizeByDepth[depth + 1] ?? current
    return 1.5 * Math.max(current, next) + builder.gapY * 2
  }

  /** 同一环上相邻节点不重叠所需的最小半径：弦长 2r·sin(Δ/2) 需大于 1.5·maxSize */
  const radiusForSector = (sub: number, size: number): number =>
    (1.5 * size) / (2 * Math.max(Math.sin(Math.min(sub, Math.PI) / 2), 1e-4))

  const centerX = rootNode.x + rootNode.width / 2
  const centerY = rootNode.y + rootNode.height / 2
  const count = kids.length
  const sector = count > 0 ? (Math.PI * 2) / count : 0

  let baseRadius = 220
  if (count > 1) {
    let maxSize = 0
    for (const kid of kids) {
      const size = builder.size(kid.id)
      maxSize = Math.max(maxSize, Math.max(size.width, size.height))
    }
    baseRadius = Math.max(baseRadius, radiusForSector(sector, maxSize))
  }

  const place = (
    topic: Topic,
    angle: number,
    sectorWidth: number,
    radius: number,
    depth: number
  ): void => {
    const size = builder.size(topic.id)
    const x = centerX + Math.cos(angle) * radius - size.width / 2
    const y = centerY + Math.sin(angle) * radius - size.height / 2
    builder.add(topic, x, y, depth, Math.cos(angle) < 0 ? 'left' : 'right')

    const childList = builder.visibleChildren(topic)
    if (childList.length === 0) return

    const sub = sectorWidth / childList.length
    const firstAngle = angle - sectorWidth / 2 + sub / 2

    let childRadius = radius + ringStep(depth)
    if (childList.length > 1) {
      let maxSize = 0
      for (const child of childList) {
        const size = builder.size(child.id)
        maxSize = Math.max(maxSize, Math.max(size.width, size.height))
      }
      const needed = radiusForSector(sub, maxSize)
      if (needed > childRadius) childRadius = needed
    }

    childList.forEach((child, index) => {
      place(child, firstAngle + sub * index, sub, childRadius, depth + 1)
    })
  }

  kids.forEach((kid, index) => {
    // 从正上方开始顺时针铺开
    place(kid, -Math.PI / 2 + sector * index, sector, baseRadius, 1)
  })

  const result = builder.finish(root)
  // 放射状用「中心到中心」的连线，压在节点下方
  const connect = (topic: Topic): void => {
    const parent = result.nodeMap.get(topic.id)
    if (!parent) return
    for (const child of builder.visibleChildren(topic)) {
      const childNode = result.nodeMap.get(child.id)
      if (childNode) {
        addEdge(
          result,
          parent.id,
          childNode.id,
          anchorPoint(parent, 'center'),
          anchorPoint(childNode, 'center'),
          'line'
        )
      }
      connect(child)
    }
  }
  connect(root)

  return result
}
