import { ipcMain } from 'electron'
import { logMain } from '../log'
import { promises as fs, existsSync } from 'node:fs'
import { IPC, type OpenResult, type RecoveryInfo } from '@shared/ipc'

import { parseXmind } from '@shared/xmind/parse'

import { shouldOfferRecovery } from '@shared/recovery'
import { DOC_ID_MAX, docOf } from '../doc-resources'
import { autosaveFile, autosaveMeta, readAutosaveMeta } from '../autosave'
import type { MainContext } from '../context'

/**
 * 这些处理器原来都在 `main/index.ts` 的 `registerIpc()` 里，整块搬来：
 * 函数体、先后顺序、通道名逐字未改（搬迁只做剪切粘贴）。
 */
export function registerRecoveryIpc(ctx: MainContext): void {
  ipcMain.handle(IPC.recoveryCheck, async (e): Promise<RecoveryInfo | null> => {
    const state = ctx.stateOf(e.sender)
    if (!state) return null
    // 只有本次进程的**第一个窗口**问恢复：否则每开一个窗口都弹一遍上一次的存档
    if (!ctx.isPrimaryWindow(state.id)) return null
    const meta = await readAutosaveMeta(state.slot)
    if (!meta || !existsSync(autosaveFile(state.slot))) return null

    let originalMtime: number | null = null
    if (meta.originalPath && existsSync(meta.originalPath)) {
      try {
        originalMtime = (await fs.stat(meta.originalPath)).mtimeMs
      } catch {
        originalMtime = null
      }
    }

    if (!shouldOfferRecovery(meta, originalMtime)) return null
    return { originalPath: meta.originalPath, title: meta.title, savedAt: meta.savedAt }
  })
  ipcMain.handle(IPC.recoveryLoad, async (e, docId: string): Promise<OpenResult | null> => {
    const state = ctx.stateOf(e.sender)
    if (!state || !existsSync(autosaveFile(state.slot))) return null
    // docId 会被当 map 键用（docOf）：加个长度上限，脏输入不该让主进程无界长胖
    if (typeof docId === 'string' && docId.length > DOC_ID_MAX) return null
    /**
     * **必须兜住异常**：要恢复的是自动保存的临时存档，它很可能正是上次断电/崩溃时写坏的那一份。
     * 以前这里没有 try/catch，`parseXmind` 一抛就把整个 IPC 变成 rejected——渲染层 `await` 直接炸，
     * 用户看到的是"启动提示可恢复 → 点恢复 → 满屏报错"，而正确处理是
     * "读不出来就当没有可恢复的存档"（返回 null，界面照常进空文档）。
     */
    try {
      const meta = await readAutosaveMeta(state.slot)
      const buf = await fs.readFile(autosaveFile(state.slot))
      const parsed = await parseXmind(new Uint8Array(buf))
      // 存档里同样带着图片/附件：不还原资源的话，恢复后一保存就全丢了。
      // 资源记到**恢复到的那份文档**名下（多标签之间互不沾染）
      if (typeof docId === 'string') {
        const doc = docOf(state, docId)
        doc.resources = parsed.resources
        doc.inserted.clear()
        doc.docPath = meta?.originalPath ?? null
      }
      return {
        path: meta?.originalPath ?? '',
        workbook: parsed.workbook,
        warnings: parsed.warnings,
        resourceCount: Object.keys(parsed.resources).length
      }
    } catch (error) {
      logMain('recovery-load-failed', (error as Error).message)
      return null
    }
  })
  ipcMain.handle(IPC.recoveryDiscard, async (e): Promise<void> => {
    const state = ctx.stateOf(e.sender)
    if (!state) return
    await fs.rm(autosaveFile(state.slot), { force: true })
    await fs.rm(autosaveMeta(state.slot), { force: true })
  })
}
