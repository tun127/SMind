import { ipcMain } from 'electron'
import { logMain } from '../log'
import { promises as fs, existsSync } from 'node:fs'
import { IPC, type OpenResult, type RecoveryInfo } from '@shared/ipc'

import { parseXmind } from '@shared/xmind/parse'

import { shouldOfferRecovery } from '@shared/recovery'
import { DOC_ID_MAX, docOf } from '../doc-resources'
import {
  autosaveFile,
  autosaveMeta,
  latestAutosaveFile,
  latestAutosaveMeta,
  listAutosaveDocIds,
  readAutosaveMeta
} from '../autosave'
import type { MainContext } from '../context'
import { autosaveKeysToClear } from '@shared/recovery'
import type { RecoveryList } from '@shared/ipc'

/**
 * 这些处理器原来都在 `main/index.ts` 的 `registerIpc()` 里，整块搬来：
 * 函数体、先后顺序、通道名逐字未改（搬迁只做剪切粘贴）。
 */
export function registerRecoveryIpc(ctx: MainContext): void {
  ipcMain.handle(IPC.recoveryCheck, async (e): Promise<RecoveryList> => {
    const state = ctx.stateOf(e.sender)
    const empty: RecoveryList = { items: [], total: 0 }
    if (!state) return empty
    // 只有本次进程的**第一个窗口**问恢复：否则每开一个窗口都弹一遍上一次的存档
    if (!ctx.isPrimaryWindow(state.id)) return empty
    /**
     * **逐份**判断：一个窗口开过几个标签就可能留下几份存档。
     * 以前只读「槽位那一份」，所以多标签时除最新那次以外的存档根本不出现在提示里（D-02）。
     */
    const items: RecoveryInfo[] = []
    for (const docId of await listAutosaveDocIds(state.slot)) {
      const meta = await readAutosaveMeta(state.slot, docId)
      if (!meta || !existsSync(autosaveFile(state.slot, docId))) continue

      let originalMtime: number | null = null
      if (meta.originalPath && existsSync(meta.originalPath)) {
        try {
          originalMtime = (await fs.stat(meta.originalPath)).mtimeMs
        } catch {
          originalMtime = null
        }
      }

      if (!shouldOfferRecovery(meta, originalMtime)) continue
      items.push({
        originalPath: meta.originalPath,
        title: meta.title,
        savedAt: meta.savedAt,
        docId
      })
    }
    /**
     * **兜底：升级前留下的旧存档**。
     *
     * 旧格式只叫 `slot-N.xmind`（就是现在的「最近一份」），它不在上面那轮 per-doc 枚举里 ——
     * 不做这一步，用户升级后第一次启动会**看不到**上次崩溃留下的未保存内容，
     * 等于把那份内容静默作废（报告 D-19，本次改动引入的兼容回归）。
     * 读侧 `recoveryLoad(docId, undefined)` 本来就支持读「最近一份」，缺的只是这一处。
     */
    if (items.length === 0) {
      const legacy = await readAutosaveMeta(state.slot, '')
      if (legacy && existsSync(latestAutosaveFile(state.slot))) {
        let legacyMtime: number | null = null
        if (legacy.originalPath && existsSync(legacy.originalPath)) {
          try {
            legacyMtime = (await fs.stat(legacy.originalPath)).mtimeMs
          } catch {
            legacyMtime = null
          }
        }
        if (shouldOfferRecovery(legacy, legacyMtime)) {
          items.push({
            originalPath: legacy.originalPath,
            title: legacy.title,
            savedAt: legacy.savedAt
          })
        }
      }
    }
    items.sort((a, b) => b.savedAt - a.savedAt)
    return { items, total: items.length }
  })
  ipcMain.handle(
    IPC.recoveryLoad,
    async (e, docId: string, savedDocId?: string): Promise<OpenResult | null> => {
      const state = ctx.stateOf(e.sender)
      if (!state) return null
      // 按**份**读：给了 savedDocId 就读它自己的文件，否则退回「最近一份」副本
      const file =
        typeof savedDocId === 'string' && savedDocId.length > 0
          ? autosaveFile(state.slot, savedDocId)
          : latestAutosaveFile(state.slot)
      if (!existsSync(file)) return null
      // docId 会被当 map 键用（docOf）：加个长度上限，脏输入不该让主进程无界长胖
      if (typeof docId === 'string' && docId.length > DOC_ID_MAX) return null
      /**
       * **必须兜住异常**：要恢复的是自动保存的临时存档，它很可能正是上次断电/崩溃时写坏的那一份。
       * 以前这里没有 try/catch，`parseXmind` 一抛就把整个 IPC 变成 rejected——渲染层 `await` 直接炸，
       * 用户看到的是"启动提示可恢复 → 点恢复 → 满屏报错"，而正确处理是
       * "读不出来就当没有可恢复的存档"（返回 null，界面照常进空文档）。
       */
      try {
        const meta = await readAutosaveMeta(state.slot, savedDocId ?? '')
        const buf = await fs.readFile(file)
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
    }
  )
  ipcMain.handle(IPC.recoveryDiscard, async (e, savedDocId?: string): Promise<void> => {
    const state = ctx.stateOf(e.sender)
    if (!state) return
    const keys = await listAutosaveDocIds(state.slot)
    // 不传 savedDocId = 丢掉本窗口**全部**自动存档（用户选"不恢复"，以及关窗路径）
    const targets =
      typeof savedDocId === 'string' && savedDocId.length > 0
        ? autosaveKeysToClear(keys, savedDocId)
        : keys
    for (const key of targets) {
      await fs.rm(autosaveFile(state.slot, key), { force: true })
      await fs.rm(autosaveMeta(state.slot, key), { force: true })
    }
    await fs.rm(latestAutosaveFile(state.slot), { force: true })
    await fs.rm(latestAutosaveMeta(state.slot), { force: true })
  })
}
