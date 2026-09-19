import { create } from 'zustand'
import { enablePatches, produce } from 'immer'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/ipc'
import { withOverlayTextStyle } from '@shared/model/overlay-style'
import type { Workbook } from '@shared/model/types'
import { createId } from '@shared/model/factory'
import { hasFormatting, normalizeRich } from '@shared/richtext'

import { DEFAULT_THEME } from '@shared/theme'
import { activeRoot, activeSheet, findTopic } from '@shared/model/tree'
import { buildRange, parseRange, readCurveOffset, withCurveOffset } from '@shared/layout'
import {
  reconcileMarkers,
  RELATIONSHIP_CURVE_KEY,
  withMarkerToggled
} from '@shared/xmind/constants'
import { notesHtmlFrom } from '@shared/richtext'

import {
  findOverlayByRange,
  findRelationshipBetween,
  normalizeImage
} from '@shared/model/editor-ops'
import type { EditorState } from './slices/types'
import { createViewSlice } from './slices/view'
import { NO_EDITING } from './slices/types'

/**
 * 公开面：`themeColorsOf` / `overlayToggleOf` 已下沉到 `@shared/model/editor-pure`。
 * 这里再导出一次，Canvas / export/index / ThemePanel / overlay-group 的调用点一行都不用改。
 */
export type { EditorState, SearchState } from './slices/types'
export { overlayToggleOf, themeColorsOf } from '@shared/model/editor-pure'

enablePatches()

import { createSearchSlice } from './slices/search'
import { createOutlineSlice } from './slices/outline'
import { createDocumentSlice } from './slices/document'
import { createHistorySlice } from './slices/history'
import { createSelectionSlice } from './slices/selection'
import { createStructureSlice } from './slices/structure'
import { createMoveSlice } from './slices/move'

/**
 * 改应用设置：写进 store 并落盘。所有「默认值」入口（格式栏默认样式面板 /
 * 主题面板的默认主题 / 工具栏收纳）都走这一个门，保证 settings.json 是唯一真相。
 */
export async function patchAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...useEditor.getState().appSettings, ...patch }
  useEditor.getState().setAppSettings(next)
  try {
    await window.api.settingsSave(next)
  } catch {
    /* 落盘失败不影响本次会话 */
  }
  return next
}

