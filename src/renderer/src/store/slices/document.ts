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
import { createWorkbook } from '@shared/model/factory'

import type { StateCreator } from 'zustand'
import type { EditorState } from './types'
import { NO_EDITING } from './types'
import { readPersistedViewLock } from './view'

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

export const createDocumentSlice: StateCreator<EditorState, [], [], DocumentSlice> = (
  set,
  get
) => ({
  workbook: createWorkbook(),
  filePath: null,
  dirty: false,
  docSeq: 0,

  /* ------------------------------------------------------------------ */
  /* 文档                                                                */
  /* ------------------------------------------------------------------ */

  newDocument: () => {
    get().resetHistory()
    set((state) => ({
      workbook: createWorkbook({
        rootTitle: '中心主题',
        seedBranches: ['分支主题 1', '分支主题 2']
      }),
      filePath: null,
      dirty: false,
      docSeq: state.docSeq + 1,
      selection: [],
      ...NO_EDITING,
      // 换文档时必须把 AI 回合状态清掉：它只在 commitAiTurn 里复位，
      // 而"AI 正在改这个文档时用户新建/打开了另一份"会让 aiTurn 一直留着，
      // 新文档里的 undo/redo 从此被静默挡住（Ctrl+Z 完全没反应）
      // 新文档：优先恢复用户上次的选择；从未动过开关才按「启动默认视角锁定」起手
      viewLock: readPersistedViewLock() ?? state.appSettings.defaultViewLock,
      selectedOverlay: null,
      zoom: 1,
      pan: { x: 0, y: 0 }
    }))
  },

  loadDocument: (workbook, path) => {
    get().resetHistory()
    set((state) => ({
      // 界面只显示**第一张画布**（画布切换按钮已移除）：文件的其余画布原样保留在
      // workbook 里，保存时照旧写回，不会丢内容。
      workbook: { ...workbook, activeSheetId: workbook.sheets[0]?.id ?? workbook.activeSheetId },
      filePath: path,
      dirty: false,
      docSeq: state.docSeq + 1,
      selection: [],
      ...NO_EDITING,
      // 同 newDocument：换文档不能把上一个文档的 AI 回合带过来
      // 打开文档同样恢复上次的选择（与新建一致）
      viewLock: readPersistedViewLock() ?? state.appSettings.defaultViewLock,
      selectedOverlay: null,
      zoom: 1,
      pan: { x: 0, y: 0 }
    }))
  },

  restoreDocument: (workbook) => {
    get().resetHistory()
    set((state) => ({
      workbook,
      // filePath 保持不动；标记为未保存，避免用户以为已经落盘
      dirty: true,
      docSeq: state.docSeq + 1,
      selection: [],
      ...NO_EDITING
      // 恢复是一次大跨度替换，撤销栈对它没有意义（恢复前会自动存一份版本兜底）
      // 整份文档被替换掉了，进行中的 AI 回合同样作废（否则新状态下的撤销被挡住）
    }))
  },

  markSaved: (path) => set({ filePath: path, dirty: false })
})
