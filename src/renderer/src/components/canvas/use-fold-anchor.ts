import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { LayoutResult } from '@shared/layout/types'

/**
 * 折叠 / 展开：以「被折叠的那个节点」为锚点，别让视角丢失（自 `Canvas.tsx` 整块搬出）。
 *
 * 折叠会让整张图重排，被折叠的节点自己也会挪位置——用户看到的就是"视角丢失"。
 * 这里**补偿平移量**，让那个节点在屏幕上原地不动；而不是把镜头拉去居中中心主题
 * （用户明确说过那不是他要的）。
 *
 * 同时给跟随循环一个"让位"信号：折叠常伴随"选择被挪到折叠节点"，
 * 不说一声的话跟随循环下一帧就把镜头拉过去居中了，锚点等于白做。
 *
 * 用 `useLayoutEffect`：要在**绘制前**把平移量补回来，否则会先闪一帧跳位。
 *
 * **搬迁单位**：`prevLayoutRef` / `consumedFoldRef` 两个 ref 与这条 `useLayoutEffect` 一起搬
 * ——它们只服务于这条 effect。hook 调用点落在原 effect 的位置上，所以它在整份 effect 序列里的
 * 次序（在跟随循环之后、新文档居中之前）一字未变。
 */

interface Deps {
  layout: LayoutResult
  lastFold: { id: string; at: number } | null
  setPan(pan: { x: number; y: number }): void
  zoomRef: RefObject<number>
  panRef: RefObject<{ x: number; y: number }>
  viewGestureAtRef: RefObject<number>
}

export function useFoldAnchor({
  layout,
  lastFold,
  setPan,
  zoomRef,
  panRef,
  viewGestureAtRef
}: Deps): void {
  const prevLayoutRef = useRef<LayoutResult | null>(null)
  const consumedFoldRef = useRef(0)

  useLayoutEffect(() => {
    const prev = prevLayoutRef.current
    prevLayoutRef.current = layout
    const signal = lastFold
    if (!signal || consumedFoldRef.current === signal.at || !prev) return
    consumedFoldRef.current = signal.at
    const before = prev.nodeMap.get(signal.id)
    const after = layout.nodeMap.get(signal.id)
    if (!before || !after) return
    const z = zoomRef.current
    const dx = (before.x - after.x) * z
    const dy = (before.y - after.y) * z
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
    setPan({ x: panRef.current.x + dx, y: panRef.current.y + dy })
    viewGestureAtRef.current = performance.now()
  }, [layout, lastFold, setPan, zoomRef, panRef, viewGestureAtRef])
}
