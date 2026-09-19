import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  protocol,
  shell
} from 'electron'
import { isInstanceAlive, isRecord, isSelfNavigation } from '../shared/guards'
import { checkImagePayload, isPlausibleFilePath } from '@shared/ipc-args'
import { writeFileAtomic, writeJsonAtomic } from './atomic-write'
import { logDirectory, logMain } from './log'
import { DOCUMENT_EXTENSIONS, extractDocumentFromBytes, extractDocumentFromPath } from './document'
import { pathFromFileUrl, type ExtractedDocument } from '@shared/document'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
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
  normalizeAiConfig,
  normalizeChatHistory,
  toConfigView,
  type AiConfig,
  type AiConfigView,
  type AiMessage,
  type ChatHistoryEntry
} from '@shared/ai'
import { normalizeConfirmSkip, planAvailableTools } from '@shared/agent'
import { hasWriteToolCall, markTrialTurnSeen, type LicenseView } from '@shared/license'
import { activateLicense, consumeTrialTurn, deactivateLicense, getLicenseView } from './license'
import type { Workbook } from '@shared/model/types'
import { createId } from '@shared/model/factory'
import {
  IMAGE_EXTENSIONS,
  mimeOfPath,
  resourcePathFor,
  safeResourceName
} from '@shared/model/resources'
import { parseXmind } from '@shared/xmind/parse'
import { serializeXmind } from '@shared/xmind/serialize'
import { buildOutline, outlineFormatDef, type OutlineFormat } from '@shared/outline'
import { defaultFileName } from '@shared/model/naming'
import { documentKeyOf, type SnapshotItem, type SnapshotReason } from '@shared/snapshot'
import { currentSaveDir } from './history'
import {
  clearSnapshotsFor,
  createSnapshot,
  listSnapshots,
  readSnapshotBytes,
  removeSnapshotById,
  snapshotOwnerKey
} from './snapshot'
import { imageExportFormatDef, type ImageExportFormat } from '@shared/export/types'
import { normalizeThemeDefinition, type ThemeDefinition } from '@shared/theme'
import { shouldOfferRecovery, type RecoveryMeta } from '@shared/recovery'
import { autosaveSlotName, sameDocPath } from '@shared/window'
import { CODE_LANGUAGES } from '@shared/code-language'
import { buildAppMenu } from './menu'
import { checkForUpdateInteractive, startAutoUpdate } from './update'
import { createMainContext, type DocWindow } from './context'
import { showOpenIn, showSaveIn } from './dialogs'
import { ensureXmindExt, firstPathOf, readDocumentInto, writeDocument } from './files'
import { docOf, pruneForSave } from './doc-resources'
import { registerHistoryIpc } from './ipc/history'
import { readThemes, writeThemes } from './themes'
import {
  autosaveDir,
  autosaveFile,
  autosaveMeta,
  copyDir,
  pruneStaleCopies,
  readAutosaveMeta
} from './autosave'
import {
  WRITE_TOOL_NAMES,
  callAi,
  callAiStream,
  countedTrialTurns,
  migrateAiConfigKey,
  readAiConfig,
  settingsFile,
  streamAborters,
  writeAiConfig
} from './ai'

/** 应用名：与 electron-builder 的 productName、窗口标题保持一致 */
const APP_NAME = 'SMind'

/**
 * 开发模式下的窗口/任务栏图标（打包后由 exe 自带图标，不需要它）。
 * 用 existsSync 判断：打包后这个路径不存在，直接跳过而不是报错。
 */
const devIconFile = join(__dirname, '../../build/icon.png')

const isDev = !app.isPackaged

/**
 * 开发版打开远程调试端口（只绑本机）。
 *
 * 唯一用途：**卡死时抓 CPU 火焰图**。`unresponsive` 只能告诉我们「卡了」，
 * 抓不到「卡在哪个函数」——这次为了定位这个循环花了很多来回，有火焰图就是一眼的事。
 */
if (isDev) app.commandLine.appendSwitch('remote-debugging-port', '9222')

/**
 * 可选：给渲染进程开 V8 采样（`SMIND_PROFILE=1` 启动）。
 *
 * 卡死时主线程不回话、调试命令进不去，只能靠 V8 自己在进程里记采样——
 * 之后用 `node --prof-process isolate-*.log` 就能看到**卡在哪个函数**。
 * 默认关闭（有性能开销），只在专门排查时打开。
 */
if (isDev && process.env.SMIND_PROFILE === '1') {
  app.commandLine.appendSwitch('js-flags', '--prof')
}

/**
 * 图片/附件通过自定义协议喂给渲染进程，而不是把二进制塞进 IPC 或 data URL。
 * 必须在 app ready 之前登记，否则 scheme 不会被当作「标准且安全」的来源。
 */
