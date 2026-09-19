import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 「AI 刚改过的节点：闪一下」这一组状态与清理（自 `Canvas.tsx` 整块搬出）。
 *
 * **搬迁单位说明**：`useState`（`flashIds`）、定时器 ref、闪一下的函数、以及卸载清定时器的
 * `useEffect` 是**一件事**，一起搬——`flashIds` 只被画布 JSX 读（`flash={flashIds.has(node.id)}`），
 * `flashNodes` 只被 `viewportActions.flash` 用，拆开任何一半都会留下一个没有消费者的残留。
 *
 * 原来那段注释：
 *
 * AI 刚改过的节点：闪一下。
 *
 * 直接操作画布省掉了「预览确认」，信任就只能来自**事后看得见**——回合结束时
 * 闪一下改过的节点、把视口带过去，否则用户根本不知道它动了哪儿。
 */
export function useFlashNodes(): {
  flashIds: ReadonlySet<string>
  flashNodes(ids: string[]): void
} {
  const [flashIds, setFlashIds] = useState<ReadonlySet<string>>(() => new Set<string>())
  const flashTimerRef = useRef<number | null>(null)
  const flashNodes = useCallback((ids: string[]): void => {
    if (ids.length === 0) return
    setFlashIds(new Set(ids))
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null
      // 已经空了就不换新对象：省掉一次无意义的整画布重渲染
      setFlashIds((prev) => (prev.size === 0 ? prev : new Set<string>()))
    }, 1700)
  }, [])
  useEffect(
    () => () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
    },
    []
  )

  return { flashIds, flashNodes }
}
