/**
 * 阶段心跳 + 循环计数（开发版诊断用）。
 *
 * 为什么需要它：界面被**同步死循环**堵死时，主线程几乎不回事件循环——
 * 调试端口进不去（实测一条 `1+1` 要等 20 秒以上）、V8 采样要等进程正常退出才落盘
 * （而卡死时只能强杀）。于是「事后去问」这条路全断，**唯一拿得到的线索就是
 * 卡死前最后一条心跳**。
 *
 * 所以这里做两件事：
 *   1. 每秒把「当前在哪一步」写进控制台；
 *   2. 顺带报**各类循环每秒跑了几次**——真凶的数字会大到一眼可见。
 * 主进程会把 `[stage]` 开头的消息落进应用日志（见 main 的 console-message 转发）。
 * 只在开发版启用：打包版不写日志、不跑定时器。
 */
let stage = '启动'

const counters = new Map<string, number>()

/** 标记当前阶段。调用点选在「可能长时间运行 / 可能循环」的地方就够，不必到处撒 */
export function setStage(next: string): void {
  stage = next
}

/** 记一次循环。心跳会报出「每秒 N 次」，用来抓停不下来的循环 */
export function count(name: string): void {
  counters.set(name, (counters.get(name) ?? 0) + 1)
}

function takeCounts(): string {
  if (counters.size === 0) return ''
  const parts: string[] = []
  for (const [name, times] of counters) parts.push(`${name}×${times}`)
  counters.clear()
  return ` | ${parts.join(' ')}`
}

if (!window.location.protocol.startsWith('file')) {
  window.setInterval(() => {
    let heap = ''
    try {
      // performance.memory 是 Chromium 专有字段，没有就不写（不为了诊断去改类型定义）
      const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
      if (memory) heap = ` · 堆 ${Math.round(memory.usedJSHeapSize / 1e6)}MB`
    } catch {
      /* 忽略 */
    }
    console.log(`[stage] ${stage}${heap}${takeCounts()}`)
  }, 1000)
}
