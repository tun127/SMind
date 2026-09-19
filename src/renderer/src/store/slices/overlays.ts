/**
 * 画布级元素切片（自 `editor.ts` 的「画布级元素」分节整块搬出，成员体逐字未改）：
 * 关系线 / 边界 / 概要的增删改、覆盖层选中态、四个「请求焦点」计数器、应用设置。
 *
 * 这些成员在原文件里就是同一个分节（同一个 banner），故按**既有分节边界**整体成一切片，不再细分：
 * 它们都围绕「选中 / 打开面板 / 写画布级元素」这一件事。
 * `setAppSettings` 留在这里（设置面板与 `patchAppSettings` 的入口）；`patchAppSettings` 本身按计划表
 * **留在 `editor.ts`**（store + IPC）。
 *
 * 本文件同时拥有这些成员在 `EditorState` 里的**声明**（接口逐字搬来）。
 */
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/ipc'
import {
  withOverlayTextStyle,
  type OverlayKind,
  type OverlayTextStylePatch
} from '@shared/model/overlay-style'

import { createId } from '@shared/model/factory'

import { activeRoot, activeSheet, findTopic } from '@shared/model/tree'
import { buildRange, parseRange, readCurveOffset, withCurveOffset } from '@shared/layout'
import { reconcileMarkers, RELATIONSHIP_CURVE_KEY } from '@shared/xmind/constants'

import { findOverlayByRange, findRelationshipBetween } from '@shared/model/editor-ops'
import type { StateCreator } from 'zustand'
import type { EditorState } from './types'
import { NO_EDITING } from './types'

export interface OverlaysSlice {
  /* ---- 画布级元素（关系线 / 边界 / 概要） ---- */
  /**
   * 这三个都是「开关」：选中状态已经存在对应元素时再点一次是移除，
   * 避免同一个范围被反复叠加出多个元素（叠加会让颜色越来越深）。
   * @returns 新建元素的 id；本次是移除则返回 null
   */
  addRelationship(): string | null
  addBoundary(): string | null
  addSummary(): string | null
  removeRelationship(id: string): void
  removeBoundary(id: string): void
  removeSummary(id: string): void
  /** 拖动线身调整弧线位置（偏移量累加，连续拖动合并为一步撤销） */
  offsetRelationshipCurve(id: string, dx: number, dy: number): void
  /** 把弧线弯度恢复到自动计算的位置 */
  resetRelationshipCurve(id: string): void
  /** 框选用：一次性设置选中集合 */
  setSelection(ids: string[]): void
  /**
   * 画布级元素（概要 / 边界 / 关系线）的选中态。
   *
   * 选中它们就能在面板里改文字与字体样式——概要因此成为「一等公民」：
   * 空文字时也点得到、选得中，不再是「删空就只能删掉重建」。
   */
  selectedOverlay: { kind: OverlayKind; id: string } | null
  selectOverlay(kind: OverlayKind, id: string): void
  clearOverlaySelection(): void
  /**
   * 「请打开节点属性面板」的信号（自增计数）。
   *
   * 画布在选中画布元素（概要/边界/关系线）时发一次：那些元素的文字、字体与删除
   * 全在面板里，选中了却不显示面板，用户会以为「选中没生效」。
   */
  nodePanelTick: number
  requestNodePanel(): void
  /** 「备注」聚焦信号（自增值），NodePanel 监听它 */
  notesFocusTick: number
  /** 请求节点面板聚焦到备注输入框（画布上的备注指示图标点击用）；面板会随之自动打开 */
  requestNotesFocus(): void
  /** 改画布级元素标题样式（字号 / 加粗 / 斜体 / 颜色），一步撤销 */
  setOverlayStyle(kind: OverlayKind, id: string, patch: OverlayTextStylePatch): void
  /** 请求节点面板聚焦到代码输入框（Alt+C 用）；面板未打开时会随打开自动聚焦 */
  requestCodeFocus(): void
  /** 代码聚焦信号（自增值），NodePanel 监听它 */
  codeFocusTick: number
  /** 公式聚焦信号（自增值），NodePanel 监听它 */
  formulaFocusTick: number
  /** 请求节点面板聚焦到公式输入框（快捷栏 / 快捷键用） */
  requestFormulaFocus(): void
  /** 应用级默认设置（默认视角锁定 / 主题 / 对齐），由「设置」对话框读写 */
  appSettings: AppSettings
  setAppSettings(next: AppSettings): void
  /** 把关系线的某一端改接到另一个主题（拖拽端点用） */
  setRelationshipEnd(id: string, end: 'end1Id' | 'end2Id', topicId: string): void
  setRelationshipTitle(id: string, title: string): void
  setBoundaryTitle(id: string, title: string): void
  setSummaryTitle(id: string, title: string): void

