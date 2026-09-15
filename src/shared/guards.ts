/**
 * 解析外部数据时的通用判断。
 *
 * 项目里到处都要从"未知形状"的数据里取值——文件格式、设置文件、AI 返回、
 * 自动存档……于是「这是不是一个普通对象」这个判断一度在 8 个文件里各写了一遍，
 * 是典型的"改一处漏七处"隐患，所以收敛到这里。
 */

/** 是不是一个普通对象（非 null、非数组的对象） */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 心跳文件里的实例还活着吗。
 *
 * 单实例判断不能只看锁文件：上一次被**强杀**会留下残留锁，之后每次启动都会被
 * 误判成「已有实例在运行」→ 双击图标毫无反应（真踩过）。所以让正在跑的实例
 * 定期写下心跳，启动时用它区分「真有实例在跑」和「残留锁」。
 */
export function isInstanceAlive(raw: unknown, now: number, staleMs = 30000): boolean {
  if (!isRecord(raw)) return false
  const time = typeof raw.time === 'number' && Number.isFinite(raw.time) ? raw.time : 0
  if (time <= 0) return false
  // 时间戳在未来（系统时间被改过）也按「活着」处理：宁可多等，也不要误判成残留锁而双开
  return now - time < staleMs
}

/**
 * 这次导航是不是「回到自身页面」（刷新、同源跳转）。
 *
 * 为什么要单独判断：`will-navigate` 里一刀切 `preventDefault()` 会把**刷新**也拦掉，
 * 「重新加载界面」就成了死按钮（开发期 Vite 的整页刷新同样被拦，热更新也回不来）。
 * 但也不能全放行——拖一张图片进窗口的默认行为就是导航过去，那会把整个界面替换掉。
 */
export function isSelfNavigation(current: string, target: string): boolean {
  if (current.length === 0) return false
  const stripHash = (value: string): string => {
    const index = value.indexOf('#')
    return index >= 0 ? value.slice(0, index) : value
  }
  // 生产环境是 file://：刷新会回到同一个 index.html（含 hash 路由）
  if (stripHash(target) === stripHash(current)) return true
  // 开发服务器是 http://localhost:5173：同源的刷新/跳转都算自身导航
  if (/^https?:\/\//i.test(current) && /^https?:\/\//i.test(target)) {
    try {
      return new URL(current).origin === new URL(target).origin
    } catch {
      return false
    }
  }
  return false
}
