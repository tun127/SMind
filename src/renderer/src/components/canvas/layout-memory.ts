import type { LayoutResult } from '@shared/layout/types'

/**
 * 画布最近一帧布局的只读快照，**按文档记账**。
 *
 * 独立主题创建时要"视觉原地不动"，而 store 没有测量能力；大纲面板又不在 Canvas 的
 * React 子树里。这里只保存**最近一帧**的布局引用，让动作触发时可以读到旧节点坐标，
 * 反算 `position`。它不是数据真相，不参与撤销、存档或渲染状态。
 *
 * 为什么要带 `docKey`：热点里可能同时有两份文档，而不同文档的主题 id 是可能撞的
 * （例如同一个模板导出的两个 .xmind 都是 `topic-0001`）—— 只按 id 查，换文档后的
 * 那一两帧里会读到**另一份文档**的坐标，把新独立主题放到莫名其妙的位置。
 * 带上文档标识后，"换了文档"这件事**天然不匹配**，不需要谁记得去清理。
 *
 * 取不到坐标时（例如刚换文档、还没有第一帧布局）调用方传 `position: undefined`，
 * 布局按**兜底口径**放置：中心主题右侧、多个独立主题纵向层叠（见 `shared/layout/detached.ts`）。
 */
let latest: { docKey: string; layout: LayoutResult } | null = null

/** 记下这一帧布局属于哪份文档（`docKey` 用当前画布的根主题 id，与调用方同一口径） */
export function rememberCanvasLayout(docKey: string, layout: LayoutResult): void {
  latest = { docKey, layout }
}

/** 读某份文档里某个主题的布局坐标；文档不匹配或主题不在快照里都返回 null */
export function canvasLayoutNode(docKey: string, id: string): { x: number; y: number } | null {
  if (latest === null || latest.docKey !== docKey) return null
  const node = latest.layout.nodeMap.get(id)
  return node ? { x: node.x, y: node.y } : null
}
