import type { LayoutResult } from '@shared/layout/types'

/**
 * 画布最近一帧布局的只读快照。
 *
 * 独立主题创建时要“视觉原地不动”，而 store 没有测量能力；大纲面板又不在 Canvas 的
 * React 子树里。这里只保存**最近一帧**的布局引用，让动作触发时可以读到旧节点坐标，
 * 反算 `position`。它不是数据真相，不参与撤销、存档或渲染状态。
 */
let latest: LayoutResult | null = null

export function rememberCanvasLayout(layout: LayoutResult): void {
  latest = layout
}

export function canvasLayoutNode(id: string): { x: number; y: number } | null {
  const node = latest?.nodeMap.get(id)
  return node ? { x: node.x, y: node.y } : null
}
