/**
 * 阶段心跳 + 循环计数 + 阶段耗时（卡死取证用）。
 *
 * 为什么需要它：界面被**同步死循环**堵死时，主线程几乎不回事件循环——
 * 调试端口进不去（实测一条 `1+1` 要等 20 秒以上）、V8 采样要等进程正常退出才落盘
 * （而卡死时只能强杀）。于是「事后去问」这条路全断，**唯一拿得到的线索就是
 * 堵死前最后写出来的那几行**。
 *
 * 所以这里做四件事（都刻意选在「可能长时间运行 / 可能循环」的地方调用）：
 *   1. `setStage(name)`：标记当前阶段，每秒把「现在在哪一步」写进控制台；
 *   2. `count(name)`：报各类循环每秒跑了几次——真凶的数字会大到一眼可见；
 *   3. `beginCost(name)`：**进入时先写一行**（`[stage] 进入 画布布局`），
 *      结束时再报耗时；没结束时最后那行就是案发现场（这一条是卡死排查的关键，
 *      因为卡住的阶段永远不会自己报完成）；
 *   4. `noteAmount(name, n)`：累计总量类指标（例如「代码块 span 一共建了多少个」），
 *      它们在时间上摊薄、看不出来，但总量是二次放大问题的直接证据。
 *
 * 输出通道：`console.log('[stage] …')` → 主进程 console-message → 应用日志文件。
 * 这条通道在**打包版同样有效**（只有下面那个定时器默认只在开发版跑）。
 *
 * 开销纪律：只有在「开发版」或「AI 回合进行中」（`armDiag` 被打过）时才会真的写日志。
 * 用户自己的日常编辑（敲字、拖动）不会产生任何日志——那是逐键触发的热路径。
 */
let stage = '启动'
let armed = false
let armedReason = ''
let disarmTimer: number | null = null

const counters = new Map<string, number>()
const amounts = new Map<string, number>()
const costs = new Map<string, { calls: number; total: number; max: number }>()

/** 超过这个耗时就单独记一行（毫秒）。低于它的阶段不值得刷屏 */
const SLOW_MS = 120

/**
 * 标记当前阶段。
 *
 * 除了进心跳，**阶段一变就立刻写一行**（相邻重复会去重）。为什么这条最关键：
 * 同步死循环会**永远不让出主线程**——心跳停了、看门狗也没机会说话（它要等恢复才能报）。
 * 唯一拿得到的线索就是「进入致命阶段的那一行」，配合主进程 unresponsive 的时间戳，
 * 就能算出「这个阶段跑了多久才把界面卡死」。
 * 去重之后开销可忽略：平移时阶段一直是「滚轮平移」，只会写第一条。
 */
export function setStage(next: string): void {
  if (next === stage) return
  stage = next
  if (armed) console.log(`[stage] 阶段 → ${next}`)
}

/** 记一次循环 / 一次调用。心跳会报出「每秒 N 次」，用来抓停不下来的循环 */
export function count(name: string): void {
  counters.set(name, (counters.get(name) ?? 0) + 1)
}

/** 累计总量类指标（不是次数：例如 token / span 个数、字符数） */
export function noteAmount(name: string, amount: number): void {
  amounts.set(name, (amounts.get(name) ?? 0) + amount)
}

/**
 * 开始计时一个阶段。返回值是「结束」函数（返回本次耗时，毫秒）。
 *
 * `detail` 会一起写进日志（例如节点数、意图种类），排查时不用再猜上下文。
 * 进入时先写一行：如果这个阶段卡死了，日志里最后一条就是它——这就是「案发现场」。
 */
export function beginCost(name: string, detail = ''): () => number {
  const startedAt = performance.now()
  if (armed) console.log(`[stage] 进入 ${name}${detail.length > 0 ? `（${detail}）` : ''}`)
  return (): number => {
    const ms = performance.now() - startedAt
    const prev = costs.get(name)
    costs.set(name, {
      calls: (prev?.calls ?? 0) + 1,
      total: (prev?.total ?? 0) + ms,
      max: Math.max(prev?.max ?? 0, ms)
    })
    // 单次就慢：立刻记一行（这种阶段往往就是卡顿的构成单元）
    if (armed && ms >= SLOW_MS) {
      console.log(
        `[stage] 慢 ${name} ${Math.round(ms)}ms${detail.length > 0 ? `（${detail}）` : ''}`
      )
    }
    return ms
  }
}

/**
 * 把累计的阶段耗时汇总成**一行**写出去，然后清空。
 *
 * 一个 AI 回合结束时调一次：这一行直接回答「这十几秒花在哪了」——
 * 例如 `布局×12 共 3400ms(最慢 900) · 应用写意图×12 共 210ms(最慢 30)`。
 */
export function reportCosts(label: string): void {
  if (!armed) return
  const costParts: string[] = []
  for (const [name, item] of costs) {
    costParts.push(
      `${name}×${item.calls} 共 ${Math.round(item.total)}ms(最慢 ${Math.round(item.max)})`
    )
  }
  const amountParts: string[] = []
  for (const [name, total] of amounts) amountParts.push(`${name} 共 ${Math.round(total)}`)
  const countParts: string[] = []
  for (const [name, times] of counters) countParts.push(`${name}×${times}`)

  const body = [...costParts, ...amountParts, ...countParts].join(' · ')
  console.log(`[stage] ${label}${body.length > 0 ? `：${body}` : '（无统计）'}`)
  clearStats()
}

/**
 * 单点标记（不配对计时）：用于「某件事已经发生」的界标。
 *
 * 典型用法是把一个可疑区间**两头都标上**，卡死时看最后一条落在哪边：
 * - 最后是「进入 画布布局」→ 卡在**计算**（布局算法 / 测量）；
 * - 最后是「画布提交完成」→ 卡在**渲染提交**（DOM 节点太多，例如 token span 爆炸）。
 */
