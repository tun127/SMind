/**
 * 分支级结构：让「分支自己声明的结构类型」真正决定它子树的排布。
 *
 * 背景：此前 layoutSheet 只读中心主题的 structureClass，整张画布只能有一种结构；
 * 在分支上用「结构▾」切换虽然会写入数据，但布局完全忽略，
 * 表现成「分支上切换结构无效」。
 *
 * 做法：布局递归的每个「放子节点」的点上都会问一句——
 * 这个子主题自己声明了不同的结构吗？声明了就把它的子树交给对应家族的摆放函数。
 *
 * v1 支持作为分支结构：逻辑图（左/右）、树形图（左/右）、思维导图（平衡）、
 * 组织架构图（上/下）、鱼骨图。时间轴 / 括号图 / 树状表格 / 矩阵 / 放射状
 * 暂回落为当前家族的排布（数据不丢，README 已知限制有说明）。
 */
import type { StructureClass, Topic } from '../model/types'
import { getStructureDef, TOPIC_SIDE_KEY } from '../xmind/constants'
import type { NodeLayout, Side } from './types'
import type { Anchor, LayoutBuilder } from './core'
import { addDecoration, bracePath, verticalAnchors } from './core'
import { placeVerticalChildren, placeVerticalColumn } from './stack'
import { placeOrgChartChildren } from './orgchart'
import { placeFishboneSubtree } from './fishbone-subtree'

/** 分支级支持的家族：结构清单里的全部家族（时间轴/括号/树状表格/矩阵是 v1.1 补上的） */
const SUPPORTED_BRANCH_FAMILIES = new Set([
  'logic',
  'tree',
  'mindmap',
  'orgchart',
  'fishbone',
  'timeline',
  'brace',
  'spreadsheet',
  'matrix'
])

/** 主题的有效结构：自己的 structureClass 优先，否则继承父链 */
export function effectiveStructure(
  topic: Topic,
  inherited: StructureClass | undefined
): StructureClass {
  return topic.structureClass ?? inherited ?? getStructureDef(undefined).class
}

/** 子主题是否声明了与当前家族不同、且分支级受支持的结构（有子树才有意义） */
export function declaresOwnStructure(
  builder: LayoutBuilder,
  child: Topic,
  current: StructureClass | undefined
): boolean {
  if (!child.structureClass || child.structureClass === current) return false
  const family = getStructureDef(child.structureClass).family
  if (family === getStructureDef(current).family) return false
  if (builder.visibleChildren(child).length === 0) return false
  return SUPPORTED_BRANCH_FAMILIES.has(family)
}

/** 连线锚点：按子主题声明的家族与它所在的排布方向选锚点 */
export function anchorsForChild(
  parent: NodeLayout,
  child: NodeLayout,
  fallback: { from: Anchor; to: Anchor }
): { from: Anchor; to: Anchor } {
  const declared = child.topic.structureClass
  if (declared) {
    const family = getStructureDef(declared).family
    if (family === 'fishbone' || family === 'timeline' || family === 'matrix') {
      // 骨刺 / 时间轴刻目 / 矩阵格：从父级右缘连到子主题近侧；
      // 鱼骨与时间轴的主脊横线由 fishbone-subtree 的 finish 钩子补画
      return { from: 'right', to: 'left' }
    }
    if (family === 'orgchart') {
      return verticalAnchors(parent, child)
    }
    // brace 的括号本身就是连线（connectTree 会跳过这条边）
  }
  // 纵向缩进列里的边（鱼骨深层、树状表格的列、时间轴分支）按几何取上下锚点，
  // 否则沿用父级家族的默认锚点会把「在正下方」的子节点连成斜线
  if (child.side === 'up' || child.side === 'down') {
    return verticalAnchors(parent, child)
  }
  return fallback
}

/**
 * 在 (x, y)（topic 的左上角）摆放以 topic 为根的子树：
 * topic 自身摆好后，子树内部按 topic 的有效结构家族排布。
 */
