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

/**
 * 空实现：既是**画布挂载前**的初始值，也是**画布卸载后**的复位值。
 *
 * 为什么要有复位：这个对象是**模块级单例**，由 Canvas 在挂载时把自己的闭包挂上来。
 * 卸载时若不复位，工具栏 / 搜索面板 / AI 面板再点「适应画布」「跳到命中」就会去调用
 * 一个已经不在的画布——那些闭包读的是旧组件的 ref 与旧 DOM，轻则什么也不做，
 * 重则在已卸载的组件上做事。空实现比"以为还能用"诚实。
 */
export const NOOP_VIEWPORT_ACTIONS: ViewportActions = {
  fit: () => {},
  centerRoot: () => {},
  zoomTo: () => {},
  ensureVisible: () => {},
  centerOn: () => {},
  flash: () => {}
}

export const viewportActions: ViewportActions = { ...NOOP_VIEWPORT_ACTIONS }
