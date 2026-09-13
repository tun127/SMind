/**
 * 「垂直堆叠」家族：思维导图、逻辑图、树形图、括号图、树状表格。
 * 它们的共同点是子节点沿垂直方向排列，区别在于
 *  - 往哪一侧展开（左右 / 单侧）
 *  - 连线形状（曲线 / 折线 / 直连线）
 *  - 是否用括号等装饰（括号图）
 *  - x 坐标是相对父节点还是按层级对齐（树状表格）
 */
import type { Topic } from '../model/types'
import { TOPIC_SIDE_KEY } from '../xmind/constants'
import type { LayoutResult, MeasureResult, NodeLayout } from './types'
import { LayoutBuilder, addDecoration, addEdge, bracePath, connectTree, horizontalAnchors, round } from './core'

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
  xResolver?: XResolver
): void {
  if (kids.length === 0) return

  let total = 0
  for (let i = 0; i < kids.length; i += 1) {
    total += builder.verticalExtent(kids[i]) + (i > 0 ? builder.gapY : 0)
  }

  let cursor = parentNode.y + parentNode.height / 2 - total / 2
  for (const child of kids) {
    const extent = builder.verticalExtent(child)
    const size = builder.size(child.id)
    const centerY = cursor + extent / 2
    const defaultX =
      dir === 1 ? parentNode.x + parentNode.width + builder.gapX : parentNode.x - builder.gapX - size.width
    const x = xResolver ? xResolver(child, size, parentNode, dir, depth) : defaultX
    const node = builder.add(
      child,
      x + (child.position?.x ?? 0),
      centerY - size.height / 2 + (child.position?.y ?? 0),
      depth,
      dir === 1 ? 'right' : 'left'
    )
    placeVerticalChildren(builder, node, builder.visibleChildren(child), dir, depth + 1, xResolver)
    cursor += extent + builder.gapY
  }
}

/**
 * 沿垂直方向把子节点堆成缩进列表（逐层向右缩进）。
 * 时间轴的上下分支、鱼骨图的骨刺都用它。
 */
export function placeVerticalColumn(
  builder: LayoutBuilder,
  topic: Topic,
  x: number,
  y: number,
  side: -1 | 1,
  depth: number,
  indent: number
): void {
  const parentSize = builder.size(topic.id)
  let cursor = side < 0 ? y - builder.gapY : y + parentSize.height + builder.gapY

  for (const child of builder.visibleChildren(topic)) {
    const size = builder.size(child.id)
    const childY = side < 0 ? cursor - size.height : cursor
    builder.add(child, x + indent, childY, depth + 1, side < 0 ? 'up' : 'down')
    placeVerticalColumn(builder, child, x + indent, childY, side, depth + 1, indent)
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
    placeHorizontalColumn(builder, child, side < 0 ? childX : childX + size.width, cursor, side, depth + 1, indent)
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

  placeVerticalChildren(
    builder,
    rootNode,
    entries.filter((topic) => rightSet.has(topic.id)),
    1,
    1
  )
  placeVerticalChildren(
    builder,
    rootNode,
    entries.filter((topic) => !rightSet.has(topic.id)),
    -1,
    1
  )

  const result = builder.finish(root)
  connectTree(result, root, 'bezier', horizontalAnchors)
  return result
}

/** 逻辑图：所有分支在单侧展开，曲线连接 */
export function layoutLogic(root: Topic, builder: LayoutBuilder, dir: 1 | -1): LayoutResult {
  const rootSize = builder.size(root.id)
  const rootNode = builder.add(root, -rootSize.width / 2, -rootSize.height / 2, 0, 'root')
  placeVerticalChildren(builder, rootNode, builder.visibleChildren(root), dir, 1)
  const result = builder.finish(root)
  connectTree(result, root, 'bezier', horizontalAnchors)
  return result
}

/** 树形图：与逻辑图同构，改用正交折线连接 */
export function layoutTree(root: Topic, builder: LayoutBuilder, dir: 1 | -1): LayoutResult {
  const rootSize = builder.size(root.id)
  const rootNode = builder.add(root, -rootSize.width / 2, -rootSize.height / 2, 0, 'root')
  placeVerticalChildren(builder, rootNode, builder.visibleChildren(root), dir, 1)
  const result = builder.finish(root)
  connectTree(result, root, 'elbow-h', horizontalAnchors)
  return result
}

/** 括号图：子节点整体右移，用括号把一组子节点括起来 */
export function layoutBrace(root: Topic, builder: LayoutBuilder): LayoutResult {
  const lead = Math.max(46, builder.gapX * 0.85)
  const rootSize = builder.size(root.id)
  const rootNode = builder.add(root, -rootSize.width / 2, -rootSize.height / 2, 0, 'root')

  const resolver: XResolver = (_child, _size, parentNode) => parentNode.x + parentNode.width + lead * 2
  placeVerticalChildren(builder, rootNode, builder.visibleChildren(root), 1, 1, resolver)

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
      const top = round(kids[0].y + kids[0].height / 2)
      const bottom = round(kids[kids.length - 1].y + kids[kids.length - 1].height / 2)
      const branchId = kids[0].id

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
        addEdge(result, topic.id, kid.id, { x: braceX, y: kidMidY }, { x: round(kid.x), y: kidMidY }, 'line')
      }
    }

    for (const child of builder.visibleChildren(topic)) walk(child)
  }
  walk(root)
  return result
}

/** 树状表格：每一层固定一列，行按子树高度堆叠 */
export function layoutSpreadsheet(root: Topic, builder: LayoutBuilder): LayoutResult {
  const maxWidthByDepth: number[] = []
  const scan = (topic: Topic, depth: number): void => {
    const size = builder.size(topic.id)
    maxWidthByDepth[depth] = Math.max(maxWidthByDepth[depth] ?? 0, size.width)
    for (const child of builder.visibleChildren(topic)) scan(child, depth + 1)
  }
  scan(root, 0)

  const colX: number[] = []
  let cursor = 0
  for (let depth = 0; depth < maxWidthByDepth.length; depth += 1) {
    colX[depth] = cursor
    cursor += maxWidthByDepth[depth] + builder.gapX
  }

  const rootSize = builder.size(root.id)
  const rootNode = builder.add(root, colX[0] ?? 0, -rootSize.height / 2, 0, 'root')

  const resolver: XResolver = (_child, _size, _parent, _dir, depth) => colX[depth] ?? 0
  placeVerticalChildren(builder, rootNode, builder.visibleChildren(root), 1, 1, resolver)

  const result = builder.finish(root)
  // 表格用直角横线连接，接近表格的行列感
  connectTree(result, root, 'line', horizontalAnchors)
  return result
}