export function placeSubtree(
  builder: LayoutBuilder,
  topic: Topic,
  x: number,
  y: number,
  depth: number,
  side: Side,
  inherited: StructureClass | undefined
): void {
  builder.add(topic, x, y, depth, side)
  const cls = effectiveStructure(topic, inherited)
  const family = getStructureDef(cls).family

  if (family === 'orgchart') {
    placeOrgChartChildren(
      builder,
      topic,
      x,
      y,
      depth,
      cls === 'org.xmind.ui.org-chart.up' ? 'up' : 'down',
      cls
    )
    return
  }
  if (family === 'fishbone' || family === 'timeline') {
    // 时间轴（水平）与鱼骨共用「主脊 + 上下交替」的几何；主脊由钩子补画
    placeFishboneSubtree(builder, topic, depth, cls)
    return
  }
  if (family === 'matrix') {
    placeMatrixChildren(builder, topic, x, y, depth, cls)
    return
  }
  if (family === 'brace') {
    placeBraceChildren(builder, topic, x, y, depth, cls)
    return
  }
  if (family === 'spreadsheet') {
    placeSpreadsheetChildren(builder, topic, x, y, depth, cls)
    return
  }
  if (family === 'mindmap') {
    placeMindmapChildren(builder, topic, depth, cls)
    return
  }
  // logic / tree（以及回落到逻辑图的家族）：沿单侧垂直堆叠
  const dir: 1 | -1 = side === 'left' ? -1 : 1
  const node = builder.nodeMap.get(topic.id)
  if (!node) return
  placeVerticalChildren(builder, node, builder.visibleChildren(topic), dir, depth, undefined, cls)
}

/** 平衡思维导图的分支摆放：按顺序交替分到左右，手动指定的侧优先 */
function placeMindmapChildren(
  builder: LayoutBuilder,
  topic: Topic,
  depth: number,
  inherited: StructureClass
): void {
  const node = builder.nodeMap.get(topic.id)
  if (!node) return
  const right: Topic[] = []
  const left: Topic[] = []
  builder.visibleChildren(topic).forEach((child, index) => {
    const manual = child.style?.properties?.[TOPIC_SIDE_KEY]
    if (manual === 'left') left.push(child)
    else if (manual === 'right' || index % 2 === 0) right.push(child)
    else left.push(child)
  })
  placeVerticalChildren(builder, node, right, 1, depth + 1, undefined, inherited)
  placeVerticalChildren(builder, node, left, -1, depth + 1, undefined, inherited)
}

/**
 * 矩阵图：子主题排成网格（最多两列，按列填充），整体垂直居中于分支右侧。
 * 每列宽取该列子树的最大宽、每行高取该行最大高，格子互不重叠。
 */
function placeMatrixChildren(
  builder: LayoutBuilder,
  topic: Topic,
  x: number,
  y: number,
  depth: number,
  inherited: StructureClass
): void {
  const node = builder.nodeMap.get(topic.id)
  if (!node) return
  const kids = builder.visibleChildren(topic)
  if (kids.length === 0) return

  const cols = Math.min(2, kids.length)
  const rows = Math.ceil(kids.length / cols)
  const extents = kids.map((kid) => builder.subtreeExtent(kid, inherited))

  const colWidths: number[] = []
  for (let c = 0; c < cols; c += 1) {
    let width = 0
    for (let i = c; i < kids.length; i += cols) width = Math.max(width, extents[i]?.width ?? 0)
    colWidths.push(width)
  }
  const rowHeights: number[] = []
  for (let r = 0; r < rows; r += 1) {
    let height = 0
    for (let i = r * cols; i < Math.min((r + 1) * cols, kids.length); i += 1) {
      height = Math.max(height, extents[i]?.height ?? 0)
    }
    rowHeights.push(height)
  }

  const totalHeight = rowHeights.reduce((a, b) => a + b, 0) + builder.gapY * (rows - 1)
  const top = y + node.height / 2 - totalHeight / 2
  const left = x + node.width + builder.gapX

  for (let c = 0; c < cols; c += 1) {
    let cursorY = top
    const cellX = left + colWidths.slice(0, c).reduce((a, b) => a + b, 0) + builder.gapX * c
    /**
     * 与其它家族同一套避让思路：同一列里逐个下推。
     *
     * 矩阵只消费 `position.y`（横向靠格位，不吃 x 偏移），所以手动拖过的节点
     * 会往下压到同列的下一个格位上。先按「上一格的底边 + 间距」算好每个格位的最终 y，
     * 再摆子树。没有偏移时判据恒不触发，坐标与以前完全一致。
     */
    const column: Array<{ child: Topic; y: number }> = []
    let floor = Number.NEGATIVE_INFINITY
    for (let r = 0; r < rows; r += 1) {
      const index = r * cols + c
      if (index >= kids.length) break
      const child = kids[index]
      if (!child) break
      const size = builder.size(child.id)
      const desiredY = cursorY + ((rowHeights[r] ?? 0) - size.height) / 2 + (child.position?.y ?? 0)
      const cellY = desiredY < floor ? floor : desiredY
      floor = cellY + size.height + builder.gapY
      column.push({ child, y: cellY })
      cursorY += (rowHeights[r] ?? 0) + builder.gapY
    }

    for (const item of column) {
      const { child, y: cellY } = item
      if (declaresOwnStructure(builder, child, inherited)) {
        placeSubtree(builder, child, cellX, cellY, depth + 1, 'right', inherited)
      } else {
        builder.add(child, cellX, cellY, depth + 1, 'right')
        placeMatrixChildren(builder, child, cellX, cellY, depth + 1, inherited)
      }
    }
  }
}

