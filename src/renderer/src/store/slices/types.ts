/**
 * store 的组合状态类型与切片共用的类型 / 常量（自 `editor.ts` 整块搬出，逐字未改）。
 *
 * `EditorState` 的成员声明**按归属搬进了各切片**（`store/slices/*.ts`）：切片工厂要用
 * `EditorState` 给 `set`/`get` 定型，若整个接口留在组合根，切片就得反向 import 组合根
 * （运行期循环依赖）；而把 368 行的接口原样放在这里，又会顶破子模块 400 行的 DoD 余量。
 * 于是：声明随切片走，组合类型留在这里。`editor.ts` 仍把 `EditorState` / `SearchState`
 * **原样再导出**，外部调用点一行不改。
 */
import { type Patch } from 'immer'
import { type SearchOptions } from '@shared/search'
import type { ViewSlice } from './view'
import type { SearchSlice } from './search'
import type { OutlineSlice } from './outline'
import type { DocumentSlice } from './document'
import type { HistorySlice } from './history'
import type { SelectionSlice } from './selection'
import type { StructureSlice } from './structure'
import type { MoveSlice } from './move'
import type { NodeContentSlice } from './node-content'
import type { OverlaysSlice } from './overlays'
import type { ThemeSlice } from './theme'

export interface HistoryEntry {
  label: string
  patches: Patch[]
  inverse: Patch[]
  /** 连续同类操作（例如拖动调色）合并为一步撤销 */
  coalesceKey?: string
  time: number
  /** 这次修改**之前**的选择（框选/多选）。撤销时恢复它，框选才不会凭空丢掉 */
  selectionBefore?: string[]
  /** 撤销那一刻的选择，重做时恢复 */
  selectionAtUndo?: string[]
}

/** 搜索状态：条件放在 store 里，画布与搜索面板才能用同一份条件算命中 */
export interface SearchState {
  query: string
  replacement: string
  options: Required<SearchOptions>
}

/**
 * 「编辑态」的空值。
 * 编辑态＝ editingId + 纯文本 + 富文本三项，而纯文本与富文本本质上是
 * **同一份内容的两种表示**——以前这里有十几处各自手写这三行，漏一处就会漂移。
 */
export const NO_EDITING = { editingId: null, editingText: '', editingRich: null }

/**
 * 空标题是**有意允许**的（自检里有两条断言钉着：清空标题能提交、空标题提交不写历史）。
 * 由此推出的一条规矩：**任何"顺手把空标题补成默认名"的改动都是错的**——
 * 用户可能就是想把标题清掉再重新打，或者那个节点只是暂时没名字。
 */

export type EditorState = ViewSlice &
  SearchSlice &
  OutlineSlice &
  DocumentSlice &
  HistorySlice &
  SelectionSlice &
  StructureSlice &
  MoveSlice &
  NodeContentSlice &
  OverlaysSlice &
  ThemeSlice
