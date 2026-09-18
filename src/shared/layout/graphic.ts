/**
 * 图形类结构：鱼骨图、矩阵图、放射状（顺时针）思维导图。
 * 这三种的排布规则差异较大，不适合归入堆叠家族。
 */
import type { Topic } from '../model/types'
import type { LayoutResult } from './types'
import { LayoutBuilder, addDecoration, addEdge, anchorPoint, round, type Point } from './core'
import { roundedRectPath } from './overlays'
import type { NodeLayout } from './types'

/* ------------------------------------------------------------------ */
/* 鱼骨图                                                              */
/* ------------------------------------------------------------------ */

/**
 * 沿水平方向向右堆叠（小骨上更深的层级）：同一层的兄弟在父节点右侧上下排开。
 *
 * 参考：「第三层及更深：继续在小骨上叠加短横线向右延伸」。
 * 不能顺着主脊方向往上/下堆——那会和相邻小骨分到的区域撞在一起。
 */
function placeRightColumn(
  builder: LayoutBuilder,
  topic: Topic,
  x: number,
  y: number,
  depth: number
): void {
  const size = builder.size(topic.id)
  let cursor = y
  for (const child of builder.visibleChildren(topic)) {
    const childSize = builder.size(child.id)
    const childX = x + size.width + builder.gapX
    builder.add(child, childX, cursor, depth + 1, 'right')
    placeRightColumn(builder, child, childX, cursor, depth + 1)
    cursor += childSize.height + builder.gapY
  }
}

/** 向右延伸的列一共占多宽（小骨上更深的层级沿它排开） */
function rightColumnWidth(builder: LayoutBuilder, topic: Topic): number {
  let widest = 0
  for (const child of builder.visibleChildren(topic)) {
    widest = Math.max(
      widest,
      builder.gapX + builder.size(child.id).width + rightColumnWidth(builder, child)
    )
  }
  return widest
}

/**
 * 鱼骨图。
 *
 * 参考长相（Xmind）：
 * - 主脊＝一条**水平**直线，鱼头在末端；
 * - 一级主题＝「大骨」，**斜向**分列主脊上下；
 * - 第二层＝「小骨」，从大骨引出，**水平短线、与主脊平行**；
 * - 第三层及更深：继续在小骨上叠加短横线，**向右延伸**。
 *
 * 小骨挂在**靠主脊的一侧**，并留一点间隙：大骨从主脊斜着上来，
 * 贴着挂会正好擦到小骨的角（自检的"穿框"当场抓到过）。
 */
