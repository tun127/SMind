/**
 * 「垂直堆叠」家族：思维导图、逻辑图、树形图、括号图、树状表格。
 * 它们的共同点是子节点沿垂直方向排列，区别在于
 *  - 往哪一侧展开（左右 / 单侧）
 *  - 连线形状（曲线 / 折线 / 直连线）
 *  - 是否用括号等装饰（括号图）
 *  - x 坐标是相对父节点还是按层级对齐（树状表格）
 */
import type { StructureClass, Topic } from '../model/types'
import { TOPIC_SIDE_KEY } from '../xmind/constants'
import type { LayoutResult, MeasureResult, NodeLayout } from './types'
import {
  LayoutBuilder,
  addDecoration,
  addEdge,
  anchorsForChild,
  bracePath,
  connectTree,
  horizontalAnchors,
  round
} from './core'
import { roundedRectPath } from './overlays'

export type XResolver = (
  child: Topic,
  size: MeasureResult,
  parent: NodeLayout,
  dir: 1 | -1,
  depth: number
) => number

/** 把一组子节点沿垂直方向堆叠在父节点外侧 */
export function placeVerticalChildren(
  builder: LayoutBuilder,
  parentNode: NodeLayout,
  kids: Topic[],
  dir: 1 | -1,
  depth: number,
  xResolver?: XResolver,
  inherited?: StructureClass
): void {
  if (kids.length === 0) return

  let total = 0
  for (let i = 0; i < kids.length; i += 1) {
    const kid = kids[i]
    if (!kid) continue
    // 边界/概要在这一支外侧占用的空间也算进槽位高度，否则会压住相邻兄弟
    total +=
      builder.subtreeExtent(kid, inherited).height +
      builder.reserveTop(kid) +
      builder.reserveBottom(kid) +
      (i > 0 ? builder.gapY : 0)
  }

  let cursor = parentNode.y + parentNode.height / 2 - total / 2
  /**
   * 两遍走：先算好每个子节点的最终位置（含手动偏移），再摆子树。
   *
   * 为什么要第二遍：子节点可能被**手动拖过**（`position` 偏移），偏移后的盒子
   * 会越过按占用算出来的槽位、压到相邻兄弟身上（用户看到的「新节点和老节点重合」）。
   * 这里按「上一个兄弟的底边 + 间距」做一次下推避让：偏移能保留就保留，
   * 只有真的要撞上时才把它往下让一点——绝不允许兄弟重叠。
   */
  const pending: Array<{ child: Topic; x: number; y: number }> = []
  let floor = Number.NEGATIVE_INFINITY
  for (const child of kids) {
    const extent = builder.subtreeExtent(child, inherited).height
    const size = builder.size(child.id)
    const centerY = cursor + extent / 2
    const defaultX =
      dir === 1
        ? parentNode.x + parentNode.width + builder.gapX
        : parentNode.x - builder.gapX - size.width
    const x = xResolver ? xResolver(child, size, parentNode, dir, depth) : defaultX
    const px = x + (child.position?.x ?? 0)
    // 上方有边界标题带时要往下让出那段空间（预留量只在区间首/末那一支上非零）
    let py = centerY - size.height / 2 + (child.position?.y ?? 0) + builder.reserveTop(child)
    if (py < floor) py = floor
    floor = py + size.height + builder.reserveBottom(child) + builder.gapY
    pending.push({ child, x: px, y: py })
    cursor += extent + builder.reserveTop(child) + builder.reserveBottom(child) + builder.gapY
  }

  for (const item of pending) {
    const node = builder.add(item.child, item.x, item.y, depth, dir === 1 ? 'right' : 'left')
    placeVerticalChildren(
      builder,
      node,
      builder.visibleChildren(item.child),
      dir,
      depth + 1,
      xResolver,
      inherited
    )
  }
}

/**
 * 沿垂直方向把子节点堆成一列。
 * 时间轴的上下刻目、鱼骨图的骨刺、树状表格的深层都用它。
 *
 * **所有层级共用同一个 x**（早先是"逐层向右缩进"）：缩进让一条链斜着往上爬，
 * 一列本来该是垂直的——用户原话「不是直接垂直才对吗？」。层级感由每一格自己的
 * 短横线（列脊）表达，不需要靠横移。
 */
export function placeVerticalColumn(
  builder: LayoutBuilder,
  topic: Topic,
  x: number,
  y: number,
  side: -1 | 1,
  depth: number
): void {
  const parentSize = builder.size(topic.id)
  let cursor = side < 0 ? y - builder.gapY : y + parentSize.height + builder.gapY

  for (const child of builder.visibleChildren(topic)) {
    const size = builder.size(child.id)
    const childY = side < 0 ? cursor - size.height : cursor
    builder.add(child, x, childY, depth + 1, side < 0 ? 'up' : 'down')
    placeVerticalColumn(builder, child, x, childY, side, depth + 1)
    cursor = side < 0 ? childY - builder.gapY : childY + size.height + builder.gapY
  }
}

