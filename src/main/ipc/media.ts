import { clipboard, ipcMain, nativeImage, shell } from 'electron'
import { checkImagePayload } from '@shared/ipc-args'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { IPC, type PickedAttachment, type PickedImage } from '@shared/ipc'

import { createId } from '@shared/model/factory'
import {
  IMAGE_EXTENSIONS,
  mimeOfPath,
  resourcePathFor,
  safeResourceName
} from '@shared/model/resources'

import { type DocWindow } from '../context'
import { showOpenIn, showSaveIn } from '../dialogs'
import { firstPathOf } from '../files'
import { docOf } from '../doc-resources'
import type { MainContext } from '../context'

/**
 * 这些处理器原来都在 `main/index.ts` 的 `registerIpc()` 里，整块搬来：
 * 函数体、先后顺序、通道名逐字未改（搬迁只做剪切粘贴）。
 */
export function registerMediaIpc(
  ctx: MainContext,
  resourceBytesOf: (path: string) => Uint8Array | undefined
): void {
  ipcMain.handle(IPC.pickImage, async (e, docId: string): Promise<PickedImage | null> => {
    const result = await showOpenIn(ctx.winOf(e.sender), {
      title: '插入图片',
      filters: [{ name: '图片', extensions: IMAGE_EXTENSIONS }],
      properties: ['openFile']
    })
    const file = firstPathOf(result)
    if (!file) return null

    const buf = await fs.readFile(file)
    return registerImageBytes(ctx.stateOf(e.sender), docId, safeResourceName(file), buf)
  })

  /**
   * 把一段图片字节登记进**这份文档**的资源表（与 pickImage 同一条路，保存时打进包里）。
   * 必须按 docId 挂：否则 A 标签保存时会把 B 标签插入的图片一起打进包。
   */
  const registerImageBytes = (
    state: DocWindow | null,
    docId: string,
    name: string,
    buf: Buffer
  ): PickedImage => {
    // 上限既挡"手滑选中超大图"，也挡渲染层被注入后拿 IPC 当放大器
    const problem = checkImagePayload(buf, name)
    if (problem) throw new Error(problem)
    const path = resourcePathFor(createId('img'), name)

    // 用 Electron 自带的解码器拿真实像素尺寸，节点才能按原始宽高比显示
    let width = 0
    let height = 0
    try {
      const size = nativeImage.createFromBuffer(buf).getSize()
      width = size.width
      height = size.height
    } catch {
      width = 0
      height = 0
    }

    if (state && typeof docId === 'string') {
      const doc = docOf(state, docId)
      doc.resources[path] = new Uint8Array(buf)
      doc.inserted.add(path)
    }
    return { path, name: safeResourceName(name), width, height, size: buf.byteLength }
  }

  // 读取系统剪贴板里的图片（截图后直接 Ctrl+V 贴到选中的主题上）；没有图片返回 null
  ipcMain.handle(IPC.pasteImage, async (e, docId: string): Promise<PickedImage | null> => {
    let items: Electron.ClipboardItem[] = []
    try {
      items = await clipboard.read()
    } catch {
      return null
    }
    for (const item of items) {
      const mime = item.types.find((type) => type.startsWith('image/'))
      if (!mime) continue
      try {
        const payload = await item.getType(mime)
        if (!(payload instanceof Blob)) continue
        const buf = Buffer.from(await payload.arrayBuffer())
        if (buf.byteLength === 0) continue
        const extension = mime === 'image/jpeg' ? 'jpg' : 'png'
        return registerImageBytes(ctx.stateOf(e.sender), docId, `剪贴板图片.${extension}`, buf)
      } catch {
        continue
      }
    }
    return null
  })

  // 渲染进程拖入 / 粘贴得到的图片字节（拖拽文件走这里）
  ipcMain.handle(
    IPC.addImage,
    async (e, docId: string, name: string, bytes: Uint8Array): Promise<PickedImage | null> => {
      if (!bytes || bytes.byteLength === 0) return null
      return registerImageBytes(ctx.stateOf(e.sender), docId, name, Buffer.from(bytes))
    }
  )

  ipcMain.handle(IPC.pickAttachment, async (e, docId: string): Promise<PickedAttachment | null> => {
    const result = await showOpenIn(ctx.winOf(e.sender), {
      title: '添加附件',
      filters: [{ name: '所有文件', extensions: ['*'] }],
      properties: ['openFile']
    })
    const file = firstPathOf(result)
    if (!file) return null

    const buf = await fs.readFile(file)
    // 一个附件只生成**一个** id：包内路径与返回给渲染层的 id 同源，
    // 否则同一份附件会有两个互不相干的标识（以前这里调了两次 createId('att')），
    // 排查"这个附件是哪来的"时对不上号
    const id = createId('att')
    const path = resourcePathFor(id, file)
    const state = ctx.stateOf(e.sender)
    if (state && typeof docId === 'string') {
      const doc = docOf(state, docId)
      doc.resources[path] = new Uint8Array(buf)
      doc.inserted.add(path)
    }

    return {
      id,
      path,
      name: basename(file),
      size: buf.byteLength,
      mime: mimeOfPath(file)
    }
  })

  ipcMain.handle(IPC.openAttachment, async (_e, path: string, name: string): Promise<boolean> => {
    // 附件资源路径全局唯一：直接跨窗口/跨标签找
    const bytes = resourceBytesOf(path)
    if (!bytes) return false
    // 附件是包内资源，得先落到临时文件才能交给系统程序打开。
    // 文件名带上路径哈希：同名附件互不覆盖，同一附件重复打开复用同一个临时文件。
    const dir = join(tmpdir(), 'mind-attachments')
    await fs.mkdir(dir, { recursive: true })
    const token = createHash('sha1').update(path).digest('hex').slice(0, 10)
    const target = join(dir, `${token}-${safeResourceName(name || path)}`)
    await fs.writeFile(target, Buffer.from(bytes))
    const message = await shell.openPath(target)
    return message.length === 0
  })

  ipcMain.handle(
    IPC.saveAttachmentAs,
    async (e, path: string, suggestedName: string): Promise<boolean> => {
      const bytes = resourceBytesOf(path)
      if (!bytes) return false
      const result = await showSaveIn(ctx.winOf(e.sender), {
        title: '导出附件',
        defaultPath: suggestedName || safeResourceName(path)
      })
      if (result.canceled || !result.filePath) return false
      await fs.writeFile(result.filePath, Buffer.from(bytes))
      return true
    }
  )
}