  /* ---- 画布元素：给 AI 用的「不依赖选中」版本 ---- */
  /**
   * 连一条关系线（按 id，不读用户当前选中）。
   *
   * 为什么不复用上面的 `addRelationship`：那个读的是**选择**，AI 自己改选中会把用户
   * 的选区搅乱；而且它是**开关**语义（再点一次是删除）——模型重试一次就把线删了。
   * 这里一律**幂等**：已经连过就返回原 id，不增不减。
   */
  connectTopics(end1Id: string, end2Id: string): string | null
  /** 给这些同级主题加边界（幂等；title 可省略） */
  addBoundaryFor(topicIds: string[], title?: string): string | null
  /** 给这些同级主题加概要（幂等；title 省略时为「概要」） */
  addSummaryFor(topicIds: string[], title?: string): string | null
  /** 直接设置标记集合（不用 toggle：对模型来说「已存在就删掉」是个陷阱） */
  setMarkers(id: string, markerIds: string[]): void
}

export const createOverlaysSlice: StateCreator<EditorState, [], [], OverlaysSlice> = (
  set,
  get
) => ({
  /* ------------------------------------------------------------------ */
  /* 画布级元素                                                          */
  /* ------------------------------------------------------------------ */

  addRelationship: () => {
    const { selection, workbook } = get()
    if (selection.length !== 2) return null
    const [end1Id, end2Id] = selection
    if (!end1Id || !end2Id || end1Id === end2Id) return null

    const existing = findRelationshipBetween(activeSheet(workbook).relationships, end1Id, end2Id)
    // 开关：已经连过就取消，避免同一个位置叠出多条线
    if (existing) {
      get().removeRelationship(existing.id)
      return null
    }

    const id = createId('rel')
    get().mutate((draft) => {
      activeSheet(draft).relationships.push({ id, end1Id, end2Id })
    }, '添加关系线')
    return id
  },

  addBoundary: () => {
    const { selection, workbook } = get()
    const range = buildRange(activeRoot(workbook), selection)
    if (!range) return null

    const existing = findOverlayByRange(activeSheet(workbook).boundaries, range)
    // 开关：再点一次移除，否则半透明填充会一层层叠加、颜色越来越深
    if (existing) {
      get().removeBoundary(existing.id)
      return null
    }

    const id = createId('boundary')
    get().mutate((draft) => {
      activeSheet(draft).boundaries.push({ id, range })
    }, '添加边界')
    return id
  },

  addSummary: () => {
    const { selection, workbook } = get()
    const range = buildRange(activeRoot(workbook), selection)
    if (!range) return null

    const existing = findOverlayByRange(activeSheet(workbook).summaries, range)
    if (existing) {
      get().removeSummary(existing.id)
      return null
    }

    const topicId = parseRange(range)?.[0] ?? selection[0]
    if (!topicId) return null
    const id = createId('summary')
    get().mutate((draft) => {
      activeSheet(draft).summaries.push({ id, topicId, range, title: '概要' })
    }, '添加概要')
    return id
  },

  connectTopics: (end1Id, end2Id) => {
    if (end1Id === end2Id) return null
    const root = activeRoot(get().workbook)
    // 两端都得真实存在：id 是模型给的，不能默认可信
    if (!findTopic(root, end1Id) || !findTopic(root, end2Id)) return null
    const existing = findRelationshipBetween(
      activeSheet(get().workbook).relationships,
      end1Id,
      end2Id
    )
    if (existing) return existing.id
    const id = createId('rel')
    get().mutate((draft) => {
      activeSheet(draft).relationships.push({ id, end1Id, end2Id })
    }, '添加关系线')
    return id
  },

  addBoundaryFor: (topicIds, title) => {
    const range = buildRange(activeRoot(get().workbook), topicIds)
    if (!range) return null
    const existing = findOverlayByRange(activeSheet(get().workbook).boundaries, range)
    if (existing) return existing.id
    const id = createId('boundary')
    const text = title?.trim()
    get().mutate((draft) => {
      activeSheet(draft).boundaries.push(text ? { id, range, title: text } : { id, range })
    }, '添加边界')
    return id
  },

  addSummaryFor: (topicIds, title) => {
    const range = buildRange(activeRoot(get().workbook), topicIds)
    if (!range) return null
    const topicId = parseRange(range)?.[0]
    if (!topicId) return null
    const existing = findOverlayByRange(activeSheet(get().workbook).summaries, range)
    if (existing) return existing.id
    const id = createId('summary')
    get().mutate((draft) => {
      activeSheet(draft).summaries.push({ id, topicId, range, title: title?.trim() || '概要' })
    }, '添加概要')
    return id
  },

  setMarkers: (id, markerIds) => {
    // 整体替换也按「每行一个」收敛：输入可能带着同一行的多个标记
    const wanted = reconcileMarkers(markerIds)
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      topic.markers = wanted.map((markerId) => ({ markerId }))
    }, '设置标记')
  },

  offsetRelationshipCurve: (id, dx, dy) => {
    get().mutate(
      (draft) => {
        const target = activeSheet(draft).relationships.find((item) => item.id === id)
        if (!target) return
        const current = readCurveOffset(target.style)
        target.style = withCurveOffset(target.style, { x: current.x + dx, y: current.y + dy })
      },
      '调整关系线弯度',
      `curve:${id}`
    )
  },

  resetRelationshipCurve: (id) => {
    get().mutate((draft) => {
      const target = activeSheet(draft).relationships.find((item) => item.id === id)
      if (!target) return
      if (!target.style?.properties?.[RELATIONSHIP_CURVE_KEY]) return
      target.style = withCurveOffset(target.style, { x: 0, y: 0 })
    }, '恢复关系线弯度')
  },

  setSelection: (ids) => {
    const root = activeRoot(get().workbook)
    const valid = Array.from(new Set(ids)).filter((id) => Boolean(findTopic(root, id)))
    // 选主题就取消画布元素的选中（两者不同时高亮）
    set({ selection: valid, ...NO_EDITING, selectedOverlay: null })
  },

  selectedOverlay: null,

  selectOverlay: (kind, id) => set({ selectedOverlay: { kind, id }, selection: [], ...NO_EDITING }),

  clearOverlaySelection: () => set({ selectedOverlay: null }),

  nodePanelTick: 0,

  requestNodePanel: () => set({ nodePanelTick: get().nodePanelTick + 1 }),

  setOverlayStyle: (kind, id, patch) => {
    get().mutate((draft) => {
      const sheet = activeSheet(draft)
      const list =
        kind === 'summary'
          ? sheet.summaries
          : kind === 'boundary'
            ? sheet.boundaries
            : sheet.relationships
      const target = list.find((item) => item.id === id)
      if (!target) return
      const next = withOverlayTextStyle(target.style, patch)
      if (!next) {
        if (target.style === undefined) return
        target.style = undefined
        return
      }
      target.style = next
    }, '修改画布元素样式')
  },

  codeFocusTick: 0,
  requestCodeFocus: () => set((s) => ({ codeFocusTick: s.codeFocusTick + 1 })),

  notesFocusTick: 0,
  requestNotesFocus: () =>
    set((s) => ({ nodePanelTick: s.nodePanelTick + 1, notesFocusTick: s.notesFocusTick + 1 })),

  formulaFocusTick: 0,
  requestFormulaFocus: () => set((s) => ({ formulaFocusTick: s.formulaFocusTick + 1 })),

  appSettings: { ...DEFAULT_APP_SETTINGS },
  setAppSettings: (next) => set({ appSettings: { ...next } }),

  removeRelationship: (id) => {
    get().mutate((draft) => {
      const list = activeSheet(draft).relationships
      const index = list.findIndex((item) => item.id === id)
      if (index >= 0) list.splice(index, 1)
    }, '删除关系线')
  },

  removeBoundary: (id) => {
    get().mutate((draft) => {
      const list = activeSheet(draft).boundaries
      const index = list.findIndex((item) => item.id === id)
      if (index >= 0) list.splice(index, 1)
    }, '删除边界')
  },

  removeSummary: (id) => {
    get().mutate((draft) => {
      const list = activeSheet(draft).summaries
      const index = list.findIndex((item) => item.id === id)
      if (index >= 0) list.splice(index, 1)
    }, '删除概要')
  },

  setRelationshipEnd: (id, end, topicId) => {
    get().mutate((draft) => {
      const target = activeSheet(draft).relationships.find((item) => item.id === id)
      if (!target) return
      const other = end === 'end1Id' ? target.end2Id : target.end1Id
      // 两端不能连到同一个主题，否则连线会退化成零长度
      if (other === topicId) return
      if (target[end] === topicId) return
      target[end] = topicId
    }, '改接关系线')
  },

  setRelationshipTitle: (id, title) => {
    const text = title.trim()
    get().mutate((draft) => {
      const target = activeSheet(draft).relationships.find((item) => item.id === id)
      if (!target) return
      target.title = text.length > 0 ? text : undefined
    }, '修改关系线标题')
  },

  setBoundaryTitle: (id, title) => {
    const text = title.trim()
    get().mutate((draft) => {
      const target = activeSheet(draft).boundaries.find((item) => item.id === id)
      if (!target) return
      target.title = text.length > 0 ? text : undefined
    }, '修改边界标题')
  },

  setSummaryTitle: (id, title) => {
    const text = title.trim()
    get().mutate((draft) => {
      const target = activeSheet(draft).summaries.find((item) => item.id === id)
      if (!target) return
      // 概要文字可能是「没有自带标题、回退显示主题文字」的情况。
      // 用户主动清空时必须写成空串而不是 undefined，
      // 否则清空后会立刻回退成主题的文字，看起来就像「改不动」。
      target.title = text
    }, '修改概要标题')
  }
})
