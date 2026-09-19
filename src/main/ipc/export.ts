import { app, BrowserWindow, ipcMain } from 'electron'
import { logMain } from '../log'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'

import type { Workbook } from '@shared/model/types'

import { buildOutline, outlineFormatDef, type OutlineFormat } from '@shared/outline'
import { defaultFileName } from '@shared/model/naming'

import { imageExportFormatDef, type ImageExportFormat } from '@shared/export/types'
import { showSaveIn } from '../dialogs'
import type { MainContext } from '../context'

/**
 * 这些处理器原来都在 `main/index.ts` 的 `registerIpc()` 里，整块搬来：
 * 函数体、先后顺序、通道名逐字未改（搬迁只做剪切粘贴）。
 */
export function registerExportIpc(ctx: MainContext): void {
  ipcMain.handle(
    IPC.exportOutline,
    async (e, workbook: Workbook, format: OutlineFormat): Promise<string | null> => {
      const def = outlineFormatDef(format)
      const content = buildOutline(workbook, format)

      const result = await showSaveIn(ctx.winOf(e.sender), {
        title: def.dialogTitle,
        // 默认文件名用中心主题的名字
        defaultPath: defaultFileName(workbook, def.ext),
        filters: [
          { name: def.label, extensions: [def.ext] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (result.canceled || !result.filePath) return null

      const target = result.filePath.toLowerCase().endsWith(`.${def.ext}`)
        ? result.filePath
        : `${result.filePath}.${def.ext}`
      await fs.writeFile(target, content, 'utf8')
      return target
    }
  )

  /* ---- 图片导出（P6） ---- */

  /**
   * 渲染进程负责排版与栅格化，这里只弹保存框、落盘。
   * SVG 是文本按 UTF-8 写，PNG/PDF 是字节按二进制写。
   */
  ipcMain.handle(
    IPC.saveExport,
    async (
      e,
      data: Uint8Array | string,
      fileName: string,
      ext: ImageExportFormat
    ): Promise<string | null> => {
      const def = imageExportFormatDef(ext)
      const result = await showSaveIn(ctx.winOf(e.sender), {
        title: `导出为 ${def.label}`,
        defaultPath: fileName || `思维导图.${def.ext}`,
        filters: [
          { name: def.label, extensions: [def.ext] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (result.canceled || !result.filePath) return null

      const target = result.filePath.toLowerCase().endsWith(`.${def.ext}`)
        ? result.filePath
        : `${result.filePath}.${def.ext}`

      if (typeof data === 'string') await fs.writeFile(target, data, 'utf8')
      else await fs.writeFile(target, Buffer.from(data))
      return target
    }
  )

  /**
   * SVG → **矢量 PDF**。
   *
   * 为什么放在主进程：渲染进程没有"打印"能力，而 `webContents.printToPDF` 正是
   * Chromium 的打印管线——文字是真字（可选中、可搜索）、图形是真矢量、中文交给系统字体。
   * 这正是位图 PDF 缺的三样（早期版本是"把画布栅格化后塞进 PDF 当图片"）。
   *
   * 三条硬性约束：
   * ① **失败一律返回 null**，由渲染层回落到位图 PDF——导出绝不能因为"想要矢量"而失败；
   * ② 内容先落到临时文件再 `loadFile`：导出的 SVG 里内嵌着图片与公式的 data URL，
   *    大文档下几百 KB 起步，走 `data:` URL 不稳；
   * ③ 页面尺寸按 CSS px 交给 `@page`，`preferCSSPageSize` 让它 1:1 对上导出坐标系
   *    （1px = 1/96 英寸），不需要再折算缩放。
   */
  async function svgToPdf(svg: string, width: number, height: number): Promise<Uint8Array | null> {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
      return null
    /**
     * Chromium 的页面尺寸上限是 200 英寸。超出就直接放弃（回落到位图），
     * 免得让用户等一次注定失败的转换。
     */
    const MAX_INCH = 190
    if (width / 96 > MAX_INCH || height / 96 > MAX_INCH) return null

    const pageWidth = Math.ceil(width)
    const pageHeight = Math.ceil(height)
    const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  /* 页面比内容多留 1px：正好相等时 Chromium 偶尔会多生成一张空白页 */
  @page { size: ${pageWidth + 1}px ${pageHeight + 1}px; margin: 0 }
  html, body { margin: 0; padding: 0; background: #ffffff; overflow: hidden }
  svg { display: block }
</style></head><body>${svg}</body></html>`

    /**
     * 临时 HTML 的文件名要**唯一**，不能只靠毫秒时间戳：
     * 连点两次导出、或同时导两份，同一毫秒内会撞名——后写的把前一份替换掉，
     * 于是"导出的 PDF 内容是另一张图"（或者 loadFile 读到一半被换掉）。
     */
    const tempPath = join(app.getPath('temp'), `smind-export-${randomUUID()}.html`)
    let win: BrowserWindow | null = null
    try {
      await fs.writeFile(tempPath, html, 'utf8')
      win = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: {
          // 这份内容完全由我们自己生成（SVG 字符串），关掉一切用不上的能力
          javascript: false,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      })
      await win.loadFile(tempPath)
      const buffer = await win.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        margins: { top: 0, bottom: 0, left: 0, right: 0 }
      })
      return new Uint8Array(buffer)
    } catch (error) {
      logMain('导出矢量 PDF 失败，回落到位图', error)
      return null
    } finally {
      if (win && !win.isDestroyed()) win.destroy()
      void fs.rm(tempPath, { force: true }).catch(() => undefined)
    }
  }

  ipcMain.handle(
    IPC.svgToPdf,
    async (_e, svg: string, width: number, height: number): Promise<Uint8Array | null> => {
      // 入参来自渲染进程：只做"是不是字符串/有限数字"这一层形状校验，
      // 真正的安全边界是"内容只被当成 SVG 渲染、且窗口没有任何权限"
      if (typeof svg !== 'string' || svg.length === 0 || svg.length > 64 * 1024 * 1024) return null
      return svgToPdf(svg, Number(width), Number(height))
    }
  )
}
