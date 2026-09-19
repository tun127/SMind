import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { OpenResult } from '@shared/ipc'
import type { OutlineFormat } from '@shared/outline'
import { activeRoot } from '@shared/model/tree'
import { defaultDocumentName, defaultFileName, fileNameOf } from '@shared/model/naming'
import { parseMarkdownOutline } from '@shared/import/markdown'
import { outlineToTopic, type OutlineNode } from '@shared/ai'
import type { ExtractedDocument } from '@shared/document'
import { createWorkbookFromRoot } from '@shared/model/factory'
import { parseOpmlOutline } from '@shared/import/opml'
import { useAutosave } from './app/use-autosave'
import { useFileDrop } from './app/use-file-drop'
import { useKeyboardShortcuts } from './app/use-keyboard-shortcuts'
import { useMenuCommands } from './app/use-menu-commands'
import { useRecovery } from './app/use-recovery'
import { useThemeLibrary } from './app/use-theme-library'
import { useWindowTitle } from './app/use-window-title'
import Canvas from './components/Canvas'
import NodePanel from './components/NodePanel'
import OutlinePanel from './components/OutlinePanel'
import RichFormatBar from './components/RichFormatBar'
import SearchPanel from './components/SearchPanel'
import StatusBar from './components/StatusBar'
import ThemePanel from './components/ThemePanel'
import Toolbar from './components/Toolbar'
import { RecoveryDialog, ShortcutsDialog, UnsavedDialog } from './components/Dialogs'
import DocumentToMapDialog from './components/DocumentToMapDialog'
import ChatPanel from './components/ChatPanel'
import AiSettingsDialog from './components/AiSettingsDialog'
import ExportDialog from './components/ExportDialog'
import HistoryDialog from './components/HistoryDialog'
import { bumpMeasureEpoch } from './render/measure'
import { setDefaultTextAlign } from './render/defaults'
import { setCodeFontSizeBase } from '@shared/layout/accessory'
import { setStage } from './dev/stage'
import { patchAppSettings, snapshotForSave, useEditor } from './store/editor'
import { activeDocId, tabTitleOf, useTabs } from './store/tabs'
import TabBar from './components/TabBar'
import { type AppSettings } from '@shared/ipc'
import { BUILTIN_THEMES, type ThemeDefinition } from '@shared/theme'

/**
 * 把设置里的默认值送到渲染层并让测量缓存失效。
 * 对齐是段落级的兜底默认值（见 render/defaults.ts），改了必须重算测量。
 */
function applyRenderDefaults(settings: AppSettings): void {
  setDefaultTextAlign(settings.defaultAlign)
  // 代码块基准字号：布局测量 / 画布 / 导出共用（改了必须重算测量）
  setCodeFontSizeBase(settings.defaultCodeFontSize)
  bumpMeasureEpoch()
  // 光让缓存失效还不够：布局自身也要重跑，否则改了设置要等别的操作才生效
  useEditor.getState().bumpRenderEpoch()
}

