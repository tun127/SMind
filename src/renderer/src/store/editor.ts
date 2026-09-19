import { create } from 'zustand'
import { applyPatches, enablePatches, produce, produceWithPatches, type Patch } from 'immer'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/ipc'
import { withOverlayTextStyle } from '@shared/model/overlay-style'
import type { Workbook } from '@shared/model/types'
import { createId, createTopic, createWorkbook } from '@shared/model/factory'
import {
  appendToRich,
  hasFormatting,
  normalizeRich,
  plainTextOf,
  richFromPlain
} from '@shared/richtext'

import { DEFAULT_THEME } from '@shared/theme'
import { BLOCK_GAP, codeMinNodeSize } from '@shared/layout/accessory'
import type { Size } from '@shared/layout/types'
import { NODE_FONT_SIZES, nodePaddingOf } from '../render/measure'
import { formulaSize } from '../render/formula'
import {
  activeRoot,
  activeSheet,
  allChildrenOf,
  cloneTopicDeep,
  detachTopic,
  ensureExpanded,
  findParent,
  findTopic,
  flatten,
  childFoldSides,
  foldedSidesOf,
  isSelfOrDescendant,
  moveTopic,
  splitFoldSidesOf,
  withFoldedSides,
  type FoldSide
} from '@shared/model/tree'
import { buildRange, parseRange, readCurveOffset, withCurveOffset } from '@shared/layout'
import {
  reconcileMarkers,
  RELATIONSHIP_CURVE_KEY,
  TOPIC_SIDE_KEY,
  withMarkerToggled
} from '@shared/xmind/constants'
import { notesHtmlFrom } from '@shared/richtext'
import { resolveDrop } from '@shared/model/drop'
import {
  editingContent,
  liveSelection,
  pruneOverlays,
  sameRich,
  settleAfterMove,
  stampNodeDefaults,
  stampRichDefaults
} from '@shared/model/editor-pure'
import {
  clampSizeToContent,
  findOverlayByRange,
  findRelationshipBetween,
  mergeTopicContent,
  navigateTargetOf,
  normalizeImage,
  normalizeSizeOverride,
  orderChildren,
  renumberChildren,
  resolveKeyMove,
  selectReducer,
  selectionAfterDelete
} from '@shared/model/editor-ops'
import type { EditorState } from './slices/types'
import { createViewSlice } from './slices/view'
import { NO_EDITING } from './slices/types'
import { readPersistedViewLock } from './slices/view'
import type { HistoryEntry } from './slices/types'

/**
 * 公开面：`themeColorsOf` / `overlayToggleOf` 已下沉到 `@shared/model/editor-pure`。
 * 这里再导出一次，Canvas / export/index / ThemePanel / overlay-group 的调用点一行都不用改。
 */
export type { EditorState, SearchState } from './slices/types'
export { overlayToggleOf, themeColorsOf } from '@shared/model/editor-pure'

enablePatches()

import { createSearchSlice } from './slices/search'
import { createOutlineSlice } from './slices/outline'
const HISTORY_LIMIT = 200

