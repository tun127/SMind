import { useEffect, useState } from 'react'

/**
 * 把一个频繁变化的值**延后一小段时间**再交出去。
 *
 * 用途：搜索框每敲一个键都会触发一次全树扫描（画布与搜索面板各一次），
 * 打字快的时候中间那些结果根本没人看。防抖让"停下来之后"才算一次。
 *
 * 重要：输入框显示的仍应是**原始值**，只有"结果"用防抖后的值——
 * 否则输入会明显滞后，手感变差。
 */
export function useDebouncedValue<T>(value: T, delayMs = 180): T {
  const [debounced, setDebounced] = useState(value)
  // 清空不必等：删掉搜索词应当立刻看到结果消失。
  // 这里**直接返回当前值**而不是在 effect 里同步 setState——
  // 后者会触发一次多余的级联渲染（React 也明确不建议）。
  const immediate = typeof value === 'string' && value.length === 0

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [value, delayMs])

  return immediate ? value : debounced
}