const RESOURCE_SCHEME = 'mind-resource'
/** docId 的长度上限：它会被当成主进程里的 map 键（`docOf`），脏输入不该让主进程无界长胖 */
const DOC_ID_MAX = 120
protocol.registerSchemesAsPrivileged([
  {
    scheme: RESOURCE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

/* ------------------------------------------------------------------ */
/* 跨域共享状态容器                                                  */
/* ------------------------------------------------------------------ */

/**
 * 整个进程一份。域处理器不再直接摸模块级变量，一律经它取用
 * （类型与访问器见 `./context`：窗口表、文档资源表、退出标志）。
 */
const ctx = createMainContext()

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 开一个窗口 = 开一份文档。
 *
 * `options.path` 只在「启动时带文件 / 双击文件 / 二实例传参」时给：
 * 那一刻 React 可能还没挂载，所以路径先存在窗口状态里，渲染进程就绪后自己来取一次。
 */
function createWindow(
  options: { path?: string | null; copySource?: string | null } = {}
): DocWindow {
  const slot = autosaveSlotName(ctx.nextWindowSeq())

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
    uiBroken: false,
    pendingPath: options.path ?? null,
    copySource: options.copySource ?? null
  }
  ctx.windows.set(state.id, state)

  // 只有本次进程的第一个窗口负责询问「上次没保存完的文档要不要恢复」
  ctx.claimPrimaryWindow(state.id)

  win.on('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })

  // 页面重新加载完成 = 界面又活了，清掉「已损坏」标记
  win.webContents.on('did-finish-load', () => {
    state.uiBroken = false
  })

  // 开发期把渲染进程的 console 转发到终端，方便定位报错
  if (isDev) {
    win.webContents.on('console-message', (details) => {
      const level = details.level ?? 'info'
      if (level === 'error' || level === 'warning') {
        console.log(
          `[renderer:${level}] ${details.message} (${details.sourceId ?? ''}:${details.lineNumber ?? 0})`
        )
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
  /** 卡死自救定时器（见下面的 unresponsive 处理） */
  let unresponsiveTimer: NodeJS.Timeout | null = null

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
    /**
     * **卡死自救**：界面卡住超过 10 秒就自动重新加载。
     *
     * 为什么必须这么硬：主线程被同步死循环占住时，窗口连「关闭」都点不动、
     * 连调试命令都不返回——用户除了强杀进程没有别的办法（真被投诉过多次）。
     * 而主进程是好的，所以这条自救路线一定走得通。
     * 文档每 30 秒有一份自动存档兜底，重载是当下唯一能让用户继续干活的选择。
     */
    if (unresponsiveTimer === null) {
      unresponsiveTimer = setTimeout(() => {
        unresponsiveTimer = null
        if (win.isDestroyed()) return
        logMain('unresponsive-reload', '界面无响应超过 10 秒，自动重新加载')
        win.webContents.reload()
        void dialog
          .showMessageBox(win, {
            type: 'info',
            title: '界面刚才卡住了',
            message: '界面进程卡住超过 10 秒，已自动重新加载。',
            detail:
              '文档每 30 秒会存一份自动存档；如果最近几十秒的改动还没进存档，可能会少一点点。' +
              '这条记录已经写进日志，方便定位。',
            buttons: ['好']
          })
          .catch(() => undefined)
      }, 10_000)
    }
  })

  win.webContents.on('responsive', () => {
    // 自己缓过来了：撤掉自救，别把用户的活儿 reload 掉
    if (unresponsiveTimer !== null) {
      clearTimeout(unresponsiveTimer)
      unresponsiveTimer = null
      logMain('responsive', '渲染进程已恢复响应（未触发重载）')
    }
  })

  /**
   * 渲染层的 console 落进应用日志。
   *
   * 卡死这种问题，主进程只能看到「无响应」，看不到**是谁**在刷警告/报错；
   * 把渲染层的 warning/error 收上来，下次翻日志就能直接定位。
   */
  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    // Electron 32+ 把详情挂在事件对象上（新签名只给一个参数），旧签名仍传位置参数。
    // 两种都兼容：这条通道是**卡死取证唯一可靠的出口**（渲染进程被堵死时，
    // 只有已经写出来的 console 能被主进程落到日志里），不能因为签名变化静默失效。
    const details = event as unknown as {
      message?: unknown
      level?: unknown
      lineNumber?: unknown
      sourceId?: unknown
    }
    const text =
      typeof details.message === 'string'
        ? details.message
        : typeof message === 'string'
          ? message
          : ''
    const rawLevel: unknown = details.level ?? level
    const source = typeof details.sourceId === 'string' ? details.sourceId : sourceId
    const lineNo = typeof details.lineNumber === 'number' ? details.lineNumber : line

    // 阶段心跳（[stage] 开头）一律记：卡死时它就是现场——最后一条 heartbeat 说明卡在哪一步
    if (text.startsWith('[stage]')) {
      logMain('stage', text)
      return
    }
    const severe =
      typeof rawLevel === 'string'
        ? rawLevel === 'warning' || rawLevel === 'error'
        : typeof rawLevel === 'number'
          ? rawLevel >= 2
          : false
    if (!severe) return
    const label = typeof rawLevel === 'string' ? rawLevel : rawLevel === 3 ? 'error' : 'warn'
    logMain('renderer-console', `${label} ${text}`, `${source}:${lineNo}`)
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
    // **刷新也走这个事件**：一刀切 preventDefault 会把「重新加载界面」变成死按钮，
    // 开发期 Vite 的整页刷新同样被拦（热更新推了新代码也回不来）。
    // 放行「回到自身页面」的导航，其余（拖进来的图片 / PDF / 外链）继续拦。
    if (isSelfNavigation(win.isDestroyed() ? '' : win.webContents.getURL(), url)) return

    event.preventDefault()
    if (!url.startsWith('file://')) return
    try {
      // 路径还原（含 UNC 共享盘、POSIX 绝对路径）统一走这个纯函数，它有自己的断言
      const target = pathFromFileUrl(url)
      if (target === null) return
      const picked = pickDocumentArg([target], existsSync)
      if (picked && !win.isDestroyed()) win.webContents.send(IPC.fileOpenRequest, picked)
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
    // 界面已进入错误状态：渲染层里**没有任何组件**能回应关闭请求
    // （错误边界把 App 卸载了）。再等下去就是「窗口关不掉，只能去任务管理器」。
    if (state.uiBroken) {
      logMain('close-with-broken-ui', '界面处于错误状态，跳过未保存确认直接关闭')
      state.allowClose = true
      return
    }
    e.preventDefault()
    contents.send(IPC.closeRequest)
  })

  win.on('closed', () => {
    ctx.windows.delete(state.id)
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
  for (const state of ctx.windows.values()) {
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
  const current = ctx.focusedState()
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
  for (const state of ctx.windows.values()) {
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
    const state = ctx.stateOf(e.sender)
    if (!state) return null
    const target = state.pendingPath
    state.pendingPath = null
    return target
  })

  /** 渲染进程报告「某个标签现在打开的是哪个文件」（新建＝null）：用于同文件不重复开窗/开标签 */
  ipcMain.on(IPC.documentPath, (e, docId: string, path: string | null) => {
    const state = ctx.stateOf(e.sender)
    if (!state || typeof docId !== 'string') return
    docOf(state, docId).docPath = typeof path === 'string' && path.length > 0 ? path : null
  })

  /** 释放一个文档（标签关闭）：丢掉它的资源表；自动存档槽位不归它管 */
  ipcMain.handle(IPC.releaseDoc, async (e, docId: string): Promise<void> => {
    const state = ctx.stateOf(e.sender)
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
      const state = ctx.stateOf(e.sender)
      if (!state) return 'failed'
      try {
        await fs.mkdir(copyDir(), { recursive: true })
        const doc = typeof docId === 'string' ? docOf(state, docId) : null
        if (doc) pruneForSave(doc, workbook)
        const bytes = await serializeXmind({ workbook, resources: doc?.resources ?? {} })
        const copyPath = join(copyDir(), `${state.slot}-copy-${randomUUID()}.xmind`)
        await fs.writeFile(copyPath, Buffer.from(bytes))
        createWindow({ path: copyPath, copySource: copyPath })
        return 'ok'
      } catch (error) {
        /**
         * 失败要**留下可查的痕迹**：以前这里只有一个裸 `catch {}`，
         * 用户看到"新窗口打不开"、日志里什么都没有，只能靠猜。
         * 返回值仍是 'failed'（渲染层的契约不变），但主进程日志里有原因。
         */
        logMain('open-sheet-window-failed', (error as Error).message)
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
    const result = await showOpenIn(ctx.winOf(e.sender), {
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
      await writeFileAtomic(autosaveFile(state.slot), bytes)
      const meta: RecoveryMeta = {
        originalPath: originalPath ?? null,
        title: title || '未命名导图',
        savedAt: Date.now()
      }
      // 元信息也要原子写：它是"这次自动保存对应哪份原稿"的唯一凭证，
      // 半截 JSON 会让恢复功能读不出标题与原路径（正文却好端端地在那儿）
      await writeJsonAtomic(autosaveMeta(state.slot), meta)
    }
  )

  /** 只清「这个窗口」的存档：别的窗口还开着，不能把它们的存档一起删了 */
  ipcMain.handle(IPC.autosaveClear, async (e): Promise<void> => {
    const state = ctx.stateOf(e.sender)
    if (!state) return
    await fs.rm(autosaveFile(state.slot), { force: true })
    await fs.rm(autosaveMeta(state.slot), { force: true })
  })

  ipcMain.handle(IPC.recoveryCheck, async (e): Promise<RecoveryInfo | null> => {
    const state = ctx.stateOf(e.sender)
    if (!state) return null
    // 只有本次进程的**第一个窗口**问恢复：否则每开一个窗口都弹一遍上一次的存档
    if (!ctx.isPrimaryWindow(state.id)) return null
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
    const state = ctx.stateOf(e.sender)
    if (!state || !existsSync(autosaveFile(state.slot))) return null
    // docId 会被当 map 键用（docOf）：加个长度上限，脏输入不该让主进程无界长胖
    if (typeof docId === 'string' && docId.length > DOC_ID_MAX) return null
    /**
     * **必须兜住异常**：要恢复的是自动保存的临时存档，它很可能正是上次断电/崩溃时写坏的那一份。
     * 以前这里没有 try/catch，`parseXmind` 一抛就把整个 IPC 变成 rejected——渲染层 `await` 直接炸，
     * 用户看到的是"启动提示可恢复 → 点恢复 → 满屏报错"，而正确处理是
     * "读不出来就当没有可恢复的存档"（返回 null，界面照常进空文档）。
     */
    try {
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
    } catch (error) {
      logMain('recovery-load-failed', (error as Error).message)
      return null
    }
  })

  ipcMain.handle(IPC.recoveryDiscard, async (e): Promise<void> => {
    const state = ctx.stateOf(e.sender)
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
          : [],
        // 手改坏 / 旧版本的脏值不许把确认框永久关掉
        aiConfirmSkip: normalizeConfirmSkip(parsed.aiConfirmSkip)
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
        : [],
      // 只认清单里认识的破坏性种类：脏数据不许把确认框永久关掉
      aiConfirmSkip: normalizeConfirmSkip(settings?.aiConfirmSkip)
    }
    await writeJsonAtomic(settingsFile(), next)
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
    const result = await showOpenIn(ctx.winOf(e.sender), {
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
    const result = await showSaveIn(ctx.winOf(e.sender), {
      title: '导出主题',
      defaultPath: `${theme.name || '主题'}.json`,
      filters: [{ name: '主题文件', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return false
    const target = result.filePath.toLowerCase().endsWith('.json')
      ? result.filePath
      : `${result.filePath}.json`
    await fs.writeFile(
      target,
      JSON.stringify({ type: 'mindmap-theme', version: 1, theme }, null, 2)
    )
    return true
  })

  /* ---- 图片与附件（P4） ---- */

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

  /* ---- 大纲导出（P5） ---- */

  ipcMain.handle(
    IPC.exportOutline,
    async (e, workbook: Workbook, format: OutlineFormat): Promise<string | null> => {
      const def = outlineFormatDef(format)
      const content = buildOutline(workbook, format)

      const result = await showSaveIn(ctx.winOf(e.sender), {
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
    }
  )

  /* ---- 图片导出（P6） ---- */

  /**
   * 渲染进程负责排版与栅格化，这里只弹保存框、落盘。
   * SVG 是文本按 UTF-8 写，PNG/PDF 是字节按二进制写。
   */
  ipcMain.handle(
    IPC.saveExport,
    async (
      e,
      data: Uint8Array | string,
      fileName: string,
      ext: ImageExportFormat
    ): Promise<string | null> => {
      const def = imageExportFormatDef(ext)
      const result = await showSaveIn(ctx.winOf(e.sender), {
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

  /**
   * SVG → **矢量 PDF**。
   *
   * 为什么放在主进程：渲染进程没有"打印"能力，而 `webContents.printToPDF` 正是
   * Chromium 的打印管线——文字是真字（可选中、可搜索）、图形是真矢量、中文交给系统字体。
   * 这正是位图 PDF 缺的三样（早期版本是"把画布栅格化后塞进 PDF 当图片"）。
   *
   * 三条硬性约束：
   * ① **失败一律返回 null**，由渲染层回落到位图 PDF——导出绝不能因为"想要矢量"而失败；
   * ② 内容先落到临时文件再 `loadFile`：导出的 SVG 里内嵌着图片与公式的 data URL，
   *    大文档下几百 KB 起步，走 `data:` URL 不稳；
   * ③ 页面尺寸按 CSS px 交给 `@page`，`preferCSSPageSize` 让它 1:1 对上导出坐标系
   *    （1px = 1/96 英寸），不需要再折算缩放。
   */
  async function svgToPdf(svg: string, width: number, height: number): Promise<Uint8Array | null> {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
      return null
    /**
     * Chromium 的页面尺寸上限是 200 英寸。超出就直接放弃（回落到位图），
     * 免得让用户等一次注定失败的转换。
     */
    const MAX_INCH = 190
    if (width / 96 > MAX_INCH || height / 96 > MAX_INCH) return null

    const pageWidth = Math.ceil(width)
    const pageHeight = Math.ceil(height)
    const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  /* 页面比内容多留 1px：正好相等时 Chromium 偶尔会多生成一张空白页 */
  @page { size: ${pageWidth + 1}px ${pageHeight + 1}px; margin: 0 }
  html, body { margin: 0; padding: 0; background: #ffffff; overflow: hidden }
  svg { display: block }
</style></head><body>${svg}</body></html>`

    /**
     * 临时 HTML 的文件名要**唯一**，不能只靠毫秒时间戳：
     * 连点两次导出、或同时导两份，同一毫秒内会撞名——后写的把前一份替换掉，
     * 于是"导出的 PDF 内容是另一张图"（或者 loadFile 读到一半被换掉）。
     */
    const tempPath = join(app.getPath('temp'), `smind-export-${randomUUID()}.html`)
    let win: BrowserWindow | null = null
    try {
      await fs.writeFile(tempPath, html, 'utf8')
      win = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: {
          // 这份内容完全由我们自己生成（SVG 字符串），关掉一切用不上的能力
          javascript: false,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      })
      await win.loadFile(tempPath)
      const buffer = await win.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        margins: { top: 0, bottom: 0, left: 0, right: 0 }
      })
      return new Uint8Array(buffer)
    } catch (error) {
      logMain('导出矢量 PDF 失败，回落到位图', error)
      return null
    } finally {
      if (win && !win.isDestroyed()) win.destroy()
      void fs.rm(tempPath, { force: true }).catch(() => undefined)
    }
  }

  ipcMain.handle(
    IPC.svgToPdf,
    async (_e, svg: string, width: number, height: number): Promise<Uint8Array | null> => {
      // 入参来自渲染进程：只做"是不是字符串/有限数字"这一层形状校验，
      // 真正的安全边界是"内容只被当成 SVG 渲染、且窗口没有任何权限"
      if (typeof svg !== 'string' || svg.length === 0 || svg.length > 64 * 1024 * 1024) return null
      return svgToPdf(svg, Number(width), Number(height))
    }
  )

  /* ---- AI（P8） ---- */

  ipcMain.handle(IPC.aiConfigGet, async (): Promise<AiConfigView> =>
    toConfigView(await readAiConfig())
  )

  ipcMain.handle(IPC.aiConfigSave, async (_e, patch: AiConfigPatch): Promise<AiConfigView> => {
    const current = await readAiConfig()
    const merged: AiConfig = {
      baseUrl:
        typeof patch.baseUrl === 'string' && patch.baseUrl.trim().length > 0
          ? patch.baseUrl.trim()
          : current.baseUrl,
      model:
        typeof patch.model === 'string' && patch.model.trim().length > 0
          ? patch.model.trim()
          : current.model,
      temperature: typeof patch.temperature === 'number' ? patch.temperature : current.temperature,
      // 0 是合规值（表示"不发送 max_tokens"），不能用 `||` 兜底
      maxTokens:
        typeof patch.maxTokens === 'number' && Number.isFinite(patch.maxTokens)
          ? Math.round(patch.maxTokens)
          : current.maxTokens,
      // 质量档位：不传就沿用已保存的（normalizeAiConfig 会挡掉非法值）
      tier: patch.tier ?? current.tier,
      // 空字符串表示「不改动已保存的 Key」，避免用户看不到明文时误清空
      apiKey:
        typeof patch.apiKey === 'string' && patch.apiKey.trim().length > 0
          ? patch.apiKey.trim()
          : current.apiKey
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
      return {
        ok: true,
        message: `连接正常（模型 ${result.model}）：${result.content.trim().slice(0, 20)}`
      }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  })

  ipcMain.handle(
    IPC.aiChatStream,
    async (e, requestId: unknown, messages: unknown, options: unknown): Promise<void> => {
      // 这条通道直连网络且带着 Key，渲染层给的一切都不默认可信，逐项校验
      if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) {
        throw new Error('流式请求标识无效')
      }
      // 额度按**真实使用**定，不按想象的边界定。
      //
      // 这套校验是安全网（渲染层给的东西不默认可信），**不是体验闸门**：
      // 以前它会把正常用法挡回去，而且只回一句「对话内容无效」，谁也查不出为什么。
      // 两个真实踩过的坑：
      //   ① 一次批量发**几十个**工具调用（大文档批量删除/改名时很自然）→ 撞上
      //      这里原本 `toolCalls.length > 20` 的上限，整回合直接死掉；
      //   ② 粘贴一整篇长文档 → 撞 6 万字上限。
      // 所以：额度放到「只拦垃圾」的量级，并且报错必须说清**第几条、哪个字段**。
      const MAX_MESSAGES = 400
      const MAX_CONTENT = 1_000_000
      const MAX_TOOL_CALLS_PER_MESSAGE = 200

      if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('对话内容无效：消息列表为空')
      }
      // 收窄之后再定义 blame：闭包里访问到的类型才不会被 TS 当成 unknown
      const list: unknown[] = messages
      const blame = (index: number, why: string): Error => {
        const item = list[index]
        const shape = isRecord(item)
          ? `role=${String(item.role)}、content=${typeof item.content}、toolCalls=${
              Array.isArray(item.toolCalls) ? item.toolCalls.length : '—'
            }`
          : `不是对象（${typeof item}）`
        return new Error(`对话内容无效：第 ${index + 1} 条消息（${shape}）——${why}`)
      }
      if (messages.length > MAX_MESSAGES) {
        throw new Error(
          `对话太长了（${messages.length} 条，上限 ${MAX_MESSAGES} 条）：` +
            '请点聊天面板右上角的「清空对话」后再继续。'
        )
      }
      for (let index = 0; index < messages.length; index += 1) {
        const item = messages[index]
        if (!isRecord(item)) throw blame(index, '不是对象')
        const role = item.role
        const knownRole =
          role === 'system' || role === 'user' || role === 'assistant' || role === 'tool'
        if (!knownRole) throw blame(index, 'role 不是 system/user/assistant/tool')
        if (typeof item.content !== 'string') throw blame(index, 'content 不是字符串')
        if (item.content.length > MAX_CONTENT) {
          throw new Error(
            `这条消息太长了（${item.content.length.toLocaleString()} 字，上限 ` +
              `${MAX_CONTENT.toLocaleString()} 字）：请拆成几条发，或先精简一下。`
          )
        }
        if (item.toolCallId !== undefined && typeof item.toolCallId !== 'string') {
          throw blame(index, 'toolCallId 不是字符串')
        }
        if (item.toolCalls !== undefined) {
          if (!Array.isArray(item.toolCalls)) throw blame(index, 'toolCalls 不是数组')
          if (item.toolCalls.length > MAX_TOOL_CALLS_PER_MESSAGE) {
            throw blame(index, `一次带的工具调用太多（${item.toolCalls.length} 个）`)
          }
          for (const call of item.toolCalls) {
            if (
              !isRecord(call) ||
              typeof call.id !== 'string' ||
              typeof call.name !== 'string' ||
              typeof call.argumentsText !== 'string' ||
              call.argumentsText.length > 60_000
            ) {
              throw blame(index, 'toolCalls 里有一项的 id/name/argumentsText 不合法')
            }
          }
        }
      }

      const config = await readAiConfig()
      if (config.apiKey.length === 0) {
        throw new Error('还没有配置 API Key：请打开「AI 设置」填入后再试')
      }

      // 工具默认开着；模型不支持函数调用时由渲染层显式关掉
      const useTools = !(isRecord(options) && options.useTools === false)

      // **许可闸门**：Pro 或试用没用完，才把写工具下发下去。
      // 放在主进程、放在「下发哪些工具」这一层——模型看不到写工具就物理上调不动它，
      // 比在渲染层判断可靠（渲染层的提示只是礼貌，不是边界）。
      const license = await getLicenseView()
      const tools = useTools ? planAvailableTools(license.canWrite) : []

      const sender = e.sender
      // 窗口销毁时中止：别留悬着的连接，也别再往已销毁的窗口发事件。
      // **用完必须摘掉**：工具循环让一条命令能跑十几二十轮，每轮挂一个 once
      // 会一直攒着（攒到 Node 的监听器上限就会打印并发告警），而且全指向已经结束的请求
      const onSenderDestroyed = (): void => streamAborters.get(requestId)?.abort()
      sender.once('destroyed', onSenderDestroyed)
      const usedTools = await callAiStream(
        config,
        messages as AiMessage[],
        requestId,
        sender,
        tools
      ).finally(() => {
        if (!sender.isDestroyed()) sender.removeListener('destroyed', onSenderDestroyed)
      })

      /**
       * 真的动了画布才算一个试用回合：只读聊天永久免费、不计数。
       *
       * 计数单位是**一次用户命令**，不是「一轮模型请求」——渲染层为每个用户命令
       * 生成一个 turnId，这里按它去重。原来每轮都计数，而一条命令可能跑十几二十轮
       * （生成 100+ 节点的详细图正是这样），会一口气吃掉十几个回合。
       */
      if (hasWriteToolCall(usedTools, WRITE_TOOL_NAMES)) {
        const turnId = isRecord(options) && typeof options.turnId === 'string' ? options.turnId : ''
        if (markTrialTurnSeen(countedTrialTurns, turnId)) await consumeTrialTurn()
      }
    }
  )

  ipcMain.on(IPC.aiChatStreamCancel, (_e, requestId: unknown) => {
    if (typeof requestId === 'string') streamAborters.get(requestId)?.abort()
  })

  /* ---- 许可与试用（商业化闸门：Pro 解锁写工具，免费送 30 个写回合） ---- */

  ipcMain.handle(IPC.licenseGet, (): Promise<LicenseView> => getLicenseView())

  ipcMain.handle(IPC.licenseActivate, async (_e, key: unknown) => {
    // 许可码是外部输入（用户粘贴的），长度与类型都验一遍再进验签
    if (typeof key !== 'string' || key.length === 0 || key.length > 4000) {
      return {
        ok: false,
        message: '许可码无效：请把购买时拿到的那一整串原样粘进来',
        view: await getLicenseView()
      }
    }
    return activateLicense(key)
  })

  ipcMain.handle(IPC.licenseDeactivate, (): Promise<LicenseView> => deactivateLicense())

  /* ---- AI 聊天记录（按文档持久化） ---- */

  const chatDir = (): string => join(app.getPath('userData'), 'chat')

  /**
   * 聊天记录的落盘文件。
   *
   * 用**文档路径的哈希**当文件名：路径可能含中文、空格、超长，直接做文件名不可靠；
   * 只存哈希不存原路径，也就不会把用户的目录结构写进这个文件。
   */
  const chatFileOf = (key: string): string =>
    join(chatDir(), `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`)

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

  /**
   * 卡死取证：渲染层节流落盘的现场（wire / workbook / 阶段）。
   *
   * 历次冻结都发生在「写意图落盘后的渲染」，而未命名文档没有自动存档、聊天也不落盘——
   * 强杀进程会把毒内容一起带走，下一轮只能从零猜。这份转储让任何一次冻结之后，
   * `%APPDATA%/smind/diag/last-state.json` 里都留着完整现场。
   */
  ipcMain.handle(IPC.diagDump, async (_e, text: unknown): Promise<void> => {
    if (typeof text !== 'string' || text.length === 0 || text.length > 64 * 1024 * 1024) return
    const dir = join(app.getPath('userData'), 'diag')
    await fs.mkdir(dir, { recursive: true })
    await writeFileAtomic(join(dir, 'last-state.json'), Buffer.from(text))
  })

  /* ---- 文档 → 导图（拖一份文档进来，AI 读完做成导图） ---- */

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
        { name: '文档', extensions: [...DOCUMENT_EXTENSIONS] },
        { name: '全部文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    const file = firstPathOf(result)
    if (!file) return null
    return extractDocumentFromPath(file)
  })

  ipcMain.handle(IPC.chatHistoryClear, async (_e, key: unknown): Promise<void> => {
    if (typeof key !== 'string' || !isPlausibleFilePath(key)) return
    await fs.rm(chatFileOf(key), { force: true })
  })

  /* ---- 大纲文件导入（Markdown / OPML） ---- */

  ipcMain.handle(
    IPC.importText,
    async (e, kind: 'markdown' | 'opml'): Promise<ImportedTextFile | null> => {
      const isMarkdown = kind !== 'opml'
      const result = await showOpenIn(ctx.winOf(e.sender), {
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
    }
  )

  /* ---- 历史记录与常用（P9+） ---- */
  registerHistoryIpc(ctx)

  /* ---- 文档版本快照（P9+） ---- */

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

  /**
   * 渲染层报告界面已损坏（错误边界触发）；页面重新加载完成时会自动清除。
   * 顺手把错误写进日志——渲染期异常以前只打在终端里，应用一重启就查不到了。
   */
  ipcMain.on(IPC.uiState, (e, message: unknown, stack: unknown, broken: unknown) => {
    const state = ctx.stateOf(e.sender)
    // 只有错误边界那种「整块界面已停止渲染」才算坏；异步错误不影响界面可用性，
    // 不能因此跳过关窗前的未保存确认
    if (state && broken === true) state.uiBroken = true
    const text = typeof message === 'string' ? message.slice(0, 2000) : ''
    const detail = typeof stack === 'string' ? stack.slice(0, 8000) : ''
    logMain('renderer-error', `${broken === true ? '[界面已停止渲染] ' : ''}${text}`, detail)
  })

  /** 由主进程刷新窗口：渲染层自己发的 location.reload 会被 will-navigate 拦下 */
  ipcMain.on(IPC.windowReload, (e) => {
    const state = ctx.stateOf(e.sender)
    if (state && !state.win.isDestroyed()) {
      state.uiBroken = false
      state.win.webContents.reload()
    }
  })

  ipcMain.on(IPC.confirmClose, (e) => {
    const state = ctx.stateOf(e.sender)
    if (!state) return
    state.allowClose = true

    if (ctx.isQuitRequested()) {
      // 退出流程：**所有**窗口都确认过（或已经不可用）才真的退
      const blocked = [...ctx.windows.values()].some(
        (item) => !item.allowClose && !item.win.webContents.isDestroyed()
      )
      if (!blocked) {
        ctx.approveQuit()
        app.quit()
        return
      }
      // 还有别的窗口没确认：这个窗口自己照样要关。
      // 以前这里无条件 return，于是「退出 → 取消 → 再点 X → 放弃修改」时
      // 窗口留在原地不动，用户以为程序卡死了（再点一次才关，且那次不再提示）。
    }
    if (!state.win.isDestroyed()) state.win.close()
  })

  /**
   * 未保存确认框里点了「取消」。
   *
   * `quitRequested` 是"退出流程进行中"的全局标记，只能在两处复位：
   * 真的退成（走 quitApproved），或者用户明确取消（这里）。
   * 以前没有这条回执，标记一直是真——之后每次关窗都进退出分支，
   * 那个分支看到"还有窗口没确认"就 return，窗口永远关不掉。
   */
  ipcMain.on(IPC.closeCancel, (e) => {
    const state = ctx.stateOf(e.sender)
    // 这个窗口并没有被允许关闭，标记也要退回去，否则下次点 X 会直接关窗、不再提示
    if (state) state.allowClose = false
    ctx.setQuitRequested(false)
  })

  ipcMain.on(IPC.setTitle, (e, title: string) => {
    const win = ctx.winOf(e.sender)
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
/** 心跳文件：用来区分「真的有实例在跑」与「上次被强杀留下的残留锁」 */
const instanceFile = (): string => join(app.getPath('userData'), 'instance.json')
/** 心跳超过这个时间就算上一个实例已经死了 */
const HEARTBEAT_STALE_MS = 30000
const HEARTBEAT_INTERVAL_MS = 10000

/** 定期写下「我还活着」，退出时抹掉 */
function startHeartbeat(): void {
  const write = (): void => {
    try {
      writeFileSync(instanceFile(), JSON.stringify({ pid: process.pid, time: Date.now() }))
    } catch {
      /* 心跳写不进去不影响使用 */
    }
  }
  write()
  const timer = setInterval(write, HEARTBEAT_INTERVAL_MS)
  app.on('will-quit', () => {
    clearInterval(timer)
    try {
      rmSync(instanceFile(), { force: true })
    } catch {
      /* 清不掉也无所谓：过期心跳不会被当成活实例 */
    }
  })
}

/**
 * 单实例闸门。
 *
 * 光靠 `requestSingleInstanceLock()` 不够：上一次被**强杀**（任务管理器结束进程）会留下
 * 残留的锁文件，之后每次启动都会被判成「已有实例在运行」——用户双击图标毫无反应、
 * 也看不到任何提示（这正是我们真遇到过的现象）。
 *
 * 所以再加一道心跳：确实有活着的实例（心跳新鲜）才安静退出；
 * 心跳过期或读不到，就当作残留锁清掉再要一次。
 */
function acquireSingleInstance(): boolean {
  if (app.requestSingleInstanceLock()) {
    startHeartbeat()
    return true
  }

  let live = false
  try {
    live = isInstanceAlive(
      JSON.parse(readFileSync(instanceFile(), 'utf8')),
      Date.now(),
      HEARTBEAT_STALE_MS
    )
  } catch {
    live = false
  }
  if (live) return false

  logMain('single-instance', '检测到残留的单实例锁（上次可能是被强杀），已清理并重试')
  try {
    rmSync(join(app.getPath('userData'), 'lockfile'), { force: true })
  } catch {
    // 删不掉说明锁正被别的进程占用：那确实有实例在跑
    return false
  }
  if (app.requestSingleInstanceLock()) {
    startHeartbeat()
    return true
  }
  return false
}

if (!acquireSingleInstance()) {
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
    const current = ctx.focusedState()
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
    // 先把可能存在的明文 Key 收进系统安全存储（幂等）
    void migrateAiConfigKey()
    registerResourceProtocol()
    registerIpc()
    buildAppMenu({
      newWindow: () => createWindow(),
      // 目录可能还没建（只在真出过错时才写日志）：先建再开，否则「打开」是无声失败
      openLogs: () => {
        void fs
          .mkdir(logDirectory(), { recursive: true })
          .then(() => shell.openPath(logDirectory()))
      },
      checkUpdates: () => {
        void checkForUpdateInteractive(
          BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
        )
      }
    })
    // 打包版才生效：后台检查更新，下载完在退出时静默安装（不打断正在画图的人）
    startAutoUpdate()
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
  if (ctx.isQuitApproved()) return
  const pending = [...ctx.windows.values()].filter(
    (state) => !state.allowClose && !state.win.webContents.isDestroyed()
  )
  if (pending.length === 0) {
    ctx.approveQuit()
    return
  }
  event.preventDefault()
  ctx.setQuitRequested(true)
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
