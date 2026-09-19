/**
 * 视角锁定的异常告警：**同一类只报一次**。
 *
 * 这些告警在排查「视角不跟随 / 抽动」时救过场，不能删；但渲染层的 `console.warn`
 * 会被主进程转发进应用日志（同步落盘），而它们都处在「每帧」的路径上——
 * 一旦某个状态持续异常（几何每帧都变、尺寸在震荡），就是每秒几十次 IPC + 写盘，
 * 告警自己会变成新的卡顿来源。保留首次现场，后续同类记数即可。
 *
 * （自 `Canvas.tsx` 整块搬出。`viewLockWarned` 是**模块级集合**，搬进独立模块后仍然是**唯一一份**：
 * 调用点只有 `use-view-follow.ts` 的一处，画布里那份已删除。）
 */
const viewLockWarned = new Set<string>()

export function warnViewLock(key: string, message: string, extra?: unknown): void {
  if (viewLockWarned.has(key)) return
  viewLockWarned.add(key)
  console.warn(`[viewlock] ${message}`, extra)
}