export default function App(): ReactElement {
  const filePath = useEditor((s) => s.filePath)
  const dirty = useEditor((s) => s.dirty)
  // 只订阅「中心主题的文字」这一个字符串：标题栏与默认文件名都跟着它变，又不至于每次改动都重渲染
  const rootTitle = useEditor((s) => activeRoot(s.workbook).title)
  // 工具栏收纳状态：右键「收进更多 ▾」后要立即反映到快捷栏与「更多」菜单
  const toolbarHidden = useEditor((s) => s.appSettings.toolbarHidden)

  const [toast, setToast] = useState<string | null>(null)
  /** 未保存确认：run＝确认后的动作；fileName＝被确认的文档名；discard＝「不保存」的额外动作 */
  const [pending, setPending] = useState<{
    run: () => void
    fileName: string
    discard?: () => void
    /** 这次询问来自主进程的关窗/退出请求：点「取消」必须回执主进程（见 closeCancel） */
    windowClose?: boolean
  } | null>(null)
  const [showShortcuts, setShowShortcuts] = useState(false)
  /** 右侧抽屉：同一时刻只开一个 */
  const [sidePanel, setSidePanel] = useState<'none' | 'theme' | 'node' | 'search' | 'chat'>('none')
  /** 左侧大纲面板：与画布并排显示，改哪边另一边都跟着变 */
  const [showOutline, setShowOutline] = useState(false)
  /** 导出设置框 */
  const [showExport, setShowExport] = useState(false)
  /** 拖进来的文档：交给「按文档生成导图」对话框 */
  const [docToMap, setDocToMap] = useState<ExtractedDocument | null>(null)
  const [showAiSettings, setShowAiSettings] = useState(false)
  const themesRef = useRef<ThemeDefinition[]>([])
  /** 历史记录 / 常用 / 保存位置 */
  const [showHistory, setShowHistory] = useState(false)
  const toastTimer = useRef<number | null>(null)
  /** 是否还停在「发现未保存内容」这一步没做决定 */
  const recoveryPendingRef = useRef(false)

  /** 心跳的起点：界面挂载完成（之后各阶段由对应组件继续标记） */
  useEffect(() => {
    setStage('应用挂载完成')
  }, [])

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
        if (result.resourceCount > 0)
          messages.push(`带回了 ${result.resourceCount} 个图片/附件资源`)
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

  /**
   * 按 id 找主题。**内置表也要查**：
   * `themesList()` 返回的只有自定义主题，如果只查它，
   * 用户把内置主题设为默认时会静默失效——这正是「默认主题设置无效」的根因。
   */
  const resolveTheme = useCallback((id: string | null): ThemeDefinition | null => {
    if (!id) return null
    return (
      BUILTIN_THEMES.find((item) => item.id === id) ??
      themesRef.current.find((item) => item.id === id) ??
      null
    )
  }, [])

  useThemeLibrary({ resolveTheme, themesRef, applyRenderDefaults })

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
    // 新文档按「设置」里的默认主题起手（打开已有文件不动它自己的主题）。
    // 用 primeTheme 而不是 applyTheme：后者会写撤销历史并把新文档标成未保存。
    const theme = resolveTheme(useEditor.getState().appSettings.defaultThemeId)
    if (theme) useEditor.getState().primeTheme(theme)
  }, [commitPending, resolveTheme])

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
        const active = useTabs
          .getState()
          .tabs.find((item) => item.id === useTabs.getState().activeId)
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

  useMenuCommands({
    newDocument,
    openDocument,
    saveDocument,
    importTheme,
    importOutlineFile,
    exportOutlineAs,
    openCopyWindow,
    showToast,
    setShowShortcuts,
    setShowExport,
    setShowHistory
  })

  /**
   * 从文件管理器打开本地文档。
   *
   * - **启动时**（双击 `.xmind` / 把文件拖到 exe 上 / 右键「打开方式 → SMind」）：路径在命令行里，
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
        windowClose: true,
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
    // closeApp 是 settle 后的最终动作：漏了它这里会一直调用**首次渲染时**的那个闭包
  }, [commitPending, closeApp])

  useEffect(() => {
    const off = window.api.onCloseRequest(() => {
      forceCloseIds.current.clear()
      closeWindowFlow()
    })
    return off
  }, [closeWindowFlow])

  useAutosave({ showToast })

  const { recovery, handleRestore, handleDiscardRecovery } = useRecovery({
    recoveryPendingRef,
    showToast
  })

  useWindowTitle({ filePath, dirty, rootTitle })

  /**
   * 画布上选中了画布元素（概要 / 边界 / 关系线）时把节点属性面板打开：
   * 它们的文字、字体、删除入口都在面板里，选中了却不给看，用户会以为"选中没生效"。
   */
  const nodePanelTick = useEditor((state) => state.nodePanelTick)
  useEffect(() => {
    // 这是「响应 store 里的一个一次性信号」，不是从数据派生 UI：
    // 信号本身没有可比较的前后值，只能这样处理。用 disable 而不是硬凑成
    // 派生状态或 remount，是因为后者会把面板里其它状态一起丢掉。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (nodePanelTick > 0) setSidePanel('node')
  }, [nodePanelTick])

  useKeyboardShortcuts({ showToast, setSidePanel })

  useFileDrop({ showToast, setDocToMap })

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
          // 恢复自动布局：只恢复选中的自由摆放主题；没有这种选中就整张画布一起恢复。
          // 结果必须**说出来**——同一个按钮两种范围，用户得知道这次到底动了多少。
          onRelayout: () => {
            const restored = useEditor.getState().restoreAutoLayout()
            showToast(
              restored === 0
                ? '这张画布上没有自由摆放的主题'
                : `已把 ${restored} 个主题放回自动位置（可撤销）`
            )
          },
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
          onAiSettings: () => setShowAiSettings(true),
          onAiChat: () => setSidePanel((current) => (current === 'chat' ? 'none' : 'chat')),
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
        {sidePanel === 'node' && (
          <NodePanel onClose={() => setSidePanel('none')} onNotify={showToast} />
        )}
        {sidePanel === 'search' && (
          <SearchPanel onClose={() => setSidePanel('none')} onNotify={showToast} />
        )}
        {sidePanel === 'chat' && (
          <ChatPanel
            onClose={() => setSidePanel('none')}
            onOpenSettings={() => setShowAiSettings(true)}
            onBeforeAiWrite={() => {
              const store = useEditor.getState()
              // 撤销栈在内存里，崩溃就没了：AI 动手前先存一份盘上的（未保存的文档不进版本快照）
              if (!store.filePath) return
              void window.api
                .snapshotCreate(activeDocId(), {
                  workbook: snapshotForSave(store),
                  path: store.filePath,
                  title: defaultDocumentName(store.workbook),
                  reason: 'manual',
                  note: 'AI 动手前的自动存档'
                })
                .catch(() => undefined)
            }}
          />
        )}
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
          onCancel={() => {
            const action = pending
            setPending(null)
            // 关窗/退出流程里点「取消」：必须回执主进程。
            // 不回执的话主进程一直以为「退出流程还在进行」，之后每次关窗都走退出分支，
            // 那个分支看到"还有窗口没确认"就直接 return —— 窗口关不掉（点了放弃修改没反应）
            if (action.windowClose) window.api.closeCancel()
          }}
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

      {docToMap && (
        <DocumentToMapDialog
          document={docToMap}
          onClose={() => setDocToMap(null)}
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
