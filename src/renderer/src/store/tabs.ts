import { create } from 'zustand'
import { sameDocPath } from '@shared/window'
import { defaultDocumentName } from '@shared/model/naming'
import type { EditorState } from './editor'
import { useEditor } from './editor'

/**
 * 浏览器式多文档标签。
 *
 * 设计：`useEditor` 仍然是**当前激活文档**的唯一真相（编辑器 store 一行不改），
 * 本 store 只做一件事——**在标签里停放 / 恢复整份文档现场**：
 *
 * - 切走：把编辑器当前状态（workbook、撤销栈、视图、选中态…）拍成快照存回标签；
 * - 切入：把目标标签的快照整体灌回编辑器。
 *
 * 所以非激活标签的数据**不可能被改动**（编辑器里根本没有它），
 * 激活标签的实时状态永远以 `useEditor` 为准。
 */

/** 一份文档切换标签时需要带走的全部现场 */
type DocSnapshot = Pick<
  EditorState,
  | 'workbook'
  | 'filePath'
  | 'dirty'
  | 'docSeq'
  | 'selection'
  | 'selectedOverlay'
  | 'editingId'
  | 'editingText'
  | 'editingRich'
  | 'zoom'
  | 'pan'
  | 'viewLock'
  | 'undoStack'
  | 'redoStack'
>

export interface DocTab extends DocSnapshot {
  /** 稳定的文档 id：主进程按它隔离图片/附件资源（window.api.* 的第一个参数） */
  id: string
}

interface TabsState {
  /** 打开的标签（含激活的那个；永远至少有一个） */
  tabs: DocTab[]
  activeId: string
  /** 新建一个空白文档标签（不动当前文档，因此不需要未保存确认） */
  newTab(): void
  /** 把一份工作簿开成新标签；当前只有一个「空白未改动」标签时就地替换它 */
  openWorkbook(workbook: DocTab['workbook'], path: string | null): void
  /** 切换到某个标签 */
  switchTo(id: string): void
  /** 关闭标签；关掉最后一个时窗口留下，换一张空白文档 */
  closeTab(id: string): void
  /** 拖拽排序 */
  moveTab(from: number, to: number): void
  /** 某个文件是否已经开着（在哪个标签里），没开返回 null */
  findByPath(path: string): string | null
}

let docIdSeq = 0

/** 新的文档 id：同时是主进程资源隔离的钥匙 */
export function createDocId(): string {
  docIdSeq += 1
  return `doc-${Date.now().toString(36)}-${docIdSeq}`
}

/** 从编辑器当前状态拍快照（不改编辑器） */
function captureOf(id: string): DocTab {
  const s = useEditor.getState()
  return {
    id,
    workbook: s.workbook,
    filePath: s.filePath,
    dirty: s.dirty,
    docSeq: s.docSeq,
    selection: s.selection,
    selectedOverlay: s.selectedOverlay,
    editingId: s.editingId,
    editingText: s.editingText,
    editingRich: s.editingRich,
    zoom: s.zoom,
    pan: s.pan,
    viewLock: s.viewLock,
    undoStack: s.undoStack,
    redoStack: s.redoStack
  }
}

/** 把快照灌回编辑器（切换标签的「切入」半步） */
function applyToEditor(tab: DocTab): void {
  // docSeq 自增：画布在文档代次变化时会重新居中，切回来看一眼就该看到全貌
  const docSeq = useEditor.getState().docSeq + 1
  useEditor.setState({
    workbook: tab.workbook,
    filePath: tab.filePath,
    dirty: tab.dirty,
    docSeq,
    selection: tab.selection,
    selectedOverlay: tab.selectedOverlay,
    // 编辑态不跨标签恢复：切回来不该悬在半输入状态
    editingId: null,
    editingText: '',
    editingRich: null,
    zoom: tab.zoom,
    pan: tab.pan,
    viewLock: tab.viewLock,
    undoStack: tab.undoStack,
    redoStack: tab.redoStack
  })
}

/** 先把正在输入但没提交的文本落定（否则拍到的快照少最后一句话） */
function commitEditing(): void {
  const editor = useEditor.getState()
  if (editor.editingId) editor.commitEdit()
}

