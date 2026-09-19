import type { Dispatch, SetStateAction } from 'react'
import type { ToolbarActions } from '../components/Toolbar'
import { patchAppSettings, useEditor } from '../store/editor'
import type { SidePanelId } from './app-side-panels'
import type { useDocumentActions } from './use-document-actions'

/**
 * 工具栏的两个 prop（自 App.tsx 整块搬出，块体逐字未改）：
 * 「收纳 / 移回某个快捷栏功能」与全部按钮动作对象；App 里的调用点只剩按名字解构。
 *
 * **身份行为一字未改（红线）**：两者搬迁前在 JSX 里就是每次渲染新建的函数字面量 / 对象字面量，
 * 搬进本 hook 后仍是——这里**不缓存任何东西**，刻意不包 useCallback / useMemo，
 * 也不把每渲染新建的闭包列进别的依赖数组。包了会改变 Toolbar 收到的 prop 身份，
 * 可能改变它的重渲染行为，那属于行为改动，本批不做。
 *
 * 唯一改写：外层包装从 JSX prop（onToggleHidden={...} / actions={{...}}）变成语句，
 * 并补上参数与返回类型注解（搬迁前靠 Toolbar 的 prop 类型做上下文推断）。
 */

interface Deps extends Pick<
  ReturnType<typeof useDocumentActions>,
  | 'newDocument'
  | 'openDocument'
  | 'saveDocument'
  | 'importTheme'
  | 'importOutlineFile'
  | 'exportOutlineAs'
  | 'openNewWindow'
  | 'openCopyWindow'
> {
  showToast(message: string): void
  setShowShortcuts: Dispatch<SetStateAction<boolean>>
  setSidePanel: Dispatch<SetStateAction<SidePanelId>>
  setShowOutline: Dispatch<SetStateAction<boolean>>
  setShowExport: Dispatch<SetStateAction<boolean>>
  setShowAiSettings: Dispatch<SetStateAction<boolean>>
  setShowHistory: Dispatch<SetStateAction<boolean>>
}

interface Api {
  onToggleHidden(id: string, hidden: boolean): void
  actions: ToolbarActions
}

export function useToolbarActions({
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
}: Deps): Api {
  const onToggleHidden = (id: string, hidden: boolean): void => {
    const current = useEditor.getState().appSettings.toolbarHidden
    const next = hidden
      ? current.includes(id)
        ? current
        : [...current, id]
      : current.filter((item) => item !== id)
    void patchAppSettings({ toolbarHidden: next })
  }

  const actions: ToolbarActions = {
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
  }

  return { onToggleHidden, actions }
}
