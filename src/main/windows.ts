import { BrowserWindow, dialog, shell } from 'electron'
import { isSelfNavigation } from '../shared/guards'
import { logMain } from './log'
import type { MainContext } from './context'
import { APP_NAME, devIconFile, isDev } from './env'
import { pathFromFileUrl } from '@shared/document'
import { promises as fs, existsSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { pickDocumentArg } from '@shared/openfile'

import { autosaveSlotName, sameDocPath } from '@shared/window'
import { type DocWindow } from './context'
import { autosaveFile, autosaveMeta } from './autosave'

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 开一个窗口 = 开一份文档。
 *
 * `options.path` 只在「启动时带文件 / 双击文件 / 二实例传参」时给：
 * 那一刻 React 可能还没挂载，所以路径先存在窗口状态里，渲染进程就绪后自己来取一次。
 */
export function createWindow(
  ctx: MainContext,
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
export function openDocumentSomewhere(ctx: MainContext, path: string): void {
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
  createWindow(ctx, { path })
}
