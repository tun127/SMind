/**
 * 自动更新策略的**纯判定**（不依赖 electron，可在自检里跑）。
 *
 * 为什么要单独一处：主进程那份实现读 `process.env` 与 `app.isPackaged`，自检起不来
 * Electron 环境、覆盖不到；把"判据"抽成纯函数、把"环境"当参数传进来，两条分支就都能被断言钉住。
 */

/** 复查间隔（6 小时）：应用长期开着时，重新获得焦点才有机会发现新版 */
export const UPDATE_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 免安装版的探测环境变量（electron-builder 的 portable target 启动时注入） */
export const PORTABLE_MARKER_ENV = 'PORTABLE_EXECUTABLE_FILE'

/**
 * 是不是免安装版？
 *
 * 免安装版**不能**自更新：它运行时把自己解压到临时目录再启动，electron-updater 会把新版
 * 装进那个临时目录，下次启动仍是旧版——用户以为更新了、其实没有。所以命中就跳过检查。
 */
export function isPortableBuild(env: Record<string, string | undefined>): boolean {
  const marker = env[PORTABLE_MARKER_ENV]
  return typeof marker === 'string' && marker.length > 0
}

/** 距上次检查是否已经够久了（`lastCheckAt === null` = 还没查过 → 该查） */
export function shouldRecheck(lastCheckAt: number | null, now: number): boolean {
  if (lastCheckAt === null) return true
  return now - lastCheckAt >= UPDATE_RECHECK_INTERVAL_MS
}
