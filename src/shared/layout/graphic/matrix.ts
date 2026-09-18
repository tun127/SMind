/**
 * 矩阵图（二维网格）：列＝一级主题，行＝序号，同一行共用一条基线；
 * 更深的层级在**本格内**继续往下堆；只用贯穿的网格线，不画父子连线。
 */
import type { Topic } from '../../model/types'
import { addDecoration, round, type LayoutBuilder } from '../core'
import type { LayoutResult } from '../types'
import { spanX, spanY } from './span'

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
