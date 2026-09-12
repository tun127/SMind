import { create } from 'zustand'
import { applyPatches, enablePatches, produce, produceWithPatches, type Patch } from 'immer'
import type { Attachment, RichText, Sheet, ThemeColors, Topic, TopicImage, Workbook } from '@shared/model/types'
import { createId, createSheet, createTopic, createWorkbook } from '@shared/model/factory'
import { hasFormatting, normalizeRich, plainTextOf, richFromPlain } from '@shared/richtext'
import {
  EMPTY_FILTER,
  countOccurrences,
  countTitleMatches,
  replaceInText,
  type SearchOptions,
  type TopicFilter
} from '@shared/search'
import { DEFAULT_THEME, getThemeColors } from '@shared/theme'
import {
  activeRoot,
  activeSheet,
  cloneTopicDeep,
  countCharacters,
  countTopics,
  detachTopic,
  findParent,
  findTopic,
  isSelfOrDescendant,
  moveTopic,
  walk
} from '@shared/model/tree'
import {
  buildRange,
  parseRange,
  readCurveOffset,
  sameRange,
  withCurveOffset
} from '@shared/layout'
import { RELATIONSHIP_CURVE_KEY } from '@shared/xmind/constants'

enablePatches()

const HISTORY_LIMIT = 200

interface HistoryEntry {
  label: string
  patches: Patch[]
  inverse: Patch[]
  /** 连续同类操作（例如拖动调色）合并为一步撤销 */
  coalesceKey?: string
  time: number
}

/** 合并窗口：同一个 coalesceKey 在此时间内的连续操作算作一步 */
const COALESCE_WINDOW_MS = 1500

/** 搜索状态：条件放在 store 里，画布与搜索面板才能用同一份条件算命中 */
export interface SearchState {
  query: string
  replacement: string
  options: Required<SearchOptions>
}

const EMPTY_SEARCH: SearchState = {
  query: '',
  replacement: '',
  options: { caseSensitive: false, inNotes: false, inLabels: false }
}

export interface EditorState {
  workbook: Workbook
  filePath: string | null
  dirty: boolean
  /** 文档代次，每次新建/打开自增，用于触发画布重新居中 */
  docSeq: number

  selection: string[]
  editingId: string | null
  /** 正在编辑的纯文本镜像，用于比较与统计 */
  editingText: string
  /** 正在编辑的富文本内容 */
  editingRich: RichText | null
  clipboard: Topic | null

  zoom: number
  pan: { x: number; y: number }

  /** 搜索条件：面板与画布共用，保证两边看到的命中完全一致 */
  search: SearchState
  /** 按标记 / 标签筛选 */
  filter: TopicFilter

  undoStack: HistoryEntry[]
  redoStack: HistoryEntry[]

  /* ---- 检索（P7） ---- */
  setSearchQuery(query: string): void
  setSearchReplacement(replacement: string): void
  setSearchOption(key: keyof SearchOptions, value: boolean): void
  resetSearch(): void
  /** 把标题里的关键词全部替换掉，返回替换处数 */
  replaceAllInTitles(): number
  /** 替换某一个节点标题里的关键词，返回替换处数 */
  replaceInTopic(topicId: string): number

  /* ---- 筛选（P7） ---- */
  toggleFilterMarker(markerId: string): void
  toggleFilterLabel(label: string): void
  clearFilter(): void

  /* ---- 多画布（P7） ---- */
  addSheet(): string
  removeSheet(id: string): void
  renameSheet(id: string, title: string): void
  setActiveSheet(id: string): void

  /* ---- 视图 ---- */
  setZoom(zoom: number): void
  zoomBy(factor: number): void
  setPan(pan: { x: number; y: number }): void

  /* ---- 文档 ---- */
  newDocument(): void
  loadDocument(workbook: Workbook, path: string | null): void
  markSaved(path: string): void

