import { ipcMain } from 'electron'
import {
  IMPORT_DOCUMENT_EXTENSIONS,
  extractDocumentFromBytes,
  extractDocumentFromPath
} from '../document'
import { type ExtractedDocument } from '@shared/document'
import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import { IPC, type ImportedTextFile } from '@shared/ipc'

import { showOpenIn } from '../dialogs'
import { firstPathOf } from '../files'
import type { MainContext } from '../context'

/**
 * 这些处理器原来都在 `main/index.ts` 的 `registerIpc()` 里，整块搬来：
 * 函数体、先后顺序、通道名逐字未改（搬迁只做剪切粘贴）。
 */
export function registerImportIpc(ctx: MainContext): void {
  ipcMain.handle(
    IPC.documentExtract,
    async (_e, name: unknown, bytes: unknown): Promise<ExtractedDocument> => {
      if (typeof name !== 'string' || name.length === 0 || name.length > 260) {
        throw new Error('文件名无效')
      }
      // 结构化克隆过来可能是 Uint8Array，也可能是 ArrayBuffer（不同 Electron 版本有差异）
      const data =
        bytes instanceof Uint8Array
          ? bytes
          : bytes instanceof ArrayBuffer
            ? new Uint8Array(bytes)
            : null
      if (!data) throw new Error('文件内容无效')
      return extractDocumentFromBytes(name, data)
    }
  )

  ipcMain.handle(IPC.documentPick, async (e): Promise<ExtractedDocument | null> => {
    const result = await showOpenIn(ctx.winOf(e.sender), {
      title: '选择要生成导图的文档',
      filters: [
        { name: '文档', extensions: [...IMPORT_DOCUMENT_EXTENSIONS] },
        { name: '全部文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    const file = firstPathOf(result)
    if (!file) return null
    return extractDocumentFromPath(file)
  })
  ipcMain.handle(
    IPC.importText,
    async (e, kind: 'markdown' | 'opml' | 'license'): Promise<ImportedTextFile | null> => {
      const isLicense = kind === 'license'
      const isMarkdown = kind === 'markdown'
      const title = isLicense
        ? '选择许可文件'
        : isMarkdown
          ? '导入 Markdown 生成导图'
          : '导入 OPML 生成导图'
      const filters = isLicense
        ? [
            { name: '文本 / 许可文件', extensions: ['txt', 'md', 'license', 'key'] },
            { name: '所有文件', extensions: ['*'] }
          ]
        : isMarkdown
          ? [
              { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
              { name: '所有文件', extensions: ['*'] }
            ]
          : [
              { name: 'OPML', extensions: ['opml', 'xml'] },
              { name: '所有文件', extensions: ['*'] }
            ]
      const result = await showOpenIn(ctx.winOf(e.sender), {
        title,
        filters,
        properties: ['openFile']
      })
      const path = firstPathOf(result)
      if (!path) return null

      // 许可文件只该是纯文本：先按体积拦住"选错了个大文件"，免得整份读进内存
      if (isLicense) {
        const info = await fs.stat(path)
        if (info.size > LICENSE_FILE_MAX) {
          throw new Error('这个文件太大了：许可码是纯文本，正常不超过几十 KB')
        }
      }

      let text: string
      try {
        text = await fs.readFile(path, 'utf8')
      } catch (error) {
        throw new Error(`读取文件失败：${(error as Error).message}`, { cause: error })
      }
      // 去掉 UTF-8 BOM，否则第一行会被当成乱码
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      if (text.trim().length === 0) throw new Error('这个文件是空的')

      return { path, name: basename(path), text }
    }
  )
}

/** 许可文件体积上限（1 MB：再大就不可能是许可码，多半是选错了文件） */
const LICENSE_FILE_MAX = 1024 * 1024
