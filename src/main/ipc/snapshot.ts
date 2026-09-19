import { ipcMain } from 'electron'
import { IPC, type SnapshotRestoreResult } from '@shared/ipc'

import type { Workbook } from '@shared/model/types'

import { parseXmind } from '@shared/xmind/parse'
import { documentKeyOf, type SnapshotItem, type SnapshotReason } from '@shared/snapshot'
import {
  clearSnapshotsFor,
  createSnapshot,
  listSnapshots,
  readSnapshotBytes,
  removeSnapshotById,
  snapshotOwnerKey
} from '../snapshot'
import { docOf } from '../doc-resources'
import type { MainContext } from '../context'

/**
 * 这些处理器原来都在 `main/index.ts` 的 `registerIpc()` 里，整块搬来：
 * 函数体、先后顺序、通道名逐字未改（搬迁只做剪切粘贴）。
 */
export function registerSnapshotIpc(ctx: MainContext): void {
  ipcMain.handle(IPC.snapshotList, async (_e, path: string | null): Promise<SnapshotItem[]> =>
    listSnapshots(path)
  )

  ipcMain.handle(
    IPC.snapshotCreate,
    async (
      e,
      docId: string,
      input: {
        workbook: Workbook
        path: string | null
        title: string
        reason: SnapshotReason
        note?: string
      }
    ): Promise<SnapshotItem[]> => {
      const state = ctx.stateOf(e.sender)
      const doc = state && typeof docId === 'string' ? docOf(state, docId) : null
      return createSnapshot({
        workbook: input.workbook,
        // 资源留在主进程，直接取**这份文档**的那一份
        resources: doc?.resources ?? {},
        path: input.path,
        title: input.title,
        reason: input.reason,
        note: input.note
      })
    }
  )

  ipcMain.handle(
    IPC.snapshotRestore,
    async (e, docId: string, id: string): Promise<SnapshotRestoreResult> => {
      const state = ctx.stateOf(e.sender)
      const doc = state && typeof docId === 'string' ? docOf(state, docId) : null
      /**
       * **恢复前必须校验这个版本属于当前文档**。
       *
       * 以前只按 id 取字节：id 是渲染层递过来的，一旦它来自另一份文档（切换文档后对话框
       * 还留着旧 id、列表渲染出错、或渲染层被改坏），就会把**别的文档的内容**恢复进来，
       * 用户接着一保存就把自己当前的文件写坏——而版本库本来是"兜底"的东西，不能反过来毁数据。
       * 而且列表本身就是用同一个路径查出来的（`snapshotList(path)`），所以两者不一致时
       * 说明链路已经错了，此时**拒绝**比"照着恢复"安全。
       */
      const owner = await snapshotOwnerKey(id)
      const current = documentKeyOf(doc?.docPath ?? null)
      if (!owner || owner !== current) {
        throw new Error('这个版本不属于当前文档，已阻止恢复（避免把别的文档内容写进当前文件）')
      }
      const bytes = await readSnapshotBytes(id)
      if (!bytes) throw new Error('这个版本的文件已经不在了，可能被清理过')
      const parsed = await parseXmind(bytes)
      // 与打开文件一致：资源必须留在主进程，否则「恢复后再保存」会把图片丢掉
      if (doc && typeof docId === 'string') {
        doc.resources = parsed.resources
        doc.inserted.clear()
      }
      return {
        workbook: parsed.workbook,
        warnings: parsed.warnings,
        resourceCount: Object.keys(parsed.resources).length
      }
    }
  )

  ipcMain.handle(
    IPC.snapshotRemove,
    async (_e, id: string, path: string | null): Promise<SnapshotItem[]> =>
      removeSnapshotById(id, path)
  )

  ipcMain.handle(IPC.snapshotClear, async (_e, path: string | null): Promise<SnapshotItem[]> =>
    clearSnapshotsFor(path)
  )
}