  /* ---- 编辑 ---- */
  /**
   * @param coalesceKey 传入后，短时间内同 key 的连续修改会合并成一步撤销。
   *                    适用于拖动调色这类高频小改动。
   */
  mutate(recipe: (draft: Workbook) => void, label: string, coalesceKey?: string): boolean
  undo(): void
  redo(): void

  /* ---- 选择与编辑态 ---- */
  select(id: string | null, additive?: boolean): void
  beginEdit(id: string): void
  updateEditingText(text: string): void
  updateEditingRich(rich: RichText): void
  /**
   * 提交当前正在编辑的内容。
   * @param forId 只有当前编辑中的正是这个节点时才提交。
   *              用于避免「新建节点后旧输入框失焦」把新节点的编辑态误关掉。
   */
  commitEdit(forId?: string): void
  cancelEdit(): void
  /** 提交编辑并新建子主题（编辑中按 Tab） */
  commitAndAddChild(): void
  /** 提交编辑并新建同级主题（编辑中按 Enter） */
  commitAndAddSibling(): void

  /* ---- 结构操作 ---- */
  addChild(parentId?: string): string
  addSibling(id?: string): string
  deleteSelection(): void
  setTitle(id: string, title: string): void
  setRichText(id: string, rich: RichText | null): void
  toggleCollapse(id: string): void
  setStructure(structureClass: string, targetId?: string): void
  moveNode(id: string, targetId: string, index?: number): boolean
  offsetPosition(id: string, dx: number, dy: number): void
  clearPosition(id: string): void
  copySelection(): void
  paste(): void

  /* ---- 节点附加元素 ---- */
  toggleMarker(id: string, markerId: string): void
  addLabel(id: string, label: string): void
  removeLabel(id: string, label: string): void
  setNotes(id: string, notes: string): void
  setHref(id: string, href: string): void
  /** 设置 LaTeX 公式源码（传空字符串即移除） */
  setFormula(id: string, formula: string): void
  /** 设置/移除节点内图片（字节由主进程存进包内资源） */
  setImage(id: string, image: TopicImage | null): void
  addAttachment(id: string, attachment: Attachment): void
  removeAttachment(id: string, attachmentId: string): void

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
  /** 把关系线的某一端改接到另一个主题（拖拽端点用） */
  setRelationshipEnd(id: string, end: 'end1Id' | 'end2Id', topicId: string): void
  setRelationshipTitle(id: string, title: string): void
  setBoundaryTitle(id: string, title: string): void
  setSummaryTitle(id: string, title: string): void

  /* ---- 主题 ---- */
  /** 应用一整套主题（会把配色写进当前画布） */
  applyTheme(theme: { id: string; name: string; colors: ThemeColors }): void
  /** 微调当前画布的配色 */
  updateThemeColors(patch: Partial<ThemeColors>, coalesceKey?: string): void
}

/** 取某个画布当前生效的配色 */
export function themeColorsOf(workbook: Workbook): ThemeColors {
  const sheet = workbook.sheets.find((s) => s.id === workbook.activeSheetId) ?? workbook.sheets[0]
  return getThemeColors(sheet?.theme)
}

const clampZoom = (z: number): number => Math.min(4, Math.max(0.1, z))

/** 删除主题后清理指向它们的画布级元素，避免出现悬空的关系线/边界/概要 */
function pruneOverlays(sheet: Sheet): void {
  const alive = new Set<string>()
  const walk = (topic: Topic): void => {
    alive.add(topic.id)
    for (const child of topic.children) walk(child)
  }
  walk(sheet.rootTopic)

  // 区间两端都还在，这段区间才仍然成立（只删中间的主题不影响）
  const rangeAlive = (range: string): boolean => {
    const parsed = parseRange(range)
    return Boolean(parsed && alive.has(parsed[0]) && alive.has(parsed[1]))
  }

  sheet.relationships = sheet.relationships.filter(
    (item) => alive.has(item.end1Id) && alive.has(item.end2Id)
  )
  sheet.boundaries = sheet.boundaries.filter((item) => rangeAlive(item.range))
  sheet.summaries = sheet.summaries.filter((item) => rangeAlive(item.range))
}

