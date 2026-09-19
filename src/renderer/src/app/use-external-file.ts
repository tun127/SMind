import { useCallback, useEffect } from 'react'
import { useTabs } from '../store/tabs'
import type { useDocumentActions } from './use-document-actions'

/**
 * 从文件管理器打开本地文档（自 App.tsx 整块搬出，块体逐字未改）。
 *
 * 「标签为主」的语义保持原样：已经开着就切到那个标签，否则开新标签——都不动当前文档，
 * 所以不需要未保存确认。
 *
 * **调用点必须留在原来那条 effect 的位置上**（在 useMenuCommands 之后、useWindowClose 之前）：
 * 本 hook 只有这一条 effect，放在那里它在这份组件 effect 序列里的相对位置才与搬迁前一致。
 *
 * 依赖数组原样 [openPath, receiveExternalFile]：receiveExternalFile 仍是 useCallback，
 * 身份只随 openPath / showToast（两者都由参数进来）变化，重建时机不变。
 */

interface Deps {
  openPath: ReturnType<typeof useDocumentActions>['openPath']
  showToast(message: string): void
}

export function useExternalFile({ openPath, showToast }: Deps): void {
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
}
