import { app, ipcMain } from 'electron'
import { writeFileAtomic } from '../atomic-write'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'

/**
 * 这些处理器原来都在 `main/index.ts` 的 `registerIpc()` 里，整块搬来：
 * 函数体、先后顺序、通道名逐字未改（搬迁只做剪切粘贴）。
 */
export function registerDiagnosticIpc(): void {
  ipcMain.handle(IPC.diagDump, async (_e, text: unknown): Promise<void> => {
    if (typeof text !== 'string' || text.length === 0 || text.length > 64 * 1024 * 1024) return
    const dir = join(app.getPath('userData'), 'diag')
    await fs.mkdir(dir, { recursive: true })
    await writeFileAtomic(join(dir, 'last-state.json'), Buffer.from(text))
  })
}
