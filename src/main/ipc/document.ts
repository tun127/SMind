import { ipcMain } from 'electron'
import { isPlausibleFilePath } from '@shared/ipc-args'
import { writeFileAtomic, writeJsonAtomic } from '../atomic-write'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { IPC, type OpenResult, type SaveResult } from '@shared/ipc'

import type { Workbook } from '@shared/model/types'

import { serializeXmind } from '@shared/xmind/serialize'
import { currentSaveDir } from '../history'

import { type RecoveryMeta } from '@shared/recovery'
import { showOpenIn, showSaveIn } from '../dialogs'
import { ensureXmindExt, firstPathOf, readDocumentInto, writeDocument } from '../files'
import { docOf, pruneForSave } from '../doc-resources'
import {
  autosaveDir,
  autosaveFile,
  autosaveMeta,
  latestAutosaveFile,
  latestAutosaveMeta,
  listAutosaveDocIds
} from '../autosave'
import { autosaveKeysToClear } from '@shared/recovery'
import type { MainContext } from '../context'
import { MINDMAP_EXTENSIONS } from '@shared/openfile'

/**
 * 这些处理器原来都在 `main/index.ts` 的 `registerIpc()` 里，整块搬来：
 * 函数体、先后顺序、通道名逐字未改（搬迁只做剪切粘贴）。
 */
/** ?????????????????????? id??clearAutosave ?????????????D-02? */
const lastAutosaveDocIds = new Map<string, string>()

export function registerDocumentIpc(ctx: MainContext): void {
  ipcMain.handle(IPC.openDialog, async (e, docId: string): Promise<OpenResult | null> => {
    const result = await showOpenIn(ctx.winOf(e.sender), {
      title: '打开思维导图',
      filters: [
        // .emmx 是亿图脑图（EdrawMind / MindMaster）的文件，能直接打开
        { name: '思维导图文件', extensions: [...MINDMAP_EXTENSIONS] },
        { name: 'Xmind 文件', extensions: ['xmind'] },
        { name: '亿图脑图文件', extensions: ['emmx', 'emm'] },
        { name: '全部文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    const file = firstPathOf(result)
    if (!file) return null
    return readDocumentInto(ctx.stateOf(e.sender), docId, file)
  })
  ipcMain.handle(IPC.openPath, async (e, docId: string, path: string): Promise<OpenResult> => {
    if (!isPlausibleFilePath(path)) throw new Error('文件路径无效，无法打开')
    return readDocumentInto(ctx.stateOf(e.sender), docId, path)
  })
  ipcMain.handle(
    IPC.saveToPath,
    async (e, docId: string, path: string, workbook: Workbook): Promise<SaveResult> => {
      // 写文件比读文件更值得拦：这条通道决定了"能往哪里写"
      if (!isPlausibleFilePath(path)) throw new Error('保存路径无效')
      return writeDocument(ctx.stateOf(e.sender), docId, ensureXmindExt(path), workbook)
    }
  )
  ipcMain.handle(
    IPC.saveAs,
    async (
      e,
      docId: string,
      workbook: Workbook,
      suggestedName: string
    ): Promise<SaveResult | null> => {
      // 默认落在记住的保存目录（首次是「文档/思维导图」）
      const dir = await currentSaveDir()
      const result = await showSaveIn(ctx.winOf(e.sender), {
        title: '另存为',
        defaultPath: join(dir, suggestedName),
        filters: [{ name: '思维导图文件', extensions: ['xmind'] }]
      })
      if (result.canceled || !result.filePath) return null
      return writeDocument(ctx.stateOf(e.sender), docId, ensureXmindExt(result.filePath), workbook)
    }
  )
  ipcMain.handle(
    IPC.autosave,
    async (
      e,
      docId: string,
      workbook: Workbook,
      originalPath: string | null,
      title: string
    ): Promise<void> => {
      const state = ctx.stateOf(e.sender)
      const doc = state && typeof docId === 'string' ? docOf(state, docId) : null
      if (!state) return
      await fs.mkdir(autosaveDir(), { recursive: true })
      if (doc) pruneForSave(doc, workbook)
      const bytes = await serializeXmind({ workbook, resources: doc?.resources ?? {} })
      // 存档也走原子写：半截的存档在恢复时会被判为损坏，等于白存一份
      // ? docId ??????????????????????? D-02?
      await writeFileAtomic(autosaveFile(state.slot, docId), bytes)
      lastAutosaveDocIds.set(state.slot, docId)
      const meta: RecoveryMeta = {
        originalPath: originalPath ?? null,
        title: title || '未命名导图',
        savedAt: Date.now()
      }
      // 元信息也要原子写：它是「这次自动保存对应哪份原稿」的唯一凭证，
      // 半截 JSON 会让恢复功能读不出标题与原路径（正文却好端端地在那儿）
      await writeJsonAtomic(autosaveMeta(state.slot, docId), meta)
      // ????????????????recovery.ts ???????????????
      await writeFileAtomic(latestAutosaveFile(state.slot), bytes)
      await writeJsonAtomic(latestAutosaveMeta(state.slot), meta)
    }
  )
  ipcMain.handle(IPC.autosaveClear, async (e, docId?: string): Promise<void> => {
    const state = ctx.stateOf(e.sender)
    if (!state) return
    /**
     * **只清这一份**。
     *
     * 以前这里不带参数、直接删掉整个窗口槽位，于是**任一标签保存一次**就会把同一窗口里
     * 别的标签的未保存存档一并删掉 —— 那正是报告 D-02 里「非激活标签崩溃不可恢复」的成因。
     * 现在走 `autosaveKeysToClear`：**没给 docId 就一份都不删**（fail-safe，漏改的调用点
     * 不会退化成"清全窗"）；关窗要清全部由 `main/windows.ts` 显式枚举每一份。
     */
    const targets = autosaveKeysToClear(await listAutosaveDocIds(state.slot), docId)
    if (targets.length === 0) return
    for (const key of targets) {
      await fs.rm(autosaveFile(state.slot, key), { force: true })
      await fs.rm(autosaveMeta(state.slot, key), { force: true })
    }
    // 「最近一份」副本只在它确实属于刚清掉的那份时才删（否则会破坏别的标签的恢复）
    if (lastAutosaveDocIds.get(state.slot) === docId) {
      await fs.rm(latestAutosaveFile(state.slot), { force: true })
      await fs.rm(latestAutosaveMeta(state.slot), { force: true })
    }
  })
}
