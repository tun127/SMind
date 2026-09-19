import { app, BrowserWindow, dialog, protocol, shell } from 'electron'
import { isInstanceAlive, isSelfNavigation } from '../shared/guards'
import { logDirectory, logMain } from './log'
import { pathFromFileUrl } from '@shared/document'
import { promises as fs, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { pickDocumentArg } from '@shared/openfile'

import { mimeOfPath } from '@shared/model/resources'

import { autosaveSlotName, sameDocPath } from '@shared/window'
import { buildAppMenu } from './menu'
import { checkForUpdateInteractive, startAutoUpdate } from './update'
import { createMainContext, type DocWindow } from './context'
import { registerHistoryIpc } from './ipc/history'
import { autosaveFile, autosaveMeta, pruneStaleCopies } from './autosave'
import { migrateAiConfigKey } from './ai'
import { registerWindowIpc } from './ipc/window'
import { registerThemeIpc } from './ipc/theme'
import { registerSettingsIpc } from './ipc/settings'
import { registerRecoveryIpc } from './ipc/recovery'
import { registerDocumentIpc } from './ipc/document'
import { registerMediaIpc } from './ipc/media'
import { registerExportIpc } from './ipc/export'
import { registerAiIpc } from './ipc/ai'
import { registerLicenseIpc } from './ipc/license'
import { registerChatHistoryIpc } from './ipc/chat-history'
import { registerDiagnosticIpc } from './ipc/diagnostic'
import { registerImportIpc } from './ipc/import'
import { registerSnapshotIpc } from './ipc/snapshot'

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
  /* ---- 窗口与文档壳（标签 / 新窗口 / 画布副本 / 关窗确认 / 外链） ---- */
  registerWindowIpc(ctx, createWindow)

  /* ---- 打开 / 保存 / 自动保存 ---- */
  registerDocumentIpc(ctx)

  /* ---- 崩溃恢复 ---- */
  registerRecoveryIpc(ctx)

  /* ---- 应用设置（%APPDATA%\SMind\settings.json） ---- */
  registerSettingsIpc()

  /* ---- 主题 ---- */
  registerThemeIpc(ctx)

  /* ---- 图片与附件（P4） ---- */

  registerMediaIpc(ctx, resourceBytesOf)

  /* ---- 大纲导出（P5） ---- */

  registerExportIpc(ctx)

  /* ---- AI（P8） ---- */

  registerAiIpc()

  /* ---- 许可与试用（商业化闸门：Pro 解锁写工具，免费送 30 个写回合） ---- */

  registerLicenseIpc()

  /* ---- AI 聊天记录（按文档持久化） ---- */

  registerChatHistoryIpc()

  /**
   * 卡死取证：渲染层节流落盘的现场（wire / workbook / 阶段）。
   *
   * 历次冻结都发生在「写意图落盘后的渲染」，而未命名文档没有自动存档、聊天也不落盘——
   * 强杀进程会把毒内容一起带走，下一轮只能从零猜。这份转储让任何一次冻结之后，
   * `%APPDATA%/smind/diag/last-state.json` 里都留着完整现场。
   */
  registerDiagnosticIpc()

  /* ---- 文档 → 导图（拖一份文档进来，AI 读完做成导图） ---- */

  registerImportIpc(ctx)

  /* ---- 大纲文件导入（Markdown / OPML） ---- */

  /* ---- 历史记录与常用（P9+） ---- */
  registerHistoryIpc(ctx)

  /* ---- 文档版本快照（P9+） ---- */

  registerSnapshotIpc(ctx)

  /**
   * 渲染层报告界面已损坏（错误边界触发）；页面重新加载完成时会自动清除。
   * 顺手把错误写进日志——渲染期异常以前只打在终端里，应用一重启就查不到了。
   */
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
