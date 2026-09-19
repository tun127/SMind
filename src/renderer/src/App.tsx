import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { activeRoot } from '@shared/model/tree'
import { defaultDocumentName, fileNameOf } from '@shared/model/naming'
import type { ExtractedDocument } from '@shared/document'
import { useAutosave } from './app/use-autosave'
import { useDocumentActions } from './app/use-document-actions'
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
import { type ThemeDefinition } from '@shared/theme'

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

  // 文件与多窗口动作（回调组；不含 effect，故放在这里不影响任何 effect 的声明顺序）
  const {
    commitPending,
    saveDocument,
    openDocument,
    openPath,
    restoreSnapshot,
    resolveTheme,
    onDefaultStyleChanged,
    handleSetDefaultTheme,
    newDocument,
    openNewWindow,
    openCopyWindow,
    openGeneratedInNewWindow,
    importTheme,
    exportOutlineAs,
    importOutlineFile
  } = useDocumentActions({ showToast, themesRef, applyRenderDefaults })

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

  useThemeLibrary({ resolveTheme, themesRef, applyRenderDefaults })

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
