import { BrowserWindow } from 'electron'
import type { DocResources } from './doc-resources'

export interface DocWindow {
  /** webContents.id */
  id: number
  win: BrowserWindow
  /** 自动存档槽位名 */
  slot: string
  /** 按文档 id（标签）隔离的资源与路径 */
  docs: Map<string, DocResources>
  /** 渲染进程已确认可以关闭（未保存内容问过了） */
  allowClose: boolean
  /**
   * 渲染层报告「界面已进入错误状态」（错误边界兜底）。
   * 此时不能再等它回应关闭请求——错误边界把 App 卸载了，没人能回应（真踩过：窗口关不掉）。
   */
  uiBroken: boolean
  /** 启动/二实例带的文件，渲染进程就绪后取走 */
  pendingPath: string | null
  /** 这个窗口打开的是临时副本：文档没有磁盘归属，关窗时把临时文件删掉 */
  copySource: string | null
}

/**
 * 主进程的跨域共享状态容器。
 *
 * 为什么要有这一层：`main/index.ts` 里的各个 IPC 域（文件 / 恢复 / 设置 / 主题 / AI /
 * 许可 / 历史 / 快照 / 窗口…）共用同一批**可变**状态——窗口表、文档资源表、
 * 「退出流程进行中」标记、自动存档槽位序号。以前它们都是 `main/index.ts` 的模块级变量，
 * 域处理器只能靠闭包偷偷看见它们；拆域之后每个注册函数都显式收一个 `MainContext`，
 * 共享面就变成类型上看得见、能数清的东西。
 *
 * 两条约定：
 * 1. **可变状态一律经访问器读写**（`isQuitRequested()` / `setQuitRequested()` …）。
 *    不要把它暴露成普通字段：`const { quitRequested } = ctx` 拿到的是**快照**，
 *    之后 `quitRequested = true` 写的是局部变量、容器里根本没变——
 *    而「退出 → 取消 → 再点 X」这条链路正是靠这个标记区分「退出整个应用」与「关一个窗口」，
 *    快照化会让窗口再也关不掉（这类 bug 之前真出现过，见 `IPC.closeCancel` 的注释）。
 * 2. 这里**只放状态**。无状态的助手（文档资源表、文件读写、主题读写、AI 配置读写…）走各自的模块，
 *    由 `index.ts` 与各域一起 import，不必绕道 ctx。
 */
export interface MainContext {
  /** 窗口表（键＝webContents.id） */
  readonly windows: Map<number, DocWindow>

  stateOf(sender: Electron.WebContents): DocWindow | null
  focusedState(): DocWindow | null
  winOf(sender: Electron.WebContents): BrowserWindow | null

  /** 该窗口是不是本次进程的第一个窗口（只有它负责询问崩溃恢复） */
  isPrimaryWindow(id: number): boolean
  /** 认领「第一个窗口」：只认第一次，后来的窗口不影响它 */
  claimPrimaryWindow(id: number): void
  /** 取下一个自动存档槽位序号（按窗口创建顺序，重启后新会话按同样顺序认领） */
  nextWindowSeq(): number

  /** 本次退出是否源于「退出应用」而不是关闭某个窗口 */
  isQuitRequested(): boolean
  setQuitRequested(value: boolean): void
  /** 所有窗口都确认过未保存内容，可以真正退出 */
  isQuitApproved(): boolean
  approveQuit(): void
}

/** 建一份共享状态。整个进程只建一次（`main/index.ts` 里那个 `ctx`）。 */
export function createMainContext(): MainContext {
  const windows = new Map<number, DocWindow>()
  let primaryWindowId: number | null = null
  let windowSeq = 0

  /** 本次退出源于「退出应用」而不是关闭某个窗口 */
  let quitRequested = false
  /** 所有窗口都确认过未保存内容，可以真正退出 */
  let quitApproved = false

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

  function isPrimaryWindow(id: number): boolean {
    return id === primaryWindowId
  }

  function claimPrimaryWindow(id: number): void {
    if (primaryWindowId === null) primaryWindowId = id
  }

  function nextWindowSeq(): number {
    windowSeq += 1
    return windowSeq
  }

  return {
    windows,
    stateOf,
    focusedState,
    winOf,
    isPrimaryWindow,
    claimPrimaryWindow,
    nextWindowSeq,
    isQuitRequested: () => quitRequested,
    setQuitRequested: (value: boolean) => {
      quitRequested = value
    },
    isQuitApproved: () => quitApproved,
    approveQuit: () => {
      quitApproved = true
    }
  }
}
