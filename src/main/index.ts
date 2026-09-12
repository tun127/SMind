import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { promises as fs, existsSync } from 'node:fs'
import { join } from 'node:path'
import { IPC, type OpenResult, type RecoveryInfo, type SaveResult } from '@shared/ipc'
import type { Workbook } from '@shared/model/types'
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

async function readDocument(path: string): Promise<OpenResult> {
  const buf = await fs.readFile(path)
  const parsed = await parseXmind(new Uint8Array(buf))
  // 关键：资源必须留着，否则「打开带图的文件 → 另存」会把图片丢掉
  loadedResources = parsed.resources
  return {
    path,
    workbook: parsed.workbook,
    warnings: parsed.warnings,
    resourceCount: Object.keys(parsed.resources).length
  }
}

async function writeDocument(path: string, workbook: Workbook): Promise<SaveResult> {
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
    loadedResources = {}
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
    return {
      path: meta?.originalPath ?? '',
      workbook: parsed.workbook,
      warnings: parsed.warnings,
      resourceCount: 0
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