/** 沿水平方向把子节点堆成缩进列表（逐层向下缩进），垂直时间轴使用 */
export function placeHorizontalColumn(
  builder: LayoutBuilder,
  topic: Topic,
  outerX: number,
  startY: number,
  side: -1 | 1,
  depth: number,
  indent: number
): void {
  let cursor = startY
  for (const child of builder.visibleChildren(topic)) {
    const size = builder.size(child.id)
    const childX = side < 0 ? outerX - indent - size.width : outerX + indent
    builder.add(child, childX, cursor, depth + 1, side < 0 ? 'left' : 'right')
    placeHorizontalColumn(
      builder,
      child,
      side < 0 ? childX : childX + size.width,
      cursor,
      side,
      depth + 1,
      indent
    )
    cursor += size.height + builder.gapY
  }
}

/** 思维导图（平衡）：按子树高度把一级分支分到左右两侧 */
export function layoutMindmap(root: Topic, builder: LayoutBuilder): LayoutResult {
  const rootSize = builder.size(root.id)
  const rootNode = builder.add(root, -rootSize.width / 2, -rootSize.height / 2, 0, 'root')

  const entries = builder.visibleChildren(root)

  /**
   * 左右分配：**优先用主题上记录的显式侧**（用户把分支拖到中心主题另一侧时写入），
   * 其余按**顺序交替**——第 1 个在右、第 2 个在左、第 3 个在右……（与 Xmind 平衡图一致）。
   *
   * 这里绝不能按"子树高度"去配平：那样只要挪动一个子节点，
   * 各分支的高度就变了，左右归属会整体翻转，
   * 表现成「分支主题 1 和分支主题 2 莫名其妙换位」——与内容无关的稳定排布才有可预期性。
   */
  const rightSet = new Set<string>()
  entries.forEach((topic, index) => {
    const manual = topic.style?.properties?.[TOPIC_SIDE_KEY]
    if (manual === 'right') rightSet.add(topic.id)
    else if (manual === 'left') return
    else if (index % 2 === 0) rightSet.add(topic.id)
  })

  const inherited = root.structureClass
  placeVerticalChildren(
    builder,
    rootNode,
    entries.filter((topic) => rightSet.has(topic.id)),
    1,
    1,
    undefined,
    inherited
  )
  placeVerticalChildren(
    builder,
    rootNode,
    entries.filter((topic) => !rightSet.has(topic.id)),
    -1,
    1,
    undefined,
    inherited
  )

  const result = builder.finish(root)
  connectTree(result, root, 'bezier', (parent, child) =>
    anchorsForChild(parent, child, horizontalAnchors(parent, child))
  )
  return result
}

/** 逻辑图：所有分支在单侧展开，曲线连接 */
export function layoutLogic(root: Topic, builder: LayoutBuilder, dir: 1 | -1): LayoutResult {
  const rootSize = builder.size(root.id)
  const rootNode = builder.add(root, -rootSize.width / 2, -rootSize.height / 2, 0, 'root')
  placeVerticalChildren(
    builder,
    rootNode,
    builder.visibleChildren(root),
    dir,
    1,
    undefined,
    root.structureClass
  )
  const result = builder.finish(root)
  connectTree(result, root, 'bezier', (parent, child) =>
    anchorsForChild(parent, child, horizontalAnchors(parent, child))
  )
  return result
}

/** 树形图：与逻辑图同构，改用正交折线连接 */
export function layoutTree(root: Topic, builder: LayoutBuilder, dir: 1 | -1): LayoutResult {
  const rootSize = builder.size(root.id)
  const rootNode = builder.add(root, -rootSize.width / 2, -rootSize.height / 2, 0, 'root')
  placeVerticalChildren(
    builder,
    rootNode,
    builder.visibleChildren(root),
    dir,
    1,
    undefined,
    root.structureClass
  )
  const result = builder.finish(root)
  connectTree(result, root, 'elbow-h', (parent, child) =>
    anchorsForChild(parent, child, horizontalAnchors(parent, child))
  )
  return result
}

