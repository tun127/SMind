/**
 * 画布级元素切片（自 `editor.ts` 的「画布级元素」分节整块搬出，成员体逐字未改）：
 * 关系线 / 边界 / 概要的增删改、覆盖层选中态、四个「请求焦点」计数器、应用设置。
 *
 * 这些成员在原文件里就是同一个分节（同一个 banner），故按**既有分节边界**整体成一切片，不再细分：
 * 它们都围绕「选中 / 打开面板 / 写画布级元素」这一件事。
 * `setAppSettings` 留在这里（设置面板与 `patchAppSettings` 的入口）；`patchAppSettings` 本身按计划表
 * **留在 `editor.ts`**（store + IPC）。
 *
 * 本文件同时拥有这些成员在 `EditorState` 里的**声明**（接口逐字搬来）。
 */
import { type AppSettings } from '@shared/ipc'
import { type OverlayKind, type OverlayTextStylePatch } from '@shared/model/overlay-style'

export interface OverlaysSlice {
  /* ---- 画布级元素（关系线 / 边界 / 概要） ---- */
  /**
   * 这三个都是「开关」：选中状态已经存在对应元素时再点一次是移除，
   * 避免同一个范围被反复叠加出多个元素（叠加会让颜色越来越深）。
   * @returns 新建元素的 id；本次是移除则返回 null
   */
  addRelationship(): string | null
  addBoundary(): string | null
  addSummary(): string | null
  removeRelationship(id: string): void
  removeBoundary(id: string): void
  removeSummary(id: string): void
  /** 拖动线身调整弧线位置（偏移量累加，连续拖动合并为一步撤销） */
  offsetRelationshipCurve(id: string, dx: number, dy: number): void
  /** 把弧线弯度恢复到自动计算的位置 */
  resetRelationshipCurve(id: string): void
  /** 框选用：一次性设置选中集合 */
  setSelection(ids: string[]): void
  /**
   * 画布级元素（概要 / 边界 / 关系线）的选中态。
   *
   * 选中它们就能在面板里改文字与字体样式——概要因此成为「一等公民」：
   * 空文字时也点得到、选得中，不再是「删空就只能删掉重建」。
   */
  selectedOverlay: { kind: OverlayKind; id: string } | null
  selectOverlay(kind: OverlayKind, id: string): void
  clearOverlaySelection(): void
  /**
   * 「请打开节点属性面板」的信号（自增计数）。
   *
   * 画布在选中画布元素（概要/边界/关系线）时发一次：那些元素的文字、字体与删除
   * 全在面板里，选中了却不显示面板，用户会以为「选中没生效」。
   */
  nodePanelTick: number
  requestNodePanel(): void
  /** 「备注」聚焦信号（自增值），NodePanel 监听它 */
  notesFocusTick: number
  /** 请求节点面板聚焦到备注输入框（画布上的备注指示图标点击用）；面板会随之自动打开 */
  requestNotesFocus(): void
  /** 改画布级元素标题样式（字号 / 加粗 / 斜体 / 颜色），一步撤销 */
  setOverlayStyle(kind: OverlayKind, id: string, patch: OverlayTextStylePatch): void
  /** 请求节点面板聚焦到代码输入框（Alt+C 用）；面板未打开时会随打开自动聚焦 */
  requestCodeFocus(): void
  /** 代码聚焦信号（自增值），NodePanel 监听它 */
  codeFocusTick: number
  /** 公式聚焦信号（自增值），NodePanel 监听它 */
  formulaFocusTick: number
  /** 请求节点面板聚焦到公式输入框（快捷栏 / 快捷键用） */
  requestFormulaFocus(): void
  /** 应用级默认设置（默认视角锁定 / 主题 / 对齐），由「设置」对话框读写 */
  appSettings: AppSettings
  setAppSettings(next: AppSettings): void
  /** 把关系线的某一端改接到另一个主题（拖拽端点用） */
  setRelationshipEnd(id: string, end: 'end1Id' | 'end2Id', topicId: string): void
  setRelationshipTitle(id: string, title: string): void
  setBoundaryTitle(id: string, title: string): void
  setSummaryTitle(id: string, title: string): void

  /* ---- 画布元素：给 AI 用的「不依赖选中」版本 ---- */
  /**
   * 连一条关系线（按 id，不读用户当前选中）。
   *
   * 为什么不复用上面的 `addRelationship`：那个读的是**选择**，AI 自己改选中会把用户
   * 的选区搅乱；而且它是**开关**语义（再点一次是删除）——模型重试一次就把线删了。
   * 这里一律**幂等**：已经连过就返回原 id，不增不减。
   */
  connectTopics(end1Id: string, end2Id: string): string | null
  /** 给这些同级主题加边界（幂等；title 可省略） */
  addBoundaryFor(topicIds: string[], title?: string): string | null
  /** 给这些同级主题加概要（幂等；title 省略时为「概要」） */
  addSummaryFor(topicIds: string[], title?: string): string | null
  /** 直接设置标记集合（不用 toggle：对模型来说「已存在就删掉」是个陷阱） */
  setMarkers(id: string, markerIds: string[]): void
}

/** 实现（状态初值与动作）随「B1 第二步 B」的对应批次搬入；本文件此刻只有类型声明。 */
