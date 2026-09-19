import { useEffect } from 'react'
import type { OutlineFormat } from '@shared/outline'
import { viewportActions } from '../render/viewport'
import { useEditor } from '../store/editor'

/**
 * 菜单命令（主进程 → 渲染层）：一条命令一句话，全部动作由 App 以 deps 传入。
 *（自 App.tsx 整块搬出，effect 体逐字未改；依赖数组里的回调原样保留。）
 */

interface Deps {
  newDocument(): void
  openDocument(): Promise<void>
  saveDocument(forceSaveAs?: boolean): Promise<boolean>
  importTheme(): Promise<void>
  importOutlineFile(kind: 'markdown' | 'opml'): Promise<void>
  exportOutlineAs(format: OutlineFormat): Promise<void>
  openCopyWindow(): void
  showToast(message: string): void
  setShowShortcuts(value: boolean): void
  setShowExport(value: boolean): void
  setShowHistory(value: boolean): void
}

export function useMenuCommands({
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
}: Deps): void {
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
  ])
}
