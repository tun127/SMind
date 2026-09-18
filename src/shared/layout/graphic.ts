/**
 * 图形类结构：鱼骨图、矩阵图、放射状（顺时针）思维导图。
 * 这三种的排布规则差异较大，不适合归入堆叠家族。
 */
import type { Topic } from '../model/types'
import { childFoldSides, RADIAL_START_ANGLE } from '../model/tree'
import type { LayoutResult } from './types'
import { LayoutBuilder, addDecoration, addEdge, anchorPoint, round, type Point } from './core'
import type { NodeLayout } from './types'

/**
 * 节点在布局里**实际**占的宽 / 高：尺寸加上边界（上下）与概要（左右）在外侧的留白。
 *
 * 这三种结构（鱼骨、矩阵、放射）的行列间距全部是"按占位算出来的"，
 * 用裸 `size` 算就会把留白算丢——加一个边界之后，边框与标题带会直接压到相邻的
 * 行 / 列 / 环上（用户之前看到的就是这类"压住"）。
 */
function spanX(builder: LayoutBuilder, topic: Topic): number {
  return builder.size(topic.id).width + builder.reserveSpanX(topic)
}
function spanY(builder: LayoutBuilder, topic: Topic): number {
  return builder.size(topic.id).height + builder.reserveSpanY(topic)
}

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
    // 边界标题带在这一格上方 → 先让出高度再摆
    cursor += builder.reserveTop(child)
    builder.add(child, childX, cursor, depth + 1, 'right')
    placeRightColumn(builder, child, childX, cursor, depth + 1)
    cursor += childSize.height + builder.reserveBottom(child) + builder.gapY
  }
}

/**
 * 从节点中心指向目标的射线，与**节点边框**的交点。
 *
 * 连线必须从边框出发：用中心点的话，线会先从自己的框里穿出来（穿过文字），
 * 再插进对方的框里——用户看到的"直线穿过框"就是这么来的。
 */
function borderToward(node: NodeLayout, target: NodeLayout): Point {
  const cx = node.x + node.width / 2
  const cy = node.y + node.height / 2
  const dx = target.x + target.width / 2 - cx
  const dy = target.y + target.height / 2 - cy
  if (dx === 0 && dy === 0) return { x: round(cx), y: round(cy) }
  const scale = Math.min(
    dx !== 0 ? node.width / 2 / Math.abs(dx) : Number.POSITIVE_INFINITY,
    dy !== 0 ? node.height / 2 / Math.abs(dy) : Number.POSITIVE_INFINITY
  )
  return { x: round(cx + dx * scale), y: round(cy + dy * scale) }
}

