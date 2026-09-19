import { useEffect, type RefObject } from 'react'
import { count, setStage } from '../../dev/stage'

/**
 * 滚轮：平移 / Ctrl 缩放（自 `Canvas.tsx` 整块搬出，effect 体逐字未改）。
 *
 * 触控板/滚轮每个物理事件都会触发一次 wheel（实测 120–160 次/秒）。
 * 以前这里是逐事件 setPan：每次都把整棵画布重渲染一遍，滚动时主线程被打满，
 * 同期运行的 AI 批量写入会被活活饿死（归因探针实锤的渲染风暴）。
 * 现在把位移累进局部变量，requestAnimationFrame 每帧最多写一次 store——
 * 帧间累加、最后一次落账，落点与逐事件处理完全一致。
 *
 * 依赖数组补进来的 ref 都是恒定身份，不改变本 effect 的重跑时机。
 */

interface Deps {
  containerRef: RefObject<HTMLDivElement | null>
  zoomRef: RefObject<number>
  panRef: RefObject<{ x: number; y: number }>
  viewGestureAtRef: RefObject<number>
  setPan(pan: { x: number; y: number }): void
  setZoom(zoom: number): void
}

export function useWheelPanZoom({
  containerRef,
  zoomRef,
  panRef,
  viewGestureAtRef,
  setPan,
  setZoom
}: Deps): void {
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let raf = 0
    let pendingDx = 0
    let pendingDy = 0
    let pendingZoomDelta = 0
    let pendingZoomClient: { x: number; y: number } | null = null
    const flush = (): void => {
      raf = 0
      // 阶段名一定要在**真正干活之前**设好：停顿看门狗就是靠它说出「卡在哪一步」
      setStage('滚轮平移')
      count('滚轮合帧')
      if (pendingZoomDelta !== 0 && pendingZoomClient) {
        const rect = el.getBoundingClientRect()
        const px = pendingZoomClient.x - rect.left
        const py = pendingZoomClient.y - rect.top
        const oldZoom = zoomRef.current
        const z = Math.max(0.1, Math.min(4, oldZoom * Math.exp(-pendingZoomDelta * 0.0015)))
        const wx = (px - panRef.current.x) / oldZoom
        const wy = (py - panRef.current.y) / oldZoom
        setZoom(z)
        setPan({ x: px - wx * z, y: py - wy * z })
      }
      if (pendingDx !== 0 || pendingDy !== 0) {
        const currentPan = panRef.current
        setPan({ x: currentPan.x - pendingDx, y: currentPan.y - pendingDy })
      }
      pendingDx = 0
      pendingDy = 0
      pendingZoomDelta = 0
      pendingZoomClient = null
    }
    const onWheel = (ev: WheelEvent): void => {
      ev.preventDefault()
      // 滚轮＝用户接管视角：跟随循环要立刻让位（否则就是跟用户的手抢镜头）
      viewGestureAtRef.current += 1
      if (ev.ctrlKey || ev.metaKey) {
        pendingZoomDelta += ev.deltaY
        pendingZoomClient = { x: ev.clientX, y: ev.clientY }
      } else {
        pendingDx += ev.deltaX
        pendingDy += ev.deltaY
      }
      if (raf === 0) raf = window.requestAnimationFrame(flush)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (raf !== 0) window.cancelAnimationFrame(raf)
    }
  }, [setPan, setZoom, containerRef, zoomRef, panRef, viewGestureAtRef])
}
