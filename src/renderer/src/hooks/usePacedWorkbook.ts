import { useEffect, useRef, useState } from 'react'
import type { Workbook } from '@shared/model/types'

/**
 * AI 回合中把「重活」的输入节流到每 ~100ms 一次。
 *
 * 为什么需要：AI 一次批量整理会连着写几十次 store，而画布对 `workbook` 是
 * 「一变就整张图重排」。223 个主题实测每次重排要几十毫秒——30 次写入就是近一秒的
 * 纯计算，全挤在用户眼前，还会和他自己的操作抢主线程。合并成每 100ms 一次，
 * 中间那几帧用上一次的布局先画（**数据仍是新的，只是位置晚一拍**）。
 *
 * 不会「永远滞后」：`lastApplied` 只在**真正应用**时推进，所以最迟 100ms 后必定应用一次
 * **最新值**（写得太快也只会让它晚 100ms，不会一直不落地）。
 *
 * 不使用 state 去同步「不节流」那条路：直接返回新值。既零延迟，也避开
 * 「在 effect 里同步 setState」这条被 lint 明令禁止的写法（那会多一次渲染）。
 */
const PACE_MS = 100

export function usePacedWorkbook(workbook: Workbook, pacing: boolean): Workbook {
  const [applied, setApplied] = useState(workbook)
  const lastAppliedRef = useRef(0)
  /**
   * 上一次「不节流」时屏幕上显示的那一份。
   *
   * 用来判断**刚进入节流的那一帧**：如果此刻进来的 workbook 就是屏幕上这份，
   * 说明 AI 还没开始写，应当立刻落地。否则会拿上一回合留下的 `applied`
   * 画上最多 100ms——用户看到画布先"跳回旧位置"再跳回来。
   */
  const shownRef = useRef(workbook)

  useEffect(() => {
    if (!pacing) {
      // 不节流：屏幕上的就是最新值。这里**不** setState（那会让每次编辑多一次渲染），
      // 只记下来，供下次进入节流时对齐
      shownRef.current = workbook
      return
    }
    const justEntered = shownRef.current === workbook
    const wait = justEntered
      ? 0
      : Math.max(0, PACE_MS - (performance.now() - lastAppliedRef.current))
    const timer = window.setTimeout(() => {
      lastAppliedRef.current = performance.now()
      setApplied(workbook)
    }, wait)
    return () => window.clearTimeout(timer)
  }, [workbook, pacing])

  // 不在 AI 回合里：一律用最新值（用户自己的操作必须零延迟）
  if (!pacing) return workbook
  // 刚进入节流那一帧直接给最新值（`applied` 可能还是上一回合的旧对象）
  return shownRef.current === workbook ? workbook : applied
}
