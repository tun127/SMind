import type { Topic } from '../model/types'
import type { LayoutBuilder } from './core'
import { placeVerticalChildren } from './stack'

/** 独立主题虽然不在树里，但视觉上仍按“一级主题”量字，深度固定为 1。 */
const DETACHED_DEPTH = 1

/**
 * 给中心主题的 `detachedChildren` 产出布局图元。
 *
 * 口径（本批定死）：
 * - `position` 是**相对中心主题左上角的偏移**；给出时直接 `rootNode.x + position.x`。
 * - 没给 `position` 时放在根主题右侧、垂直居中，多个独立主题按顺序纵向层叠（确定性兜底）。
 * - 整棵子树用 `placeVerticalChildren` 递归摆放；非根级 `detachedChildren` 不参与。
 *
 * 这个函数通过 `LayoutBuilder.onBeforeFinish` 在坐标归一化之前调用，所以独立主题会被
 * `finish` 自动纳入 bounds / geometryHash / 节点复用，不需要另建缓存。
 */
export function placeDetachedRoots(builder: LayoutBuilder, root: Topic): void {
  const rootNode = builder.nodeMap.get(root.id)
  if (!rootNode) return

  let stackCenterY = rootNode.y + rootNode.height / 2
  for (const floating of root.detachedChildren) {
    const size = builder.size(floating.id)
    const offset = floating.position
    const x = rootNode.x + (offset ? offset.x : rootNode.width + builder.gapX)
    const y = offset ? rootNode.y + offset.y : stackCenterY - size.height / 2

    const node = builder.add(floating, x, y, DETACHED_DEPTH, 'right')
    node.detached = true
    if (!offset) stackCenterY += size.height + builder.gapY

    placeVerticalChildren(
      builder,
      node,
      builder.visibleChildren(floating),
      1,
      DETACHED_DEPTH + 1,
      undefined,
      undefined
    )
  }
}
