/**
 * 移动与布局切片（「结构操作」分节的**后半**，成员体逐字未改）：键盘移动/选择导航、结构调整、
 * 拖放落点、同级排序、合并、自由摆放偏移、恢复自动布局、复制粘贴。
 *
 * `clipboard` 归本切片：它只被 `copySelection` / `paste` 写读（结构操作的后半段），
 * 初值 `null` 随本切片搬来。跨切片的 `get().addChild/addSibling/...` 调用与搬迁前一致。
 *
 * 本文件同时拥有这些成员在 `EditorState` 里的**声明**（接口逐字搬来）。
 */

import type { Topic } from '@shared/model/types'

import { type DropMode } from '@shared/model/drop'

export interface MoveSlice {
  clipboard: Topic | null
  /**
   * 切换**整张画布**的结构。
   *
   * 刻意的签名（没有 targetId）：结构是画布级属性，只住在中心主题上。
   * 以前它接一个可选目标，于是能在分支上写 `structureClass`——布局随即把那一支
   * 交给别的家族排，画面变成"主干对、下面那截乱"。数据字段仍保留（导入的文件里
   * 可能带着它，另存时原样写回），但**不再参与布局**。
   */
  setStructure(structureClass: string): void
  /**
   * 移动主题。
   *
   * 刻意**没有** coalesceKey：移动会重排 children 数组，
   * 而撤销是基于 immer patch 的，数组重排的 patch 带下标——
   * 把连续两步的 inverse 合成一个再套到"后来的状态"上会下标错位、改坏数组
   * （自检里抓到过 `["甲","乙","甲"]` 这种结果）。
   * 合并只对「替换某个值」类操作安全：折叠、调色、拉伸尺寸。
   */
  moveNode(id: string, targetId: string, index?: number): boolean
  /**
   * 批量移动（AI 的 `moveTopics` 工具走这里）：一次写入落完，返回**实际成功**的条目。
   *
   * 逐条调 `moveNode` 终态相同，但每条都要跑一次 `settleAfterMove` → `pruneOverlays`
   * 的**全树扫描**——一次最多 200 条就是 200 遍全树（O(k×N)），
   * 正是「AI 批量整理大导图」时的固定放大器。
   */
  moveNodes(moves: Array<{ id: string; targetId: string; index: number | null }>): Array<{
    id: string
    targetId: string
  }>
  /**
   * 同级排序（AI 的 `sortSiblings` 走这里）：按给定顺序重排某个主题的子主题。
   * `renumber` 为真时顺便加「1. 2. 」编号（先去掉旧编号，避免「1. 1. xxx」）。
   */
  sortChildren(parentId: string, orderedIds: string[], renumber: boolean): void
  /**
   * 合并同名主题（AI 的 `mergeDuplicates` 走这里）。
   *
   * 每组保留 keepId，把 mergeIds 的**子主题搬过来、缺的备注/代码/公式/标签/标记补上**，
   * 然后删掉那些多余节点。整批算**一步撤销**（`mutate` 一次）。
   */
  mergeTopics(groups: Array<{ keepId: string; mergeIds: string[] }>): number
  /**
   * 用快捷键微调选中主题（与亿图脑图一致，适合结构复杂时精确挪动）：
   * - `↑` / `↓`：在同级里上移 / 下移一位
   * - `Home` / `End`：移到同级的最前 / 最后
   * - `←`：升级，成为父级的后一个兄弟
   * - `→`：降级，成为前一个兄弟的最后一个子主题
   */
  moveSelectionByKey(
    key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'
  ): boolean
  /**
   * 按方向键在主题之间移动**选择**（← 父级、→ 第一个子级、↑↓ 同级）。
   *
   * 抽到 store 里是因为**编辑态**也要用它：刚建出来的空主题里按方向键，
   * 应当退出编辑并移到相邻主题，而不是把光标在一个空格子里挪来挪去（看起来像"方向键失灵"）。
   * 另外它有兜底：选择指向已不存在的主题时自动回到根，键盘永远不会"死掉"。
   */
  navigateSelection(key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'): void
  /**
   * 拖拽节点释放。落点一律由 `resolveDrop` 裁决（在 shared/model/drop 里，
   * 与画布上的落点预览共用同一套规则）：
   * - `child` → 成为目标的**最后一个子主题**；
   * - `before` / `after` → 插到目标**前面 / 后面**、与它同级；
   * - 落点非法（自己 / 自己的后代 / 原地不动）→ 返回 false，不做改动。
   * 因为判定只看"目标是谁 + 指针在它的哪个分区"，所以**任意两个节点之间**都能拖。
   */
  dropNode(id: string, targetId: string, mode: DropMode): boolean
  offsetPosition(id: string, dx: number, dy: number): void
  /**
   * 一次写完多个主题的自由位置（多选拖拽用）。
   * 走一次 mutate，所以整群移动在撤销里是**一步**，而不是一堆零碎记录。
   */
  offsetPositions(moves: Array<{ id: string; dx: number; dy: number }>): void
  /**
   * 恢复自动布局：把**选中的自由摆放主题**放回自动位置；选中里没有这样的主题就整张画布一起恢复。
   * 返回实际恢复的个数（0 = 没什么可恢复）。
   *
   * 为什么只留一个入口：以前「选中」「全部」各有按钮、菜单里还各有一条名字几乎一样的项
   * （三个入口、两种实现，其中两个完全相同），用户面对的是"我该点哪个"。
   * 现在范围交给选择决定、结果用提示条说清：想只恢复一个，先选中它。
   */
  restoreAutoLayout(): number
  copySelection(): void
  paste(): void
}

/** 实现（状态初值与动作）随「B1 第二步 B」的对应批次搬入；本文件此刻只有类型声明。 */
