import { app, ipcMain } from 'electron'
import { isPlausibleFilePath } from '@shared/ipc-args'
import { writeFileAtomic } from '../atomic-write'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { normalizeChatHistory, type ChatHistoryEntry } from '@shared/ai'

/**
 * 这些处理器原来都在 `main/index.ts` 的 `registerIpc()` 里，整块搬来：
 * 函数体、先后顺序、通道名逐字未改（搬迁只做剪切粘贴）。
 */
export function registerChatHistoryIpc(): void {
  ipcMain.handle(IPC.chatHistoryLoad, async (_e, key: unknown): Promise<ChatHistoryEntry[]> => {
    if (typeof key !== 'string' || !isPlausibleFilePath(key)) return []
    try {
      const raw: unknown = JSON.parse(await fs.readFile(chatFileOf(key), 'utf8'))
      return normalizeChatHistory(raw)
    } catch {
      // 文件不存在或坏了都当「没有记录」：聊天记录丢了不该影响开文档
      return []
    }
  })

  ipcMain.handle(
    IPC.chatHistorySave,
    async (_e, key: unknown, messages: unknown): Promise<void> => {
      if (typeof key !== 'string' || !isPlausibleFilePath(key))
        throw new Error('聊天记录的文档标识无效')
      if (!Array.isArray(messages)) throw new Error('聊天记录无效')
      // 复用与读取同一套校验：写进去的和读出来的一定同构
      const items = normalizeChatHistory({ messages })
      await fs.mkdir(chatDir(), { recursive: true })
      // 原子写：半截的聊天记录文件解析不了，等于整段对话白存
      await writeFileAtomic(
        chatFileOf(key),
        Buffer.from(JSON.stringify({ version: 1, messages: items }, null, 2))
      )
    }
  )
  ipcMain.handle(IPC.chatHistoryClear, async (_e, key: unknown): Promise<void> => {
    if (typeof key !== 'string' || !isPlausibleFilePath(key)) return
    await fs.rm(chatFileOf(key), { force: true })
  })
}

const chatDir = (): string => join(app.getPath('userData'), 'chat')

/**
 * 聊天记录的落盘文件。
 *
 * 用**文档路径的哈希**当文件名：路径可能含中文、空格、超长，直接做文件名不可靠；
 * 只存哈希不存原路径，也就不会把用户的目录结构写进这个文件。
 */
const chatFileOf = (key: string): string =>
  join(chatDir(), `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`)
