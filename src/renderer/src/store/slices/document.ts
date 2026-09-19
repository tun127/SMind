/**
 * 文档切片（自 `editor.ts` 的「文档」分节整块搬出，成员体逐字未改）：文档本体与四条生命周期动作。
 *
 * **它与历史切片的分工（计划表 §八 的实测归属）**：`undoStack` / `redoStack` / `aiTurn` 归历史切片，
 * 但换文档时那三样必须一起清（否则新文档的 undo/redo 被上一个文档的 AI 回合静默挡住）。
 * 这里**仍在同一次 `set` 里写 `aiTurn: null`**，与搬迁前逐字相同——若改成「调用历史切片的一个复位动作」
 * 会多出一次 `set()`（多一轮订阅通知），与「行为零变化」冲突。
 *
 * `viewLock` 的初值按「上次会话的选择 → 设置里的默认视角锁定」重算，读的是视图切片的
 * `readPersistedViewLock`（同目录切片间导入，不回到组合根）。
 *
 * 本文件同时拥有这些成员在 `EditorState` 里的**声明**（接口逐字搬来）。
 */

import type { Workbook } from '@shared/model/types'

export interface DocumentSlice {
  workbook: Workbook
  filePath: string | null
  dirty: boolean
  /** 文档代次，每次新建/打开自增，用于触发画布重新居中 */
  docSeq: number

  /* ---- 文档 ---- */
  newDocument(): void
  loadDocument(workbook: Workbook, path: string | null): void
  /**
   * 把当前文档的内容换成某个历史版本。
   * 刻意**保留 filePath**（恢复的是「当前文档的旧内容」，不该把文档换成别的文件），
   * 并标记为未保存——恢复出来的内容与磁盘上的还不一样。
   */
  restoreDocument(workbook: Workbook): void
  markSaved(path: string): void
}

/** 实现（状态初值与动作）随「B1 第二步 B」的对应批次搬入；本文件此刻只有类型声明。 */
