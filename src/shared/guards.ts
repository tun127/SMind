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
