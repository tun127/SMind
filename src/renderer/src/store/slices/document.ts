/**
 * 文档切片（自 `editor.ts` 的「文档」分节整块搬出，成员体逐字未改）：文档本体与四条生命周期动作。
 *
 * **它与历史切片的分工（计划表 §八 的实测归属）**：`undoStack` / `redoStack` / `aiTurn` 归历史切片，
 * 但换文档时那三样必须一起清（否则新文档的 undo/redo 被上一个文档的 AI 回合静默挡住）。
 * 这里调历史切片的 **`resetHistory()`**（它一次 `set` 就把三样都清掉），文档自己的状态在紧随其后的
 * 另一次 `set` 里改。
 *
 * ⚠️ **如实交代一处与搬迁前的差异**（B1 切片时的有意选择，行为副作用已核实无害）：
 * 搬迁前这两件事写在**同一次** `set` 里，现在变成**两次** —— 订阅者会多收一轮通知。
 * 之所以不合并：跨切片直接写 `aiTurn` 会破坏「谁拥有谁复位」的归属（那正是切片要解决的问题），
 * 而换文档本身就是"整屏换内容"的语义，多一轮通知没有可观察的界面副作用（§八 已登记）。
 * 本文件顶部原先写「仍在同一次 set 里写 aiTurn: null」——那是搬迁前的写法，2026-09-19 订正。
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
  /**
   * 内容代次：每次改动自增。保存流程拿它判断「这笔写盘是否覆盖了全部改动」——
   * 写盘期间用户又改了几笔的话，代次已经涨了，就不能把 dirty 清掉（报告 D-03）。
   * 与 `docSeq`（新建/打开才涨，用于画布重新居中）是两件事，别合并。
   */
  docRevision: number
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
  markSaved(path: string, revision: number): void
}

export const createDocumentSlice: StateCreator<EditorState, [], [], DocumentSlice> = (
  set,
  get
) => ({
  workbook: createWorkbook(),
  filePath: null,
  dirty: false,
  docRevision: 0,
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
      docRevision: 0,
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

  /**
   * 记下「已保存到 path」。**只有这笔写盘覆盖了全部改动时才清 dirty**：
   * `revision` 是发起写盘那一刻的代次；若期间用户又改了东西（代次已涨），保持 dirty ——
   * 否则那几笔没落盘的编辑会被标成"已保存"，之后关窗不再提示、静默丢失（报告 D-03）。
   */
  markSaved: (path, revision) =>
    set((state) => ({
      filePath: path,
      dirty: state.docRevision === revision ? false : state.dirty
    }))
})