/** 合并窗口：同一个 coalesceKey 在此时间内的连续操作算作一步 */
const COALESCE_WINDOW_MS = 1500

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
  ...createViewSlice(set, get, store),
  workbook: createWorkbook(),
  filePath: null,
  dirty: false,
  docSeq: 0,

  selection: [],
  ...NO_EDITING,
  renderEpoch: 0,
  clipboard: null,

  undoStack: [],
  redoStack: [],
  aiTurn: null,

  /* ------------------------------------------------------------------ */
  /* 文档                                                                */
  /* ------------------------------------------------------------------ */

  newDocument: () =>
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
      undoStack: [],
      redoStack: [],
      // 换文档时必须把 AI 回合状态清掉：它只在 commitAiTurn 里复位，
      // 而"AI 正在改这个文档时用户新建/打开了另一份"会让 aiTurn 一直留着，
      // 新文档里的 undo/redo 从此被静默挡住（Ctrl+Z 完全没反应）
      aiTurn: null,
      // 新文档：优先恢复用户上次的选择；从未动过开关才按「启动默认视角锁定」起手
      viewLock: readPersistedViewLock() ?? state.appSettings.defaultViewLock,
      selectedOverlay: null,
      zoom: 1,
      pan: { x: 0, y: 0 }
    })),

  loadDocument: (workbook, path) =>
    set((state) => ({
      // 界面只显示**第一张画布**（画布切换按钮已移除）：文件的其余画布原样保留在
      // workbook 里，保存时照旧写回，不会丢内容。
      workbook: { ...workbook, activeSheetId: workbook.sheets[0]?.id ?? workbook.activeSheetId },
      filePath: path,
      dirty: false,
      docSeq: state.docSeq + 1,
      selection: [],
      ...NO_EDITING,
      undoStack: [],
      redoStack: [],
      // 同 newDocument：换文档不能把上一个文档的 AI 回合带过来
      aiTurn: null,
      // 打开文档同样恢复上次的选择（与新建一致）
      viewLock: readPersistedViewLock() ?? state.appSettings.defaultViewLock,
      selectedOverlay: null,
      zoom: 1,
      pan: { x: 0, y: 0 }
    })),

  restoreDocument: (workbook) =>
    set((state) => ({
      workbook,
      // filePath 保持不动；标记为未保存，避免用户以为已经落盘
      dirty: true,
      docSeq: state.docSeq + 1,
      selection: [],
      ...NO_EDITING,
      // 恢复是一次大跨度替换，撤销栈对它没有意义（恢复前会自动存一份版本兜底）
      undoStack: [],
      redoStack: [],
      // 整份文档被替换掉了，进行中的 AI 回合同样作废（否则新状态下的撤销被挡住）
      aiTurn: null
    })),

  markSaved: (path) => set({ filePath: path, dirty: false }),

  /* ------------------------------------------------------------------ */
  /* 编辑                                                                */
  /* ------------------------------------------------------------------ */

  mutate: (recipe, label, coalesceKey) => {
    const { workbook, undoStack, selection: selectionBefore } = get()
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
      const merged: HistoryEntry = {
        label,
        patches,
        inverse: last.inverse,
        coalesceKey,
        time: now,
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
        { label, patches, inverse, coalesceKey, time: now, selectionBefore }
      ].slice(-HISTORY_LIMIT),
      redoStack: []
    })
    return true
  },

  beginAiTurn: () => {
    // 已经在回合里就别重入：同一份文档同时只允许一个 AI 回合
    if (get().aiTurn) return
    set({ aiTurn: { depth: get().undoStack.length, selectionBefore: get().selection } })
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
    const batch = undoStack.slice(turn.depth)
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

    set({
      aiTurn: null,
      undoStack: [
        ...undoStack.slice(0, turn.depth),
        { label, patches, inverse, time: Date.now(), selectionBefore: turn.selectionBefore }
      ].slice(-HISTORY_LIMIT),
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

  /* ------------------------------------------------------------------ */
  /* 选择与编辑态                                                        */
  /* ------------------------------------------------------------------ */

  select: (id, additive = false) => set((s) => selectReducer(s.selection, id, additive)),

  beginEdit: (id, insertText) => {
    const topic = findTopic(activeRoot(get().workbook), id)
    const base = topic?.titleRich
      ? normalizeRich(topic.titleRich)
      : richFromPlain(topic?.title ?? '')
    const rich = insertText ? appendToRich(base, insertText) : base
    set({ editingId: id, ...editingContent(rich), selection: [id] })
  },

  updateEditingText: (text) => set(editingContent(richFromPlain(text))),

  updateEditingRich: (rich) => set(editingContent(rich)),

  commitEdit: (forId) => {
    const { editingId, editingText, editingRich, workbook } = get()
    if (!editingId) return
    // 旧输入框失焦时可能已经切到了新节点，此时必须忽略这次提交
    if (forId !== undefined && forId !== editingId) return

    const topic = findTopic(activeRoot(workbook), editingId)
    const nextTitle = editingText
    const nextRich = editingRich ? normalizeRich(editingRich) : null
    // 「首次命名」＝新建节点第一次输入文字：给打的内容补上默认字体/字号/颜色。
    // 只认「原来标题为空」的节点——改老节点的文字绝不能突然被换样式。
    const firstNaming = topic !== null && topic.title === ''
    const stampedRich =
      nextRich && firstNaming ? stampRichDefaults(nextRich, get().appSettings) : nextRich
    const keepRich = stampedRich && hasFormatting(stampedRich) ? stampedRich : null

    set(NO_EDITING)
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

  cancelEdit: () => set(NO_EDITING),

  bumpRenderEpoch: () => set((state) => ({ renderEpoch: state.renderEpoch + 1 })),

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
    stampNodeDefaults(node, get().appSettings)
    get().mutate((draft) => {
      const target = findTopic(activeRoot(draft), parent.id) ?? activeRoot(draft)
      target.children.push(node)
      // 只在确实折叠着时才改：避免写入多余的 collapsed: false，
      // 否则「打开 → 另存」会因为默认值产生结构性差异
      ensureExpanded(target)
    }, '新建子主题')
    set({ selection: [node.id], editingId: node.id, ...editingContent(richFromPlain('')) })
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
    stampNodeDefaults(node, get().appSettings)
    get().mutate((draft) => {
      const draftParent = findTopic(activeRoot(draft), parent.id)
      if (!draftParent) return
      draftParent.children.splice(index < 0 ? draftParent.children.length : index + 1, 0, node)
    }, '新建同级主题')
    set({ selection: [node.id], editingId: node.id, ...editingContent(richFromPlain('')) })
    return node.id
  },

  deleteSelection: () => {
    // 选中的是画布元素（概要 / 边界 / 关系线）时，Delete 删的是它而不是主题
    const overlay = get().selectedOverlay
    if (overlay) {
      const state = get()
      if (overlay.kind === 'summary') state.removeSummary(overlay.id)
      else if (overlay.kind === 'boundary') state.removeBoundary(overlay.id)
      else state.removeRelationship(overlay.id)
      set({ selectedOverlay: null })
      return
    }

    const { workbook, selection } = get()
    const root = activeRoot(workbook)
    const targets = selection.filter((id) => id !== root.id && findTopic(root, id))
    if (targets.length === 0) return

    // 删完必须把选择落到一个**还存在**的主题上：否则选择指向"空"，
    // 方向键、Delete、Tab/Enter 全都失灵，用户只能先拿鼠标点一下才能继续用键盘
    // （这就是反馈里的「删除节点后选择失效，必须鼠标点击才能生效」）。
    // 落点顺序：原位置**之后**的下一个未删除兄弟 → **之前**的上一个 → 父级。
    const first = targets[0]
    if (!first) return
    const nextIds = selectionAfterDelete(root, first, targets)

    get().mutate((draft) => {
      const draftRoot = activeRoot(draft)
      for (const id of targets) detachTopic(draftRoot, id)
      // 指向已删除主题的关系线/边界/概要会变成悬空元素，必须一起清掉
      pruneOverlays(activeSheet(draft))
    }, '删除主题')
    set({
      selection: nextIds,
      ...NO_EDITING
    })
  },

  deleteTopic: (id) => {
    const { workbook } = get()
    const root = activeRoot(workbook)
    if (id === root.id || !findTopic(root, id)) return false

    const parent = findParent(root, id)
    // 真正能摘下来才动手：以前这里不检查，`detachTopic` 找不到（自由摆放的主题）
    // 也会走完整个流程并 `return true`——界面报"已删除"，树却没变
    const removable = parent !== null && allChildrenOf(parent).some((child) => child.id === id)
    if (!removable) return false

    get().mutate((draft) => {
      const draftRoot = activeRoot(draft)
      detachTopic(draftRoot, id)
      // 指向已删除主题的关系线/边界/概要会变成悬空元素，必须一起清掉
      pruneOverlays(activeSheet(draft))
    }, '删除主题')

    // 选择落在**被删节点的父级**上（不是随便挑一个），用户不会觉得焦点丢了；
    // 原本还选着的其它节点仍然保留
    const stillThere = get().selection.filter(
      (item) => item !== id && findTopic(activeRoot(get().workbook), item) !== null
    )
    set({
      selection: stillThere.length > 0 ? stillThere : parent ? [parent.id] : [],
      ...NO_EDITING
    })
    return true
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
    const topic = findTopic(activeRoot(get().workbook), id)
    if (!topic || topic.children.length === 0) return
    /**
     * 「**按侧收起**」也算折叠着：大纲那一行会显示成「展开」按钮（`outlineRows` 的
     * `collapsed` 判据是"有子节点但不是全部可见"），画布上 `Ctrl+/` 也是同一个入口。
     * 此时按一下必须**展开**（把按侧标记清掉），否则就是"提示写展开、点下去把两侧都收起来"——
     * 动作与提示相反，比不做还糟（真踩过）。
     */
    const folded = foldedSidesOf(topic)
    if (folded.length > 0 && !topic.collapsed) {
      get().setCollapsed(id, false)
      return
    }
    /**
     * 只有「**超过 1 个子主题**」才允许折叠（与 `TopicNode` 的徽标显示同一条规则）：
     * 只有一个子节点时折叠没有信息量，而且界面上已经不显示折叠徽标——
     * 这里不守卫的话，键盘（Ctrl + /）或 AI 仍能把折叠状态写进去，
     * 用户就会遇到"看不见任何徽标、图却少了一截"的怪状态。
     * 已折叠的主题总是可以展开（不然一个子节点的折叠状态就永远打不开了）。
     */
    if (!topic.collapsed && topic.children.length < 2) return
    get().setCollapsed(id, !topic.collapsed)
  },

  setCollapsed: (id, collapsed) => {
    const before = get()
    get().mutate(
      (draft) => {
        const topic = findTopic(activeRoot(draft), id)
        if (!topic || topic.children.length === 0) return
        // 用 undefined 表示展开，让模型中只存在「折叠 / 未设置」两种状态
        const next = collapsed ? true : undefined
        const hadFolded = foldedSidesOf(topic).length > 0
        // 按侧收起也算「折叠着」：只有它存在时，展开同样要落一步（否则点了没反应）
        if (topic.collapsed === next && !hadFolded) return
        topic.collapsed = next
        /**
         * 「整体折叠」与「按侧收起」互斥：两者的模型标记各存一处，
         * 不同时清掉就会出现「整体展开了、某一侧却还收着」这种读不懂的状态。
         */
        if (hadFolded) withFoldedSides(topic, [])
      },
      '折叠/展开',
      // 同一个主题、同一个方向的连续折叠（例如连按空格）合并成一步；
      // 方向一变就是新的一步——否则「折叠又展开」会被并成一次空操作，撤销看起来没反应
      `collapse:${id}:${collapsed ? 'fold' : 'unfold'}`
    )

    // 记下"刚折叠/展开的是谁"：画布拿它当镜头锚点（见 lastFold 的说明）
    set({ lastFold: { id, at: Date.now() } })

    // 折叠会把整棵子树**藏起来**：选中的主题若正在里面，它就从布局里消失了——
    // 视角锁定再也盯不到它，用户看到的是「锁定突然失效、画面不跟了」。
    // 把选择挪到折叠节点自己身上：既看得见，锁定也能继续跟。
    if (collapsed) {
      const root = activeRoot(before.workbook)
      if (before.selection.some((sel) => sel !== id && isSelfOrDescendant(root, id, sel))) {
        get().select(id)
      }
    }
  },

  setFoldSide: (id, side, folded) => {
    const before = get()
    get().mutate(
      (draft) => {
        const root = activeRoot(draft)
        const topic = findTopic(root, id)
        if (!topic) return
        // 只对「中心主题 + 两个方向都真的挂着分支」的结构生效（与 TopicNode 的多根徽标同一判据）
        if (splitFoldSidesOf(topic, topic.id === root.id).length < 2) return
        if (![...childFoldSides(topic).values()].includes(side)) return
        const current = foldedSidesOf(topic)
        // 已经是这个状态就什么都不写：AI 重试 / 重复点击不该产生撤销记录
        if (current.includes(side) === folded) return
        // 切到按侧收起模式：整体折叠标记要先清掉，否则整体折叠优先、这一侧点了没反应
        if (topic.collapsed) topic.collapsed = undefined
        const next: FoldSide[] = folded
          ? [...current, side]
          : current.filter((item) => item !== side)
        withFoldedSides(topic, next)
      },
      '折叠/展开',
      // 同一侧同一方向连续操作合并成一步；**方向或侧别一变就是新的一步**——
      // 否则「收起又展开」会被并成一次空操作，撤销看起来没反应（与 setCollapsed 同一套口径）
      `fold:${id}:${side}:${folded ? 'fold' : 'unfold'}`
    )

    // 与 setCollapsed 同一处理：刚折叠/展开的是谁，交给画布做镜头锚点
    set({ lastFold: { id, at: Date.now() } })

    /**
     * 收起后，落在这一侧的选中主题已经从布局里消失——视角锁定再也盯不到它。
     * 与整体折叠同一处理：把选择挪到中心主题身上（它一定看得见）。
     */
    const after = findTopic(activeRoot(get().workbook), id)
    if (!after || !foldedSidesOf(after).includes(side)) return
    const sides = childFoldSides(after)
    const hidden = after.children.filter((child) => sides.get(child.id) === side)
    const root = activeRoot(before.workbook)
    if (
      before.selection.some((sel) =>
        hidden.some((child) => isSelfOrDescendant(root, child.id, sel))
      )
    ) {
      get().select(id)
    }
  },

  toggleFoldSide: (id, side) => {
    const topic = findTopic(activeRoot(get().workbook), id)
    if (!topic) return
    get().setFoldSide(id, side, !foldedSidesOf(topic).includes(side))
  },

  setTopicSide: (id, side) => {
    get().mutate((draft) => {
      const root = activeRoot(draft)
      const topic = findTopic(root, id)
      if (!topic) return
      const properties: Record<string, string> = { ...(topic.style?.properties ?? {}) }
      const moved = properties[TOPIC_SIDE_KEY] !== side
      if (moved) {
        properties[TOPIC_SIDE_KEY] = side
        topic.style = { ...(topic.style ?? {}), properties }
      }
      /**
       * 拖到的那一侧如果正**收起着**，这个分支会当场消失（看着像把数据弄丢了）——
       * 刚挪过去的东西必须看得见，所以顺手把那一侧展开。
       * 与「新建子主题时自动展开」是同一条规矩。
       */
      if (!moved) return
      const parent = findParent(root, id)
      if (!parent) return
      const folded = foldedSidesOf(parent)
      if (folded.includes(side))
        withFoldedSides(
          parent,
          folded.filter((item) => item !== side)
        )
    }, '调整分支左右')
  },

  setSizeOverride: (id, size) => {
    const next = normalizeSizeOverride(size)
    get().mutate(
      (draft) => {
        const root = activeRoot(draft)
        const topic = findTopic(root, id)
        if (!topic) return
        if (!next) {
          if (topic.sizeOverride === undefined) return
          topic.sizeOverride = undefined
          return
        }
        // 兜底：框不能小于内容。代码块最小只能缩到缩放下限、公式是整块原子，
        // 任一方都按「内容尺寸 + 内边距」夹一下（渲染层的拉伸手柄也夹，双保险）
        let depth = 0
        let cursor = topic
        while (cursor) {
          const parent = findParent(root, cursor.id)
          if (!parent) break
          depth += 1
          cursor = parent
        }
        const padding = nodePaddingOf(depth)
        // 下标已经 clamp 在数组范围内
        const fontSize = NODE_FONT_SIZES[Math.min(depth, NODE_FONT_SIZES.length - 1)]!
        const mins: Size[] = []
        const codeMin = codeMinNodeSize(topic.code, padding)
        if (codeMin) mins.push(codeMin)
        // 公式块：宽度 = 公式宽 + 内边距；高度 = 公式高 + 一行标题 + 间隔 + 内边距
        // （这里拿不到排版行高，用 1.6 倍字号近似——渲染层手柄才是精确钳制，这里只防历史遗留的过小值）
        if (topic.formula) {
          const box = formulaSize(topic.formula, fontSize)
          mins.push({
            width: box.width + padding.x * 2,
            height: box.height + Math.round(fontSize * 1.6) + BLOCK_GAP + padding.y * 2
          })
        }
        const clamped = clampSizeToContent(next, mins)
        if (
          topic.sizeOverride?.width === clamped.width &&
          topic.sizeOverride?.height === clamped.height
        )
          return
        topic.sizeOverride = clamped
      },
      next ? '拉伸节点' : '恢复节点自动尺寸',
      // 拖动过程中每帧都写，合并成一步撤销
      next ? `size:${id}` : undefined
    )
  },

  moveSelectionByKey: (key) => {
    const state = get()
    const id = state.selection[0]
    if (!id) return false
    const root = activeRoot(state.workbook)
    const plan = resolveKeyMove(root, id, key)
    if (!plan) return false

    // 每次按键各记一步撤销，**刻意不合并**：移动是数组重排，
    // 合并两步的 inverse 会因为下标错位而改坏 children（见 moveNode 的说明）。
    return state.moveNode(id, plan.targetId, plan.index)
  },

  navigateSelection: (key) => {
    const state = get()
    const root = activeRoot(state.workbook)
    const selectedId = state.selection[0]
    const selected = selectedId ? findTopic(root, selectedId) : null
    // 选择可能已经失效（比如它刚被删掉、或撤销回到了另一个版本）→ 先把选择收回根，
    // 保证"键盘永远可用"，不再出现按了没反应、只能拿鼠标点一下的死状态。
    if (selectedId && !selected) set({ selection: [root.id] })
    const currentId = selected ? selected.id : root.id

    const target = navigateTargetOf(root, currentId, key)
    if (target) set({ selection: [target] })
  },

  setStructure: (structureClass) => {
    const root = activeRoot(get().workbook)
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), root.id)
      if (topic) topic.structureClass = structureClass
    }, '切换结构')
  },

  moveNode: (id, targetId, index) => {
    const root = activeRoot(get().workbook)
    if (id === root.id) return false
    if (isSelfOrDescendant(root, id, targetId)) return false
    const parent = findParent(root, id)
    // 同父级且没给插入位置 → 等于原地不动，直接忽略（避免产生空的撤销记录）。
    // 给了 index 才是「同级排序」，那是允许的。
    if (parent && parent.id === targetId && index === undefined) return false
    let ok = false
    get().mutate((draft) => {
      ok = moveTopic(activeRoot(draft), id, targetId, index)
      if (ok) settleAfterMove(draft, id)
    }, '移动主题')
    if (ok) set({ selection: [id] })
    return ok
  },

  moveNodes: (moves) => {
    const applied: Array<{ id: string; targetId: string }> = []
    get().mutate((draft) => {
      const draftRoot = activeRoot(draft)
      for (const move of moves) {
        // 与 moveNode 逐条调用时的准入规则完全一致，只是不再每条都清一遍覆盖层
        if (move.id === draftRoot.id) continue
        if (isSelfOrDescendant(draftRoot, move.id, move.targetId)) continue
        const parent = findParent(draftRoot, move.id)
        // 同父级、又没给插入位置 → 等于原地不动（与 moveNode 的规则一致）
        if (parent && parent.id === move.targetId && move.index === null) continue
        if (!moveTopic(draftRoot, move.id, move.targetId, move.index ?? undefined)) continue
        // 必须清掉自由摆放偏移：留着它节点会落在「自动位置 + 偏移」，
        // 看起来像「落点预览在这里、松手却跑到别处」（与 settleAfterMove 同理）
        const moved = findTopic(draftRoot, move.id)
        if (moved) moved.position = undefined
        applied.push({ id: move.id, targetId: move.targetId })
      }
      // 失效覆盖层只在这里清一次：pruneOverlays 只看最终树、结果幂等，
      // 所以终态与「每条都清一遍」等价，成本从 O(k×N) 降到 O(N + k)
      if (applied.length > 0) pruneOverlays(activeSheet(draft))
    }, '批量移动主题')
    // 逐条调用时每次都会把选中设成刚移动的那个，这里保留同一语义：落到最后一个成功的
    const last = applied[applied.length - 1]
    if (last) set({ selection: [last.id] })
    return applied
  },

  sortChildren: (parentId, orderedIds, renumber) => {
    get().mutate(
      (draft) => {
        const parent = findTopic(activeRoot(draft), parentId)
        if (!parent) return
        // 只按给定顺序排**还在的**子主题；没给到的（模型看不到的）保持原相对顺序、排在最后
        const ordered = orderChildren(parent.children, orderedIds)
        parent.children = ordered
        if (!renumber) return
        renumberChildren(ordered)
      },
      renumber ? '同级排序并编号' : '同级排序'
    )
  },

  mergeTopics: (groups) => {
    let merged = 0
    get().mutate((draft) => {
      const draftRoot = activeRoot(draft)
      for (const group of groups) {
        const keep = findTopic(draftRoot, group.keepId)
        if (!keep) continue
        for (const mergeId of group.mergeIds) {
          const loser = findTopic(draftRoot, mergeId)
          if (!loser || loser.id === keep.id) continue
          // 互为祖先时跳过（规划阶段已拦一道，这里是执行侧的最后一道）
          if (
            isSelfOrDescendant(draftRoot, keep.id, loser.id) ||
            isSelfOrDescendant(draftRoot, loser.id, keep.id)
          ) {
            continue
          }
          // 内容并入：保留方缺什么补什么（不覆盖它已有的内容）
          mergeTopicContent(keep, loser)

          // 子主题原样搬到保留方下面
          for (const child of [...loser.children]) {
            if (!moveTopic(draftRoot, child.id, keep.id, keep.children.length)) continue
            // 清掉自由摆放偏移：留着会落到"自动位置 + 偏移"的地方，看着像搬丢了
            const placed = findTopic(draftRoot, child.id)
            if (placed) placed.position = undefined
          }
          detachTopic(draftRoot, loser.id)
          merged += 1
        }
      }
      // 被删掉的主题可能挂着关系线/边界/概要：一并清掉悬空元素
      if (merged > 0) pruneOverlays(activeSheet(draft))
    }, '合并同名主题')
    return merged
  },

  dropNode: (id, targetId, mode) => {
    const root = activeRoot(get().workbook)
    // 与画布上的落点预览共用同一套裁决规则，避免"预览说这样、落下去却那样"
    const plan = resolveDrop(root, id, targetId, mode)
    if (!plan) return false

    if (plan.mode === 'child') {
      // 落进折叠的目标时顺手展开它，并和移动**合并成同一笔**：
      // 否则新加的子主题被藏起来看不见，而分成两笔又会让撤销要按两次。
      const ok = get().mutate((draft) => {
        const target = findTopic(activeRoot(draft), plan.targetId)
        if (target) ensureExpanded(target)
        moveTopic(activeRoot(draft), id, plan.targetId)
        settleAfterMove(draft, id)
      }, '移动主题')
      if (ok) set({ selection: [id] })
      return ok
    }

    // 同级插入：下标必须在「先把自己摘掉」的数组上算——
    // moveTopic 是先摘后插，若自己原本排在目标之前，用摘除前的下标
    // 插入会整体前移一位、落到错误的位置。
    const parent = findTopic(root, plan.parentId)
    if (!parent) return false
    const rest = parent.children.filter((child) => child.id !== id)
    const at = rest.findIndex((child) => child.id === targetId)
    if (at < 0) return false
    return get().moveNode(id, plan.parentId, plan.mode === 'before' ? at : at + 1)
  },

  offsetPosition: (id, dx, dy) => {
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      const base = topic.position ?? { x: 0, y: 0 }
      topic.position = { x: base.x + dx, y: base.y + dy }
    }, '移动位置')
  },

  offsetPositions: (moves) => {
    if (moves.length === 0) return
    get().mutate((draft) => {
      const root = activeRoot(draft)
      for (const move of moves) {
        const topic = findTopic(root, move.id)
        if (!topic) continue
        const base = topic.position ?? { x: 0, y: 0 }
        topic.position = { x: base.x + move.dx, y: base.y + move.dy }
      }
    }, '移动位置')
  },

  restoreAutoLayout: () => {
    const state = get()
    const root = activeRoot(state.workbook)
    const floating = flatten(root).filter((topic) => topic.position !== undefined)
    if (floating.length === 0) return 0

    /**
     * 范围规则：**选中里只要有自由摆放的主题，就只恢复这些**；否则整张画布一起恢复。
     *
     * 宁可这样也不做两个入口——只有一个按钮时，用户不会在"选中 vs 全部"之间猜；
     * 而"想只恢复一个"这件事本身就已经在手上有选择了，直接用它最自然。
     */
    const selected = state.selection.filter((id) => {
      const topic = findTopic(root, id)
      return topic !== null && topic.position !== undefined
    })
    const targets = selected.length > 0 ? selected : floating.map((topic) => topic.id)
    const scope = new Set(targets)

    get().mutate((draft) => {
      for (const topic of flatten(activeRoot(draft))) {
        if (scope.has(topic.id)) topic.position = undefined
      }
    }, '恢复自动布局')
    return targets.length
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
      ensureExpanded(target)
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
