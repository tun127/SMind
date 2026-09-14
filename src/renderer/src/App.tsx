import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { OpenResult, RecoveryInfo } from '@shared/ipc'
import type { OutlineFormat } from '@shared/outline'
import { activeRoot } from '@shared/model/tree'
import { defaultDocumentName, defaultFileName } from '@shared/model/naming'
import {
  inlineRunsToRich,
  looksLikeMarkdown,
  parseInlineMarkdown,
  parseMarkdownOutline
} from '@shared/import/markdown'
import { outlineToTopic, type OutlineNode } from '@shared/ai'
import { createWorkbookFromRoot } from '@shared/model/factory'
import { parseOpmlOutline } from '@shared/import/opml'
import Canvas from './components/Canvas'
import NodePanel from './components/NodePanel'
import OutlinePanel from './components/OutlinePanel'
import RichFormatBar from './components/RichFormatBar'
import SearchPanel from './components/SearchPanel'
import StatusBar from './components/StatusBar'
import ThemePanel from './components/ThemePanel'
import Toolbar from './components/Toolbar'
import { RecoveryDialog, ShortcutsDialog, UnsavedDialog } from './components/Dialogs'
import AiDialog, { type AiTask } from './components/AiDialog'
import AiSettingsDialog from './components/AiSettingsDialog'
import ExportDialog from './components/ExportDialog'
import HistoryDialog from './components/HistoryDialog'
import { viewportActions } from './render/viewport'
import { bumpMeasureEpoch } from './render/measure'
import { setDefaultTextAlign } from './render/defaults'
import { setCodeFontSizeBase } from '@shared/layout/accessory'
import { stageTypedChar } from './editor/typedChar'
import { patchAppSettings, snapshotForSave, useEditor } from './store/editor'
import { activeDocId, tabTitleOf, useTabs } from './store/tabs'
import TabBar from './components/TabBar'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/ipc'
import type { ThemeDefinition } from '@shared/theme'

/**
 * 把设置里的默认值送到渲染层并让测量缓存失效。
 * 对齐是段落级的兜底默认值（见 render/defaults.ts），改了必须重算测量。
 */
function applyRenderDefaults(settings: AppSettings): void {
  setDefaultTextAlign(settings.defaultAlign)
  // 代码块基准字号：布局测量 / 画布 / 导出共用（改了必须重算测量）
  setCodeFontSizeBase(settings.defaultCodeFontSize)
  bumpMeasureEpoch()
}

