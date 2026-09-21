/**
 * 历史切片（自 `editor.ts` 的「编辑」分节整块搬出，成员体逐字未改）：撤销/重做 + 唯一的写入门 `mutate`。
 *
 * **`aiTurn` 必须与本切片同生共死**（计划表 §八 的实测归属）：`beginAiTurn` 用 `undoStack.length` 当 depth、
 * `commitAiTurn` 用 `undoStack.slice(depth)` 把期间所有改动的 patch/inverse 并成一步撤销，
 * `undo` / `redo` 又要靠 `aiTurn` 把「AI 改到一半」的历史挡住——三者分家就会静默改坏撤销栈。
 * 深度计算、合并顺序（patches 正序、inverse 倒序）、`HISTORY_LIMIT` 截断与 `COALESCE_WINDOW_MS`
 * 合并窗口一律逐字未改。
 *
 * `HISTORY_LIMIT` / `HistoryEntry` / `COALESCE_WINDOW_MS` 随本切片搬来（`HistoryEntry` 落在 `types.ts`，
 * 因为它是 `EditorState` 的成员类型）。
 *
 * **跨域归属（计划表第七批的实测口径）**：本切片新暴露 `resetHistory()`，文档生命周期只调它，
 * 不再直接写 `undoStack` / `redoStack` / `aiTurn`。
 *
 * 本文件同时拥有这些成员在 `EditorState` 里的**声明**（接口逐字搬来）。
 */
import { applyPatches, produceWithPatches, type Patch } from 'immer'

import type { Workbook } from '@shared/model/types'

import { activeRoot } from '@shared/model/tree'

import { liveSelection } from '@shared/model/editor-pure'

import type { StateCreator } from 'zustand'
import type { EditorState } from './types'
import { NO_EDITING } from './types'
import type { HistoryEntry } from './types'

const HISTORY_LIMIT = 200

/** 合并窗口：同一个 coalesceKey 在此时间内的连续操作算作一步 */
const COALESCE_WINDOW_MS = 1500

export interface HistorySlice {
  undoStack: HistoryEntry[]
  redoStack: HistoryEntry[]
  /**
   * 进行中的 AI 回合（null = 不在 AI 操作中；此时禁止撤销，见 undo 的说明）。
   *
   * 这里存的是**回合序号**而不是"入栈时的下标"：`mutate` 会用 `slice(-HISTORY_LIMIT)` 从头部
   * 截断撤销栈，下标会随截断永久错位 —— 栈一满，"整轮 AI 并成一步"就静默失效（D-01）。
   * 序号单调递增、与截断无关，`commitAiTurn` 按它取整批。
   */
  aiTurn: { turnSeq: number; selectionBefore: string[] } | null
  /** 下一个 AI 回合序号（单调递增，与撤销栈的截断无关） */
  aiTurnSeq: number

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

  /** 换文档时整段复位历史（含 AI 回合状态）：文档生命周期只调它，不再直接写这三样 */
  resetHistory(): void
}

