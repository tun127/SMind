import { app, clipboard, ipcMain, shell } from 'electron'
import { isPlausibleFilePath } from '@shared/ipc-args'
import { logMain } from '../log'
import { randomUUID } from 'node:crypto'
import { promises as fs, existsSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'

import type { Workbook } from '@shared/model/types'

import { serializeXmind } from '@shared/xmind/serialize'

import { docOf, pruneForSave } from '../doc-resources'
import { copyDir } from '../autosave'
import type { MainContext } from '../context'
import { createWindow } from '../windows'

/**
 * 这些处理器原来都在 `main/index.ts` 的 `registerIpc()` 里，整块搬来：
 * 函数体、先后顺序、通道名逐字未改（搬迁只做剪切粘贴）。
 */
export function registerWindowIpc(ctx: MainContext): void {
  ipcMain.handle(IPC.openFilePending, async (e): Promise<string | null> => {
    const state = ctx.stateOf(e.sender)
    if (!state) return null
    const target = state.pendingPath
    state.pendingPath = null
    return target
  })

  /** 渲染进程报告「某个标签现在打开的是哪个文件」（新建＝null）：用于同文件不重复开窗/开标签 */
  ipcMain.on(IPC.documentPath, (e, docId: string, path: string | null) => {
    const state = ctx.stateOf(e.sender)
    if (!state || typeof docId !== 'string') return
    docOf(state, docId).docPath = typeof path === 'string' && path.length > 0 ? path : null
  })

  /** 释放一个文档（标签关闭）：丢掉它的资源表；自动存档槽位不归它管 */
  ipcMain.handle(IPC.releaseDoc, async (e, docId: string): Promise<void> => {
    const state = ctx.stateOf(e.sender)
    if (!state || typeof docId !== 'string') return
    state.docs.delete(docId)
  })

  /** 新建一个窗口（菜单「新建窗口」/ Ctrl+Shift+N） */
  ipcMain.handle(IPC.newWindow, async (): Promise<void> => {
    createWindow(ctx)
  })

  /**
   * 在新窗口打开**当前文档的副本**（并定位到指定画布）。
   *
   * 为什么是"副本"而不是"在同一份文件上再开一个窗口"：
   * 用户要的是"A 画布新建 B 画布，B 能自己导入/导出，**不影响 A**，两者互不影响"。
   * 两个窗口指向同一个文件时，谁后保存谁覆盖——那就谈不上互不影响了。
   * 所以这里把当前文档（含未保存改动与图片资源）写成一份**临时副本**，
   * 新窗口打开它但**不认路径**：保存时会走「另存为」，永远不会写回原文件。
   */
  ipcMain.handle(
    IPC.openSheetWindow,
    async (e, docId: string, workbook: Workbook): Promise<'ok' | 'failed'> => {
      const state = ctx.stateOf(e.sender)
      if (!state) return 'failed'
      try {
        await fs.mkdir(copyDir(), { recursive: true })
        const doc = typeof docId === 'string' ? docOf(state, docId) : null
        if (doc) pruneForSave(doc, workbook)
        const bytes = await serializeXmind({ workbook, resources: doc?.resources ?? {} })
        const copyPath = join(copyDir(), `${state.slot}-copy-${randomUUID()}.xmind`)
        await fs.writeFile(copyPath, Buffer.from(bytes))
        createWindow(ctx, { path: copyPath, copySource: copyPath })
        return 'ok'
      } catch (error) {
        /**
         * 失败要**留下可查的痕迹**：以前这里只有一个裸 `catch {}`，
         * 用户看到"新窗口打不开"、日志里什么都没有，只能靠猜。
         * 返回值仍是 'failed'（渲染层的契约不变），但主进程日志里有原因。
         */
        logMain('open-sheet-window-failed', (error as Error).message)
        return 'failed'
      }
    }
  )

  /**
   * 读系统剪贴板里的纯文本。
   * 渲染进程自己也读得到（navigator.clipboard），但那个 API 在没聚焦/无权限时会抛，
   * 走主进程更稳——粘贴 Markdown 片段要靠它。
   */
  ipcMain.handle(IPC.clipboardText, async (): Promise<string> => clipboard.readText())
  ipcMain.on(IPC.uiState, (e, message: unknown, stack: unknown, broken: unknown) => {
    const state = ctx.stateOf(e.sender)
    // 只有错误边界那种「整块界面已停止渲染」才算坏；异步错误不影响界面可用性，
    // 不能因此跳过关窗前的未保存确认
    if (state && broken === true) state.uiBroken = true
    const text = typeof message === 'string' ? message.slice(0, 2000) : ''
    const detail = typeof stack === 'string' ? stack.slice(0, 8000) : ''
    logMain('renderer-error', `${broken === true ? '[界面已停止渲染] ' : ''}${text}`, detail)
  })

  /** 由主进程刷新窗口：渲染层自己发的 location.reload 会被 will-navigate 拦下 */
  ipcMain.on(IPC.windowReload, (e) => {
    const state = ctx.stateOf(e.sender)
    if (state && !state.win.isDestroyed()) {
      state.uiBroken = false
      state.win.webContents.reload()
    }
  })

  ipcMain.on(IPC.confirmClose, (e) => {
    const state = ctx.stateOf(e.sender)
    if (!state) return
    state.allowClose = true

    if (ctx.isQuitRequested()) {
      // 退出流程：**所有**窗口都确认过（或已经不可用）才真的退
      const blocked = [...ctx.windows.values()].some(
        (item) => !item.allowClose && !item.win.webContents.isDestroyed()
      )
      if (!blocked) {
        ctx.approveQuit()
        app.quit()
        return
      }
      // 还有别的窗口没确认：这个窗口自己照样要关。
      // 以前这里无条件 return，于是「退出 → 取消 → 再点 X → 放弃修改」时
      // 窗口留在原地不动，用户以为程序卡死了（再点一次才关，且那次不再提示）。
    }
    if (!state.win.isDestroyed()) state.win.close()
  })

  /**
   * 未保存确认框里点了「取消」。
   *
   * `quitRequested` 是"退出流程进行中"的全局标记，只能在两处复位：
   * 真的退成（走 quitApproved），或者用户明确取消（这里）。
   * 以前没有这条回执，标记一直是真——之后每次关窗都进退出分支，
   * 那个分支看到"还有窗口没确认"就 return，窗口永远关不掉。
   */
  ipcMain.on(IPC.closeCancel, (e) => {
    const state = ctx.stateOf(e.sender)
    // 这个窗口并没有被允许关闭，标记也要退回去，否则下次点 X 会直接关窗、不再提示
    if (state) state.allowClose = false
    ctx.setQuitRequested(false)
  })

  ipcMain.on(IPC.setTitle, (e, title: string) => {
    const win = ctx.winOf(e.sender)
    if (win) win.setTitle(title)
  })

  ipcMain.handle(IPC.openExternal, async (_e, url: string): Promise<boolean> => {
    // 只放行安全协议，避免被诱导打开本地可执行文件
    if (typeof url !== 'string' || !/^(https?|mailto):/i.test(url.trim())) return false
    try {
      await shell.openExternal(url.trim())
      return true
    } catch {
      return false
    }
  })

  ipcMain.on(IPC.showInFolder, (_e, path: string) => {
    if (isPlausibleFilePath(path) && existsSync(path)) shell.showItemInFolder(path)
  })
}