/** 备注 HTML 由纯文本派生时用到的转义，避免把用户输入当成标签 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function sameRich(a: RichText | undefined, b: RichText | null): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

export const useEditor = create<EditorState>()((set, get) => ({
  workbook: createWorkbook(),
  filePath: null,
  dirty: false,
  docSeq: 0,

  selection: [],
  editingId: null,
  editingText: '',
  editingRich: null,
  clipboard: null,

  zoom: 1,
  pan: { x: 0, y: 0 },

  search: { ...EMPTY_SEARCH },
  filter: { ...EMPTY_FILTER },

  undoStack: [],
  redoStack: [],

  /* ------------------------------------------------------------------ */
  /* 视图                                                                */
  /* ------------------------------------------------------------------ */

  setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),

  zoomBy: (factor) => set((s) => ({ zoom: clampZoom(s.zoom * factor) })),

  setPan: (pan) => set({ pan }),

  /* ------------------------------------------------------------------ */
  /* 检索与筛选                                                          */
  /* ------------------------------------------------------------------ */

  setSearchQuery: (query) => set((s) => ({ search: { ...s.search, query } })),

  setSearchReplacement: (replacement) => set((s) => ({ search: { ...s.search, replacement } })),

  setSearchOption: (key, value) =>
    set((s) => ({ search: { ...s.search, options: { ...s.search.options, [key]: value } } })),

  resetSearch: () => set({ search: { ...EMPTY_SEARCH } }),

  replaceAllInTitles: () => {
    const { search, workbook } = get()
    const query = search.query
    if (query.length === 0) return 0

    // 先按当前条件数出总处数（mutate 不返回值），再统一替换
    const total = countTitleMatches(workbook, query, search.options)
    if (total === 0) return 0

    get().mutate((draft) => {
      for (const sheet of draft.sheets) {
        walk(sheet.rootTopic, (topic) => {
          const result = replaceInText(topic.title, query, search.replacement, search.options.caseSensitive)
          if (result.count === 0) return
          topic.title = result.text
          // 文本长度变了，原来的富文本区间就对不上了，必须一并清掉
          topic.titleRich = undefined
        })
      }
    }, '替换全部')
    return total
  },

  replaceInTopic: (topicId) => {
    const { search, workbook } = get()
    const query = search.query
    if (query.length === 0) return 0

    const root = activeRoot(workbook)
    const topic = findTopic(root, topicId)
    if (!topic) return 0
    const count = countOccurrences(topic.title, query, search.options.caseSensitive)
    if (count === 0) return 0

    get().mutate((draft) => {
      const target = findTopic(activeRoot(draft), topicId)
      if (!target) return
      const result = replaceInText(target.title, query, search.replacement, search.options.caseSensitive)
      target.title = result.text
      target.titleRich = undefined
    }, '替换文本')
    return count
  },

  toggleFilterMarker: (markerId) =>
    set((s) => ({
      filter: {
        ...s.filter,
        markers: s.filter.markers.includes(markerId)
          ? s.filter.markers.filter((id) => id !== markerId)
          : [...s.filter.markers, markerId]
      }
    })),

  toggleFilterLabel: (label) =>
    set((s) => ({
      filter: {
        ...s.filter,
        labels: s.filter.labels.includes(label)
          ? s.filter.labels.filter((item) => item !== label)
          : [...s.filter.labels, label]
      }
    })),

  clearFilter: () => set({ filter: { ...EMPTY_FILTER } }),

  /* ------------------------------------------------------------------ */
  /* 多画布                                                              */
  /* ------------------------------------------------------------------ */

  addSheet: () => {
    const { workbook } = get()
    const sheet = createSheet(`画布 ${workbook.sheets.length + 1}`, '中心主题')
    get().mutate((draft) => {
      draft.sheets.push(sheet)
      draft.activeSheetId = sheet.id
    }, '新建画布')
    set({ selection: [sheet.rootTopic.id], editingId: null, editingText: '', editingRich: null, zoom: 1, pan: { x: 0, y: 0 } })
    return sheet.id
  },

  removeSheet: (id) => {
    const { workbook } = get()
    // 至少留一张画布
    if (workbook.sheets.length <= 1) return
    const index = workbook.sheets.findIndex((sheet) => sheet.id === id)
    if (index < 0) return
    const next = workbook.sheets[index + 1] ?? workbook.sheets[index - 1]

    get().mutate((draft) => {
      draft.sheets = draft.sheets.filter((sheet) => sheet.id !== id)
      if (draft.activeSheetId === id) draft.activeSheetId = next.id
    }, '删除画布')
    set({ selection: [], editingId: null, editingText: '', editingRich: null, zoom: 1, pan: { x: 0, y: 0 } })
  },

  renameSheet: (id, title) => {
    get().mutate((draft) => {
      const sheet = draft.sheets.find((item) => item.id === id)
      if (sheet) sheet.title = title
    }, '重命名画布')
  },

  /**
   * 切换画布不写历史、也不标记未保存：切标签页本身不是对内容的修改。
   * activeSheetId 会在下一次保存时一并写进文件。
   */
  setActiveSheet: (id) =>
    set((s) => {
      if (s.workbook.activeSheetId === id) return {}
      if (!s.workbook.sheets.some((sheet) => sheet.id === id)) return {}
      return {
        workbook: { ...s.workbook, activeSheetId: id },
        selection: [],
        editingId: null,
        editingText: '',
        editingRich: null,
        zoom: 1,
        pan: { x: 0, y: 0 }
      }
    }),

  /* ------------------------------------------------------------------ */
  /* 文档                                                                */
  /* ------------------------------------------------------------------ */

  newDocument: () =>
    set((state) => ({
      workbook: createWorkbook({ rootTitle: '中心主题', seedBranches: ['分支主题 1', '分支主题 2'] }),
      filePath: null,
      dirty: false,
      docSeq: state.docSeq + 1,
      selection: [],
      editingId: null,
      editingText: '',
      editingRich: null,
      undoStack: [],
      redoStack: [],
      zoom: 1,
      pan: { x: 0, y: 0 }
    })),

  loadDocument: (workbook, path) =>
    set((state) => ({
      workbook,
      filePath: path,
      dirty: false,
      docSeq: state.docSeq + 1,
      selection: [],
      editingId: null,
      editingText: '',
      editingRich: null,
      undoStack: [],
      redoStack: [],
      zoom: 1,
      pan: { x: 0, y: 0 }
    })),

  markSaved: (path) => set({ filePath: path, dirty: false }),

  /* ------------------------------------------------------------------ */
  /* 编辑                                                                */
  /* ------------------------------------------------------------------ */

  mutate: (recipe, label, coalesceKey) => {
    const { workbook, undoStack } = get()
    const [next, patches, inverse] = produceWithPatches(workbook, recipe)
    if (patches.length === 0) return false

    const now = Date.now()
    const last = undoStack[undoStack.length - 1]
    const canMerge =
      coalesceKey !== undefined &&
      last !== undefined &&
      last.coalesceKey === coalesceKey &&
      now - last.time < COALESCE_WINDOW_MS

    if (canMerge) {
      // 合并成一步撤销：重做用最新的 patches，撤销仍然回到最早那次修改之前
      const merged: HistoryEntry = { label, patches, inverse: last.inverse, coalesceKey, time: now }
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
      undoStack: [...undoStack, { label, patches, inverse, coalesceKey, time: now }].slice(-HISTORY_LIMIT),
      redoStack: []
    })
    return true
  },

  undo: () => {
    const { workbook, undoStack, redoStack } = get()
    const entry = undoStack[undoStack.length - 1]
    if (!entry) return
    const next = applyPatches(workbook, entry.inverse) as Workbook
    const root = activeRoot(next)
    set({
      workbook: next,
      dirty: true,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, entry],
      editingId: null,
      editingText: '',
      editingRich: null,
      selection: get().selection.filter((id) => findTopic(root, id) !== null)
    })
  },

  redo: () => {
    const { workbook, undoStack, redoStack } = get()
    const entry = redoStack[redoStack.length - 1]
    if (!entry) return
    const next = applyPatches(workbook, entry.patches) as Workbook
    const root = activeRoot(next)
    set({
      workbook: next,
      dirty: true,
      undoStack: [...undoStack, entry],
      redoStack: redoStack.slice(0, -1),
      editingId: null,
      editingText: '',
      editingRich: null,
      selection: get().selection.filter((id) => findTopic(root, id) !== null)
    })
  },

  /* ------------------------------------------------------------------ */
  /* 选择与编辑态                                                        */
  /* ------------------------------------------------------------------ */

  select: (id, additive = false) =>
    set((s) => {
      if (id === null) return { selection: [] }
      if (!additive) return { selection: [id] }
      return s.selection.includes(id)
        ? { selection: s.selection.filter((x) => x !== id) }
        : { selection: [...s.selection, id] }
    }),

  beginEdit: (id) => {
    const topic = findTopic(activeRoot(get().workbook), id)
    const rich = topic?.titleRich ? normalizeRich(topic.titleRich) : richFromPlain(topic?.title ?? '')
    set({ editingId: id, editingText: plainTextOf(rich), editingRich: rich, selection: [id] })
  },

  updateEditingText: (text) => set({ editingText: text, editingRich: richFromPlain(text) }),

  updateEditingRich: (rich) => set({ editingRich: rich, editingText: plainTextOf(rich) }),

  commitEdit: (forId) => {
    const { editingId, editingText, editingRich, workbook } = get()
    if (!editingId) return
    // 旧输入框失焦时可能已经切到了新节点，此时必须忽略这次提交
    if (forId !== undefined && forId !== editingId) return

    const topic = findTopic(activeRoot(workbook), editingId)
    const nextTitle = editingText
    const nextRich = editingRich ? normalizeRich(editingRich) : null
    const keepRich = nextRich && hasFormatting(nextRich) ? nextRich : null

    set({ editingId: null, editingText: '', editingRich: null })
    if (!topic) return
    if (topic.title === nextTitle && sameRich(topic.titleRich, keepRich)) return

    get().mutate((draft) => {
      const target = findTopic(activeRoot(draft), editingId)
      if (!target) return
      target.title = nextTitle
      // 只有真正带格式时才写 titleRich，保持 .xmind 干净且与 Xmind 兼容
      target.titleRich = keepRich ?? undefined
    }, '修改文本')
  },

  cancelEdit: () => set({ editingId: null, editingText: '', editingRich: null }),

  commitAndAddChild: () => {
    const id = get().editingId
    if (!id) return
    get().commitEdit()
    get().addChild(id)
  },

  commitAndAddSibling: () => {
    const id = get().editingId
    if (!id) return
    get().commitEdit()
    get().addSibling(id)
  },

  /* ------------------------------------------------------------------ */
  /* 结构操作                                                            */
  /* ------------------------------------------------------------------ */

  addChild: (parentId) => {
    const { workbook, selection } = get()
    const root = activeRoot(workbook)
    const baseId = parentId ?? selection[0] ?? root.id
    const parent = findTopic(root, baseId) ?? root
    const node = createTopic('')
    get().mutate((draft) => {
      const target = findTopic(activeRoot(draft), parent.id) ?? activeRoot(draft)
      target.children.push(node)
      // 只在确实处于折叠态时才改：避免写入多余的 collapsed: false，
      // 否则「打开 → 另存」会因为默认值产生结构性差异
      if (target.collapsed) target.collapsed = false
    }, '新建子主题')
    set({ selection: [node.id], editingId: node.id, editingText: '', editingRich: richFromPlain('') })
    return node.id
  },

  addSibling: (id) => {
    const { workbook, selection } = get()
    const root = activeRoot(workbook)
    const baseId = id ?? selection[0]
    if (!baseId || baseId === root.id) return get().addChild(root.id)
    const parent = findParent(root, baseId)
    if (!parent) return get().addChild(root.id)
    const index = parent.children.findIndex((c) => c.id === baseId)
    const node = createTopic('')
    get().mutate((draft) => {
      const draftParent = findTopic(activeRoot(draft), parent.id)
      if (!draftParent) return
      draftParent.children.splice(index < 0 ? draftParent.children.length : index + 1, 0, node)
    }, '新建同级主题')
    set({ selection: [node.id], editingId: node.id, editingText: '', editingRich: richFromPlain('') })
    return node.id
  },

  deleteSelection: () => {
    const { workbook, selection } = get()
    const root = activeRoot(workbook)
    const targets = selection.filter((id) => id !== root.id && findTopic(root, id))
    if (targets.length === 0) return
    get().mutate((draft) => {
      const draftRoot = activeRoot(draft)
      for (const id of targets) detachTopic(draftRoot, id)
      // 指向已删除主题的关系线/边界/概要会变成悬空元素，必须一起清掉
      pruneOverlays(activeSheet(draft))
    }, '删除主题')
    set({ selection: [], editingId: null, editingText: '', editingRich: null })
  },

  setTitle: (id, title) => {
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (topic) {
        topic.title = title
        topic.titleRich = undefined
      }
    }, '修改文本')
  },

  setRichText: (id, rich) => {
    const normalized = rich ? normalizeRich(rich) : null
    const keep = normalized && hasFormatting(normalized) ? normalized : null
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      topic.titleRich = keep ?? undefined
      if (keep) topic.title = plainTextOf(keep)
    }, '修改格式')
  },

  toggleCollapse: (id) => {
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic || topic.children.length === 0) return
      // 用 undefined 表示展开，让模型中只存在「折叠 / 未设置」两种状态
      topic.collapsed = topic.collapsed ? undefined : true
    }, '折叠/展开')
  },

  setStructure: (structureClass, targetId) => {
    const root = activeRoot(get().workbook)
    const id = targetId ?? root.id
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (topic) topic.structureClass = structureClass
    }, '切换结构')
  },

  moveNode: (id, targetId, index) => {
    const root = activeRoot(get().workbook)
    if (id === root.id) return false
    if (isSelfOrDescendant(root, id, targetId)) return false
    const parent = findParent(root, id)
    if (parent && parent.id === targetId) return false
    let ok = false
    get().mutate((draft) => {
      ok = moveTopic(activeRoot(draft), id, targetId, index)
      // 换了父级后，原本「同级连续区间」可能不再成立，顺手清掉失效的边界/概要
      if (ok) pruneOverlays(activeSheet(draft))
    }, '移动主题')
    if (ok) set({ selection: [id] })
    return ok
  },

  offsetPosition: (id, dx, dy) => {
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      const base = topic.position ?? { x: 0, y: 0 }
      topic.position = { x: base.x + dx, y: base.y + dy }
    }, '移动位置')
  },

  clearPosition: (id) => {
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (topic) topic.position = undefined
    }, '恢复自动布局')
  },

  copySelection: () => {
    const { selection, workbook } = get()
    const root = activeRoot(workbook)
    const id = selection[0]
    if (!id) return
    const topic = findTopic(root, id)
    if (!topic) return
    set({ clipboard: cloneTopicDeep(topic) })
  },

  paste: () => {
    const { clipboard, selection, workbook } = get()
    if (!clipboard) return
    const root = activeRoot(workbook)
    const targetId = selection[0] ?? root.id
    const copy = cloneTopicDeep(clipboard)
    get().mutate((draft) => {
      const target = findTopic(activeRoot(draft), targetId) ?? activeRoot(draft)
      target.children.push(copy)
      if (target.collapsed) target.collapsed = false
    }, '粘贴主题')
    set({ selection: [copy.id] })
  },

  /* ------------------------------------------------------------------ */
  /* 节点附加元素                                                        */
  /* ------------------------------------------------------------------ */

  toggleMarker: (id, markerId) => {
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      const index = topic.markers.findIndex((marker) => marker.markerId === markerId)
      if (index >= 0) topic.markers.splice(index, 1)
      else topic.markers.push({ markerId })
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
      topic.notesHtml = `<p>${escapeHtml(text).replace(/\n/g, '<br/>')}</p>`
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

  setImage: (id, image) => {
    // 拿不到像素尺寸时不要写 0，交给渲染层走「尺寸未知」的兜底框
    const positive = (value: number | undefined): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
    const next: TopicImage | null = image
      ? { path: image.path, width: positive(image.width), height: positive(image.height) }
      : null

    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      if (!next) {
        if (topic.image === undefined) return
        topic.image = undefined
        return
      }
      topic.image = { ...next }
    }, next ? '插入图片' : '移除图片')
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
    if (end1Id === end2Id) return null

    const existing = activeSheet(workbook).relationships.find(
      (item) =>
        (item.end1Id === end1Id && item.end2Id === end2Id) ||
        (item.end1Id === end2Id && item.end2Id === end1Id)
    )
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

    const existing = activeSheet(workbook).boundaries.find((item) => sameRange(item.range, range))
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

    const existing = activeSheet(workbook).summaries.find((item) => sameRange(item.range, range))
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

  offsetRelationshipCurve: (id, dx, dy) => {
    get().mutate((draft) => {
      const target = activeSheet(draft).relationships.find((item) => item.id === id)
      if (!target) return
      const current = readCurveOffset(target.style)
      target.style = withCurveOffset(target.style, { x: current.x + dx, y: current.y + dy })
    }, '调整关系线弯度', `curve:${id}`)
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
    set({ selection: valid, editingId: null, editingText: '', editingRich: null })
  },

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

  applyTheme: (theme) => {
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

export function currentRoot(state: EditorState): Topic {
  return activeRoot(state.workbook)
}

/**
 * 工具栏「关系线 / 边界 / 概要」三个开关的当前状态。
 * 返回已存在元素的 id，按钮据此显示为「已按下」，用户也能看出再点一次会取消。
 *
 * 注意：这里刻意接收 workbook / selection 而不是整个 state，
 * 是为了能在组件里用 useMemo 包住——直接当 zustand selector 用会每次返回新对象，
 * 触发 useSyncExternalStore 的无限重渲染。
 */
export function overlayToggleOf(
  workbook: Workbook,
  selection: string[]
): {
  relationshipId: string | null
  boundaryId: string | null
  summaryId: string | null
} {
  const sheet = activeSheet(workbook)

  let relationshipId: string | null = null
  if (selection.length === 2) {
    const [first, second] = selection
    relationshipId =
      sheet.relationships.find(
        (item) =>
          (item.end1Id === first && item.end2Id === second) ||
          (item.end1Id === second && item.end2Id === first)
      )?.id ?? null
  }

  const range = buildRange(activeRoot(workbook), selection)
  return {
    relationshipId,
    boundaryId: range ? (sheet.boundaries.find((item) => sameRange(item.range, range))?.id ?? null) : null,
    summaryId: range ? (sheet.summaries.find((item) => sameRange(item.range, range))?.id ?? null) : null
  }
}

export function statsOf(state: EditorState): { nodes: number; chars: number; branches: number } {
  const root = activeRoot(state.workbook)
  return {
    nodes: countTopics(root),
    chars: countCharacters(root),
    branches: root.children.length
  }
}

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

export { countTopics, countCharacters }
