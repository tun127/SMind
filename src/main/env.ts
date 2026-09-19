import { app } from 'electron'
import { join } from 'node:path'

/** 应用名：与 electron-builder 的 productName、窗口标题保持一致 */
export const APP_NAME = 'SMind'

/**
 * 开发模式下的窗口/任务栏图标（打包后由 exe 自带图标，不需要它）。
 * 用 existsSync 判断：打包后这个路径不存在，直接跳过而不是报错。
 */
export const devIconFile = join(__dirname, '../../build/icon.png')

export const isDev = !app.isPackaged
