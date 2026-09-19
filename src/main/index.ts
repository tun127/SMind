import { app, protocol } from 'electron'
import { existsSync } from 'node:fs'
import { pickDocumentArg } from '@shared/openfile'

import { createMainContext } from './context'
import { RESOURCE_SCHEME } from './resource-protocol'
import { isDev } from './env'
import { startLifecycle } from './lifecycle'

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

startLifecycle(ctx, startupOpenPath)
