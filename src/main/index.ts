import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol, shell } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fs, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  IPC,
  type OpenResult,
  type PickedAttachment,
  type PickedImage,
  type RecoveryInfo,
  type SaveResult
} from '@shared/ipc'
import type { Workbook } from '@shared/model/types'
import { createId } from '@shared/model/factory'
import {
  IMAGE_EXTENSIONS,
  mimeOfPath,
  pruneSessionResources,
  resourcePathFor,
  safeResourceName
} from '@shared/model/resources'
import { parseXmind } from '@shared/xmind/parse'
import { serializeXmind } from '@shared/xmind/serialize'
import { normalizeThemeDefinition, type ThemeDefinition } from '@shared/theme'
import { parseRecoveryMeta, shouldOfferRecovery, type RecoveryMeta } from '@shared/recovery'
import { buildAppMenu } from './menu'

const isDev = !app.isPackaged
let mainWindow: BrowserWindow | null = null
/** 允许真正关闭窗口（渲染进程确认过未保存内容之后） */
let allowClose = false
/** 本次关闭源于「退出应用」而不是关闭窗口 */
let quitRequested = false

/**
 * 图片/附件通过自定义协议喂给渲染进程，而不是把二进制塞进 IPC 或 data URL。
 * 必须在 app ready 之前登记，否则 scheme 不会被当作「标准且安全」的来源。
 */
