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
import { appendToRich, hasFormatting, normalizeRich, richFromPlain } from '@shared/richtext'

import { activeRoot, findTopic } from '@shared/model/tree'

import { editingContent, sameRich, stampRichDefaults } from '@shared/model/editor-pure'
import { selectReducer } from '@shared/model/editor-ops'
import type { StateCreator } from 'zustand'
import type { EditorState } from './types'
import { NO_EDITING } from './types'

export interface SelectionSlice {
  selection: string[]
  editingId: string | null
  /** 正在编辑的纯文本镜像，用于比较与统计 */
  editingText: string
  /** 正在编辑的富文本内容 */
  editingRich: RichText | null
  /**
   * **只喂测量**的实时草稿：编辑区里还没提交进文档的文本（组词 / 输入中的那一串）。
   *
   * 它不参与提交：`commitEdit` 仍以 `editingText` / `editingRich` 为准，草稿只让布局
   * 在"文本还没进文档"时也能把框量对（否则框不长，拼音只能在窄框里折行）。
   * 随 `NO_EDITING` 一起清空，所以提交/取消/切标签都会自动收回。
   */
  editingDraftText: string
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
  /** 上报/收回实时草稿（只喂测量，见 editingDraftText 的说明） */
  setEditingDraftText(text: string): void
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

export const createSelectionSlice: StateCreator<EditorState, [], [], SelectionSlice> = (
  set,
  get
) => ({
  selection: [],
  ...NO_EDITING,
  renderEpoch: 0,

  /* ------------------------------------------------------------------ */
  /* 选择与编辑态                                                        */
  /* ------------------------------------------------------------------ */

  select: (id, additive = false) => set((s) => selectReducer(s.selection, id, additive)),

  beginEdit: (id, insertText) => {
    const topic = findTopic(activeRoot(get().workbook), id)
    const base = topic?.titleRich
      ? normalizeRich(topic.titleRich)
      : richFromPlain(topic?.title ?? '')
    const rich = insertText ? appendToRich(base, insertText) : base
    set({ editingId: id, ...editingContent(rich), selection: [id] })
  },

  updateEditingText: (text) => set(editingContent(richFromPlain(text))),

  updateEditingRich: (rich) => set(editingContent(rich)),

  // 只写草稿字段：不碰 editingText / editingRich / workbook，所以提交语义与 undo 都不受影响
  setEditingDraftText: (text) => set({ editingDraftText: text }),

  commitEdit: (forId) => {
    const { editingId, editingText, editingRich, workbook } = get()
    if (!editingId) return
    // 旧输入框失焦时可能已经切到了新节点，此时必须忽略这次提交
    if (forId !== undefined && forId !== editingId) return

    const topic = findTopic(activeRoot(workbook), editingId)
    const nextTitle = editingText
    const nextRich = editingRich ? normalizeRich(editingRich) : null
    // 「首次命名」＝新建节点第一次输入文字：给打的内容补上默认字体/字号/颜色。
    // 只认「原来标题为空」的节点——改老节点的文字绝不能突然被换样式。
    const firstNaming = topic !== null && topic.title === ''
    const stampedRich =
      nextRich && firstNaming ? stampRichDefaults(nextRich, get().appSettings) : nextRich
    const keepRich = stampedRich && hasFormatting(stampedRich) ? stampedRich : null

    set(NO_EDITING)
    if (!topic) return
    if (topic.title === nextTitle && sameRich(topic.titleRich, keepRich)) return

    get().mutate((draft) => {
      const target = findTopic(activeRoot(draft), editingId)
      if (!target) return
      target.title = nextTitle
      // 只有真正带格式时才写 titleRich，保持 .xmind 干净且与 Xmind 兼容
      target.titleRich = keepRich ?? undefined
    }, '修改文本')
  },

  cancelEdit: () => set(NO_EDITING),

  bumpRenderEpoch: () => set((state) => ({ renderEpoch: state.renderEpoch + 1 })),

  commitAndAddChild: () => {
    const id = get().editingId
    if (!id) return
    get().commitEdit()
    get().addChild(id)
  },

  commitAndAddSibling: () => {
    const id = get().editingId
    if (!id) return
    get().commitEdit()
    get().addSibling(id)
  }
})
