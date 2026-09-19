/**
 * 选择与编辑态切片（自 `editor.ts` 的「选择与编辑态」分节整块搬出，成员体逐字未改）。
 *
 * 编辑态＝ `editingId` + 纯文本 + 富文本三项，共用类型模块里的 `NO_EDITING`（多切片共用，故不放在这里）。
 * `commitAndAddChild` / `commitAndAddSibling` 走 `get().commitEdit()` + 结构切片的 `get().addChild/addSibling`，
 * 跨切片调用经 `get()`，与搬迁前同一份实现。
 *
 * 本文件同时拥有这些成员在 `EditorState` 里的**声明**（接口逐字搬来）。
 */

import type { RichText } from '@shared/model/types'

export interface SelectionSlice {
  selection: string[]
  editingId: string | null
  /** 正在编辑的纯文本镜像，用于比较与统计 */
  editingText: string
  /** 正在编辑的富文本内容 */
  editingRich: RichText | null
  /**
   * 渲染默认值（默认对齐 / 代码块基准字号）的变更计数。
   *
   * 这些默认值作用于**没有显式样式**的节点，改了会让测量结果变化，所以布局必须依赖它——
   * 否则改了设置要等到别的操作才生效（画布上表现为"设置似乎没起作用"）。
   */
  renderEpoch: number

  /* ---- 选择与编辑态 ---- */
  select(id: string | null, additive?: boolean): void
  /**
   * 进入编辑。
   * `insertText` 用于「选中主题后直接打字」：把这一下敲的字符**接到末尾**再进入编辑
   * （是追加不是覆盖——误按一个字母就把整句标题冲掉太危险）。
   */
  beginEdit(id: string, insertText?: string): void
  updateEditingText(text: string): void
  updateEditingRich(rich: RichText): void
  /**
   * 提交当前正在编辑的内容。
   * @param forId 只有当前编辑中的正是这个节点时才提交。
   *              用于避免「新建节点后旧输入框失焦」把新节点的编辑态误关掉。
   */
  commitEdit(forId?: string): void
  cancelEdit(): void
  /** 提交编辑并新建子主题（编辑中按 Tab） */
  commitAndAddChild(): void
  /** 提交编辑并新建同级主题（编辑中按 Enter） */
  commitAndAddSibling(): void
  /** 渲染默认值变更后调用：让布局与画布重算 */
  bumpRenderEpoch(): void
}

/** 实现（状态初值与动作）随「B1 第二步 B」的对应批次搬入；本文件此刻只有类型声明。 */