/** 括号图：子节点整体右移，用括号把一组子节点括起来 */
export function layoutBrace(root: Topic, builder: LayoutBuilder): LayoutResult {
  const lead = Math.max(46, builder.gapX * 0.85)
  const rootSize = builder.size(root.id)
  const rootNode = builder.add(root, -rootSize.width / 2, -rootSize.height / 2, 0, 'root')

  const resolver: XResolver = (_child, _size, parentNode) =>
    parentNode.x + parentNode.width + lead * 2
  placeVerticalChildren(
    builder,
    rootNode,
    builder.visibleChildren(root),
    1,
    1,
    resolver,
    root.structureClass
  )

  const result = builder.finish(root)

  const walk = (topic: Topic): void => {
    const parent = result.nodeMap.get(topic.id)
    const kids = builder
      .visibleChildren(topic)
      .map((child) => result.nodeMap.get(child.id))
      .filter((node): node is NodeLayout => node !== undefined)

    if (parent && kids.length > 0) {
      const parentRight = round(parent.x + parent.width)
      const parentMidY = round(parent.y + parent.height / 2)
      const tipX = parentRight + lead
      const braceX = tipX + 10
      // kids.length > 0 在上面已经判过
      const firstKid = kids[0]!
      const lastKid = kids[kids.length - 1]!
      const top = round(firstKid.y + firstKid.height / 2)
      const bottom = round(lastKid.y + lastKid.height / 2)
      const branchId = firstKid.id

      addDecoration(result, { d: bracePath(braceX, top, bottom, tipX), branchId, widthScale: 0.85 })
      addDecoration(result, {
        d: `M ${parentRight} ${parentMidY} L ${round(tipX - 12)} ${parentMidY}`,
        branchId,
        widthScale: 0.85
      })
      for (const kid of kids) {
        const kidMidY = round(kid.y + kid.height / 2)
        // 括号到子节点的这段仍然是真实的父子关系，所以走 edge 而不是装饰，
        // 保证「每个子节点都有一条属于自己的连线」这个不变量成立
        addEdge(
          result,
          topic.id,
          kid.id,
          { x: braceX, y: kidMidY },
          { x: round(kid.x), y: kidMidY },
          'line'
        )
      }
    }

    for (const child of builder.visibleChildren(topic)) walk(child)
  }
  walk(root)
  return result
}

/**
 * 树状表格：**表格**形状。
 *
 * 参考：「根在**最上方 / 左上**；一级主题作为**行**；子主题填进各行的**单元格**，
 * 按深度向右排列；靠**表格边框与缩进**表达层级，**没有连线**」。
 *
 * 所以：**每一行 = 一个一级分支及其全部后代**（按深度分列，同一深度共用同一个列 x，
 * 这才有表格的纵向对齐），行高由这一行最长的那条链决定；每行画一个框。
 */
export function layoutSpreadsheet(root: Topic, builder: LayoutBuilder): LayoutResult {
  // 每一层的列宽 = 该层最宽的节点（跨行共用，保证各行的同层单元格左边缘对齐）
  const widthByDepth: number[] = []
  const scan = (topic: Topic, depth: number): void => {
    const size = builder.size(topic.id)
    widthByDepth[depth] = Math.max(widthByDepth[depth] ?? 0, size.width)
    for (const child of builder.visibleChildren(topic)) scan(child, depth + 1)
  }
  scan(root, 0)

  const colX: number[] = []
  let cursorX = 0
  for (let depth = 0; depth < widthByDepth.length; depth += 1) {
    colX[depth] = cursorX
    cursorX += (widthByDepth[depth] ?? 0) + builder.gapX
  }

  const rootSize = builder.size(root.id)
  const rootNode = builder.add(root, colX[0] ?? 0, 0, 0, 'root')

  const rows: Array<{ top: number; left: number; right: number; bottom: number }> = []
  let cursorY = rootNode.y + rootSize.height + builder.gapY * 2

  for (const branch of builder.visibleChildren(root)) {
    const rowTop = cursorY
    let rowBottom = cursorY
    let rowRight = colX[1] ?? 0
    const place = (topic: Topic, depth: number): void => {
      const size = builder.size(topic.id)
      const node = builder.add(topic, colX[depth] ?? 0, cursorY, depth, 'down')
      rowBottom = Math.max(rowBottom, node.y + node.height)
      rowRight = Math.max(rowRight, node.x + node.width)
      cursorY += size.height + builder.gapY
      for (const child of builder.visibleChildren(topic)) place(child, depth + 1)
    }
    place(branch, 1)
    rows.push({ top: rowTop, left: colX[1] ?? 0, right: rowRight, bottom: rowBottom })
    cursorY += builder.gapY * 1.6
  }

  const result = builder.finish(root)
  /** 每行一个框：表格的"行"感由框 + 列对齐表达（参考：没有连线） */
  for (const row of rows) {
    const pad = 10
    addDecoration(result, {
      d: roundedRectPath(
        round(row.left - pad),
        round(row.top - pad),
        round(row.right - row.left + pad * 2),
        round(row.bottom - row.top + pad * 2),
        10
      ),
      widthScale: 1
    })
  }
  return result
}
