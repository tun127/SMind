/**
 * 大纲 / AI 结果落地切片（自 `editor.ts` 的「AI 结果落地」分节整块搬出，成员体逐字未改）。
 *
 * 四者都是「批量把内容灌进当前文档」：新增子主题、富文本子主题、整棵大纲树、把默认样式盖到全部节点。
 * 写入一律经 `get().mutate(...)`（历史切片拥有 mutate），与新文档/打开文档无关，故不归文档切片。
 *
 * 本文件同时拥有这些成员在 `EditorState` 里的**声明**（接口逐字搬来）。
 */

import type { RichText } from '@shared/model/types'
import { createTopic } from '@shared/model/factory'
import { countOutlineNodes, outlineToTopic, type OutlineNode } from '@shared/ai'

import { activeRoot, ensureExpanded, findTopic } from '@shared/model/tree'

import { stampNodeDefaults, walkStampDefaults } from '@shared/model/editor-pure'

import type { StateCreator } from 'zustand'
import type { EditorState } from './types'
import { NO_EDITING } from './types'

export interface OutlineSlice {
  /* ---- AI 结果落地（P8） ---- */
  /** 给某个主题一次性追加若干子主题（AI 扩写用，整批算一步撤销） */
  addChildTitles(parentId: string, titles: string[]): number
  /** 追加若干**带格式**的子主题（粘贴 Markdown 片段用；整批一步撤销） */
  addRichChildren(parentId: string, items: Array<{ title: string; rich?: RichText }>): number
  /**
   * 把 AI 生成的整棵大纲挂到指定主题下面。
   *
   * 「生成新导图」不再走这里——那会往当前文档里塞内容；改成在新窗口里成为独立文档
   * （见 App 的 `openGeneratedInNewWindow`）。
   */
  applyOutlineTree(parentId: string, root: OutlineNode): number

  /** 把当前「默认文字样式」（字体/字号/颜色）一次性应用到全部现有节点（一步撤销） */
  applyDefaultsToAll(): void
}

export const createOutlineSlice: StateCreator<EditorState, [], [], OutlineSlice> = (set, get) => ({
  /* ------------------------------------------------------------------ */
  /* AI 结果落地                                                         */
  /* ------------------------------------------------------------------ */

  addChildTitles: (parentId, titles) => {
    const cleaned = titles.map((title) => title.trim()).filter((title) => title.length > 0)
    if (cleaned.length === 0) return 0

    const created: string[] = []
    get().mutate((draft) => {
      const parent = findTopic(activeRoot(draft), parentId) ?? activeRoot(draft)
      for (const title of cleaned) {
        const node = createTopic(title)
        stampNodeDefaults(node, get().appSettings)
        parent.children.push(node)
        created.push(node.id)
      }
      ensureExpanded(parent)
    }, 'AI 扩写子主题')

    if (created.length > 0) set({ selection: created })
    return created.length
  },

  /**
   * 追加若干**带格式**的子主题（粘贴 Markdown 片段用）。
   * 与 `addChildTitles` 的区别：标题之外还能带上富文本（高亮/上下标/加粗…），
   * 而且不进编辑态——粘贴完就能继续操作。
   */
  addRichChildren: (parentId, items) => {
    const cleaned = items.filter((item) => item.title.trim().length > 0)
    if (cleaned.length === 0) return 0

    const created: string[] = []
    get().mutate((draft) => {
      const parent = findTopic(activeRoot(draft), parentId) ?? activeRoot(draft)
      for (const item of cleaned) {
        const node = createTopic(item.title.trim())
        if (item.rich) node.titleRich = item.rich
        stampNodeDefaults(node, get().appSettings)
        parent.children.push(node)
        created.push(node.id)
      }
      ensureExpanded(parent)
    }, '粘贴 Markdown')

    if (created.length > 0) set({ selection: created, ...NO_EDITING })
    return created.length
  },

  applyOutlineTree: (parentId, root) => {
    const count = countOutlineNodes(root)
    if (count === 0) return 0

    // 挂到已有主题下：根节点的文字成为新的子主题
    const childTopic = outlineToTopic(root)
    walkStampDefaults(childTopic, get().appSettings)
    get().mutate((draft) => {
      const parent = findTopic(activeRoot(draft), parentId)
      if (!parent) return
      parent.children.push(childTopic)
      ensureExpanded(parent)
    }, 'AI 生成子主题')
    set({ selection: [childTopic.id] })
    return count
  },

  applyDefaultsToAll: () => {
    const settings = get().appSettings
    get().mutate((draft) => {
      for (const sheet of draft.sheets) walkStampDefaults(sheet.rootTopic, settings)
    }, '应用默认样式到全部节点')
  }
})