/**
 * 括号图：子主题垂直排成一列，括号在 finish 钩子里补画
 * （父子连线由 connectTree 跳过——括号本身就是连线）。
 */
function placeBraceChildren(
  builder: LayoutBuilder,
  topic: Topic,
  x: number,
  _y: number,
  depth: number,
  inherited: StructureClass
): void {
  const node = builder.nodeMap.get(topic.id)
  if (!node) return
  const kids = builder.visibleChildren(topic)
  if (kids.length === 0) return

  const columnX = x + node.width + builder.gapX
  placeVerticalChildren(builder, node, kids, 1, depth + 1, () => columnX, inherited)

  builder.onFinish((result) => {
    const branch = result.nodeMap.get(topic.id)
    if (!branch) return
    let top = Number.POSITIVE_INFINITY
    let bottom = Number.NEGATIVE_INFINITY
    let left = Number.POSITIVE_INFINITY
    for (const child of kids) {
      const item = result.nodeMap.get(child.id)
      if (!item) continue
      top = Math.min(top, item.y)
      bottom = Math.max(bottom, item.y + item.height)
      left = Math.min(left, item.x)
    }
    if (!Number.isFinite(top)) return
    addDecoration(result, {
      d: bracePath(left - builder.gapX * 0.5, top, bottom, branch.x + branch.width + 4),
      branchId: topic.id,
      widthScale: 1.2
    })
  })
}

/**
 * 树状表格：子主题横向排成「表头行」，各自的后代沿垂直缩进列表往下排，
 * 横看是列、竖看是行，接近表格的行列感。
 */
function placeSpreadsheetChildren(
  builder: LayoutBuilder,
  topic: Topic,
  x: number,
  y: number,
  depth: number,
  inherited: StructureClass
): void {
  const node = builder.nodeMap.get(topic.id)
  if (!node) return
  const kids = builder.visibleChildren(topic)
  if (kids.length === 0) return

  let cursor = x + node.width + builder.gapX
  for (const child of kids) {
    const extent = builder.subtreeExtent(child, inherited).width
    const size = builder.size(child.id)
    const childX = cursor + extent / 2 - size.width / 2 + (child.position?.x ?? 0)
    const childY = y + node.height + builder.gapY + (child.position?.y ?? 0)

    if (declaresOwnStructure(builder, child, inherited)) {
      placeSubtree(builder, child, childX, childY, depth + 1, 'down', inherited)
    } else {
      builder.add(child, childX, childY, depth + 1, 'down')
      placeVerticalColumn(
        builder,
        child,
        childX,
        childY,
        1,
        depth + 1,
        Math.max(18, builder.gapX * 0.5)
      )
    }
    cursor += extent + builder.gapX
  }
}
