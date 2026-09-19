import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { activeRoot } from '@shared/model/tree'
import { fileNameOf } from '@shared/model/naming'
import type { ExtractedDocument } from '@shared/document'
import { AppDialogs } from './app/app-dialogs'
import { AppSidePanels } from './app/app-side-panels'
import { useAutosave } from './app/use-autosave'
import { useDocumentActions } from './app/use-document-actions'
import { useExternalFile } from './app/use-external-file'
import { useFileDrop } from './app/use-file-drop'
import { useKeyboardShortcuts } from './app/use-keyboard-shortcuts'
import { useMenuCommands } from './app/use-menu-commands'
import { useRecovery } from './app/use-recovery'
import { useThemeLibrary } from './app/use-theme-library'
import { useToolbarActions } from './app/use-toolbar-actions'
import { useWindowClose } from './app/use-window-close'
import { useWindowTitle } from './app/use-window-title'
import RichFormatBar from './components/RichFormatBar'
import StatusBar from './components/StatusBar'
import Toolbar from './components/Toolbar'
import { bumpMeasureEpoch } from './render/measure'
import { setDefaultTextAlign } from './render/defaults'
import { setCodeFontSizeBase } from '@shared/layout/accessory'
import { setStage } from './dev/stage'
import { useEditor } from './store/editor'
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

  useThemeLibrary({ resolveTheme, themesRef, applyRenderDefaults })

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

  /* ------------------------------------------------------------------ */
  /* 外部文件打开：整块在 app/use-external-file.ts（调用点＝原 effect 的位置） */
  /* ------------------------------------------------------------------ */
  useExternalFile({ openPath, showToast })

  /* ------------------------------------------------------------------ */
  /* 关闭窗口                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 关窗链路（未保存确认 / 逐个标签询问 / 取消后回执主进程）整块在 `app/use-window-close.ts`。
   *
   * **调用点必须留在原来那条 `onCloseRequest` effect 的位置上**：hook 内只有这一条 effect，
   * 放在这里，它在这份组件 effect 序列里的相对位置才与搬迁前一致（别挪到 `pending` 原来的位置去）。
   */
  const { pending, setPending, closeTabById, guard } = useWindowClose({
    commitPending,
    recoveryPendingRef
  })

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

  /* 工具栏的两个 prop 整块在 app/use-toolbar-actions.ts（仍是每渲染新建的函数/对象） */
  const { onToggleHidden, actions } = useToolbarActions({
    newDocument,
    openDocument,
    saveDocument,
    importTheme,
    importOutlineFile,
    exportOutlineAs,
    openNewWindow,
    openCopyWindow,
    showToast,
    setShowShortcuts,
    setSidePanel,
    setShowOutline,
    setShowExport,
    setShowAiSettings,
    setShowHistory
  })

  const displayName = fileNameOf(filePath) ?? '未命名导图'

  return (
    <div className="app">
      <Toolbar
        outlineOpen={showOutline}
        hiddenItems={toolbarHidden}
        onToggleHidden={onToggleHidden}
        actions={actions}
      />

      <AppSidePanels
        showOutline={showOutline}
        setShowOutline={setShowOutline}
        sidePanel={sidePanel}
        setSidePanel={setSidePanel}
        showToast={showToast}
        handleSetDefaultTheme={handleSetDefaultTheme}
        setShowAiSettings={setShowAiSettings}
      />

      {/* 仅在进入编辑态时出现；「默认样式」面板改渲染兜底值后要让测量缓存失效 */}
      <RichFormatBar onRenderDefaultsChanged={onDefaultStyleChanged} />

      {/* 底部多文档标签栏（浏览器式任务栏）：点标签切换文档 */}
      <TabBar onNewTab={() => newDocument()} onCloseTab={closeTabById} />

      <StatusBar />

      <AppDialogs
        recovery={recovery}
        handleRestore={handleRestore}
        handleDiscardRecovery={handleDiscardRecovery}
        pending={pending}
        setPending={setPending}
        displayName={displayName}
        saveDocument={saveDocument}
        showShortcuts={showShortcuts}
        setShowShortcuts={setShowShortcuts}
        showExport={showExport}
        setShowExport={setShowExport}
        showToast={showToast}
        docToMap={docToMap}
        setDocToMap={setDocToMap}
        openGeneratedInNewWindow={openGeneratedInNewWindow}
        showAiSettings={showAiSettings}
        setShowAiSettings={setShowAiSettings}
        showHistory={showHistory}
        setShowHistory={setShowHistory}
        openPath={openPath}
        guard={guard}
        restoreSnapshot={restoreSnapshot}
        toast={toast}
      />
    </div>
  )
}