export function mark(name: string, detail = ''): void {
  if (!armed) return
  console.log(`[stage] ${name}${detail.length > 0 ? `（${detail}）` : ''}`)
}

/** 清空累计（回合之间不互相污染） */
function clearStats(): void {
  counters.clear()
  amounts.clear()
  costs.clear()
}

/**
 * 打开诊断输出（打包版默认关着，避免日常使用刷日志）。
 * 由「AI 回合开始」触发——卡死正好都发生在这条路径上。
 */
export function armDiag(reason: string, holdMs = 300_000): void {
  if (!armed) {
    armed = true
    armedReason = reason
    console.log(`[stage] 诊断已开启（${reason}）`)
  }
  scheduleDisarm(holdMs)
}

/**
 * 延长取证窗口（不改变已开启状态）。
 *
 * 实测教训：AI 回合**写入侧只用了几毫秒**，冻结发生在**回合结束后用户开始滚动画布**那一段——
 * 那时探针已经关了，日志一片空白，白丢一次现场。所以回合结束时不是关掉，而是再保持一段时间。
 */
export function keepDiagArmed(holdMs: number): void {
  if (!armed) return
  scheduleDisarm(holdMs)
}

function scheduleDisarm(holdMs: number): void {
  if (typeof window === 'undefined' || typeof window.setTimeout !== 'function') return
  if (disarmTimer !== null) window.clearTimeout(disarmTimer)
  disarmTimer = window.setTimeout(() => {
    disarmTimer = null
    disarmDiag()
  }, holdMs)
}

/** 关掉诊断输出（不再刷新窗口时；定时自动调用） */
function disarmDiag(): void {
  if (disarmTimer !== null && typeof window !== 'undefined') window.clearTimeout(disarmTimer)
  disarmTimer = null
  if (!armed) return
  armed = false
  console.log(`[stage] 诊断已关闭（${armedReason}）`)
  armedReason = ''
}

export function isDiagArmed(): boolean {
  return armed
}

function takeCounts(): string {
  if (counters.size === 0) return ''
  const parts: string[] = []
  for (const [name, times] of counters) parts.push(`${name}×${times}`)
  counters.clear()
  return ` | ${parts.join(' ')}`
}

function takeAmounts(): string {
  if (amounts.size === 0) return ''
  const parts: string[] = []
  for (const [name, total] of amounts) parts.push(`${name} ${Math.round(total)}`)
  amounts.clear()
  return ` | ${parts.join(' ')}`
}

// 这个模块只服务渲染进程；自检里若有人不小心 import 它，不要因此炸掉测试
const inRenderer = typeof window !== 'undefined' && typeof window.setInterval === 'function'

/**
 * 主线程停顿看门狗（**常驻，不依赖诊断开关**）。
 *
 * 这是整套取证里唯一「停顿结束后自己会说话」的探针：500ms 一跳，
 * 如果某一跳晚了 ≥700ms，说明主线程刚被**同步卡住**过——立刻把「卡了多久 + 卡之前最后
 * 停在哪个阶段」写出去。正因为它在恢复后立刻执行，所以**打包版、诊断没开**都能拿到，
 * 而且给出的是**时长**（历次取证最缺的就是这个数）。
 */
const WATCHDOG_TICK_MS = 500
const STALL_MS = 700
/** 只有「比当前节奏还慢这么多倍」才在节流状态下仍然报警（真死循环往往远超它） */
const STALL_MULTIPLE = 3
if (inRenderer) {
  let lastTickAt = performance.now()
  const recent: number[] = []
  const median = (list: number[]): number => {
    if (list.length === 0) return 0
    const sorted = [...list].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)] ?? 0
  }
  window.setInterval(() => {
    const now = performance.now()
    const delta = now - lastTickAt
    lastTickAt = now
    /**
     * 只报「相对当前节奏的异常」。
     *
     * 教训：窗口被遮挡 / 最小化时，Chromium 会把定时器压到 1Hz——那是**节流**不是卡顿。
     * 一开始没区分，结果空闲窗口里整屏都是「主线程停顿 1000ms」，把真现场淹了。
     * 现在：页面不可见不报；连续多拍都慢（基线本身就慢）也不报；
     * 只有「单独一拍慢」或「远比当前节奏更慢」才算真的把主线程堵住了。
     */
    const baseline = median(recent)
    const throttled = baseline >= STALL_MS
    if (
      delta >= STALL_MS &&
      document.visibilityState === 'visible' &&
      (!throttled || delta >= baseline * STALL_MULTIPLE)
    ) {
      console.log(
        `[stage] 主线程停顿 ${Math.round(delta)}ms（停顿前最后阶段：${stage}${armed ? '' : ' · 诊断未开启'}）`
      )
    }
    recent.push(delta)
    if (recent.length > 8) recent.shift()
  }, WATCHDOG_TICK_MS)
}

// 开发版一开始就开着；打包版要等 armDiag（AI 回合）——用户日常编辑不产生日志
if (inRenderer && !window.location.protocol.startsWith('file')) armed = true

if (inRenderer)
  window.setInterval(() => {
    if (!armed) return
    let heap = ''
    try {
      // performance.memory 是 Chromium 专有字段，没有就不写（不为了诊断去改类型定义）
      const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
      if (memory) heap = ` · 堆 ${Math.round(memory.usedJSHeapSize / 1e6)}MB`
    } catch {
      /* 忽略 */
    }
    console.log(`[stage] ${stage}${heap}${takeCounts()}${takeAmounts()}`)
  }, 1000)
