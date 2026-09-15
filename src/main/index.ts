import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, protocol, shell } from 'electron'
import { isRecord } from '../shared/guards'
import { checkImagePayload, isPlausibleFilePath } from '@shared/ipc-args'
import { writeFileAtomic } from './atomic-write'
import { logDirectory, logMain } from './log'
import { createHash } from 'node:crypto'
import { promises as fs, existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DEFAULT_APP_SETTINGS,
  IPC,
  type AiChatResult,
  type AiConfigPatch,
  type AiTestResult,
  type AppSettings,
  type ImportedTextFile,
  type OpenResult,
  type PickedAttachment,
  type PickedImage,
  type RecoveryInfo,
  type SaveResult,
  type SnapshotRestoreResult
} from '@shared/ipc'
import { pickDocumentArg } from '@shared/openfile'
import {
  DEFAULT_AI_CONFIG,
  chatCompletionsUrl,
  describeAiError,
  extractContent,
  normalizeAiConfig,
  toConfigView,
  type AiConfig,
  type AiConfigView,
  type AiMessage
} from '@shared/ai'
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
import { buildOutline, outlineFormatDef, type OutlineFormat } from '@shared/outline'
import { defaultDocumentName, defaultFileName } from '@shared/model/naming'
import type { HistoryEntry } from '@shared/history'
import type { SnapshotItem, SnapshotReason } from '@shared/snapshot'
import {
  clearAllHistory,
  currentSaveDir,
  listHistory,
  recordVisit,
  rememberSaveDir,
  removeEntry,
  togglePin
} from './history'
import {
  clearSnapshotsFor,
  createSnapshot,
  listSnapshots,
  readSnapshotBytes,
  removeSnapshotById
} from './snapshot'
import { imageExportFormatDef, type ImageExportFormat } from '@shared/export/types'
import { normalizeThemeDefinition, type ThemeDefinition } from '@shared/theme'
import { parseRecoveryMeta, shouldOfferRecovery, type RecoveryMeta } from '@shared/recovery'
import { autosaveSlotName, sameDocPath } from '@shared/window'
import { CODE_LANGUAGES } from '@shared/code-language'
import { buildAppMenu } from './menu'

/** 应用名：与 electron-builder 的 productName、窗口标题保持一致 */
const APP_NAME = 'SMind'

/**
 * 开发模式下的窗口/任务栏图标（打包后由 exe 自带图标，不需要它）。
 * 用 existsSync 判断：打包后这个路径不存在，直接跳过而不是报错。
 */
const devIconFile = join(__dirname, '../../build/icon.png')

const isDev = !app.isPackaged

/** 本次退出源于「退出应用」而不是关闭某个窗口 */
let quitRequested = false
/** 所有窗口都确认过未保存内容，可以真正退出 */
let quitApproved = false

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
/** 「在新窗口打开画布副本」用的临时文件目录（关窗即删） */
const copyDir = (): string => join(app.getPath('userData'), 'copies')
/**
 * 自动存档按**窗口**分槽位：多窗口时各存各的，互不覆盖。
 * 槽位名按窗口创建顺序（slot-1 / slot-2 …），重启后新会话的窗口按同样顺序认领。
 */
const autosaveFile = (slot: string): string => join(autosaveDir(), `${slot}.xmind`)
const autosaveMeta = (slot: string): string => join(autosaveDir(), `${slot}.json`)

async function readAutosaveMeta(slot: string): Promise<RecoveryMeta | null> {
  try {
    return parseRecoveryMeta(JSON.parse(await fs.readFile(autosaveMeta(slot), 'utf8')))
  } catch {
    return null
  }
}

/** 清理上次运行留下的画布副本（超过一天，肯定没窗口还开着它了） */
async function pruneStaleCopies(): Promise<void> {
  try {
    const dir = copyDir()
    const names = await fs.readdir(dir)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    await Promise.all(
      names.map(async (name) => {
        const target = join(dir, name)
        try {
          const info = await fs.stat(target)
          if (info.mtimeMs < cutoff) await fs.rm(target, { force: true })
        } catch {
          /* 单个文件清理失败不影响启动 */
        }
      })
    )
  } catch {
    /* 目录不存在就是没有副本 */
  }
}

/* ------------------------------------------------------------------ */
/* 窗口与文档状态                                                      */
/* ------------------------------------------------------------------ */

/**
 * 一个窗口可以开着**多个文档标签**（浏览器式多文件），
 * 所以资源与文档归属再往下分一层——按 docId（标签）隔离。
 *
 * 不分的话：A 标签保存时会把 B 标签的图片打进包里，A 删掉图片会把 B 的资源一起清掉。
 * 自动存档槽位与未保存确认仍然按窗口（一次只存/问激活的那个标签）。
 */
interface DocResources {
  /** 这份文档携带的图片/附件资源；保存时只打自己这一份 */
  resources: Record<string, Uint8Array>
  /**
   * 本次会话新插入的资源路径。
   * 保存时只清理「新插入过、后来又被删掉」的资源，
   * 文件里原本带着的资源一律不动（可能有本软件尚未建模的引用）。
   */
  inserted: Set<string>
  /** 这份文档当前打开的文件路径（新文档＝null） */
  docPath: string | null
}

interface DocWindow {
  /** webContents.id */
  id: number
  win: BrowserWindow
  /** 自动存档槽位名 */
  slot: string
  /** 按文档 id（标签）隔离的资源与路径 */
  docs: Map<string, DocResources>
  /** 渲染进程已确认可以关闭（未保存内容问过了） */
  allowClose: boolean
  /** 启动/二实例带的文件，渲染进程就绪后取走 */
  pendingPath: string | null
  /** 这个窗口打开的是临时副本：文档没有磁盘归属，关窗时把临时文件删掉 */
  copySource: string | null
}

