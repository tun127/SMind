/**
 * 分支级鱼骨图：主脊从分支右侧延伸，一级子主题左右交替斜向伸出，
 * 更深层沿远离主脊的方向堆成缩进列表。
 */
import type { StructureClass, Topic } from '../model/types'
import type { LayoutBuilder } from './core'
import { addDecoration, round } from './core'
import { placeVerticalColumn } from './stack'

export function placeFishboneSubtree(
  builder: LayoutBuilder,
  topic: Topic,
  depth: number,
  inherited: StructureClass
): void {
  const node = builder.nodeMap.get(topic.id)
  if (!node) return
  const size = builder.size(topic.id)
  const spineY0 = node.y + size.height / 2
  const kids = builder.visibleChildren(topic)
  const indent = Math.max(18, builder.gapX * 0.5)
  const boneOffset = Math.max(size.height / 2 + builder.gapY * 3, 46)
  const boneSlant = Math.round(boneOffset * 0.45)
  const anchors: Array<{ id: string; x: number; side: number }> = []
  let cursor = node.x + size.width + builder.gapX * 2
  kids.forEach((child, index) => {
    const extent = builder.subtreeExtent(child, inherited).width
    const childSize = builder.size(child.id)
    const centerX = cursor + boneSlant + extent / 2
    const anchorX = centerX - boneSlant
    const side: number = index % 2 === 0 ? -1 : 1
    const childY = side < 0 ? spineY0 - boneOffset - childSize.height : spineY0 + boneOffset
    builder.add(child, centerX - childSize.width / 2, childY, depth + 1, side < 0 ? 'up' : 'down')
    placeVerticalColumn(
      builder,
      child,
      centerX - childSize.width / 2,
      childY,
      side < 0 ? -1 : 1,
      depth + 1,
      indent
    )
    anchors.push({ id: child.id, x: Math.round(anchorX), side })
    cursor += extent + builder.gapX + boneSlant + indent * (builder.maxDepth(child) - 1)
  })

  // 主脊：坐标归一化之后从分支右缘向右补一条横线，鱼骨的「脊」才看得见
  builder.onFinish((result) => {
    const branch = result.nodeMap.get(topic.id)
    if (!branch) return
    const spineY = branch.y + branch.height / 2
    let endX = branch.x + branch.width
    for (const anchor of anchors) {
      const child = result.nodeMap.get(anchor.id)
      if (!child) continue
      endX = Math.max(endX, child.x + child.width / 2)
    }
    addDecoration(result, {
      d: `M ${round(branch.x + branch.width)} ${round(spineY)} L ${round(endX + 16)} ${round(spineY)}`,
      branchId: topic.id,
      widthScale: 1.6
    })
  })
}
