/**
 * 阶段心跳（开发版诊断用）。
 *
 * 为什么需要它：界面被**同步死循环**堵死时，主线程再也不回到事件循环——
 * 调试端口进不去、V8 采样要等进程正常退出才落盘（而卡死时只能强杀）。
 * 于是「事后去问」这条路全断，**唯一拿得到的线索就是卡死前最后一条心跳**。
 *
 * 做法：每秒把「当前在哪一步」打进控制台；主进程会把 `[stage]` 开头的消息
 * 一律落进应用日志（见 main 的 console-message 转发）。卡死时翻日志最后一行即可定位。
 * 只在开发版启用：打包版不写日志、也不跑定时器。
 */
let stage = '启动'

/** 标记当前阶段。调用点选在「可能长时间运行 / 可能循环」的地方就够，不必到处撒 */
export function setStage(next: string): void {
  stage = next
}

export function currentStage(): string {
  return stage
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
    console.log(`[stage] ${stage}${heap}`)
  }, 1000)
}