/** 向右延伸的列一共占多宽（小骨上更深的层级沿它排开） */
function rightColumnWidth(builder: LayoutBuilder, topic: Topic): number {
  let widest = 0
  for (const child of builder.visibleChildren(topic)) {
    widest = Math.max(
      widest,
      builder.gapX + spanX(builder, child) + rightColumnWidth(builder, child)
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
  /** 小骨这一格**实际**占的高（含边界预留）：沿大骨取点时的最小间距由它决定 */
  const ribKidHeight = Math.max(
    0,
    ...kids.flatMap((child) => builder.visibleChildren(child).map((kid) => spanY(builder, kid)))
  )
  const ribSpan = maxRibKids > 1 ? (maxRibKids + 1) * (ribKidHeight + builder.gapY) : 0
  /** 大骨在主脊的哪一侧：取 `childFoldSides`（唯一来源），与折叠无关 */
  const sides = childFoldSides(root)
  /** 大骨在 `side` 那一侧、离主脊半高最远需要多少（**只算靠主脊那一侧的留白**） */
  const boneReach = (side: -1 | 1): number => {
    let reach = rootSize.height / 2
    for (const child of kids) {
      if ((sides.get(child.id) === 'up' ? -1 : 1) !== side) continue
      reach = Math.max(
        reach,
        builder.size(child.id).height / 2 +
          (side < 0 ? builder.reserveBottom(child) : builder.reserveTop(child))
      )
    }
    return reach
  }
  /**
   * 大骨的上下偏移。
   *
   * 除了「装得下小骨」（`ribSpan`），还要装得下**边界**：边框与标题带画在大骨外侧，
   * 靠近主脊的那一侧若不让位，边框就会压到主脊上（远离主脊的一侧是往外长，不用管）。
   */
  const boneOffset = Math.max(
    46,
    ribSpan,
    boneReach(-1) + builder.gapY * 3,
    boneReach(1) + builder.gapY * 3
  )
  // 骨刺斜度：让骨刺看起来是斜的，而不是垂直的
  const boneSlant = Math.round(boneOffset * 0.45)
  /** 小骨长度（大骨上的取点 → 子主题左缘） */
  const ribGap = Math.max(16, Math.round(builder.gapX * 0.3))

  const anchors: Array<{ id: string; side: -1 | 1 }> = []
  /** 小骨：记下"哪根大骨的第几段"，最终坐标到 finish 之后再算 */
  const ribs: Array<{ branchId: string; childId: string; side: -1 | 1; t: number }> = []
  let cursor = rootNode.x + rootNode.width + builder.gapX * 2

  kids.forEach((child) => {
    // 大骨占的宽度要含概要在它右侧留出的括号位
    const extent = builder.horizontalExtent(child) + builder.reserveSpanX(child)
    const size = builder.size(child.id)
    const nodeCenterX = cursor + boneSlant + extent / 2
    const anchorX = nodeCenterX - boneSlant
    const side: -1 | 1 = sides.get(child.id) === 'up' ? -1 : 1
    const childY = side < 0 ? spineCenterY - boneOffset - size.height : spineCenterY + boneOffset

    builder.add(child, nodeCenterX - size.width / 2, childY, 1, side < 0 ? 'up' : 'down')

    // 小骨：沿大骨（主脊上的锚点 → 这一支的近侧边缘）按比例取点
    const nearY = side < 0 ? childY + size.height : childY
    const ribKids = builder.visibleChildren(child)
    /**
     * 这一根大骨上所有小骨的**取点**（先全算出来，再决定子主题那一列放哪）。
     *
     * 为什么不能像以前那样"每根小骨各自往右挪一点点就放下子主题"：那样同一根大骨下的
     * 子主题会沿着斜线**错开成阶梯**（实测：第一个在 x=373、第二个在 x=398），
     * 小骨只剩 17px 长、几乎看不见，看着像"几个框斜着飘在骨头旁边"——
     * 用户报的"鱼骨子节点也有问题"就是这个。
     *
     * 官方的要求是「小要因标在**鱼骨分支**上」（《鱼骨图教学｜定位问题根因》2021-06-15），
     * 所以小骨要**看得见**：取最靠右的那个取点作为公共列，子主题**对齐成一列**，
     * 每根小骨从自己的取点水平连到这一列——长短不一，但都是清清楚楚的水平线。
     */
    const ribPoints = ribKids.map((_kid, ribIndex) => {
      const t = (ribIndex + 1) / (ribKids.length + 1)
      return {
        t,
        x: anchorX + (nodeCenterX - anchorX) * t,
        y: spineCenterY + (nearY - spineCenterY) * t
      }
    })
    const columnX = ribKids.length > 0 ? Math.max(...ribPoints.map((point) => point.x)) + ribGap : 0

    ribKids.forEach((kid, ribIndex) => {
      const point = ribPoints[ribIndex]
      if (!point) return
      const kidSize = builder.size(kid.id)
      /**
       * 子主题**以取点的高度为中心**、x 对齐到公共列：小骨因此是**水平**的
       * （与主脊平行），完全符合"小骨"的形状。
       */
      const kidY = point.y - kidSize.height / 2
      builder.add(kid, columnX, kidY, 2, side < 0 ? 'up' : 'down')
      placeRightColumn(builder, kid, columnX, kidY, 2)
      ribs.push({ branchId: child.id, childId: kid.id, side, t: point.t })
    })

    anchors.push({ id: child.id, side })
    /**
     * 推进量：一根大骨占的宽度 = 锚点 → 子主题那一列的右边缘（含小骨子树向右延伸的宽度）。
     * 不算进来就会顶到隔壁大骨的地盘（自检的"节点重叠"当场抓到过：深4 ⨯ 短二2）。
     */
    const ribFootprint = ribKids.reduce(
      (widest, kid) => Math.max(widest, spanX(builder, kid) + rightColumnWidth(builder, kid)),
      0
    )
    const ownFootprint = ribKids.length > 0 ? columnX - anchorX + ribFootprint : boneSlant + ribGap
    cursor += Math.max(extent, ownFootprint) + builder.gapX
  })

  const result = builder.finish(root)
  const rootFinal = result.nodeMap.get(root.id)!
  const spineY = round(rootFinal.y + rootFinal.height / 2)

  /**
   * 主脊。
   *
   * **没有可见分支时整条不画**：折叠之后（整体折叠，或收起全部方向）
   * 主脊仍会从中心主题往右画一截 120px 的兜底短线——一条什么也没挂着的孤线，
   * 看着就是「凭空多了一根线」（用户截图）。鱼骨没有分支时，图里只该剩中心主题。
   */
  if (anchors.length > 0) {
    const lastBranchNode = result.nodeMap.get(anchors[anchors.length - 1]!.id)
    const spineEnd = lastBranchNode
      ? round(lastBranchNode.x + lastBranchNode.width / 2 - boneSlant + 60)
      : round(rootFinal.x + rootFinal.width + 120)
    addDecoration(result, {
      d: `M ${round(rootFinal.x + rootFinal.width)} ${spineY} L ${spineEnd} ${spineY}`,
      widthScale: 1.3
    })
  }

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

/** 某一棵子树里最宽的节点（含概要括号留白），用于决定列的宽度 */
function maxWidthOf(builder: LayoutBuilder, topic: Topic): number {
  let width = spanX(builder, topic)
  for (const child of builder.visibleChildren(topic)) {
    width = Math.max(width, maxWidthOf(builder, child))
  }
  return width
}

/**
 * 「自己 + 全部后代」在格子里纵向堆起来的总高度。
 *
 * 矩阵的**行高要按它取最大值**：同一行的格子共用一条基线，这一行里哪一格内容最高，
 * 这一行就多高——否则高的那格会捅进下一行里。
 */
function stackHeight(builder: LayoutBuilder, topic: Topic): number {
  const size = builder.size(topic.id)
  // 格内纵向堆叠同样要算边界预留：边框与标题带都画在这一格的上下
  const own = size.height + builder.reserveSpanY(topic)
  const kids = builder.visibleChildren(topic)
  if (kids.length === 0) return own
  let total = own + builder.gapY
  for (const kid of kids) total += stackHeight(builder, kid) + builder.gapY
  return total - builder.gapY
}

/**
 * 矩阵图：**二维网格**。
 *
 * 官方原文（《如何混用和转换结构？》2020-05-12、《介绍树形表格》的矩阵对比段）：
 * 「**从多个维度**组织和分析复杂信息」、官方称之为「**二维表脑图**」，
 * 思维重点是**对比、比较**，落点在**行与列的交叉**。
 *
 * 官方没写行列怎么排，这里取的口径（见 `docs/structure-spec.md`「我方取值」）：
 *  - **列＝一级主题＝第一维**（横向排成表头）；
 *  - **行＝序号＝第二维**：各列的第 r 个子主题落在**第 r 行**，同一行**共用一条基线**；
 *  - 更深的层级属于「格内细分」，在**本格内**继续往下堆；
 *  - 只用**网格线**，**不画父子连线**。
 *
 * 三条踩过的坑：
 * ① 曾经把每个一级主题的子节点**在各自列里各自往下堆**——那根本没有"行"，
 *    读起来是一列列互不相干的竖条，不是二维表（用户：「矩阵图也有问题」）；
 * ② 曾经给每列套一个大圆角框——一列一个竖卡片，仍然不像表格；表格感只能靠**贯穿的网格线**；
 * ③ 曾经让格子认**纵向偏移**——表格语义下一格挪出自己那一行就说不通了（和"组织架构行不认
 *    纵向偏移"是同一套道理），现在纵向偏移一律不生效；横向偏移仍生效，但**钳在列内**。
 */
export function layoutMatrix(root: Topic, builder: LayoutBuilder): LayoutResult {
  const kids = builder.visibleChildren(root)
  const rootSize = builder.size(root.id)
  const colGap = builder.gapX * 1.8

  // 列宽 = 该列子树里最宽的节点（跨行共用，保证列边界是一条直线）
  const colWidth = kids.map((header) => maxWidthOf(builder, header))
  const colLeft: number[] = []
  let cursorX = 0
  for (let index = 0; index < kids.length; index += 1) {
    colLeft[index] = cursorX
    cursorX += (colWidth[index] ?? 0) + colGap
  }
  const tableWidth = Math.max(0, cursorX - colGap)

  /** 行数＝最"高"的那一列的子主题数；每行高度＝各列该行内容的最大值 */
  const rowCount = kids.reduce(
    (deepest, header) => Math.max(deepest, builder.visibleChildren(header).length),
    0
  )
  const rowHeight: number[] = []
  for (let row = 0; row < rowCount; row += 1) {
    let tallest = 0
    for (const header of kids) {
      const cell = builder.visibleChildren(header)[row]
      if (cell) tallest = Math.max(tallest, stackHeight(builder, cell))
    }
    rowHeight[row] = tallest
  }

  const plannedRootX = Math.max(0, (tableWidth - rootSize.width) / 2)
  const rootNode = builder.add(root, plannedRootX, 0, 0, 'root')
  /**
   * 表头行的上下都要为边界让位：上方是根与这一行之间的标题带，下方是这一行自己的边框。
   * 以前只按 `gapY * 2` 留，给表头加边界之后边框会压到根主题或第一行格子上。
   */
  let headerTopReserve = 0
  let headerBottomReserve = 0
  for (const header of kids) {
    headerTopReserve = Math.max(headerTopReserve, builder.reserveTop(header))
    headerBottomReserve = Math.max(headerBottomReserve, builder.reserveBottom(header))
  }
  const headerTop =
    rootNode.y + rootSize.height + builder.reserveBottom(root) + headerTopReserve + builder.gapY * 2
  const headerHeight = kids.reduce(
    (tallest, header) => Math.max(tallest, spanY(builder, header)),
    0
  )

  const rowTop: number[] = []
  let cursorY = headerTop + headerHeight + builder.gapY * 1.6
  for (let row = 0; row < rowCount; row += 1) {
    rowTop[row] = cursorY
    cursorY += (rowHeight[row] ?? 0) + builder.gapY
  }

  /** 格子横向居中，手动偏移**钳在列内**（一格挪到隔壁列上说不过去） */
  const cellX = (left: number, width: number, size: { width: number }, offset: number): number => {
    const centered = left + (width - size.width) / 2 + offset
    return Math.min(Math.max(centered, left), left + Math.max(0, width - size.width))
  }

  kids.forEach((header, index) => {
    const left = colLeft[index] ?? 0
    const width = colWidth[index] ?? 0
    const headerSize = builder.size(header.id)
    builder.add(
      header,
      cellX(left, width, headerSize, header.position?.x ?? 0),
      headerTop,
      1,
      'down'
    )

    builder.visibleChildren(header).forEach((cell, row) => {
      const size = builder.size(cell.id)
      // 这一格的边界标题带要先让出来（行高里已经含了这份预留）
      const y = (rowTop[row] ?? headerTop) + builder.reserveTop(cell)
      builder.add(cell, cellX(left, width, size, cell.position?.x ?? 0), y, 2, 'down')
      // 更深的层级是本格的细分：在同一格里继续往下堆
      let below = y + size.height + builder.reserveBottom(cell) + builder.gapY
      const stackDeeper = (topic: Topic, depth: number): void => {
        for (const kid of builder.visibleChildren(topic)) {
          const kidSize = builder.size(kid.id)
          builder.add(kid, cellX(left, width, kidSize, kid.position?.x ?? 0), below, depth, 'down')
          below += kidSize.height + builder.gapY
          stackDeeper(kid, depth + 1)
        }
      }
      stackDeeper(cell, 3)
    })
  })

  const result = builder.finish(root)
  const finalRoot = result.nodeMap.get(root.id)
  if (!finalRoot || kids.length === 0) return result

  /**
   * 网格线：**列线纵贯全表 + 行线横贯全表**。
   *
   * 归一化（`finish`）会把所有坐标整体平移，所以这里用「最终根节点 - 计划中根节点」
   * 求出平移量，再把计划里的列边界/行边界平移到最终坐标系——比重新从节点反推边界可靠：
   * 格子是**居中**的，节点边缘并不等于列边界。
   */
  const dx = finalRoot.x - plannedRootX
  const dy = finalRoot.y
  // 网格的顶边要越过表头为边界让出的那一段，否则标题带会露在表格外面
  const gridTop = round(
    headerTop - headerTopReserve - Math.max(headerBottomReserve, builder.gapY / 2) + dy
  )
  const gridBottom = round(
    (rowCount > 0
      ? (rowTop[rowCount - 1] ?? headerTop) + (rowHeight[rowCount - 1] ?? 0)
      : headerTop + headerHeight) +
      builder.gapY / 2 +
      dy
  )
  const gridLeft = round((colLeft[0] ?? 0) - colGap / 2 + dx)
  const gridRight = round(tableWidth + colGap / 2 + dx)

  // 列线：每条列的左右边界都画（最右一列只有右边线；最左一列只有左边线由下面统一画）
  addDecoration(result, {
    d: `M ${gridLeft} ${gridTop} L ${gridLeft} ${gridBottom}`,
    widthScale: 1
  })
  for (let index = 0; index < kids.length; index += 1) {
    const x = round((colLeft[index] ?? 0) + (colWidth[index] ?? 0) + colGap / 2 + dx)
    addDecoration(result, { d: `M ${x} ${gridTop} L ${x} ${gridBottom}`, widthScale: 1 })
  }
  // 行线：表头上边、表头下边、每一行的下边
  addDecoration(result, {
    d: `M ${gridLeft} ${gridTop} L ${gridRight} ${gridTop}`,
    widthScale: 1
  })
  const headerBottom = round(headerTop + headerHeight + builder.gapY / 2 + dy)
  addDecoration(result, {
    d: `M ${gridLeft} ${headerBottom} L ${gridRight} ${headerBottom}`,
    widthScale: 1
  })
  for (let row = 0; row < rowCount; row += 1) {
    const y = round((rowTop[row] ?? headerTop) + (rowHeight[row] ?? 0) + builder.gapY / 2 + dy)
    addDecoration(result, { d: `M ${gridLeft} ${y} L ${gridRight} ${y}`, widthScale: 1 })
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

  /** 每一层节点的最大"实际占位"（含边界/概要留白），用于决定环间距与扇区半径 */
  const maxSizeByDepth: number[] = []
  const scan = (topic: Topic, depth: number): void => {
    const reach = Math.max(spanX(builder, topic), spanY(builder, topic))
    maxSizeByDepth[depth] = Math.max(maxSizeByDepth[depth] ?? 0, reach)
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
  /**
   * 扇区按**全部**一级分支算（`childFoldSides` 的「左右半圈」判定用的是同一份角度），
   * 只摆放当前可见的那些。
   *
   * 为什么不用可见数量：收起左侧之后，剩下的一支若按新数量重新均分整圈，
   * 会被铺到左边去——用户看到的还是"左右都有"，像没收起来一样。
   */
  const allKids = root.children
  const count = allKids.length
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
      maxSize = Math.max(maxSize, Math.max(spanX(builder, kid), spanY(builder, kid)))
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
  /**
   * 起点角度与「左右半圈」判定**共用同一个常量**（`RADIAL_START_ANGLE`）：
   * 两边各写一份的话，收起一侧后剩下的分支会被判到另一侧去。
   *
   * 官方只规定了"顺时针"这个方向（《如何在 Xmind 中结合不同的结构以及为什么》把顺时针
   * 列为思维导图的一个方向），起点的具体角度属于**我方取值**（见 `docs/structure-spec.md`）。
   * 从正上方（−90°）起铺时，两个一级分支会落在正上／正下，画出来是"一上一下"的
   * 纵向排布，读不出"顺时针"；从右上起，两个分支落在右上与左下，方向感才对。
   */
  const visibleIds = new Set(kids.map((kid) => kid.id))
  allKids.forEach((kid, index) => {
    if (!visibleIds.has(kid.id)) return
    collect(kid, RADIAL_START_ANGLE + sector * index, sector, 1)
  })

  // 第二遍：逐层定半径——本层取该层所有节点的最大需求，同层同半径
  const needByDepth: number[] = []
  for (const plan of plans) {
    // 实际占位（含边界/概要留白）：否则紧邻的那一环会被括号压住
    const reach = Math.max(spanX(builder, plan.topic), spanY(builder, plan.topic))
    const need = radiusForSector(plan.sector, reach)
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
  /**
   * 连线**从边框连到边框**。
   *
   * 早先这里是「中心到中心」：线必然从自己的框里穿出来、又插进对方的框里，
   * 节点越大越明显——用户看到的就是"直线穿过框、直接穿过文字"。
   */
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
          borderToward(parent, childNode),
          borderToward(childNode, parent),
          'line'
        )
      }
      connect(child)
    }
  }
  connect(root)

  return result
}