export const useEditor = create<EditorState>()((set, get, store) => ({
  ...createViewSlice(set, get, store),
  ...createSearchSlice(set, get, store),
  ...createOutlineSlice(set, get, store),
  ...createHistorySlice(set, get, store),
  ...createDocumentSlice(set, get, store),
  ...createSelectionSlice(set, get, store),
  ...createStructureSlice(set, get, store),
  ...createMoveSlice(set, get, store),

  /* ------------------------------------------------------------------ */
  /* 节点附加元素                                                        */
  /* ------------------------------------------------------------------ */

  toggleMarker: (id, markerId) => {
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      /**
       * 同一**行**只能有一个（与 Xmind 一致）：点同组的另一个是**替换**，不是叠加。
       * 规则本身在 `shared/xmind/constants` 里，渲染层和自检共用同一份。
       */
      const next = withMarkerToggled(
        topic.markers.map((marker) => marker.markerId),
        markerId
      )
      topic.markers = next.map((markerId) => ({ markerId }))
    }, '切换标记')
  },

  addLabel: (id, label) => {
    const text = label.trim()
    if (text.length === 0) return
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic || topic.labels.includes(text)) return
      topic.labels.push(text)
    }, '添加标签')
  },

  removeLabel: (id, label) => {
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      const index = topic.labels.indexOf(label)
      if (index >= 0) topic.labels.splice(index, 1)
    }, '删除标签')
  },

  setNotes: (id, notes) => {
    const text = notes.trim().length > 0 ? notes : ''
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      if (text.length === 0) {
        if (topic.notes === undefined && topic.notesHtml === undefined) return
        topic.notes = undefined
        topic.notesHtml = undefined
        return
      }
      if (topic.notes === text) return
      topic.notes = text
      // notesHtml 由纯文本派生，避免两者说法不一致
      topic.notesHtml = notesHtmlFrom(text)
    }, '修改备注')
  },

  setHref: (id, href) => {
    const next = href.trim()
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      if (next.length === 0) {
        if (topic.href === undefined) return
        topic.href = undefined
        return
      }
      topic.href = next
    }, '修改超链接')
  },

  setFormula: (id, formula) => {
    const next = formula.trim()
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      if (next.length === 0) {
        if (topic.formula === undefined) return
        topic.formula = undefined
        return
      }
      if (topic.formula === next) return
      topic.formula = next
    }, '修改公式')
  },

  setCode: (id, code) => {
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      const next = code && (code.text.length > 0 || code.language.length > 0) ? code : null
      if (!next) {
        if (topic.code === undefined) return
        topic.code = undefined
        return
      }
      if (topic.code?.text === next.text && topic.code?.language === next.language) return
      topic.code = { language: next.language, text: next.text }
    }, '修改代码块')
  },

  setImage: (id, image) => {
    // 拿不到像素尺寸时不要写 0，交给渲染层走「尺寸未知」的兜底框
    const next = normalizeImage(image)

    get().mutate(
      (draft) => {
        const topic = findTopic(activeRoot(draft), id)
        if (!topic) return
        if (!next) {
          if (topic.image === undefined) return
          topic.image = undefined
          return
        }
        topic.image = { ...next }
      },
      next ? '插入图片' : '移除图片'
    )
  },

  addAttachment: (id, attachment) => {
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      const exists = topic.attachments.some((item) => item.path === attachment.path)
      if (exists) return
      topic.attachments.push({ ...attachment })
    }, '添加附件')
  },

  removeAttachment: (id, attachmentId) => {
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      const index = topic.attachments.findIndex((item) => item.id === attachmentId)
      if (index >= 0) topic.attachments.splice(index, 1)
    }, '删除附件')
  },

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
  },

  /* ------------------------------------------------------------------ */
  /* 主题                                                                */
  /* ------------------------------------------------------------------ */

  primeTheme: (theme) => {
    set((state) => ({
      workbook: produce(state.workbook, (draft) => {
        for (const sheet of draft.sheets) {
          // 把配色「烤」进文档，与 applyTheme 保持同一套写法
          sheet.theme = {
            ...(sheet.theme ?? {}),
            id: theme.id,
            name: theme.name,
            colors: { ...theme.colors, branches: [...theme.colors.branches] }
          }
        }
      })
    }))
  },

  applyTheme: (theme) => {
    const current = (() => {
      const { workbook } = get()
      return (workbook.sheets.find((s) => s.id === workbook.activeSheetId) ?? workbook.sheets[0])
        ?.theme
    })()
    // 已经是这个主题（例如启动时套用「设置」里的默认主题）就别再写一次：
    // 否则新建文档一上来就被记成"有未保存改动"，标题栏立刻出现 ●
    if (
      current &&
      current.id === theme.id &&
      JSON.stringify(current.colors) === JSON.stringify(theme.colors)
    ) {
      return
    }
    get().mutate((draft) => {
      const sheet = draft.sheets.find((s) => s.id === draft.activeSheetId) ?? draft.sheets[0]
      if (!sheet) return
      // 把配色「烤」进文档，内置主题日后调整也不会改变老文件的样子
      sheet.theme = {
        ...(sheet.theme ?? {}),
        id: theme.id,
        name: theme.name,
        colors: { ...theme.colors, branches: [...theme.colors.branches] }
      }
    }, '应用主题')
  },

  updateThemeColors: (patch, coalesceKey) => {
    get().mutate(
      (draft) => {
        const sheet = draft.sheets.find((s) => s.id === draft.activeSheetId) ?? draft.sheets[0]
        if (!sheet) return
        const current = sheet.theme?.colors ?? DEFAULT_THEME.colors
        sheet.theme = {
          ...(sheet.theme ?? {}),
          id: sheet.theme?.id ?? 'custom',
          name: sheet.theme?.name ?? DEFAULT_THEME.name,
          colors: {
            ...current,
            ...patch,
            branches: patch.branches ? [...patch.branches] : [...current.branches]
          }
        }
      },
      '调整主题',
      coalesceKey
    )
  }
}))

/* ------------------------------------------------------------------ */
/* 派生工具                                                            */
/* ------------------------------------------------------------------ */

/**
 * 落盘用的快照。
 * 把「正在编辑但还没提交」的内容也包含进去，
 * 这样自动保存不会因为用户还在输入而丢掉最后几个字，
 * 同时也不需要打断用户的输入（不会改动编辑态）。
 */
export function snapshotForSave(state: EditorState): Workbook {
  if (!state.editingId) return state.workbook
  const editingId = state.editingId
  const rich = state.editingRich
  const text = state.editingText
  return produce(state.workbook, (draft) => {
    const topic = findTopic(activeRoot(draft), editingId)
    if (!topic) return
    topic.title = text
    const normalized = rich ? normalizeRich(rich) : null
    topic.titleRich = normalized && hasFormatting(normalized) ? normalized : undefined
  })
}
