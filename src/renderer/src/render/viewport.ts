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
  /** 把指定节点移到视口正中（搜索命中跳转用） */
  centerOn(id: string): void
  /**
   * 让这些节点**闪一下**（AI 刚改过它们）。
   *
   * 放在这里是因为它和视口动作是同一类东西：画布对外暴露的**临时**视觉效果，
   * 由画布自己在挂载时实现、别处只负责触发（与 centerOn 同一套做法）。
   */
  flash(ids: string[]): void
}

export const viewportActions: ViewportActions = {
  fit: () => {},
  centerRoot: () => {},
  zoomTo: () => {},
  ensureVisible: () => {},
  centerOn: () => {},
  flash: () => {}
}