const windows = new Map<number, DocWindow>()
/** 本次进程第一个窗口：只有它负责询问「上次没保存完的文档要不要恢复」 */
let primaryWindowId: number | null = null
let windowSeq = 0

/** 取（或建）某个文档的资源记录：渲染进程开新标签后第一次用到时才真正建起来 */
function docOf(state: DocWindow, docId: string): DocResources {
  let doc = state.docs.get(docId)
  if (!doc) {
    doc = { resources: {}, inserted: new Set(), docPath: null }
    state.docs.set(docId, doc)
  }
  return doc
}

function pruneForSave(doc: DocResources, workbook: Workbook): void {
  const { resources, removed } = pruneSessionResources(doc.resources, doc.inserted, workbook)
  if (removed.length === 0) return
  doc.resources = resources
  for (const path of removed) doc.inserted.delete(path)
}

/** 取发起请求的窗口状态；实在拿不到就退回聚焦窗口 */
function stateOf(sender: Electron.WebContents): DocWindow | null {
  return windows.get(sender.id) ?? focusedState()
}

function focusedState(): DocWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused) {
    const state = windows.get(focused.webContents.id)
    if (state) return state
  }
  return windows.values().next().value ?? null
}

function winOf(sender: Electron.WebContents): BrowserWindow | null {
  const state = stateOf(sender)
  if (state && !state.win.isDestroyed()) return state.win
  const focused = BrowserWindow.getFocusedWindow()
  return focused && !focused.isDestroyed() ? focused : null
}

/** 对话框挂在发起窗口上（多窗口下不能只认「主窗口」） */
async function showOpenIn(
  win: BrowserWindow | null,
  options: Electron.OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue> {
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
}

async function showSaveIn(
  win: BrowserWindow | null,
  options: Electron.SaveDialogOptions
): Promise<Electron.SaveDialogReturnValue> {
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
}

/* ------------------------------------------------------------------ */
/* 文件读写                                                            */
/* ------------------------------------------------------------------ */

async function readDocumentInto(
  state: DocWindow | null,
  docId: string,
  path: string
): Promise<OpenResult> {
  const buf = await fs.readFile(path)
  // 传文件名进去：亿图脑图的专有 .emmx 没有自带文档名，只能拿文件名当中心主题
  const parsed = await parseXmind(new Uint8Array(buf), { fileName: basename(path) })
  // 副本（临时文件）：算"未保存的新文档"——不记路径、不进历史、保存走另存为
  const isCopy = Boolean(state && state.copySource && state.copySource === path)
  if (state && typeof docId === 'string') {
    // 资源记在**这个文档**名下：别的标签保存时不会把它们打进去
    const doc = docOf(state, docId)
    doc.resources = parsed.resources
    doc.inserted.clear()
    doc.docPath = isCopy ? null : path
  }
  // 记一笔打开历史（用中心主题名，方便在历史界面里认出是哪张图）；副本不进历史
  if (!isCopy) await recordVisit(path, defaultDocumentName(parsed.workbook)).catch(() => undefined)
  return {
    path: isCopy ? '' : path,
    workbook: parsed.workbook,
    warnings: parsed.warnings,
    resourceCount: Object.keys(parsed.resources).length,
    copy: isCopy || undefined
  }
}

async function writeDocument(
  state: DocWindow | null,
  docId: string,
  path: string,
  workbook: Workbook
): Promise<SaveResult> {
  const doc = state && typeof docId === 'string' ? docOf(state, docId) : null
  if (doc) pruneForSave(doc, workbook)
  const bytes = await serializeXmind({ workbook, resources: doc?.resources ?? {} })
  await writeFileAtomic(path, bytes)
  if (doc) doc.docPath = path
  // 保存成功也记一笔，并记住这次用的目录（下次「另存为」默认落在这里）
  await rememberSaveDir(dirname(path)).catch(() => undefined)
  await recordVisit(path, defaultDocumentName(workbook)).catch(() => undefined)
  return { path }
}

/**
 * 从「打开 / 保存对话框」的结果里取用户选中的第一个路径。
 *
 * 各处原本都写成「先判 `filePaths.length === 0`、再取 `filePaths[0]`」——
 * 逻辑没错，但取下标那一步没有类型保证，于是这段判断在每个调用点都重复了一遍。
 * 收成一个函数：判断只写一次，也不会再出现"忘了判"的新代码。
 */
function firstPathOf(result: { canceled: boolean; filePaths: string[] }): string | null {
  if (result.canceled) return null
  return result.filePaths[0] ?? null
}

function ensureXmindExt(p: string): string {
  return p.toLowerCase().endsWith('.xmind') ? p : `${p}.xmind`
}

/* ------------------------------------------------------------------ */
/* 自定义主题的持久化                                                  */
/* ------------------------------------------------------------------ */

const themesFile = (): string => join(app.getPath('userData'), 'themes.json')

async function readThemes(): Promise<ThemeDefinition[]> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(themesFile(), 'utf8'))
    const list = isRecord(raw) && Array.isArray(raw.themes) ? raw.themes : []
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
/* AI 配置与请求代理（P8）                                             */
/* ------------------------------------------------------------------ */

/** 应用级默认设置（默认视角锁定 / 默认主题 / 默认对齐） */
const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')

const aiConfigFile = (): string => join(app.getPath('userData'), 'ai-config.json')