function fileNameOf(path: string | null): string | null {
  if (!path) return null
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

interface PastedImage {
  path: string
  width: number
  height: number
}

/**
 * 读取系统剪贴板里的图片。
 *
 * 优先走渲染进程的标准异步剪贴板 API（navigator.clipboard.read）——它读的就是
 * 系统剪贴板，截图 / 复制的图都能拿到；读不到（权限或实现差异）再退回
 * 主进程的 paste-image。两条路都没有图片就返回 null，由调用方按「粘贴节点」处理。
 */
async function readClipboardImage(): Promise<PastedImage | null> {
  try {
    const items = await navigator.clipboard.read()
    for (const item of items) {
      const mime = item.types.find((type) => type.startsWith('image/'))
      if (!mime) continue
      const blob = await item.getType(mime)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (bytes.byteLength === 0) continue
      const picked = await window.api.addImage(
        activeDocId(),
        mime === 'image/jpeg' ? '剪贴板图片.jpg' : '剪贴板图片.png',
        bytes
      )
      if (picked) return { path: picked.path, width: picked.width, height: picked.height }
    }
  } catch {
    /* 渲染进程读不到就走主进程 */
  }
  try {
    const picked = await window.api.pasteImage(activeDocId())
    return picked ? { path: picked.path, width: picked.width, height: picked.height } : null
  } catch {
    return null
  }
}

export default function App(): ReactElement {
  const filePath = useEditor((s) => s.filePath)
  const dirty = useEditor((s) => s.dirty)
  // 只订阅「中心主题的文字」这一个字符串：标题栏与默认文件名都跟着它变，又不至于每次改动都重渲染
  const rootTitle = useEditor((s) => activeRoot(s.workbook).title)
  // 工具栏收纳状态：右键「收进更多 ▾」后要立即反映到快捷栏与「更多」菜单
  const toolbarHidden = useEditor((s) => s.appSettings.toolbarHidden)

  const [toast, setToast] = useState<string | null>(null)
  const [recovery, setRecovery] = useState<RecoveryInfo | null>(null)
  /** 未保存确认：run＝确认后的动作；fileName＝被确认的文档名；discard＝「不保存」的额外动作 */
  const [pending, setPending] = useState<{
    run: () => void
    fileName: string
    discard?: () => void
  } | null>(null)
  const [showShortcuts, setShowShortcuts] = useState(false)
  /** 右侧抽屉：同一时刻只开一个 */
  const [sidePanel, setSidePanel] = useState<'none' | 'theme' | 'node' | 'search'>('none')
  /** 左侧大纲面板：与画布并排显示，改哪边另一边都跟着变 */
  const [showOutline, setShowOutline] = useState(false)
  /** 导出设置框 */
  const [showExport, setShowExport] = useState(false)
  /** AI 对话框：生成 / 扩写 / 润色 */
  const [aiTask, setAiTask] = useState<AiTask | null>(null)
  const [showAiSettings, setShowAiSettings] = useState(false)
  const themesRef = useRef<ThemeDefinition[]>([])
  /** 历史记录 / 常用 / 保存位置 */
  const [showHistory, setShowHistory] = useState(false)
  const toastTimer = useRef<number | null>(null)
  /** 是否还停在「发现未保存内容」这一步没做决定 */
  const recoveryPendingRef = useRef(false)

  const showToast = useCallback((message: string): void => {
    setToast(message)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 4600)
  }, [])

  /* ------------------------------------------------------------------ */
  /* 文件操作                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 先把「正在编辑但还没提交」的文本落定。
   * 否则 dirty 判断与实际内容不一致，会出现「刚打的字被无声丢掉」。
   */
  const commitPending = useCallback((): void => {
    const store = useEditor.getState()
    if (store.editingId) store.commitEdit()
  }, [])

  const saveDocument = useCallback(
    async (forceSaveAs = false): Promise<boolean> => {
      commitPending()
      const state = useEditor.getState()
      try {
        if (!state.filePath || forceSaveAs) {
          // 默认文件名用中心主题的名字（空标题才退回「未命名导图」）
          const suggested = state.filePath ?? defaultFileName(state.workbook, 'xmind')
          const result = await window.api.saveAs(activeDocId(), state.workbook, suggested)
          if (!result) return false
          useEditor.getState().markSaved(result.path)
          showToast(`已保存到 ${result.path}`)
        } else {
          await window.api.saveToPath(activeDocId(), state.filePath, state.workbook)
          useEditor.getState().markSaved(state.filePath)
          showToast('已保存')
        }
        await window.api.clearAutosave()
        return true
      } catch (err) {
        showToast(`保存失败：${(err as Error).message}`)
        return false
      }
    },
    [commitPending, showToast]
  )

  /** 把「打开结果」落成**一个标签**（对话框打开与历史记录打开共用一套收尾逻辑） */
  const openIntoTab = useCallback(
    async (result: OpenResult): Promise<void> => {
      const tabs = useTabs.getState()
      // 已经开着这个文件：直接切过去（多标签去重，不会同一文件开两份）
      if (!result.copy) {
        const existing = tabs.findByPath(result.path)
        if (existing) {
          tabs.switchTo(existing)
          showToast('这个文件已经开着，已帮你切换到那个标签')
          return
        }
      }
      // 副本没有磁盘归属：当成未保存的新文档（保存时会提示另存为），
      // 这样它跟原文档完全独立——导入/导出/保存都不会影响另一个画布
      tabs.openWorkbook(result.workbook, result.copy ? null : result.path)
      const messages: string[] = []
      if (result.resourceCount > 0) {
        messages.push(`已加载 ${result.resourceCount} 个图片/附件资源（保存时会一并写回）`)
      }
      if (result.warnings.length > 0) messages.push(...result.warnings)
      if (messages.length > 0) showToast(messages.join('；'))
    },
    [showToast]
  )

  const openDocument = useCallback(async (): Promise<void> => {
    commitPending()
    try {
      const result = await window.api.openDialog(activeDocId())
      if (!result) return
      await openIntoTab(result)
    } catch (err) {
      showToast(`打开失败：${(err as Error).message}`)
    }
  }, [commitPending, openIntoTab, showToast])

  /** 直接打开某个路径（历史记录里点一条、外部拖入/双击共用） */
  const openPath = useCallback(
    async (path: string): Promise<void> => {
      commitPending()
      try {
        await openIntoTab(await window.api.openPath(activeDocId(), path))
      } catch (err) {
        showToast(`打开失败：${(err as Error).message}`)
      }
    },
    [commitPending, openIntoTab, showToast]
  )

  /** 直接打开某个路径（历史记录里点一条走这里） */

  /**
   * 恢复到某个历史版本。
   *
   * 恢复前**先自动存一份「恢复前」的版本**：万一点错了还能再回来，
   * 这也是恢复动作不进撤销栈的安全网。
   */
  const restoreSnapshot = useCallback(
    async (snapshotId: string): Promise<void> => {
      commitPending()
      const store = useEditor.getState()

      try {
        await window.api.snapshotCreate(activeDocId(), {
          workbook: snapshotForSave(store),
          path: store.filePath,
          title: defaultDocumentName(store.workbook),
          reason: 'before-restore'
        })
      } catch {
        // 兜底版本存不上也要继续恢复，不能因此卡住用户
      }

      try {
        const result = await window.api.snapshotRestore(activeDocId(), snapshotId)
        useEditor.getState().restoreDocument(result.workbook)
        const messages = ['已恢复到所选版本（恢复前的状态也留了一份，可再切回）']
        if (result.resourceCount > 0) messages.push(`带回了 ${result.resourceCount} 个图片/附件资源`)
        if (result.warnings.length > 0) messages.push(...result.warnings)
        showToast(messages.join('；'))
      } catch (error) {
        showToast(`恢复失败：${(error as Error).message}`)
      }
    },
    [commitPending, showToast]
  )

  /**
   * 正常关闭应用。
   * 关键：关闭前必须清掉自动存档，否则「不保存退出」后下次启动还会反复提示恢复。
   * 但如果用户还停在「发现未保存内容」的弹窗上没有做决定，就不能悄悄删掉存档。
   */
  const closeApp = useCallback((): void => {
    const finish = (): void => window.api.confirmClose()
    if (recoveryPendingRef.current) {
      finish()
      return
    }
    void (async () => {
      try {
        await window.api.clearAutosave()
      } catch {
        /* 忽略：清不掉也不该阻塞关闭 */
      }
      finish()
    })()
  }, [])

  /* 启动时读一次应用设置与主题库：默认参数影响新建文档、主题下拉可选项 */
  useEffect(() => {
    void (async () => {
      try {
        const loaded = await window.api.settingsLoad()
        useEditor.getState().setAppSettings(loaded)
        applyRenderDefaults(loaded)
      } catch {
        /* 读不到就用内置默认值 */
      }
      try {
        themesRef.current = await window.api.themesList()
      } catch {
        themesRef.current = []
      }
    })()
  }, [])

  /**
   * 改「默认对齐 / 默认字体」这类渲染兜底值后，让测量缓存失效。
   * 设置值本身的写入与落盘统一走 `patchAppSettings`（各面板各自调用）。
   */
  const handleRenderDefaults = useCallback((next: AppSettings): void => {
    applyRenderDefaults(next)
  }, [])

  /** 「默认样式」改动后的统一收尾：渲染兜底值失效 */
  const onDefaultStyleChanged = useCallback((): void => {
    applyRenderDefaults(useEditor.getState().appSettings)
  }, [])

  /** 主题面板：把某个主题设为新文档的默认主题 */
  const handleSetDefaultTheme = useCallback(
    (themeId: string): void => {
      void patchAppSettings({ defaultThemeId: themeId }).then((next) => {
        applyRenderDefaults(next)
        showToast('已设为新文档的默认主题')
      })
    },
    [showToast]
  )

  const newDocument = useCallback((): void => {
    commitPending()
    // 新建＝开一个**新标签**：当前文档原样留在自己的标签里，不需要未保存确认
    useTabs.getState().newTab()
    // 新文档按「设置」里的默认主题起手（打开已有文件不动它自己的主题）
    const preferred = useEditor.getState().appSettings.defaultThemeId
    if (preferred) {
      const theme = themesRef.current.find((item) => item.id === preferred)
      if (theme) useEditor.getState().applyTheme({ id: theme.id, name: theme.name, colors: theme.colors })
    }
  }, [commitPending])

  /** 关闭一个标签（带未保存确认；确认文案里显示这份文档自己的名字） */
  const closeTabById = useCallback(
    (id: string): void => {
      commitPending()
      const tabs = useTabs.getState()
      const tab = tabs.tabs.find((item) => item.id === id)
      if (!tab) return
      const liveDirty = id === tabs.activeId ? useEditor.getState().dirty : tab.dirty
      const run = (): void => {
        useTabs.getState().closeTab(id)
        // 主进程丢掉这份文档的图片/附件资源（别的标签不受影响）
        void window.api.releaseDoc(id).catch(() => undefined)
      }
      if (liveDirty) {
        // 保存要保的是被关的那份：先把它切到前台再问
        if (id !== tabs.activeId) useTabs.getState().switchTo(id)
        setPending({ fileName: tabTitleOf(tab), run, discard: run })
        return
      }
      run()
    },
    [commitPending]
  )

  /** 有未保存内容时先弹确认框（先把未提交的输入落定，dirty 才准确） */
  const guard = useCallback(
    (run: () => void): void => {
      commitPending()
      if (useEditor.getState().dirty) {
        const state = useEditor.getState()
        const active = useTabs.getState().tabs.find((item) => item.id === useTabs.getState().activeId)
        setPending({ fileName: active ? tabTitleOf(active) : '当前文档', run })
      } else run()
    },
    [commitPending]
  )

  /* ------------------------------------------------------------------ */
  /* 多窗口（一个窗口 = 一份文档）                                        */
  /* ------------------------------------------------------------------ */

  /**
   * 开一个**新窗口**（一份新文档）。
   * 不需要未保存确认：新窗口是空的，不动当前文档。
   */
  const openNewWindow = useCallback((): void => {
    void window.api.newWindow()
  }, [])

  /**
   * 在**新窗口打开当前画布**（实际是这份文档的**副本**）。
   *
   * 副本完全独立：没有磁盘归属，导入/导出/保存都走自己的路，
   * **不会影响当前文档**——这就是"A 画布新建 B 画布、两者互不影响"的做法。
   * 因为副本是直接从内存里的文档序列化出来的（含未保存改动），不需要先保存。
   */
  const openCopyWindow = useCallback((): void => {
    commitPending()
    const store = useEditor.getState()
    void (async () => {
      const result = await window.api.openWorkbookInNewWindow(activeDocId(), store.workbook)
      showToast(
        result === 'ok'
          ? '已在新窗口打开副本：两边互不影响，保存时会让你另存为新文件'
          : '新窗口打开失败，请重试'
      )
    })()
  }, [commitPending, showToast])

  /**
   * AI「生成新导图」：在**新窗口**里成为一份独立文档（副本语义）。
   * 不往当前文档里塞内容——那会让用户觉得"当前导图被塞了东西"。
   */
  const openGeneratedInNewWindow = useCallback(
    (root: OutlineNode, title: string): void => {
      const workbook = createWorkbookFromRoot(outlineToTopic(root), title || 'AI 导图')
      void (async () => {
        const opened = await window.api.openWorkbookInNewWindow(activeDocId(), workbook)
        showToast(opened === 'ok' ? '已在新窗口生成一份独立导图' : '新窗口打开失败，请重试')
      })()
    },
    [showToast]
  )

  /* ------------------------------------------------------------------ */
  /* 导入 / 导出（工具栏与菜单共用）                                      */
  /* ------------------------------------------------------------------ */

  /** 导入主题文件（.json），存进「我的主题」 */
  const importTheme = useCallback(async (): Promise<void> => {
    try {
      const theme = await window.api.themesImport()
      if (!theme) return
      await window.api.themesSave(theme)
      showToast(`已导入主题「${theme.name}」，可在「主题外观」里选用`)
    } catch (error) {
      showToast(`导入主题失败：${(error as Error).message}`)
    }
  }, [showToast])

  /** 导出当前画布的大纲（TXT / Markdown / OPML） */
  const exportOutlineAs = useCallback(
    async (format: OutlineFormat): Promise<void> => {
      commitPending()
      try {
        const workbook = useEditor.getState().workbook
        const path = await window.api.exportOutline(workbook, format)
        if (path) showToast(`已导出大纲：${path}`)
      } catch (error) {
        showToast(`导出大纲失败：${(error as Error).message}`)
      }
    },
    [commitPending, showToast]
  )

  /**
   * 导入 Markdown / OPML 一键生成导图。
   * 解析逻辑在 shared 里（纯函数、有自检），这里只负责选文件、落地到新画布、给提示。
   */
  const importOutlineFile = useCallback(
    async (kind: 'markdown' | 'opml'): Promise<void> => {
      commitPending()
      try {
        const file = await window.api.importText(kind)
        if (!file) return

        const fallbackTitle = file.name.replace(/\.[^.]+$/, '') || '导入的大纲'
        const parsed =
          kind === 'markdown'
            ? parseMarkdownOutline(file.text, fallbackTitle)
            : parseOpmlOutline(file.text, fallbackTitle)

        if (!parsed.root) {
          showToast(`导入失败：${parsed.warnings.join('；') || '文件里没有可用的大纲'}`)
          return
        }

        // 导入＝在**新窗口**里成为一份独立文档：不往当前文档里塞内容，
        // 也就不会影响用户正在编辑的东西（保存时另存为新文件）
        const workbook = createWorkbookFromRoot(outlineToTopic(parsed.root), fallbackTitle)
        const opened = await window.api.openWorkbookInNewWindow(activeDocId(), workbook)
        const extra = parsed.warnings.length > 0 ? `（${parsed.warnings.join('；')}）` : ''
        showToast(
          opened === 'ok'
            ? `已在新窗口打开「${file.name}」导入的 ${parsed.count} 个主题${extra}`
            : '导入失败：新窗口没能打开'
        )
      } catch (error) {
        showToast(`导入失败：${(error as Error).message}`)
      }
    },
    [commitPending, showToast]
  )

  /* ------------------------------------------------------------------ */
  /* 菜单命令                                                            */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    const off = window.api.onMenuCommand((command) => {
      const store = useEditor.getState()
      switch (command) {
        case 'file:new':
          // 新标签不动当前文档，不需要未保存确认
          newDocument()
          break
        case 'file:open':
          void openDocument()
          break
        case 'file:save':
          void saveDocument(false)
          break
        case 'file:save-as':
          void saveDocument(true)
          break
        case 'file:open-sheet-window':
          openCopyWindow()
          break
        case 'edit:undo':
          store.undo()
          break
        case 'edit:redo':
          store.redo()
          break
        case 'edit:delete':
          store.deleteSelection()
          break
        case 'edit:copy':
          store.copySelection()
          break
        case 'edit:paste':
          store.paste()
          break
        case 'view:zoom-in':
          viewportActions.zoomTo(store.zoom * 1.2)
          break
        case 'view:zoom-out':
          viewportActions.zoomTo(store.zoom / 1.2)
          break
        case 'view:zoom-reset':
          viewportActions.zoomTo(1)
          break
        case 'view:fit':
          viewportActions.fit()
          break
        case 'view:lock':
          // 视角锁定：开着的时候视角始终把选中的主题按在视口正中
          showToast(
            store.toggleViewLock() ? '视角锁定：已开启，视角会跟住选中的主题' : '视角锁定：已关闭'
          )
          break
        case 'help:shortcuts':
          setShowShortcuts(true)
          break
        case 'file:import-theme':
          void importTheme()
          break
        case 'file:import-markdown':
          void importOutlineFile('markdown')
          break
        case 'file:import-opml':
          void importOutlineFile('opml')
          break
        case 'file:export-image':
          setShowExport(true)
          break
        case 'file:export-txt':
          void exportOutlineAs('txt')
          break
        case 'file:export-md':
          void exportOutlineAs('md')
          break
        case 'file:export-opml':
          void exportOutlineAs('opml')
          break
        case 'file:history':
          setShowHistory(true)
          break
        default:
          break
      }
    })
    return off
  }, [
    guard,
    newDocument,
    openDocument,
    saveDocument,
    importTheme,
    importOutlineFile,
    exportOutlineAs,
    openCopyWindow,
    showToast
  ])

  /**
   * 从文件管理器打开本地文档。
   *
   * - **启动时**（双击 `.xmind` / 把文件拖到 exe 上 / 右键「打开方式 → Mind」）：路径在命令行里，
   *   主进程替我们存着，这里就绪后取一次（取走即清空）；
   * - **窗口已经开着时**再打开一个：主进程通过 `fileOpenRequest` 推过来。
   *
   * 标签为主：已经开着就切到那个标签，否则开**新标签**——都不动当前文档，无需未保存确认。
   */
  const receiveExternalFile = useCallback(
    (path: string): void => {
      const tabs = useTabs.getState()
      const existing = tabs.findByPath(path)
      if (existing) {
        tabs.switchTo(existing)
        showToast('这个文件已经开着，已帮你切换到那个标签')
        return
      }
      void openPath(path)
    },
    [openPath, showToast]
  )

  useEffect(() => {
    void (async () => {
      const path = await window.api.openFilePending()
      if (!path) return
      void openPath(path)
    })()
    return window.api.onFileOpenRequest((path) => receiveExternalFile(path))
  }, [openPath, receiveExternalFile])

  /* ------------------------------------------------------------------ */
  /* 关闭窗口                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 退出前把**每个有未保存改动的标签**都问一遍（逐个切到前台询问），
   * 全部有了着落（保存 / 丢弃）才真正关闭窗口。
   */
  const forceCloseIds = useRef(new Set<string>())
  const closeWindowFlow = useCallback((): void => {
    commitPending()
    const tabs = useTabs.getState()
    const askThis = (fileName: string): void =>
      setPending({
        fileName,
        run: closeWindowFlow,
        discard: () => {
          forceCloseIds.current.add(useTabs.getState().activeId)
          closeWindowFlow()
        }
      })
    // 先问激活的（它就是屏幕上这份，用户最有概念）
    if (useEditor.getState().dirty && !forceCloseIds.current.has(tabs.activeId)) {
      const active = tabs.tabs.find((item) => item.id === tabs.activeId)
      askThis(active ? tabTitleOf(active) : '当前文档')
      return
    }
    // 再问其余脏标签（逐个切过去问）
    const nextDirty = tabs.tabs.find(
      (item) => item.dirty && item.id !== tabs.activeId && !forceCloseIds.current.has(item.id)
    )
    if (nextDirty) {
      tabs.switchTo(nextDirty.id)
      askThis(tabTitleOf(nextDirty))
      return
    }
    closeApp()
  }, [commitPending])

  useEffect(() => {
    const off = window.api.onCloseRequest(() => {
      forceCloseIds.current.clear()
      closeWindowFlow()
    })
    return off
  }, [closeWindowFlow])

  /* ------------------------------------------------------------------ */
  /* 自动保存                                                            */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    const timer = window.setInterval(() => {
      const store = useEditor.getState()
      if (!store.dirty) return
      // 用快照而不是直接落库：把正在输入但还没提交的文本也写进去，
      // 同时不打断用户的输入（不会退出编辑态）
      void window.api.autosave(
        activeDocId(),
        snapshotForSave(store),
        store.filePath,
        fileNameOf(store.filePath) ?? '未命名导图'
      )
    }, 30000)
    return () => window.clearInterval(timer)
  }, [])

  /* ------------------------------------------------------------------ */
  /* 自动版本快照                                                        */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    // 每 10 分钟留一个版本；内容与上一份相同（或距上次太近）时
    // 主进程会按内容指纹直接忽略，不会白写盘。
    // 只对「已保存过的文档」记录：还没有路径的文档由自动保存与崩溃恢复兜底。
    const timer = window.setInterval(() => {
      const store = useEditor.getState()
      if (!store.filePath) return
      void window.api
        .snapshotCreate(activeDocId(), {
          workbook: snapshotForSave(store),
          path: store.filePath,
          title: defaultDocumentName(store.workbook),
          reason: 'auto'
        })
        .catch(() => undefined)
    }, 600000)
    return () => window.clearInterval(timer)
  }, [])

  /* ------------------------------------------------------------------ */
  /* 崩溃恢复                                                            */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    void (async () => {
      try {
        const info = await window.api.recoveryCheck()
        if (info) {
          recoveryPendingRef.current = true
          setRecovery(info)
        }
      } catch {
        /* 忽略 */
      }
    })()
  }, [])

  const handleRestore = useCallback(async (): Promise<void> => {
    setRecovery(null)
    try {
      const result = await window.api.recoveryLoad(activeDocId())
      if (result) {
        useTabs.getState().openWorkbook(result.workbook, result.path || null)
        showToast('已恢复未保存的内容')
      }
    } catch (err) {
      // 存档读不出来（多半已损坏），清掉它，否则每次启动都会再问一次
      void window.api.recoveryDiscard()
      showToast(`恢复失败：${(err as Error).message}`)
    } finally {
      recoveryPendingRef.current = false
    }
  }, [showToast])

  const handleDiscardRecovery = useCallback((): void => {
    recoveryPendingRef.current = false
    setRecovery(null)
    void window.api.recoveryDiscard()
  }, [])

  /* ------------------------------------------------------------------ */
  /* 窗口标题                                                            */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    // 未保存过的新文件，标题也用中心主题的名字，和保存时的默认文件名保持一致
    const name = filePath
      ? (fileNameOf(filePath) ?? '未命名导图')
      : defaultDocumentName(useEditor.getState().workbook)
    window.api.setTitle(`${dirty ? '● ' : ''}${name} - SMind`)
    // 告诉主进程「这个标签开着哪个文件」：多标签/多窗口下双击同一个 .xmind 时，
    // 主进程会聚焦对应窗口，由渲染层切到那个标签（同一文件开两份会互相覆盖）
    window.api.reportDocument(activeDocId(), filePath)
    // rootTitle 参与依赖：改名后标题栏要立刻跟着变
  }, [filePath, dirty, rootTitle])

  /**
   * 画布上选中了画布元素（概要 / 边界 / 关系线）时把节点属性面板打开：
   * 它们的文字、字体、删除入口都在面板里，选中了却不给看，用户会以为"选中没生效"。
   */
  const nodePanelTick = useEditor((state) => state.nodePanelTick)
  useEffect(() => {
    if (nodePanelTick > 0) setSidePanel('node')
  }, [nodePanelTick])

  /* ------------------------------------------------------------------ */
  /* 键盘快捷键                                                          */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // 已经被内层处理掉的按键不再重复处理（例如富文本编辑器自己的快捷键）
      if (e.defaultPrevented) return
      // 输入法组词过程中的按键交给输入法处理
      if (e.isComposing || e.keyCode === 229) return

      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }

      const store = useEditor.getState()
      const selectedId = store.selection[0]

      /**
       * 仍在编辑态时（焦点可能因为点了底部格式栏而离开编辑器），**单键动作一律不接管**：
       * 否则"想输入空格"会被当成折叠主题、想输入字符会被当成删除/新建节点。
       * Ctrl 组合键（保存、撤销、搜索…）照旧放行。
       */
      if (store.editingId && !(e.ctrlKey || e.metaKey)) return

      // Alt+↑ / ↓：同级上移 / 下移（知犀的写法，和 Ctrl+Shift+方向键等价）
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        store.moveSelectionByKey(e.key)
        return
      }

      // Alt+C：给选中主题打开代码块编辑（面板聚焦到代码输入框）
      if (e.altKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault()
        if (selectedId) {
          setSidePanel('node')
          useEditor.getState().requestCodeFocus()
        }
        return
      }

      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase()
        if (key === 'z') {
          e.preventDefault()
          if (e.shiftKey) store.redo()
          else store.undo()
        } else if (key === 'y') {
          e.preventDefault()
          store.redo()
        } else if (key === 'c') {
          e.preventDefault()
          store.copySelection()
        } else if (key === 'v') {
          e.preventDefault()
          // 依次试：剪贴板图片 → 带 Markdown 标记的文本 → 内部复制的节点
          void (async () => {
            if (!store.editingId && selectedId) {
              const image = await readClipboardImage()
              if (image) {
                useEditor
                  .getState()
                  .setImage(selectedId, { path: image.path, width: image.width, height: image.height })
                showToast(
                  image.width > 0
                    ? `已把剪贴板图片贴到选中的主题（${image.width}×${image.height}）`
                    : '已把剪贴板图片贴到选中的主题（未取到像素尺寸，按默认大小显示）'
                )
                return
              }

              // 文本里带 Markdown 标记（`==高亮==`、`^上标^`、`A[^1]`…）→ 建成带格式的子主题。
              // 编辑器内粘贴由 RichTextEditor 自己处理；这里是"选中节点、没在编辑"时的路径。
              const text = await window.api.readClipboardText().catch(() => '')
              const lines = text
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line.length > 0 && looksLikeMarkdown(line))
              if (lines.length > 0) {
                const items = lines.map((line) => {
                  const inline = parseInlineMarkdown(line)
                  return { title: inline.text, rich: inlineRunsToRich(inline.runs) }
                })
                const count = useEditor.getState().addRichChildren(selectedId, items)
                showToast(`已按 Markdown 粘贴 ${count} 个带格式的子主题（可用 Ctrl+Z 撤回）`)
                return
              }
            }
            useEditor.getState().paste()
          })()
        } else if (key === 'f') {
          // Ctrl+F：打开搜索面板（与 Xmind 一致）
          e.preventDefault()
          setSidePanel('search')
        } else if (e.key === '/') {
          // Ctrl+/：折叠 / 展开。空格已经让给"直接输入空格"（选中后直接打字即进入编辑）
          e.preventDefault()
          if (selectedId) store.toggleCollapse(selectedId)
        } else if (
          // 编辑态里 Ctrl+Shift+方向键交给浏览器/编辑器（选词），不要去挪节点
          !store.editingId &&
          e.shiftKey &&
          (e.key === 'ArrowUp' ||
            e.key === 'ArrowDown' ||
            e.key === 'ArrowLeft' ||
            e.key === 'ArrowRight' ||
            e.key === 'Home' ||
            e.key === 'End')
        ) {
          // Ctrl+Shift+方向键：选中主题的精确移动（与亿图脑图一致）
          e.preventDefault()
          store.moveSelectionByKey(e.key)
        }
        return
      }

      switch (e.key) {
        case 'Tab':
          e.preventDefault()
          store.addChild(selectedId)
          break
        case 'Enter':
          e.preventDefault()
          store.addSibling(selectedId)
          break
        case 'F2':
          if (selectedId) {
            e.preventDefault()
            store.beginEdit(selectedId)
          }
          break
        case 'Delete':
        case 'Backspace':
          e.preventDefault()
          store.deleteSelection()
          break
        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowLeft':
        case 'ArrowRight':
          e.preventDefault()
          store.navigateSelection(e.key)
          break
        default:
          /**
           * 选中主题后**直接打字就进入编辑**（Xmind 的手感）。
           *
           * 两条防呆：
           * 1. 空格只用来"进入编辑"，**不落字**——输入法用空格选词、用户也可能只是
           *    习惯性按一下，在空白框里留下一个前导空格没有任何意义；
           * 2. 其它字符落字后**寄存**一笔（`stageTypedChar`）：它可能只是拼音的第一个
           *    字母（输入法组词时的第一个 keydown 完全看不出组词迹象），
           *    编辑器发现真正的组词开始后会把这个字符让给输入法，避免空框里冒出 `w` 这种怪字符。
           */
          if (selectedId && !e.altKey && e.key.length === 1) {
            e.preventDefault()
            if (e.key === ' ') {
              store.beginEdit(selectedId)
            } else {
              store.beginEdit(selectedId, e.key)
              stageTypedChar(selectedId, e.key)
            }
          }
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /* ------------------------------------------------------------------ */
  /* 拖拽图片文件到窗口：贴到选中的主题                                     */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    // 文档文件（.xmind 等）不拦：不 preventDefault，让 Chromium 的默认导航发生，
    // 主进程的 will-navigate 拦截器才能接住并走「打开文档」流程
    const DOCUMENT_RE = /\.(xmind|emmx|emm)$/i
    const pickImageFile = (files: FileList | null): File | null => {
      if (!files) return null
      for (const file of Array.from(files)) {
        if (DOCUMENT_RE.test(file.name)) return null // 混着文档时整体交给文档流程
        if (file.type.startsWith('image/') || /\.(png|jpe?g|gif|bmp|webp|svg|avif)$/i.test(file.name)) {
          return file
        }
      }
      return null
    }
    const onDragOver = (event: DragEvent): void => {
      if (pickImageFile(event.dataTransfer?.files ?? null)) event.preventDefault()
    }
    const onDrop = (event: DragEvent): void => {
      const file = pickImageFile(event.dataTransfer?.files ?? null)
      if (!file) return
      event.preventDefault()
      void (async () => {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const image = await window.api.addImage(activeDocId(), file.name, bytes)
          const store = useEditor.getState()
          const id = store.selection[0]
          if (!image || !id) {
            showToast('请先选中一个主题，再把图片拖进来')
            return
          }
          store.setImage(id, { path: image.path, width: image.width, height: image.height })
          showToast(
            image.width > 0
              ? `已插入图片 ${file.name}（${image.width}×${image.height}）`
              : `已插入图片 ${file.name}（未取到像素尺寸，按默认大小显示）`
          )
        } catch (error) {
          showToast(`插入图片失败：${(error as Error).message}`)
        }
      })()
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [showToast])

  /* ------------------------------------------------------------------ */

  const displayName = fileNameOf(filePath) ?? '未命名导图'

  return (
    <div className="app">
      <Toolbar
        outlineOpen={showOutline}
        hiddenItems={toolbarHidden}
        onToggleHidden={(id, hidden) => {
          const current = useEditor.getState().appSettings.toolbarHidden
          const next = hidden
            ? current.includes(id)
              ? current
              : [...current, id]
            : current.filter((item) => item !== id)
          void patchAppSettings({ toolbarHidden: next })
        }}
        actions={{
          onNew: () => newDocument(),
          onOpen: () => void openDocument(),
          onSave: () => void saveDocument(false),
          onSaveAs: () => void saveDocument(true),
          onHelp: () => setShowShortcuts(true),
          onThemes: () => setSidePanel((current) => (current === 'theme' ? 'none' : 'theme')),
          onNodes: () => setSidePanel((current) => (current === 'node' ? 'none' : 'node')),
          onOutline: () => setShowOutline((current) => !current),
          onSearch: () => setSidePanel((current) => (current === 'search' ? 'none' : 'search')),
          onRelayout: () => useEditor.getState().relayoutAll(),
          onFormula: () => {
            setSidePanel('node')
            useEditor.getState().requestFormulaFocus()
          },
          onCode: () => {
            setSidePanel('node')
            useEditor.getState().requestCodeFocus()
          },
          onExport: () => setShowExport(true),
          onImportTheme: () => void importTheme(),
          onImportMarkdown: () => void importOutlineFile('markdown'),
          onImportOpml: () => void importOutlineFile('opml'),
          onExportOutline: (format) => void exportOutlineAs(format),
          onAiGenerate: () => setAiTask('generate'),
          onAiExpand: () => setAiTask('expand'),
          onAiPolish: () => setAiTask('polish'),
          onAiSettings: () => setShowAiSettings(true),
          onHistory: () => setShowHistory(true),
          onNewWindow: openNewWindow,
          onOpenSheetWindow: openCopyWindow
        }}
      />

      <div className={showOutline ? 'app__body app__body--with-outline' : 'app__body'}>
        {showOutline && <OutlinePanel onClose={() => setShowOutline(false)} onNotify={showToast} />}
        <Canvas />
        {sidePanel === 'theme' && (
          <ThemePanel
            onClose={() => setSidePanel('none')}
            onNotify={showToast}
            onSetDefaultTheme={handleSetDefaultTheme}
          />
        )}
        {sidePanel === 'node' && <NodePanel onClose={() => setSidePanel('none')} onNotify={showToast} />}
        {sidePanel === 'search' && <SearchPanel onClose={() => setSidePanel('none')} onNotify={showToast} />}
      </div>

      {/* 仅在进入编辑态时出现；「默认样式」面板改渲染兜底值后要让测量缓存失效 */}
      <RichFormatBar onRenderDefaultsChanged={onDefaultStyleChanged} />

      {/* 底部多文档标签栏（浏览器式任务栏）：点标签切换文档 */}
      <TabBar onNewTab={() => newDocument()} onCloseTab={closeTabById} />

      <StatusBar />

      {recovery && (
        <RecoveryDialog
          info={recovery}
          onRestore={() => void handleRestore()}
          onDiscard={handleDiscardRecovery}
        />
      )}

      {pending && (
        <UnsavedDialog
          fileName={pending.fileName || displayName}
          onCancel={() => setPending(null)}
          onDiscard={() => {
            const action = pending
            setPending(null)
            // 关标签/退出的「不保存」：先做自己的收尾（标记强制关闭等），再继续流程
            if (action.discard) action.discard()
            else action.run()
          }}
          onSave={() => {
            const action = pending
            setPending(null)
            void saveDocument(false).then((ok) => {
              if (ok) action.run()
            })
          }}
        />
      )}

      {showShortcuts && <ShortcutsDialog onClose={() => setShowShortcuts(false)} />}

      {showExport && <ExportDialog onClose={() => setShowExport(false)} onNotify={showToast} />}

      {aiTask && (
        <AiDialog
          task={aiTask}
          onClose={() => setAiTask(null)}
          onNotify={showToast}
          onGenerateInNewWindow={openGeneratedInNewWindow}
        />
      )}

      {showAiSettings && (
        <AiSettingsDialog onClose={() => setShowAiSettings(false)} onNotify={showToast} />
      )}

      {showHistory && (
        <HistoryDialog
          onClose={() => setShowHistory(false)}
          onNotify={showToast}
          onOpenFile={(path) => void openPath(path)}
          onRestore={(snapshotId) => guard(() => void restoreSnapshot(snapshotId))}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