/** 标签上显示的名字：有文件用文件名，没有用中心主题名 */
export function tabTitleOf(tab: Pick<DocTab, 'filePath' | 'workbook'>): string {
  if (tab.filePath) {
    const parts = tab.filePath.split(/[\\/]/)
    const name = parts[parts.length - 1]
    if (name) return name
  }
  return defaultDocumentName(tab.workbook)
}

/** 当前激活文档的 id（window.api.* 调用方随手取用） */
export function activeDocId(): string {
  return useTabs.getState().activeId
}

const initialTab: DocTab = captureOf(createDocId())

export const useTabs = create<TabsState>()((set, get) => ({
  tabs: [initialTab],
  activeId: initialTab.id,

  newTab: () => {
    const { tabs, activeId } = get()
    commitEditing()
    // 当前激活文档的现场存回它的标签
    const parked =
      tabs.length > 0
        ? tabs.map((t) => (t.id === activeId ? { ...t, ...captureOf(t.id) } : t))
        : tabs
    // 编辑器换成全新文档，再把它拍成新标签
    useEditor.getState().newDocument()
    const fresh = captureOf(createDocId())
    set({ tabs: [...parked, fresh], activeId: fresh.id })
  },

  openWorkbook: (workbook, path) => {
    const { tabs, activeId } = get()
    commitEditing()
    // 「就地替换」的条件：只有一个标签，而且它是空白未改动的——
    // 浏览器打开第一个文件也不会给你留一个空标签
    const editor = useEditor.getState()
    const only = tabs[0]
    const singlePristine =
      tabs.length === 1 &&
      only !== undefined &&
      only.filePath === null &&
      !only.dirty &&
      editor.filePath === null &&
      !editor.dirty
    const parked = singlePristine
      ? []
      : tabs.map((t) => (t.id === activeId ? { ...t, ...captureOf(t.id) } : t))
    useEditor.getState().loadDocument(workbook, path)
    // 就地替换时沿用原标签的 id（主进程资源表里它已经登记过）
    const fresh = captureOf(singlePristine && only ? only.id : createDocId())
    set({ tabs: [...parked, fresh], activeId: fresh.id })
  },

  switchTo: (id) => {
    const { tabs, activeId } = get()
    if (id === activeId) return
    const target = tabs.find((t) => t.id === id)
    if (!target) return
    commitEditing()
    const parked = tabs.map((t) => (t.id === activeId ? { ...t, ...captureOf(t.id) } : t))
    applyToEditor(target)
    set({ tabs: parked, activeId: id })
  },

  closeTab: (id) => {
    const { tabs, activeId } = get()
    const rest = tabs.filter((t) => t.id !== id)
    if (rest.length === 0) {
      // 关掉最后一个标签：窗口留下，换成空白文档（与浏览器的「最后一个标签页」一致）
      commitEditing()
      useEditor.getState().newDocument()
      const fresh = captureOf(createDocId())
      set({ tabs: [fresh], activeId: fresh.id })
      return
    }
    if (id !== activeId) {
      set({ tabs: rest })
      return
    }
    // 关的是激活标签：切到相邻的（优先右边那个，与浏览器一致）
    const index = tabs.findIndex((t) => t.id === id)
    const next = rest[Math.min(index, rest.length - 1)]
    if (!next) return
    applyToEditor(next)
    set({ tabs: rest, activeId: next.id })
  },

  moveTab: (from, to) => {
    const { tabs } = get()
    if (from === to || from < 0 || from >= tabs.length) return
    const clamped = Math.max(0, Math.min(to, tabs.length - 1))
    const next = [...tabs]
    const [moved] = next.splice(from, 1)
    if (!moved) return
    next.splice(clamped, 0, moved)
    set({ tabs: next })
  },

  findByPath: (path) => {
    const { tabs, activeId } = get()
    // 激活标签的实时路径以编辑器为准（记录只在切走时落盘快照）
    const liveFilePath = useEditor.getState().filePath
    for (const t of tabs) {
      const filePath = t.id === activeId ? liveFilePath : t.filePath
      if (filePath !== null && sameDocPath(filePath, path)) return t.id
    }
    return null
  }
}))