const RESOURCE_SCHEME = 'mind-resource'
protocol.registerSchemesAsPrivileged([
  {
    scheme: RESOURCE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

/* ------------------------------------------------------------------ */
/* 自动保存路径                                                        */
/* ------------------------------------------------------------------ */

const autosaveDir = (): string => join(app.getPath('userData'), 'autosave')
const autosaveFile = (): string => join(autosaveDir(), 'current.xmind')
const autosaveMeta = (): string => join(autosaveDir(), 'meta.json')

async function readAutosaveMeta(): Promise<RecoveryMeta | null> {
  try {
    return parseRecoveryMeta(JSON.parse(await fs.readFile(autosaveMeta(), 'utf8')))
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 文件读写                                                            */
/* ------------------------------------------------------------------ */

/**
 * 当前文档携带的附件/图片资源。
 * 保存在主进程里，避免每次自动保存都把二进制数据在进程间来回搬。
 * 打开文件时替换，新建文档时清空。
 */
let loadedResources: Record<string, Uint8Array> = {}

/**
 * 本次会话新插入的资源路径。
 * 保存时只清理「新插入过、后来又被删掉」的资源，
 * 文件里原本带着的资源一律不动（可能有本软件尚未建模的引用）。
 */
let sessionResources = new Set<string>()

function resetResources(): void {
  loadedResources = {}
  sessionResources.clear()
}

function pruneForSave(workbook: Workbook): void {
  const { resources, removed } = pruneSessionResources(loadedResources, sessionResources, workbook)
  if (removed.length === 0) return
  loadedResources = resources
  for (const path of removed) sessionResources.delete(path)
}

async function readDocument(path: string): Promise<OpenResult> {
  const buf = await fs.readFile(path)
  const parsed = await parseXmind(new Uint8Array(buf))
  // 关键：资源必须留着，否则「打开带图的文件 → 另存」会把图片丢掉
  loadedResources = parsed.resources
  sessionResources.clear()
  return {
    path,
    workbook: parsed.workbook,
    warnings: parsed.warnings,
    resourceCount: Object.keys(parsed.resources).length
  }
}

async function writeDocument(path: string, workbook: Workbook): Promise<SaveResult> {
  pruneForSave(workbook)
  const bytes = await serializeXmind({ workbook, resources: loadedResources })
  await fs.writeFile(path, Buffer.from(bytes))
  return { path }
}

function ensureXmindExt(p: string): string {
  return p.toLowerCase().endsWith('.xmind') ? p : `${p}.xmind`
}

/* ------------------------------------------------------------------ */
/* 自定义主题的持久化                                                  */
/* ------------------------------------------------------------------ */

const themesFile = (): string => join(app.getPath('userData'), 'themes.json')

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readThemes(): Promise<ThemeDefinition[]> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(themesFile(), 'utf8'))
    const list = isPlainRecord(raw) && Array.isArray(raw.themes) ? raw.themes : []
    return list
      .map((item) => normalizeThemeDefinition(item, { builtin: false }))
      .filter((item): item is ThemeDefinition => item !== null)
  } catch {
    return []
  }
}

async function writeThemes(themes: ThemeDefinition[]): Promise<void> {
  await fs.writeFile(themesFile(), JSON.stringify({ version: 1, themes }, null, 2))
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

function createWindow(): void {
  // 新窗口要重新走一遍未保存确认
  allowClose = false
  quitRequested = false

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#f4f5f7',
    title: '思维导图',
    autoHideMenuBar: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 开发期把渲染进程的 console 转发到终端，方便定位报错
  if (isDev) {
    mainWindow.webContents.on('console-message', (details) => {
      const level = details.level ?? 'info'
      if (level === 'error' || level === 'warning') {
        console.log(`[renderer:${level}] ${details.message} (${details.sourceId ?? ''}:${details.lineNumber ?? 0})`)
      }
    })
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 关闭前交由渲染进程判断是否有未保存内容
  mainWindow.on('close', (e) => {
    if (allowClose) return
    const contents = mainWindow?.webContents
    // 渲染进程已经没了（崩溃/被销毁）时不能再等它回应，否则窗口关不掉
    if (!contents || contents.isDestroyed()) {
      allowClose = true
      return
    }
    e.preventDefault()
    contents.send(IPC.closeRequest)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

/** 把包内资源（resources/…）通过自定义协议暴露给画布上的 <img> */
function registerResourceProtocol(): void {
  protocol.handle(RESOURCE_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const path = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const bytes = loadedResources[path]
      if (!bytes) return new Response('', { status: 404 })
      return new Response(bytes as unknown as BodyInit, {
        headers: {
          'content-type': mimeOfPath(path),
          // 图片可能在同一次会话里被替换，不做缓存最省心
          'cache-control': 'no-store'
        }
      })
    } catch {
      return new Response('', { status: 400 })
    }
  })
}

function registerIpc(): void {
  ipcMain.handle(IPC.openDialog, async (): Promise<OpenResult | null> => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '打开思维导图',
      filters: [{ name: '思维导图文件', extensions: ['xmind'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return readDocument(result.filePaths[0])
  })

  ipcMain.handle(IPC.openPath, async (_e, path: string): Promise<OpenResult> => readDocument(path))

  ipcMain.handle(IPC.saveToPath, async (_e, path: string, workbook: Workbook): Promise<SaveResult> => {
    return writeDocument(ensureXmindExt(path), workbook)
  })

  ipcMain.handle(
    IPC.saveAs,
    async (_e, workbook: Workbook, suggestedName: string): Promise<SaveResult | null> => {
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: '另存为',
        defaultPath: suggestedName,
        filters: [{ name: '思维导图文件', extensions: ['xmind'] }]
      })
      if (result.canceled || !result.filePath) return null
      return writeDocument(ensureXmindExt(result.filePath), workbook)
    }
  )

  ipcMain.handle(
    IPC.autosave,
    async (_e, workbook: Workbook, originalPath: string | null, title: string): Promise<void> => {
      await fs.mkdir(autosaveDir(), { recursive: true })
      pruneForSave(workbook)
      const bytes = await serializeXmind({ workbook, resources: loadedResources })
      await fs.writeFile(autosaveFile(), Buffer.from(bytes))
      const meta: RecoveryMeta = {
        originalPath: originalPath ?? null,
        title: title || '未命名导图',
        savedAt: Date.now()
      }
      await fs.writeFile(autosaveMeta(), JSON.stringify(meta))
    }
  )

  ipcMain.handle(IPC.autosaveClear, async (): Promise<void> => {
    await fs.rm(autosaveDir(), { recursive: true, force: true })
  })

  ipcMain.handle(IPC.documentReset, async (): Promise<void> => {
    resetResources()
    await fs.rm(autosaveDir(), { recursive: true, force: true })
  })

  ipcMain.handle(IPC.recoveryCheck, async (): Promise<RecoveryInfo | null> => {
    const meta = await readAutosaveMeta()
    if (!meta || !existsSync(autosaveFile())) return null

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

  ipcMain.handle(IPC.recoveryLoad, async (): Promise<OpenResult | null> => {
    if (!existsSync(autosaveFile())) return null
    const meta = await readAutosaveMeta()
    const buf = await fs.readFile(autosaveFile())
    const parsed = await parseXmind(new Uint8Array(buf))
    // 存档里同样带着图片/附件：不还原资源的话，恢复后一保存就全丢了
    loadedResources = parsed.resources
    sessionResources.clear()
    return {
      path: meta?.originalPath ?? '',
      workbook: parsed.workbook,
      warnings: parsed.warnings,
      resourceCount: Object.keys(parsed.resources).length
    }
  })

  ipcMain.handle(IPC.recoveryDiscard, async (): Promise<void> => {
    await fs.rm(autosaveDir(), { recursive: true, force: true })
  })

  /* ---- 主题 ---- */

  ipcMain.handle(IPC.themesList, async (): Promise<ThemeDefinition[]> => readThemes())

  ipcMain.handle(IPC.themesSave, async (_e, theme: ThemeDefinition): Promise<void> => {
    const normalized = normalizeThemeDefinition(theme, { builtin: false })
    if (!normalized) return
    const list = await readThemes()
    const index = list.findIndex((item) => item.id === normalized.id)
    if (index >= 0) list[index] = normalized
    else list.push(normalized)
    await writeThemes(list)
  })

  ipcMain.handle(IPC.themesDelete, async (_e, id: string): Promise<void> => {
    await writeThemes((await readThemes()).filter((item) => item.id !== id))
  })

  ipcMain.handle(IPC.themesImport, async (): Promise<ThemeDefinition | null> => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '导入主题',
      filters: [{ name: '主题文件', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const parsed: unknown = JSON.parse(await fs.readFile(result.filePaths[0], 'utf8'))
    const candidate = isPlainRecord(parsed) && 'theme' in parsed ? parsed.theme : parsed
    const theme = normalizeThemeDefinition(candidate, { builtin: false })
    if (!theme) throw new Error('主题文件格式不正确，请确认是本软件导出的主题文件')
    // 分配新 id，避免覆盖已有的自定义主题
    return { ...theme, id: `custom-${Date.now().toString(36)}`, builtin: false }
  })

  ipcMain.handle(IPC.themesExport, async (_e, theme: ThemeDefinition): Promise<boolean> => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '导出主题',
      defaultPath: `${theme.name || '主题'}.json`,
      filters: [{ name: '主题文件', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return false
    const target = result.filePath.toLowerCase().endsWith('.json')
      ? result.filePath
      : `${result.filePath}.json`
    await fs.writeFile(target, JSON.stringify({ type: 'mindmap-theme', version: 1, theme }, null, 2))
    return true
  })

  /* ---- 图片与附件（P4） ---- */

  ipcMain.handle(IPC.pickImage, async (): Promise<PickedImage | null> => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '插入图片',
      filters: [{ name: '图片', extensions: IMAGE_EXTENSIONS }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const file = result.filePaths[0]
    const buf = await fs.readFile(file)
    if (buf.byteLength === 0) throw new Error('这张图片是空文件，无法插入')

    const path = resourcePathFor(createId('img'), file)
    loadedResources[path] = new Uint8Array(buf)
    sessionResources.add(path)

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

    return { path, name: safeResourceName(file), width, height, size: buf.byteLength }
  })

  ipcMain.handle(IPC.pickAttachment, async (): Promise<PickedAttachment | null> => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '添加附件',
      filters: [{ name: '所有文件', extensions: ['*'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const file = result.filePaths[0]
    const buf = await fs.readFile(file)
    const path = resourcePathFor(createId('att'), file)
    loadedResources[path] = new Uint8Array(buf)
    sessionResources.add(path)

    return {
      id: createId('att'),
      path,
      name: basename(file),
      size: buf.byteLength,
      mime: mimeOfPath(file)
    }
  })

  ipcMain.handle(IPC.openAttachment, async (_e, path: string, name: string): Promise<boolean> => {
    const bytes = loadedResources[path]
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

  ipcMain.handle(IPC.saveAttachmentAs, async (_e, path: string, suggestedName: string): Promise<boolean> => {
    const bytes = loadedResources[path]
    if (!bytes) return false
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '导出附件',
      defaultPath: suggestedName || safeResourceName(path)
    })
    if (result.canceled || !result.filePath) return false
    await fs.writeFile(result.filePath, Buffer.from(bytes))
    return true
  })

  ipcMain.on(IPC.confirmClose, () => {
    allowClose = true
    if (quitRequested) app.quit()
    else mainWindow?.close()
  })

  ipcMain.on(IPC.setTitle, (_e, title: string) => {
    mainWindow?.setTitle(title)
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
    if (existsSync(path)) shell.showItemInFolder(path)
  })
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

// 单实例：两个进程同时读写同一份自动存档与主题文件会互相覆盖
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    registerResourceProtocol()
    registerIpc()
    buildAppMenu()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * 退出前也要走一遍未保存确认。
 * 之前这里直接放行，导致从菜单「退出」会绕过确认、静默丢掉未保存的修改。
 */
app.on('before-quit', (event) => {
  if (allowClose) return
  const contents = mainWindow?.webContents
  if (!contents || contents.isDestroyed()) {
    allowClose = true
    return
  }
  event.preventDefault()
  quitRequested = true
  contents.send(IPC.closeRequest)
})
