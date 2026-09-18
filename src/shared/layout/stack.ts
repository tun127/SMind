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
  anchorsForChild,
  bracePath,
  connectTree,
  horizontalAnchors,
  round
} from './core'

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

/**
 * 树形图：与逻辑图同构，但连线是**直角折线**。
 *
 * 两个结构的区分恰恰就在连线形状上（官方对两者都只规定了布局方向，没规定连线形状，
 * 这是**我方取值**，见 `docs/structure-spec.md`）：**逻辑图＝曲线**、**树形图＝直角折线**。
 * 有一轮我把树形图也改成了曲线——用户当场指出「树形图和逻辑图长的一模一样，
 * 没有任何区别」，所以这里必须与逻辑图拉开：曲线是弧线枝干（读作"发散"），
 * 折线是有棱角的枝干（读作"分类树"）。
 */
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
      /**
       * **不画父子连线**。
       *
       * 官方（括号图制作工具页）：「将主要主题放在左侧，向右扩展的**支架（大括号）**用于显示
       * 组成部分和子部分」——层级完全由大括号表达；括号图的通行规范也是"不用连线/箭头"，
       * 这正是它与思维导图的根本区别。
       *
       * 以前这里补了"括号 → 每个子节点"的直线，理由是"每个子节点都要有一条属于自己的连线"
       * 这个不变量——那是为别的结构立的规矩，套到括号图上就把图弄脏了。
       * 现在括号图与矩阵/树状表格同属"靠装饰表达层级"的结构，不变量改判"必须画出括号"。
       */
    }

    for (const child of builder.visibleChildren(topic)) walk(child)
  }
  walk(root)
  return result
}

/**
 * 树状表格：**带层级的多列表格**。
 *
 * 官方原文（《树型表格上线》2021-05-10、《介绍树形表格》2021-06-06）：
 *  - 「按**总-分-分**的树状逻辑脉络展开」→ 展开方向＝从左到右，**深度＝列**；
 *  - 「主题以**嵌套块**的形式显示，您可以不断地在块中保持树枝的增长」→ 每个主题是一个块（格子），
 *    层级由**缩进**表达；
 *  - 「节点在主题中**默认右对齐**，可以用于记录数据」→ 单元格内的文本对齐（渲染层的事）；
 *  - 「靠**表格的行列结构与缩进/对齐**表达层级」→ **画网格线，不画父子连线**。
 *
 * 几何：前序遍历给每个主题一行（行高＝该主题自身高度），列号＝深度，且**同一深度共用同一个 x**
 * （列宽取该深度最宽的节点）——同一层级的块左边缘对齐，纵向才读得出"列"。
 *
 * 两条踩过的坑，写在这儿免得再犯：
 * ① **不要把"行"理解成"一个一级分支及其全部后代"**：那样一行里混着好几个层级的高度，
 *    网格线只能按子树分组画成一条条长短不一的长横线，读起来既不像表格、也不知道在划什么
 *    （用户：「看着乱七八糟」，后来直接说「根本无法使用」）；
 * ② 网格线必须用**归一化之后**的坐标算，否则线和格子对不上。
 */
export function layoutSpreadsheet(root: Topic, builder: LayoutBuilder): LayoutResult {
  // 每一层的列宽 = 该层最宽的节点（跨行共用，保证同一深度的块左边缘对齐）
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
  const tableRight = cursorX - builder.gapX

  const rootSize = builder.size(root.id)
  const rootNode = builder.add(root, colX[0] ?? 0, 0, 0, 'root')

  /** 每个主题占一行：前序遍历（父在子上、子树连续），与大纲的读法一致 */
  let cursorY = rootNode.y + rootSize.height + builder.gapY
  const rowIds: string[] = [root.id]
  const place = (topic: Topic, depth: number): void => {
    for (const child of builder.visibleChildren(topic)) {
      const size = builder.size(child.id)
      builder.add(child, colX[depth] ?? 0, cursorY, depth, 'down')
      rowIds.push(child.id)
      cursorY += size.height + builder.gapY
      place(child, depth + 1)
    }
  }
  place(root, 1)

  const result = builder.finish(root)

  const nodes = rowIds
    .map((id) => result.nodeMap.get(id))
    .filter((node): node is NodeLayout => node !== undefined)
  if (nodes.length === 0) return result

  /**
   * 网格线：**每行下方一条横线（贯穿整表宽度）+ 每个层级分界一条竖线（贯穿整表高度）**。
   *
   * 为什么必须"贯穿"：表格的读法全靠这些线把行列切出来。只画一段（比如只包住这一行、
   * 或只包住一棵子树），行与列的对应关系就断了——上一版就是这么画的，于是看起来像
   * "缩进的文字下随机划了几条线"。
   */
  const left = round(colX[0] ?? 0)
  const top = round(Math.min(...nodes.map((node) => node.y)) - builder.gapY / 2)
  const bottom = round(Math.max(...nodes.map((node) => node.y + node.height)) + builder.gapY / 2)
  const right = round(tableRight)

  // 顶边：把第一行（读起来就是表头行）封起来
  addDecoration(result, { d: `M ${left} ${top} L ${right} ${top}`, widthScale: 1 })
  // 行线：每个主题一行，线画在它下方（根的下一行也自然被上一条线分开）
  for (const node of nodes) {
    const y = round(node.y + node.height + builder.gapY / 2)
    addDecoration(result, { d: `M ${left} ${y} L ${right} ${y}`, widthScale: 1 })
  }
  // 列线：每个层级的分界（含最左边界）——同一深度的块靠它读成一列
  for (let depth = 0; depth <= widthByDepth.length - 1; depth += 1) {
    const x = round((colX[depth] ?? 0) - builder.gapX / 2)
    addDecoration(result, { d: `M ${x} ${top} L ${x} ${bottom}`, widthScale: 1 })
  }

  return result
}
