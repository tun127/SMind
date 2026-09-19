/**
 * 结构切片（「结构操作」分节的**前半**，成员体逐字未改）：节点增删、标题/富文本、折叠与侧向、尺寸覆盖。
 *
 * 「结构操作」分节原本 559 行 > DoD 的 400 行，按**成员自然断层**拆成两个切片：
 * 前半＝「建/删/改一个节点自己」（本文件），后半＝「动它在树里的位置与布局」(`move.ts`)。
 * 两半都只经 `get().mutate(...)` 写文档，互相之间没有共享的局部状态。
 *
 * 本文件同时拥有这些成员在 `EditorState` 里的**声明**（接口逐字搬来）。
 */

import type { RichText } from '@shared/model/types'

import { type FoldSide } from '@shared/model/tree'

export interface StructureSlice {
  /* ---- 结构操作 ---- */
  addChild(parentId?: string): string
  addSibling(id?: string): string
  deleteSelection(): void
  /**
   * 删除指定主题（连同子树）。
   *
   * AI 写工具用：`deleteSelection` 是给键盘操作的，会连带改用户的选择；
   * AI 不该有这种副作用，所以按 id 删、只在必要时把选择挪到父级。
   */
  deleteTopic(id: string): boolean
  setTitle(id: string, title: string): void
  setRichText(id: string, rich: RichText | null): void
  toggleCollapse(id: string): void
  /**
   * 直接指定折叠状态。拖拽时用它把落点那个折叠着的主题**展开**——
   * 不展开就看不见新子主题会落在哪，落点预览成了空谈。
   */
  setCollapsed(id: string, collapsed: boolean): void
  /**
   * 平衡思维导图的中心主题：**按侧收起 / 展开**（左右分开收）。
   *
   * 只在「中心主题 + 平衡结构 + 该侧确实挂着分支」时生效；
   * 一般主题的收起走 `toggleCollapse`（那里是整体收起）。
   *
   * 刻意做成**设置值**而不是开关（与 `setCollapsed` 同一口径）：AI 重试一次
   * 不会把刚收起来的那一侧又翻回去。
   */
  setFoldSide(id: string, side: FoldSide, folded: boolean): void
  /** 界面上点徽标用：切换某一侧的收起状态（转发到 `setFoldSide`） */
  toggleFoldSide(id: string, side: FoldSide): void
  /**
   * 把一级主题对调到中心主题的另一侧（知犀 / Xmind 的「左右位置调整」）。
   * 平衡结构默认按顺序交替分配左右，这里写入的是显式覆盖。
   */
  setTopicSide(id: string, side: 'left' | 'right'): void
  /** 手动拉伸节点尺寸；传 null 恢复自动尺寸（拖拽过程中会合并成一步撤销） */
  setSizeOverride(id: string, size: { width: number; height: number } | null): void
}

/** 实现（状态初值与动作）随「B1 第二步 B」的对应批次搬入；本文件此刻只有类型声明。 */
