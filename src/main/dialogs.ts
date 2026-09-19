import { dialog, type BrowserWindow } from 'electron'

/** 对话框挂在发起窗口上（多窗口下不能只认「主窗口」） */
export async function showOpenIn(
  win: BrowserWindow | null,
  options: Electron.OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue> {
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
}

export async function showSaveIn(
  win: BrowserWindow | null,
  options: Electron.SaveDialogOptions
): Promise<Electron.SaveDialogReturnValue> {
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
}
