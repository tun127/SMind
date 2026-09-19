import { existsSync } from 'node:fs'
import { ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc'
import { isPlausibleFilePath } from '@shared/ipc-args'
import type { HistoryEntry } from '@shared/history'
import {
  clearAllHistory,
  currentSaveDir,
  listHistory,
  rememberSaveDir,
  removeEntry,
  togglePin
} from '../history'
import { showOpenIn } from '../dialogs'
import { firstPathOf } from '../files'
import type { MainContext } from '../context'

/**
 * 历史记录与常用（P9+）：打开过的文件列表、常用标记、默认保存位置。
 *
 * 这一域没有自己的可变状态——记录本身落在磁盘（`./history`），
 * 唯一要经 `ctx` 取的是「对话框挂哪个窗口」（多窗口下不能只认主窗口）。
 */
export function registerHistoryIpc(ctx: MainContext): void {
  ipcMain.handle(IPC.historyList, async (): Promise<HistoryEntry[]> => listHistory())

  ipcMain.handle(IPC.historyTogglePin, async (_e, path: string): Promise<HistoryEntry[]> =>
    togglePin(path)
  )

  ipcMain.handle(IPC.historyRemove, async (_e, path: string): Promise<HistoryEntry[]> =>
    removeEntry(path)
  )

  ipcMain.handle(IPC.historyClear, async (): Promise<HistoryEntry[]> => clearAllHistory())

  ipcMain.handle(IPC.historySaveDir, async (): Promise<string> => currentSaveDir())

  ipcMain.handle(IPC.historyChooseSaveDir, async (e): Promise<string | null> => {
    const result = await showOpenIn(ctx.winOf(e.sender), {
      title: '选择默认保存位置',
      defaultPath: await currentSaveDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    const dir = firstPathOf(result)
    return dir ? rememberSaveDir(dir) : null
  })

  ipcMain.handle(IPC.historyReveal, async (_e, path: string): Promise<void> => {
    if (isPlausibleFilePath(path) && existsSync(path)) shell.showItemInFolder(path)
  })
}