async function readAiConfig(): Promise<AiConfig> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(aiConfigFile(), 'utf8'))
    return normalizeAiConfig(raw).config
  } catch {
    return { ...DEFAULT_AI_CONFIG }
  }
}

async function writeAiConfig(config: AiConfig): Promise<void> {
  await fs.writeFile(aiConfigFile(), JSON.stringify(config, null, 2), 'utf8')
}

/**
 * 调一次 OpenAI 兼容的 chat/completions。
 *
 * 放在主进程做：① 绕开渲染进程的 CORS 限制；② 超时与错误翻译集中在一处；
 * ③ API Key 只留在主进程的配置文件里，不经过渲染进程。
 */
async function callAi(
  config: AiConfig,
  messages: AiMessage[],
  timeoutMs: number
): Promise<AiChatResult> {
  if (config.apiKey.length === 0) {
    throw new Error('还没有配置 API Key：请打开「AI 设置」填入后再试')
  }
  const url = chatCompletionsUrl(config.baseUrl)
  if (url.length === 0) throw new Error('BaseURL 没有配置')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: config.temperature,
        stream: false
      }),
      signal: controller.signal
    })

    const text = await response.text()
    if (!response.ok) {
      throw new Error(describeAiError(response.status, text))
    }

    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error('AI 返回的不是合法 JSON：可能 BaseURL 指向的不是兼容接口')
    }

    const content = extractContent(payload)
    const usage = isRecord(payload) && isRecord(payload.usage) ? payload.usage : null
    const totalTokens = usage && typeof usage.total_tokens === 'number' ? usage.total_tokens : null
    const model = isRecord(payload) && typeof payload.model === 'string' ? payload.model : config.model
    return { content, model, totalTokens }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(
        `请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒）：网络慢或模型响应太慢，可以稍后再试`,
        { cause: error }
      )
    }
    if (error instanceof TypeError) {
      // fetch 的网络层错误（DNS/连接被拒/证书）
      throw new Error(`连不上 AI 服务：请检查 BaseURL 是否正确、网络是否可用（${error.message}）`, {
        cause: error
      })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 开一个窗口 = 开一份文档。
 *
 * `options.path` 只在「启动时带文件 / 双击文件 / 二实例传参」时给：
 * 那一刻 React 可能还没挂载，所以路径先存在窗口状态里，渲染进程就绪后自己来取一次。
 */
function createWindow(options: { path?: string | null; copySource?: string | null } = {}): DocWindow {
  windowSeq += 1
  const slot = autosaveSlotName(windowSeq)

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#f4f5f7',
    title: APP_NAME,
    autoHideMenuBar: false,
    ...(existsSync(devIconFile) ? { icon: devIconFile } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 沙箱开着更安全；preload 只用了 contextBridge + ipcRenderer，两者在沙箱里都可用
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const state: DocWindow = {
    id: win.webContents.id,
    win,
    slot,
    docs: new Map(),
    allowClose: false,
    pendingPath: options.path ?? null,
    copySource: options.copySource ?? null
  }
  windows.set(state.id, state)

  // 只有本次进程的第一个窗口负责询问「上次没保存完的文档要不要恢复」
  if (primaryWindowId === null) primaryWindowId = state.id

  win.on('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })

  // 开发期把渲染进程的 console 转发到终端，方便定位报错
  if (isDev) {
    win.webContents.on('console-message', (details) => {
      const level = details.level ?? 'info'
      if (level === 'error' || level === 'warning') {
        console.log(`[renderer:${level}] ${details.message} (${details.sourceId ?? ''}:${details.lineNumber ?? 0})`)
      }
    })
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  /**
   * 渲染进程崩溃 / 无响应 / 页面加载失败。
   * 不处理的话用户只会看到一个**空窗口或卡住的窗口**，不知道发生了什么、也不知道能不能救。
   */
  win.webContents.on('render-process-gone', (_event, details) => {
    logMain('render-process-gone', details.reason, { exitCode: details.exitCode })
    if (win.isDestroyed()) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'error',
      title: '界面进程已退出',
      message: '界面进程意外退出了。文档有自动存档（每 30 秒一份），重新加载即可继续。',
      detail: `退出原因：${details.reason}`,
      buttons: ['重新加载界面', '关闭这个窗口'],
      defaultId: 0,
      cancelId: 0
    })
    if (choice === 0) win.reload()
    else win.close()
  })

  win.webContents.on('unresponsive', () => {
    logMain('unresponsive', '渲染进程无响应')
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    // -3 是主动中止（正常的导航取消），不必记
    if (errorCode === -3) return
    logMain('did-fail-load', `${errorCode} ${errorDescription}`, validatedURL)
  })

  /**
   * 把文件拖进窗口：Chromium 的默认行为是**导航到那个文件**——整个应用界面会被替换成
   * 一张图片或一个 PDF，看起来就像"软件坏了"。这里一律拦下：
   * 拖进来的是本软件的文档（.xmind/.emmx/.emm）就**在这个窗口里打开**，别的文件忽略。
   */
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (!url.startsWith('file://')) return
    try {
      const pathname = decodeURIComponent(new URL(url).pathname)
      const target = pickDocumentArg([pathname.replace(/^\//, '')], existsSync)
      if (target && !win.isDestroyed()) win.webContents.send(IPC.fileOpenRequest, target)
    } catch {
      /* 解析不了就当作普通拖拽，忽略 */
    }
  })

  // 关闭前交由**这个窗口**的渲染进程判断是否有未保存内容
  win.on('close', (e) => {
    if (state.allowClose) return
    const contents = win.webContents
    // 渲染进程已经没了（崩溃/被销毁）时不能再等它回应，否则窗口关不掉
    if (!contents || contents.isDestroyed()) {
      state.allowClose = true
      return
    }
    e.preventDefault()
    contents.send(IPC.closeRequest)
  })

  win.on('closed', () => {
    windows.delete(state.id)
    // 正常关闭（含"丢弃未保存改动"）＝不再需要这份自动存档：
    // 留着它，下次启动的窗口认领同一槽位时会弹出一个"幽灵恢复"。
    // 真崩溃时这个事件不会触发，存档照旧留着给恢复用。
    void fs.rm(autosaveFile(state.slot), { force: true })
    void fs.rm(autosaveMeta(state.slot), { force: true })
    // 画布副本的临时文件：窗口关了就没用了
    if (state.copySource) void fs.rm(state.copySource, { force: true })
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return state
}

/**
 * 「从外面打开一个文档」（双击 .xmind、二实例传参、macOS 的 open-file）。
 *
 * 标签为主：已经开着这个文件 → 聚焦那个窗口，并推给它的渲染进程去**切到那个标签**；
 * 没开过 → 交给**当前聚焦的窗口**开一个新标签（浏览器的行为）；
 * 一个窗口都没有才新建窗口。
 */
function openDocumentSomewhere(path: string): void {
  for (const state of windows.values()) {
    let has = false
    for (const doc of state.docs.values()) {
      if (doc.docPath && sameDocPath(doc.docPath, path)) {
        has = true
        break
      }
    }
    if (has && !state.win.isDestroyed()) {
      if (state.win.isMinimized()) state.win.restore()
      state.win.focus()
      state.win.webContents.send(IPC.fileOpenRequest, path)
      return
    }
  }
  const current = focusedState()
  if (current && !current.win.isDestroyed()) {
    current.win.webContents.send(IPC.fileOpenRequest, path)
    return
  }
  createWindow({ path })
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 跨窗口、跨标签找一份资源。
 *
 * 协议请求本身认不出是哪个窗口/标签发的，而资源路径是全局唯一的，
 * 所以这里扫描各窗口各文档的资源表；**隔离发生在保存时**（每份文档只打自己那一份）。
 */
function resourceBytesOf(path: string): Uint8Array | undefined {
  for (const state of windows.values()) {
    for (const doc of state.docs.values()) {
      const bytes = doc.resources[path]
      if (bytes) return bytes
    }
  }
  return undefined
}

/** 把包内资源（resources/…）通过自定义协议暴露给画布上的 <img> */
function registerResourceProtocol(): void {
  protocol.handle(RESOURCE_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const path = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const bytes = resourceBytesOf(path)
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

/**
 * 启动时命令行里带的文档路径（双击 `.xmind`、把文件拖到 exe 上、右键「打开方式 → SMind」都会走这里）。
 *
 * 刻意**不在启动流程里直接推给渲染进程**：那一刻 React 可能还没挂载、监听还没注册上，
 * 推过去就丢了。所以先挂到窗口状态上，渲染进程就绪后自己来取一次（取走即清空），时序上稳。
 */
const startupOpenPath: string | null = pickDocumentArg(process.argv, existsSync)

function registerIpc(): void {
  /**
   * 渲染进程就绪后取「这个窗口启动时带的文件」，取一次即清空。
   */
  ipcMain.handle(IPC.openFilePending, async (e): Promise<string | null> => {
    const state = stateOf(e.sender)
    if (!state) return null
    const target = state.pendingPath
    state.pendingPath = null
    return target
  })

  /** 渲染进程报告「某个标签现在打开的是哪个文件」（新建＝null）：用于同文件不重复开窗/开标签 */
  ipcMain.on(IPC.documentPath, (e, docId: string, path: string | null) => {
    const state = stateOf(e.sender)
    if (!state || typeof docId !== 'string') return
    docOf(state, docId).docPath = typeof path === 'string' && path.length > 0 ? path : null
  })

  /** 释放一个文档（标签关闭）：丢掉它的资源表；自动存档槽位不归它管 */
  ipcMain.handle(IPC.releaseDoc, async (e, docId: string): Promise<void> => {
    const state = stateOf(e.sender)
    if (!state || typeof docId !== 'string') return
    state.docs.delete(docId)
  })

  /** 新建一个窗口（菜单「新建窗口」/ Ctrl+Shift+N） */
  ipcMain.handle(IPC.newWindow, async (): Promise<void> => {
    createWindow()
  })

  /**
   * 在新窗口打开**当前文档的副本**（并定位到指定画布）。
   *
   * 为什么是"副本"而不是"在同一份文件上再开一个窗口"：
   * 用户要的是"A 画布新建 B 画布，B 能自己导入/导出，**不影响 A**，两者互不影响"。
   * 两个窗口指向同一个文件时，谁后保存谁覆盖——那就谈不上互不影响了。
   * 所以这里把当前文档（含未保存改动与图片资源）写成一份**临时副本**，
   * 新窗口打开它但**不认路径**：保存时会走「另存为」，永远不会写回原文件。
   */
  ipcMain.handle(
    IPC.openSheetWindow,
    async (e, docId: string, workbook: Workbook): Promise<'ok' | 'failed'> => {
      const state = stateOf(e.sender)
      if (!state) return 'failed'
      try {
        await fs.mkdir(copyDir(), { recursive: true })
        const doc = typeof docId === 'string' ? docOf(state, docId) : null
        if (doc) pruneForSave(doc, workbook)
        const bytes = await serializeXmind({ workbook, resources: doc?.resources ?? {} })
        const copyPath = join(copyDir(), `${state.slot}-copy-${Date.now().toString(36)}.xmind`)
        await fs.writeFile(copyPath, Buffer.from(bytes))
        createWindow({ path: copyPath, copySource: copyPath })
        return 'ok'
      } catch {
        return 'failed'
      }
    }
  )

  /**
   * 读系统剪贴板里的纯文本。
   * 渲染进程自己也读得到（navigator.clipboard），但那个 API 在没聚焦/无权限时会抛，
   * 走主进程更稳——粘贴 Markdown 片段要靠它。
   */
  ipcMain.handle(IPC.clipboardText, async (): Promise<string> => clipboard.readText())

  ipcMain.handle(IPC.openDialog, async (e, docId: string): Promise<OpenResult | null> => {
    const result = await showOpenIn(winOf(e.sender), {
      title: '打开思维导图',
      filters: [
        // .emmx 是亿图脑图（EdrawMind / MindMaster）的文件，能直接打开
        { name: '思维导图文件', extensions: ['xmind', 'emmx', 'emm'] },
        { name: 'Xmind 文件', extensions: ['xmind'] },
        { name: '亿图脑图文件', extensions: ['emmx', 'emm'] },
        { name: '全部文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    const file = firstPathOf(result)
    if (!file) return null
    return readDocumentInto(stateOf(e.sender), docId, file)
  })

  ipcMain.handle(IPC.openPath, async (e, docId: string, path: string): Promise<OpenResult> => {
    if (!isPlausibleFilePath(path)) throw new Error('文件路径无效，无法打开')
    return readDocumentInto(stateOf(e.sender), docId, path)
  })

  ipcMain.handle(
    IPC.saveToPath,
    async (e, docId: string, path: string, workbook: Workbook): Promise<SaveResult> => {
      // 写文件比读文件更值得拦：这条通道决定了"能往哪里写"
      if (!isPlausibleFilePath(path)) throw new Error('保存路径无效')
      return writeDocument(stateOf(e.sender), docId, ensureXmindExt(path), workbook)
    }
  )

  ipcMain.handle(
    IPC.saveAs,
    async (e, docId: string, workbook: Workbook, suggestedName: string): Promise<SaveResult | null> => {
      // 默认落在记住的保存目录（首次是「文档/思维导图」）
      const dir = await currentSaveDir()
      const result = await showSaveIn(winOf(e.sender), {
        title: '另存为',
        defaultPath: join(dir, suggestedName),
        filters: [{ name: '思维导图文件', extensions: ['xmind'] }]
      })
      if (result.canceled || !result.filePath) return null
      return writeDocument(stateOf(e.sender), docId, ensureXmindExt(result.filePath), workbook)
    }
  )

  ipcMain.handle(
    IPC.autosave,
    async (e, docId: string, workbook: Workbook, originalPath: string | null, title: string): Promise<void> => {
      const state = stateOf(e.sender)
      const doc = state && typeof docId === 'string' ? docOf(state, docId) : null
      if (!state) return
      await fs.mkdir(autosaveDir(), { recursive: true })
      if (doc) pruneForSave(doc, workbook)
      const bytes = await serializeXmind({ workbook, resources: doc?.resources ?? {} })
      // 存档也走原子写：半截的存档在恢复时会被判为损坏，等于白存一份
      await writeFileAtomic(autosaveFile(state.slot), bytes)
      const meta: RecoveryMeta = {
        originalPath: originalPath ?? null,
        title: title || '未命名导图',
        savedAt: Date.now()
      }
      await fs.writeFile(autosaveMeta(state.slot), JSON.stringify(meta))
    }
  )

  /** 只清「这个窗口」的存档：别的窗口还开着，不能把它们的存档一起删了 */
  ipcMain.handle(IPC.autosaveClear, async (e): Promise<void> => {
    const state = stateOf(e.sender)
    if (!state) return
    await fs.rm(autosaveFile(state.slot), { force: true })
    await fs.rm(autosaveMeta(state.slot), { force: true })
  })

  ipcMain.handle(IPC.recoveryCheck, async (e): Promise<RecoveryInfo | null> => {
    const state = stateOf(e.sender)
    if (!state) return null
    // 只有本次进程的**第一个窗口**问恢复：否则每开一个窗口都弹一遍上一次的存档
    if (state.id !== primaryWindowId) return null
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
    const state = stateOf(e.sender)
    if (!state || !existsSync(autosaveFile(state.slot))) return null
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
  })

  ipcMain.handle(IPC.recoveryDiscard, async (e): Promise<void> => {
    const state = stateOf(e.sender)
    if (!state) return
    await fs.rm(autosaveFile(state.slot), { force: true })
    await fs.rm(autosaveMeta(state.slot), { force: true })
  })

  /* ---- 应用设置（%APPDATA%\SMind\settings.json） ---- */

  ipcMain.handle(IPC.settingsLoad, async (): Promise<AppSettings> => {
    try {
      const raw = await fs.readFile(settingsFile(), 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      // 与默认值合并：文件缺字段 / 老版本写过的都还能读
      return {
        defaultViewLock:
          typeof parsed.defaultViewLock === 'boolean'
            ? parsed.defaultViewLock
            : DEFAULT_APP_SETTINGS.defaultViewLock,
        defaultThemeId:
          typeof parsed.defaultThemeId === 'string' && parsed.defaultThemeId.length > 0
            ? parsed.defaultThemeId
            : null,
        defaultAlign:
          parsed.defaultAlign === 'left' || parsed.defaultAlign === 'right'
            ? parsed.defaultAlign
            : DEFAULT_APP_SETTINGS.defaultAlign,
        defaultFontFamily:
          typeof parsed.defaultFontFamily === 'string' && parsed.defaultFontFamily.length > 0
            ? parsed.defaultFontFamily
            : null,
        defaultFontSize:
          typeof parsed.defaultFontSize === 'number' && parsed.defaultFontSize > 0
            ? parsed.defaultFontSize
            : null,
        defaultColor:
          typeof parsed.defaultColor === 'string' && parsed.defaultColor.length > 0
            ? parsed.defaultColor
            : null,
        defaultCodeFontSize:
          typeof parsed.defaultCodeFontSize === 'number' &&
          Number.isFinite(parsed.defaultCodeFontSize) &&
          parsed.defaultCodeFontSize >= 8
            ? Math.round(parsed.defaultCodeFontSize)
            : null,
        defaultCodeLanguage: CODE_LANGUAGES.includes(parsed.defaultCodeLanguage as never)
          ? (parsed.defaultCodeLanguage as string)
          : null,
        toolbarHidden: Array.isArray(parsed.toolbarHidden)
          ? parsed.toolbarHidden.filter((item): item is string => typeof item === 'string')
          : []
      }
    } catch {
      return { ...DEFAULT_APP_SETTINGS }
    }
  })

  ipcMain.handle(IPC.settingsSave, async (_e, settings: AppSettings): Promise<void> => {
    const next: AppSettings = {
      defaultViewLock: Boolean(settings?.defaultViewLock),
      defaultThemeId:
        typeof settings?.defaultThemeId === 'string' && settings.defaultThemeId.length > 0
          ? settings.defaultThemeId
          : null,
      defaultAlign:
        settings?.defaultAlign === 'left' || settings?.defaultAlign === 'right'
          ? settings.defaultAlign
          : 'center',
      defaultFontFamily:
        typeof settings?.defaultFontFamily === 'string' && settings.defaultFontFamily.length > 0
          ? settings.defaultFontFamily
          : null,
      defaultFontSize:
        typeof settings?.defaultFontSize === 'number' && settings.defaultFontSize > 0
          ? settings.defaultFontSize
          : null,
      defaultColor:
        typeof settings?.defaultColor === 'string' && settings.defaultColor.length > 0
          ? settings.defaultColor
          : null,
      defaultCodeFontSize:
        typeof settings?.defaultCodeFontSize === 'number' &&
        Number.isFinite(settings.defaultCodeFontSize) &&
        settings.defaultCodeFontSize >= 8
          ? Math.round(settings.defaultCodeFontSize)
          : null,
      defaultCodeLanguage: CODE_LANGUAGES.includes(settings?.defaultCodeLanguage as never)
        ? (settings.defaultCodeLanguage as string)
        : null,
      toolbarHidden: Array.isArray(settings?.toolbarHidden)
        ? settings.toolbarHidden.filter((item) => typeof item === 'string')
        : []
    }
    await fs.writeFile(settingsFile(), JSON.stringify(next, null, 2), 'utf8')
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

  ipcMain.handle(IPC.themesImport, async (e): Promise<ThemeDefinition | null> => {
    const result = await showOpenIn(winOf(e.sender), {
      title: '导入主题',
      filters: [{ name: '主题文件', extensions: ['json'] }],
      properties: ['openFile']
    })
    const file = firstPathOf(result)
    if (!file) return null

    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    const candidate = isRecord(parsed) && 'theme' in parsed ? parsed.theme : parsed
    const theme = normalizeThemeDefinition(candidate, { builtin: false })
    if (!theme) throw new Error('主题文件格式不正确，请确认是本软件导出的主题文件')
    // 分配新 id，避免覆盖已有的自定义主题
    return { ...theme, id: `custom-${Date.now().toString(36)}`, builtin: false }
  })

  ipcMain.handle(IPC.themesExport, async (e, theme: ThemeDefinition): Promise<boolean> => {
    const result = await showSaveIn(winOf(e.sender), {
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

  ipcMain.handle(IPC.pickImage, async (e, docId: string): Promise<PickedImage | null> => {
    const result = await showOpenIn(winOf(e.sender), {
      title: '插入图片',
      filters: [{ name: '图片', extensions: IMAGE_EXTENSIONS }],
      properties: ['openFile']
    })
    const file = firstPathOf(result)
    if (!file) return null

    const buf = await fs.readFile(file)
    return registerImageBytes(stateOf(e.sender), docId, safeResourceName(file), buf)
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
        return registerImageBytes(stateOf(e.sender), docId, `剪贴板图片.${extension}`, buf)
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
      return registerImageBytes(stateOf(e.sender), docId, name, Buffer.from(bytes))
    }
  )

  ipcMain.handle(IPC.pickAttachment, async (e, docId: string): Promise<PickedAttachment | null> => {
    const result = await showOpenIn(winOf(e.sender), {
      title: '添加附件',
      filters: [{ name: '所有文件', extensions: ['*'] }],
      properties: ['openFile']
    })
    const file = firstPathOf(result)
    if (!file) return null

    const buf = await fs.readFile(file)
    const path = resourcePathFor(createId('att'), file)
    const state = stateOf(e.sender)
    if (state && typeof docId === 'string') {
      const doc = docOf(state, docId)
      doc.resources[path] = new Uint8Array(buf)
      doc.inserted.add(path)
    }

    return {
      id: createId('att'),
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

  ipcMain.handle(IPC.saveAttachmentAs, async (e, path: string, suggestedName: string): Promise<boolean> => {
    const bytes = resourceBytesOf(path)
    if (!bytes) return false
    const result = await showSaveIn(winOf(e.sender), {
      title: '导出附件',
      defaultPath: suggestedName || safeResourceName(path)
    })
    if (result.canceled || !result.filePath) return false
    await fs.writeFile(result.filePath, Buffer.from(bytes))
    return true
  })

  /* ---- 大纲导出（P5） ---- */

  ipcMain.handle(IPC.exportOutline, async (e, workbook: Workbook, format: OutlineFormat): Promise<string | null> => {
    const def = outlineFormatDef(format)
    const content = buildOutline(workbook, format)

    const result = await showSaveIn(winOf(e.sender), {
      title: def.dialogTitle,
      // 默认文件名用中心主题的名字
      defaultPath: defaultFileName(workbook, def.ext),
      filters: [
        { name: def.label, extensions: [def.ext] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePath) return null

    const target = result.filePath.toLowerCase().endsWith(`.${def.ext}`)
      ? result.filePath
      : `${result.filePath}.${def.ext}`
    await fs.writeFile(target, content, 'utf8')
    return target
  })

  /* ---- 图片导出（P6） ---- */

  /**
   * 渲染进程负责排版与栅格化，这里只弹保存框、落盘。
   * SVG 是文本按 UTF-8 写，PNG/PDF 是字节按二进制写。
   */
  ipcMain.handle(
    IPC.saveExport,
    async (e, data: Uint8Array | string, fileName: string, ext: ImageExportFormat): Promise<string | null> => {
      const def = imageExportFormatDef(ext)
      const result = await showSaveIn(winOf(e.sender), {
        title: `导出为 ${def.label}`,
        defaultPath: fileName || `思维导图.${def.ext}`,
        filters: [
          { name: def.label, extensions: [def.ext] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (result.canceled || !result.filePath) return null

      const target = result.filePath.toLowerCase().endsWith(`.${def.ext}`)
        ? result.filePath
        : `${result.filePath}.${def.ext}`

      if (typeof data === 'string') await fs.writeFile(target, data, 'utf8')
      else await fs.writeFile(target, Buffer.from(data))
      return target
    }
  )

  /* ---- AI（P8） ---- */

  ipcMain.handle(IPC.aiConfigGet, async (): Promise<AiConfigView> => toConfigView(await readAiConfig()))

  ipcMain.handle(IPC.aiConfigSave, async (_e, patch: AiConfigPatch): Promise<AiConfigView> => {
    const current = await readAiConfig()
    const merged: AiConfig = {
      baseUrl: typeof patch.baseUrl === 'string' && patch.baseUrl.trim().length > 0 ? patch.baseUrl.trim() : current.baseUrl,
      model: typeof patch.model === 'string' && patch.model.trim().length > 0 ? patch.model.trim() : current.model,
      temperature: typeof patch.temperature === 'number' ? patch.temperature : current.temperature,
      // 空字符串表示「不改动已保存的 Key」，避免用户看不到明文时误清空
      apiKey: typeof patch.apiKey === 'string' && patch.apiKey.trim().length > 0 ? patch.apiKey.trim() : current.apiKey
    }
    const { config } = normalizeAiConfig(merged)
    await writeAiConfig(config)
    return toConfigView(config)
  })

  ipcMain.handle(
    IPC.aiChat,
    async (_e, messages: AiMessage[], options?: { timeoutMs?: number }): Promise<AiChatResult> => {
      const config = await readAiConfig()
      return callAi(config, messages, options?.timeoutMs ?? 120000)
    }
  )

  ipcMain.handle(IPC.aiTest, async (): Promise<AiTestResult> => {
    const config = await readAiConfig()
    try {
      const result = await callAi(
        config,
        [{ role: 'user', content: '请只回复两个字：正常' }],
        25000
      )
      return { ok: true, message: `连接正常（模型 ${result.model}）：${result.content.trim().slice(0, 20)}` }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  })

  /* ---- 大纲文件导入（Markdown / OPML） ---- */

  ipcMain.handle(IPC.importText, async (e, kind: 'markdown' | 'opml'): Promise<ImportedTextFile | null> => {
    const isMarkdown = kind !== 'opml'
    const result = await showOpenIn(winOf(e.sender), {
      title: isMarkdown ? '导入 Markdown 生成导图' : '导入 OPML 生成导图',
      filters: isMarkdown
        ? [
            { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
            { name: '所有文件', extensions: ['*'] }
          ]
        : [
            { name: 'OPML', extensions: ['opml', 'xml'] },
            { name: '所有文件', extensions: ['*'] }
          ],
      properties: ['openFile']
    })
    const path = firstPathOf(result)
    if (!path) return null

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
  })

  /* ---- 历史记录与常用（P9+） ---- */

  ipcMain.handle(IPC.historyList, async (): Promise<HistoryEntry[]> => listHistory())

  ipcMain.handle(IPC.historyTogglePin, async (_e, path: string): Promise<HistoryEntry[]> => togglePin(path))

  ipcMain.handle(IPC.historyRemove, async (_e, path: string): Promise<HistoryEntry[]> => removeEntry(path))

  ipcMain.handle(IPC.historyClear, async (): Promise<HistoryEntry[]> => clearAllHistory())

  ipcMain.handle(IPC.historySaveDir, async (): Promise<string> => currentSaveDir())

  ipcMain.handle(IPC.historyChooseSaveDir, async (e): Promise<string | null> => {
    const result = await showOpenIn(winOf(e.sender), {
      title: '选择默认保存位置',
      defaultPath: await currentSaveDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    const dir = firstPathOf(result)
    return dir ? rememberSaveDir(dir) : null
  })

  ipcMain.handle(IPC.historyReveal, async (_e, path: string): Promise<void> => {
    if (isPlausibleFilePath(path) && existsSync(path)) shell.showItemInFolder(path)
  })

  /* ---- 文档版本快照（P9+） ---- */

  ipcMain.handle(
    IPC.snapshotList,
    async (_e, path: string | null): Promise<SnapshotItem[]> => listSnapshots(path)
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
      const state = stateOf(e.sender)
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

  ipcMain.handle(IPC.snapshotRestore, async (e, docId: string, id: string): Promise<SnapshotRestoreResult> => {
    const bytes = await readSnapshotBytes(id)
    if (!bytes) throw new Error('这个版本的文件已经不在了，可能被清理过')
    const parsed = await parseXmind(bytes)
    // 与打开文件一致：资源必须留在主进程，否则「恢复后再保存」会把图片丢掉
    const state = stateOf(e.sender)
    if (state && typeof docId === 'string') {
      const doc = docOf(state, docId)
      doc.resources = parsed.resources
      doc.inserted.clear()
    }
    return {
      workbook: parsed.workbook,
      warnings: parsed.warnings,
      resourceCount: Object.keys(parsed.resources).length
    }
  })

  ipcMain.handle(
    IPC.snapshotRemove,
    async (_e, id: string, path: string | null): Promise<SnapshotItem[]> => removeSnapshotById(id, path)
  )

  ipcMain.handle(
    IPC.snapshotClear,
    async (_e, path: string | null): Promise<SnapshotItem[]> => clearSnapshotsFor(path)
  )

  ipcMain.on(IPC.confirmClose, (e) => {
    const state = stateOf(e.sender)
    if (!state) return
    state.allowClose = true

    if (quitRequested) {
      // 退出流程：**所有**窗口都确认过（或已经不可用）才真的退
      const blocked = [...windows.values()].some(
        (item) => !item.allowClose && !item.win.webContents.isDestroyed()
      )
      if (!blocked) {
        quitApproved = true
        app.quit()
      }
      return
    }
    if (!state.win.isDestroyed()) state.win.close()
  })

  ipcMain.on(IPC.setTitle, (e, title: string) => {
    const win = winOf(e.sender)
    if (win) win.setTitle(title)
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
    if (isPlausibleFilePath(path) && existsSync(path)) shell.showItemInFolder(path)
  })
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

// 单实例：两个进程同时读写同一份自动存档与主题文件会互相覆盖。
// 注意「单实例」指的是**一个进程**，不是「一个窗口」——多窗口由本进程内管。
if (!app.requestSingleInstanceLock()) {
  // 这里**必须**留一行日志：静默退出是最难查的一类现象，
  // 排查者看到的会是"启动干干净净、然后什么都没了"，很容易误判成崩溃。
  // 真实原因通常只是"已经开着一个实例（比如打包版）占用了单实例锁"。
  logMain('single-instance', '已有实例在运行，本进程退出（新实例只负责把文件路径交给已有窗口）')
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // 又双击了一个 .xmind（或又开了一次 exe）：新实例把路径塞在 argv 里传过来。
    // 已经开着同一个文件就聚焦那个窗口，否则**开一个新窗口**——
    // 这样「双击第二个文件」不会把当前正在编辑的文档顶掉。
    const target = pickDocumentArg(argv, existsSync)
    if (target) {
      openDocumentSomewhere(target)
      return
    }
    const current = focusedState()
    if (current && !current.win.isDestroyed()) {
      if (current.win.isMinimized()) current.win.restore()
      current.win.focus()
    } else {
      createWindow()
    }
  })

  // macOS 的「用本应用打开文件」
  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (app.isReady()) openDocumentSomewhere(path)
  })

  void app.whenReady().then(() => {
    registerResourceProtocol()
    registerIpc()
    buildAppMenu({
      newWindow: () => createWindow(),
      // 目录可能还没建（只在真出过错时才写日志）：先建再开，否则「打开」是无声失败
      openLogs: () => {
        void fs.mkdir(logDirectory(), { recursive: true }).then(() => shell.openPath(logDirectory()))
      }
    })
    // 上一次运行崩溃时可能留下画布副本的临时文件：超过一天的一律清掉
    void pruneStaleCopies()
    // 第一个窗口认领「启动时带的那个文件」（双击 .xmind / 拖到 exe 上 / 右键打开方式）
    createWindow({ path: startupOpenPath })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * 退出前也要走一遍未保存确认——**每个窗口都要问**。
 * 之前这里只问了一个窗口，多窗口下「退出」会静默丢掉其他窗口的未保存修改。
 */
app.on('before-quit', (event) => {
  if (quitApproved) return
  const pending = [...windows.values()].filter(
    (state) => !state.allowClose && !state.win.webContents.isDestroyed()
  )
  if (pending.length === 0) {
    quitApproved = true
    return
  }
  event.preventDefault()
  quitRequested = true
  for (const state of pending) state.win.webContents.send(IPC.closeRequest)
})

/**
 * 进程级兜底：未捕获异常与未处理的 Promise 拒绝都落盘（日志目录可直接打开查看）。
 *
 * **刻意不退出**：主进程在大多数异常之后仍能继续服务；一旦在这里 quit()，
 * 用户正在编辑的内容会跟着窗口一起消失——那才是最大的损失。
 */
process.on('uncaughtException', (error) => {
  logMain('uncaughtException', error)
})

process.on('unhandledRejection', (reason) => {
  logMain('unhandledRejection', reason)
})