export const createHistorySlice: StateCreator<EditorState, [], [], HistorySlice> = (set, get) => ({
  undoStack: [],
  redoStack: [],
  aiTurn: null,
  aiTurnSeq: 0,

  /* ------------------------------------------------------------------ */
  /* 编辑                                                                */
  /* ------------------------------------------------------------------ */

  mutate: (recipe, label, coalesceKey) => {
    const { workbook, undoStack, selection: selectionBefore } = get()
    const [next, patches, inverse] = produceWithPatches(workbook, recipe)
    if (patches.length === 0) return false

    const now = Date.now()
    const last = undoStack[undoStack.length - 1]
    // 先算这次改动属于哪个回合：**跨回合不合并** —— 否则合并条目会带着上一回合的序号，
    // 被这一回合 commit 一起收走，两轮 AI 的改动就粘成一步（撤销一次退太多）。
    const turnSeq = get().aiTurn?.turnSeq
    const canMerge =
      coalesceKey !== undefined &&
      last !== undefined &&
      last.coalesceKey === coalesceKey &&
      last.turnSeq === turnSeq &&
      now - last.time < COALESCE_WINDOW_MS

    if (canMerge) {
      // 合并成一步撤销：重做用最新的 patches，撤销仍然回到最早那次修改之前
      const merged: HistoryEntry = {
        label,
        patches,
        inverse: last.inverse,
        coalesceKey,
        time: now,
        turnSeq,
        selectionBefore: last.selectionBefore ?? selectionBefore
      }
      set({
        workbook: next,
        dirty: true,
        undoStack: [...undoStack.slice(0, -1), merged],
        redoStack: []
      })
      return true
    }

    set({
      workbook: next,
      dirty: true,
      undoStack: [
        ...undoStack,
        { label, patches, inverse, coalesceKey, time: now, turnSeq, selectionBefore }
      ].slice(-HISTORY_LIMIT),
      redoStack: []
    })
    return true
  },

  beginAiTurn: () => {
    // 已经在回合里就别重入：同一份文档同时只允许一个 AI 回合
    if (get().aiTurn) return
    const turnSeq = get().aiTurnSeq + 1
    set({ aiTurnSeq: turnSeq, aiTurn: { turnSeq, selectionBefore: get().selection } })
  },

  /**
   * 结束 AI 回合，把期间的所有改动**并成一步撤销**。
   *
   * 合成规则是这件事的关键：
   * - `patches` 按**发生顺序**拼（撤销栈里的顺序就是发生顺序）；
   * - `inverse` 按**条目倒序**拼（每个 inverse 是针对它自己那次改动**之前**的状态算出来的，
   *   必须从最后一步往前依次套用）。
   *
   * 反过来做（把 inverse 合成一份、正向套到"后来的状态"上）会踩坑：数组重排的 patch 带下标，
   * 套错状态就会改坏 `children`——早期做「连按方向键合并成一步」时就这么坏过数据。
   */
  commitAiTurn: (label) => {
    const turn = get().aiTurn
    if (!turn) return false
    const { undoStack } = get()
    // 按**回合序号**取整批：栈被 HISTORY_LIMIT 截断过也不受影响（原来用下标，栈满即失效）
    const batch = undoStack.filter((entry) => entry.turnSeq === turn.turnSeq)
    if (batch.length === 0) {
      // AI 没改任何东西：不留空条目（否则用户按 Ctrl+Z 会"没反应"）
      set({ aiTurn: null })
      return false
    }

    const patches = batch.flatMap((entry) => entry.patches)
    const inverse: Patch[] = []
    for (let index = batch.length - 1; index >= 0; index -= 1) {
      const entry = batch[index]
      if (entry) inverse.push(...entry.inverse)
    }

    const mergedEntry: HistoryEntry = {
      label,
      patches,
      inverse,
      time: Date.now(),
      selectionBefore: turn.selectionBefore
    }
    // 合并条目**插回本回合第一条的位置**（不是一律追加到末尾）：回合期间万一还夹着别的手动改动，
    // 撤销的先后顺序才不会乱。用 filter+重建而不是 slice：切片下标正是这条 bug 的来源。
    const kept: HistoryEntry[] = []
    let inserted = false
    for (const entry of undoStack) {
      if (entry.turnSeq === turn.turnSeq) {
        if (!inserted) {
          kept.push(mergedEntry)
          inserted = true
        }
        continue
      }
      kept.push(entry)
    }
    set({
      aiTurn: null,
      undoStack: kept.slice(-HISTORY_LIMIT),
      redoStack: []
    })
    return true
  },

  undo: () => {
    // AI 回合进行中禁止撤销：中途把撤销栈抽走，会让后续步骤全部错位
    if (get().aiTurn) return
    const { workbook, undoStack, redoStack } = get()
    const entry = undoStack[undoStack.length - 1]
    if (!entry) return
    const next = applyPatches(workbook, entry.inverse) as Workbook
    const root = activeRoot(next)
    /**
     * 撤销连选择一起还原：框选了几个节点，撤销后还是那几个。
     *
     * 写进**新对象**而不是就地改 `entry.selectionAtUndo`：`entry` 是 store 里的历史条目，
     * 就地改等于绕过 `set` 改 state——不触发渲染、dev 下若对象被冻结就直接抛错。
     */
    const undone = { ...entry, selectionAtUndo: get().selection }
    set({
      workbook: next,
      dirty: true,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, undone],
      ...NO_EDITING,
      selection: liveSelection(root, entry.selectionBefore)
    })
  },

  redo: () => {
    // 同 undo：AI 回合进行中不许动历史
    if (get().aiTurn) return
    const { workbook, undoStack, redoStack } = get()
    const entry = redoStack[redoStack.length - 1]
    if (!entry) return
    const next = applyPatches(workbook, entry.patches) as Workbook
    const root = activeRoot(next)
    // 重做还原「撤销那一刻」的选择。注意不要覆盖 entry.selectionBefore——
    // 条目回到撤销栈后，再撤销仍要用它还原到「这次修改之前」的框选
    set({
      workbook: next,
      dirty: true,
      undoStack: [...undoStack, entry],
      redoStack: redoStack.slice(0, -1),
      ...NO_EDITING,
      selection: liveSelection(root, entry.selectionAtUndo)
    })
  },

  /**
   * 换文档时整段复位：撤销/重做栈清空，AI 回合状态一并作废。
   * 为什么必须一起清（照搬原来的注释）：`aiTurn` 只在 `commitAiTurn` 里复位，而「AI 正在改这个文档时
   * 用户新建/打开了另一份」会让它一直留着，新文档里的 undo/redo 从此被静默挡住（Ctrl+Z 完全没反应）；
   * 整份文档被替换掉时同理。
   */
  resetHistory: () => set({ undoStack: [], redoStack: [], aiTurn: null })
})
