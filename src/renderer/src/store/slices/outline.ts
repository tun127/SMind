/**
 * 大纲 / AI 结果落地切片（自 `editor.ts` 的「AI 结果落地」分节整块搬出，成员体逐字未改）。
 *
 * 四者都是「批量把内容灌进当前文档」：新增子主题、富文本子主题、整棵大纲树、把默认样式盖到全部节点。
 * 写入一律经 `get().mutate(...)`（历史切片拥有 mutate），与新文档/打开文档无关，故不归文档切片。
 *
 * 本文件同时拥有这些成员在 `EditorState` 里的**声明**（接口逐字搬来）。
 */

import type { RichText } from '@shared/model/types'
import { type OutlineNode } from '@shared/ai'

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

/** 实现（状态初值与动作）随「B1 第二步 B」的对应批次搬入；本文件此刻只有类型声明。 */
