/**
 * 视口动作注册表。
 * 让工具栏 / 菜单可以触发只存在于画布内部的「适应画布」「回到中心」等操作。
 */
export interface ViewportActions {
  /** 缩放以适应画布 */
  fit(): void
  /** 回到根主题中心 */
  centerRoot(): void
  /** 以画布中心为锚点缩放到指定比例 */
  zoomTo(zoom: number): void
  /** 把指定节点滚动到可见范围内（新节点可能生成在视口外） */
  ensureVisible(id: string): void
}

export const viewportActions: ViewportActions = {
  fit: () => {},
  centerRoot: () => {},
  zoomTo: () => {},
  ensureVisible: () => {}
}