export function layoutFishbone(root: Topic, builder: LayoutBuilder): LayoutResult {
  const rootSize = builder.size(root.id)
  const rootNode = builder.add(root, 0, -rootSize.height / 2, 0, 'root')
  const spineCenterY = rootNode.y + rootNode.height / 2

  const kids = builder.visibleChildren(root)
  /**
   * 大骨的竖向跨度必须装得下所有小骨：小骨沿大骨按比例取点排开，
   * 相邻两根的间距 = 跨度 ÷（小骨数 + 1），要求它 ≥ 小骨高 + 行距。
   */
  const maxRibKids = Math.max(0, ...kids.map((child) => builder.visibleChildren(child).length))
  const ribKidHeight = Math.max(
    0,
    ...kids.flatMap((child) =>
      builder.visibleChildren(child).map((kid) => builder.size(kid.id).height)
    )
  )
  const ribSpan = maxRibKids > 1 ? (maxRibKids + 1) * (ribKidHeight + builder.gapY) : 0
  const boneOffset = Math.max(rootSize.height / 2 + builder.gapY * 3, 46, ribSpan)
  // 骨刺斜度：让骨刺看起来是斜的，而不是垂直的
  const boneSlant = Math.round(boneOffset * 0.45)
  /** 小骨长度（大骨上的取点 → 子主题左缘） */
  const ribGap = Math.max(16, Math.round(builder.gapX * 0.3))

  const anchors: Array<{ id: string; side: -1 | 1 }> = []
  /** 小骨：记下"哪根大骨的第几段"，最终坐标到 finish 之后再算 */
  const ribs: Array<{ branchId: string; childId: string; side: -1 | 1; t: number }> = []
  let cursor = rootNode.x + rootNode.width + builder.gapX * 2

  kids.forEach((child, index) => {
    const extent = builder.horizontalExtent(child)
    const size = builder.size(child.id)
    const nodeCenterX = cursor + boneSlant + extent / 2
    const anchorX = nodeCenterX - boneSlant
    const side: -1 | 1 = index % 2 === 0 ? -1 : 1
    const childY = side < 0 ? spineCenterY - boneOffset - size.height : spineCenterY + boneOffset

    builder.add(child, nodeCenterX - size.width / 2, childY, 1, side < 0 ? 'up' : 'down')

    // 小骨：沿大骨（主脊上的锚点 → 这一支的近侧边缘）按比例取点
    const nearY = side < 0 ? childY + size.height : childY
    const ribKids = builder.visibleChildren(child)
    ribKids.forEach((kid, ribIndex) => {
      const t = (ribIndex + 1) / (ribKids.length + 1)
      const ribX = anchorX + (nodeCenterX - anchorX) * t
      const ribY = spineCenterY + (nearY - spineCenterY) * t
      const kidSize = builder.size(kid.id)
      /**
       * 子主题**以取点为中心**挂在旁边：这样小骨是一条**水平**短线（与主脊平行），
       * 完全符合参考里的"小骨"形状。
       * 大骨从取点往上（下）走、离盒子越来越远，所以压不到它——
       * 早先把它整体挪到取点一侧，反而让大骨擦着盒角过去。
       */
      const kidX = ribX + ribGap
      const kidY = ribY - kidSize.height / 2
      builder.add(kid, kidX, kidY, 2, side < 0 ? 'up' : 'down')
      placeRightColumn(builder, kid, kidX, kidY, 2)
      ribs.push({ branchId: child.id, childId: kid.id, side, t })
    })

    anchors.push({ id: child.id, side })
    /**
     * 推进量：一根大骨占的宽度 = 自己那一段（骨刺斜度 + 小骨长度）**加上小骨子树向右延伸的宽度**。
     * 小骨的子树是向右长的，不算进来就会顶到隔壁大骨的地盘
     * （自检的"节点重叠"当场抓到过：深4 ⨯ 短二2）。
     */
    const ribFootprint = ribKids.reduce(
      (widest, kid) =>
        Math.max(widest, builder.size(kid.id).width + rightColumnWidth(builder, kid)),
      0
    )
    cursor += Math.max(extent, boneSlant + ribGap + ribFootprint) + builder.gapX
  })

  const result = builder.finish(root)
  const rootFinal = result.nodeMap.get(root.id)!
  const spineY = round(rootFinal.y + rootFinal.height / 2)

  // 主脊
  const lastBranchNode = anchors[anchors.length - 1]
    ? result.nodeMap.get(anchors[anchors.length - 1]!.id)
    : undefined
  const spineEnd = lastBranchNode
    ? round(lastBranchNode.x + lastBranchNode.width / 2 - boneSlant + 60)
    : round(rootFinal.x + rootFinal.width + 120)
  addDecoration(result, {
    d: `M ${round(rootFinal.x + rootFinal.width)} ${spineY} L ${spineEnd} ${spineY}`,
    widthScale: 1.3
  })

  /**
   * 大骨：从主脊斜向连到一级主题。
   *
   * **必须用最终坐标算**：早先这里把归一化之前的 x 和归一化之后的 y 混着用，
   * 大骨的方向被拉歪、于是从子主题身上压过去（自检的"穿框"当场抓到）。
   */
  const boneOf = (branch: NodeLayout, side: -1 | 1): { start: Point; end: Point } => {
    const centerX = round(branch.x + branch.width / 2)
    return {
      start: { x: round(centerX - boneSlant), y: spineY },
      end: { x: centerX, y: side < 0 ? round(branch.y + branch.height) : branch.y }
    }
  }

  for (const anchor of anchors) {
    const childNode = result.nodeMap.get(anchor.id)
    if (!childNode) continue
    const bone = boneOf(childNode, anchor.side)
    addEdge(result, root.id, anchor.id, bone.start, bone.end, 'line')
  }

  // 小骨：从大骨上的取点**水平**拉到子主题左缘（与主脊平行）
  for (const rib of ribs) {
    const branch = result.nodeMap.get(rib.branchId)
    const kid = result.nodeMap.get(rib.childId)
    if (!branch || !kid) continue
    const bone = boneOf(branch, rib.side)
    addEdge(
      result,
      rib.branchId,
      rib.childId,
      {
        x: round(bone.start.x + (bone.end.x - bone.start.x) * rib.t),
        y: round(bone.start.y + (bone.end.y - bone.start.y) * rib.t)
      },
      { x: round(kid.x), y: round(kid.y + kid.height / 2) },
      'line'
    )
  }

  // 小骨上的更深层级：一条竖脊挂一排短横线（不能是"父下→子上"，否则会穿过上面的兄弟）
  const connect = (topic: Topic): void => {
    for (const child of builder.visibleChildren(topic)) {
      const parent = result.nodeMap.get(topic.id)
      const childNode = result.nodeMap.get(child.id)
      if (parent && childNode && parent.depth >= 2) {
        addEdge(
          result,
          parent.id,
          childNode.id,
          anchorPoint(parent, 'bottom'),
          anchorPoint(childNode, 'top'),
          'spine'
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

    const headerNode = builder.add(
      header,
      cellX(colLeft, colWidth, headerSize, header.position?.x ?? 0),
      headerTop + (header.position?.y ?? 0),
      1,
      'down'
    )

    let rowY = headerTop + headerSize.height + builder.gapY * 1.6
    const walk = (topic: Topic, depth: number): void => {
      const parent = builder.nodeMap.get(topic.id)
      /**
       * 与**父节点**的最小间隙。
       *
       * 矩阵是唯一读手动 y 偏移的列布局（其它列摆放在 `placeVerticalColumn` 里不读偏移），
       * 于是把格子往上拖到贴住父节点时，连线只能从它身上穿过去——任何绕行都会压到它。
       * 这里留半个行距：偏移能保留就保留，只有真的要贴上去时才往下让一点。
       */
      const minY = (parent ? parent.y + parent.height : rowY) + Math.max(builder.gapY / 2, 6)
      for (const child of builder.visibleChildren(topic)) {
        const size = builder.size(child.id)
        const desired = rowY + (child.position?.y ?? 0)
        const y = Math.max(desired, minY)
        /**
         * 子格与**表头左对齐**，而不是「在列宽里居中」。
         *
         * 列宽是按该列最宽的节点算的，居中的话每列的缩进都不一样——同一张图里
         * 这一列的子格贴着表头、那一列却缩进一大截，看起来就是「每列格式不一样」。
         * 左对齐后每列形状完全一致（用户看的就是"有没有对齐"）。仍钳在列内，不许溢出到邻列。
         */
        const maxX = colLeft + Math.max(0, colWidth - size.width)
        const cellLeft = Math.max(colLeft, Math.min(headerNode.x + (child.position?.x ?? 0), maxX))
        builder.add(child, cellLeft, y, depth, 'down')
        // 手动偏移过的格子不许压到同列的下一个格位（与其它家族同一套避让）
        rowY = y + size.height + builder.gapY
        walk(child, depth + 1)
      }
    }
    walk(header, 2)

    cursor = colLeft + colWidth + builder.gapX * 1.8
  }

  const result = builder.finish(root)
  /**
   * 矩阵是**表格**：参考写得很明确——「子主题填入单元格；**没有连线**，靠网格线/底色分割」。
   *
   * 所以这里**不画父子连线**，改成给每一列加一个**框**（框住表头与它下面的格子）。
   * 行列感由"框 + 节点自己的方块"表达；节点本身就是格子，不需要再引线。
   */
  for (const header of kids) {
    const headerNode = result.nodeMap.get(header.id)
    if (!headerNode) continue
    let left = headerNode.x
    let right = headerNode.x + headerNode.width
    let top = headerNode.y
    let bottom = headerNode.y + headerNode.height
    const walk = (topic: Topic): void => {
      for (const child of builder.visibleChildren(topic)) {
        const node = result.nodeMap.get(child.id)
        if (node) {
          left = Math.min(left, node.x)
          right = Math.max(right, node.x + node.width)
          top = Math.min(top, node.y)
          bottom = Math.max(bottom, node.y + node.height)
        }
        walk(child)
      }
    }
    walk(header)
    const pad = 10
    addDecoration(result, {
      d: roundedRectPath(
        round(left - pad),
        round(top - pad),
        round(right - left + pad * 2),
        round(bottom - top + pad * 2),
        10
      ),
      branchId: header.id,
      widthScale: 1
    })
    /**
     * 表头与格子之间补一条横线：参考要求「单元格之间靠网格线分割」，
     * 只有一个外框的话整列看着像一张竖卡片，不像表格。
     */
    const headerBottom = round(headerNode.y + headerNode.height + pad / 2)
    addDecoration(result, {
      d: `M ${round(left - pad)} ${headerBottom} L ${round(right + pad)} ${headerBottom}`,
      branchId: header.id,
      widthScale: 1
    })
  }

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
  /**
   * 每个一级分支分到的扇区角度。
   *
   * 只有一个分支时**不能**给整圈（2π）：那一支的子节点会被摊到 180° 以上、
   * 跑到中心主题的**另一侧**（实测「一个分支 + 两个子节点」画成左一个右一个，
   * 连线还横穿中心主题）。没有别的分支可避让时，给一个直角扇区就够。
   */
  const sector = count > 1 ? (Math.PI * 2) / count : Math.PI / 2

  let baseRadius = 220
  if (count > 1) {
    let maxSize = 0
    for (const kid of kids) {
      const size = builder.size(kid.id)
      maxSize = Math.max(maxSize, Math.max(size.width, size.height))
    }
    baseRadius = Math.max(baseRadius, radiusForSector(sector, maxSize))
  }

  /**
   * 第一遍：只算**角度与扇区**（跟半径无关），并记下每层"最多需要多大半径"。
   *
   * 为什么要分两遍：半径必须**逐层统一**。早先是每个节点各自按自己的扇区撑开半径，
   * 结果同一层的兄弟半径差出好几百（实测 513 / 726 / 965），画出来就是
   * "每个分支射出一根长短不一的长线"——用户说的"随便穿线"。
   */
  interface RingPlan {
    topic: Topic
    angle: number
    sector: number
    depth: number
  }
  const plans: RingPlan[] = []
  const collect = (topic: Topic, angle: number, sectorWidth: number, depth: number): void => {
    plans.push({ topic, angle, sector: sectorWidth, depth })
    const childList = builder.visibleChildren(topic)
    if (childList.length === 0) return
    /**
     * 子节点的扇区**收窄**到最多 90°。
     *
     * 一级分支自己占的扇区是「整圈 ÷ 分支数」：只有两个分支时每个分支有 180°，
     * 直接把子节点摊到 180° 以上——那不像顺时针图（Xmind 里同一分支的子节点
     * 是**贴着分支方向**挤在一起的），连线也会拉成横穿画面的长斜线。
     */
    const fan = Math.min(sectorWidth, Math.PI / 2)
    const sub = fan / childList.length
    const firstAngle = angle - fan / 2 + sub / 2
    childList.forEach((child, index) => {
      collect(child, firstAngle + sub * index, sub, depth + 1)
    })
  }
  kids.forEach((kid, index) => {
    // 从正上方开始顺时针铺开
    collect(kid, -Math.PI / 2 + sector * index, sector, 1)
  })

  // 第二遍：逐层定半径——本层取该层所有节点的最大需求，同层同半径
  const needByDepth: number[] = []
  for (const plan of plans) {
    const size = builder.size(plan.topic.id)
    const need = radiusForSector(plan.sector, Math.max(size.width, size.height))
    needByDepth[plan.depth] = Math.max(needByDepth[plan.depth] ?? 0, need)
  }
  const maxDepth = plans.reduce((deepest, plan) => Math.max(deepest, plan.depth), 1)
  const radiusByDepth: number[] = [0]
  radiusByDepth[1] = Math.max(baseRadius, needByDepth[1] ?? 0)
  for (let depth = 2; depth <= maxDepth; depth += 1) {
    radiusByDepth[depth] = Math.max(
      (radiusByDepth[depth - 1] ?? 0) + ringStep(depth - 1),
      needByDepth[depth] ?? 0
    )
  }

  for (const plan of plans) {
    const size = builder.size(plan.topic.id)
    const radius = radiusByDepth[plan.depth] ?? 0
    builder.add(
      plan.topic,
      centerX + Math.cos(plan.angle) * radius - size.width / 2,
      centerY + Math.sin(plan.angle) * radius - size.height / 2,
      plan.depth,
      Math.cos(plan.angle) < 0 ? 'left' : 'right'
    )
  }

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
