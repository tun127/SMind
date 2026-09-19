import { app, BrowserWindow, protocol, shell } from 'electron'
import { isInstanceAlive } from '../shared/guards'
import { logDirectory, logMain } from './log'
import { promises as fs, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { pickDocumentArg } from '@shared/openfile'

import { buildAppMenu } from './menu'
import { checkForUpdateInteractive, startAutoUpdate } from './update'
import { createMainContext } from './context'
import { pruneStaleCopies } from './autosave'
import { migrateAiConfigKey } from './ai'
import { registerIpc } from './ipc'
import { createWindow, openDocumentSomewhere } from './windows'
import { RESOURCE_SCHEME, registerResourceProtocol } from './resource-protocol'
import { isDev } from './env'

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

/**
 * 启动时命令行里带的文档路径（双击 `.xmind`、把文件拖到 exe 上、右键「打开方式 → SMind」都会走这里）。
 *
 * 刻意**不在启动流程里直接推给渲染进程**：那一刻 React 可能还没挂载、监听还没注册上，
 * 推过去就丢了。所以先挂到窗口状态上，渲染进程就绪后自己来取一次（取走即清空），时序上稳。
 */
const startupOpenPath: string | null = pickDocumentArg(process.argv, existsSync)

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
      openDocumentSomewhere(ctx, target)
      return
    }
    const current = ctx.focusedState()
    if (current && !current.win.isDestroyed()) {
      if (current.win.isMinimized()) current.win.restore()
      current.win.focus()
    } else {
      createWindow(ctx)
    }
  })

  // macOS 的「用本应用打开文件」
  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (app.isReady()) openDocumentSomewhere(ctx, path)
  })

  void app.whenReady().then(() => {
    // 先把可能存在的明文 Key 收进系统安全存储（幂等）
    void migrateAiConfigKey()
    registerResourceProtocol(ctx)
    registerIpc(ctx)
    buildAppMenu({
      newWindow: () => createWindow(ctx),
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
    createWindow(ctx, { path: startupOpenPath })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(ctx)
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
