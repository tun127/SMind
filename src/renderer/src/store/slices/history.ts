/**
 * 历史切片（自 `editor.ts` 的「编辑」分节整块搬出，成员体逐字未改）：撤销/重做 + 唯一的写入门 `mutate`。
 *
 * **`aiTurn` 必须与本切片同生共死**（计划表 §八 的实测归属）：`beginAiTurn` 用 `undoStack.length` 当 depth、
 * `commitAiTurn` 用 `undoStack.slice(depth)` 把期间所有改动的 patch/inverse 并成一步撤销，
 * `undo` / `redo` 又要靠 `aiTurn` 把「AI 改到一半」的历史挡住——三者分家就会静默改坏撤销栈。
 * 深度计算、合并顺序（patches 正序、inverse 倒序）、`HISTORY_LIMIT` 截断与 `COALESCE_WINDOW_MS`
 * 合并窗口一律逐字未改。
 *
 * `HISTORY_LIMIT` / `HistoryEntry` / `COALESCE_WINDOW_MS` 随本切片搬来（只被这里使用）。
 *
 * 本文件同时拥有这些成员在 `EditorState` 里的**声明**（接口逐字搬来）。
 */

import type { Workbook } from '@shared/model/types'

import type { HistoryEntry } from './types'

export interface HistorySlice {
  undoStack: HistoryEntry[]
  redoStack: HistoryEntry[]
  /** 进行中的 AI 回合（null = 不在 AI 操作中；此时禁止撤销，见 undo 的说明） */
  aiTurn: { depth: number; selectionBefore: string[] } | null

  /* ---- 编辑 ---- */
  /**
   * @param coalesceKey 传入后，短时间内同 key 的连续修改会合并成一步撤销。
   *                    适用于拖动调色这类高频小改动。
   */
  mutate(recipe: (draft: Workbook) => void, label: string, coalesceKey?: string): boolean
  undo(): void
  redo(): void
  /**
   * 开始一个 AI 回合。
   *
   * AI 一次命令可能改几十个节点——每个改动各记一步撤销等于没有撤销。
   * 从 begin 到 commit 之间的所有改动会在结束时**并成一步**，用户按一下 `Ctrl+Z` 全回来。
   */
  beginAiTurn(): void
  /** 结束 AI 回合并合并；返回这一步是否真的产生了改动 */
  commitAiTurn(label: string): boolean
}

/** 实现（状态初值与动作）随「B1 第二步 B」的对应批次搬入；本文件此刻只有类型声明。 */
