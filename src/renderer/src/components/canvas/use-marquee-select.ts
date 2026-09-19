import { useCallback, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { LayoutResult } from '@shared/layout/types'
import { topicsInBox } from '@shared/model/drop'
import { setStage } from '../../dev/stage'
import { useEditor } from '../../store/editor'

/**
 * 画布空白处的两种手势（自 `Canvas.tsx` 整块搬出，函数体逐字未改）：
 *
 * - **右键 / 中键拖动**：平移画布（与 Xmind 一致）。位移累进局部变量、
 *   `requestAnimationFrame` 每帧最多落账一次；同时给跟随循环一个「用户接管视角」的信号。
 * - **左键拖动**：框选。边走边写 `marquee`（容器局部坐标）让节点即时高亮，
 *   松手用 `topicsInBox` 定案；只点一下（位移 < 3px）就是取消选择，按住 Ctrl 是追加选择。
 *
 * `marquee` **由本 hook 持有并返回**：它只被这里的框选写，但画布的 `marqueeHits`（高亮）
 * 与 JSX（选框矩形）都要读。
 *
 * 依赖数组 `[setPan]` 逐字保留；lint 要求补进来的 `containerRef` / `layoutRef` / `panRef` /
 * `viewGestureAtRef` / `zoomRef` 是恒等身份的 `RefObject`，`setStage` 是模块级函数，
 * `setMarquee` 是 React setter——列进依赖数组不改变本回调的重建时机。
 */

/** 左键框选：矩形用容器内的局部坐标，便于直接定位 */
export interface Marquee {
  x0: number
  y0: number
  x1: number
  y1: number
}

interface Deps {
  containerRef: RefObject<HTMLDivElement | null>
  layoutRef: RefObject<LayoutResult>
  zoomRef: RefObject<number>
  panRef: RefObject<{ x: number; y: number }>
  /** 用户接管视角的次数：拖动平移要 +1，跟随循环据此让位 */
  viewGestureAtRef: RefObject<number>
  setPan(pan: { x: number; y: number }): void
}

export function useMarqueeSelect({
  containerRef,
  layoutRef,
  zoomRef,
  panRef,
  viewGestureAtRef,
  setPan
}: Deps): {
  marquee: Marquee | null
  /** state setter 原样带出：签名必须与 `useState` 的 `Dispatch<SetStateAction<…>>` 同型 */
  setMarquee: Dispatch<SetStateAction<Marquee | null>>
  handleBackgroundPointerDown(e: ReactPointerEvent<HTMLDivElement>): void
} {
  /** 左键框选：矩形用容器内的局部坐标，便于直接定位 */
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null
  )

  /* ---- 空白处：右键/中键拖动平移；左键拖动框选 ---- */
  const handleBackgroundPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      const store = useEditor.getState()
      if (store.editingId) store.commitEdit()
      if (e.button !== 0 && e.button !== 1 && e.button !== 2) return

      // 与 Xmind 一致：右键（或中键）拖动平移画布
      if (e.button === 1 || e.button === 2) {
        e.preventDefault()
        // 手动拖画布＝接管视角（与滚轮同一条规则）
        viewGestureAtRef.current += 1
        const startX = e.clientX
        const startY = e.clientY
        const startPan = { ...panRef.current }
        // pointermove 同样是每秒上百次的高频事件：累进局部变量，每帧最多落账一次
        let raf = 0
        let targetX = startPan.x
        let targetY = startPan.y
        const flush = (): void => {
          raf = 0
          setStage('拖拽平移')
          setPan({ x: targetX, y: targetY })
        }
        const onMove = (ev: PointerEvent): void => {
          targetX = startPan.x + (ev.clientX - startX)
          targetY = startPan.y + (ev.clientY - startY)
          if (raf === 0) raf = window.requestAnimationFrame(flush)
        }
        const detach = (): void => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onCancel)
          if (raf !== 0) window.cancelAnimationFrame(raf)
        }
        const onCancel = (): void => detach()
        // 右键原地点击不应清空选择
        const onUp = (): void => detach()
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onCancel)
        return
      }

      // 左键：框选
      const rect = containerRef.current?.getBoundingClientRect()
      const baseLeft = rect?.left ?? 0
      const baseTop = rect?.top ?? 0
      const startClient = { x: e.clientX, y: e.clientY }
      const startLocal = { x: e.clientX - baseLeft, y: e.clientY - baseTop }
      let moved = false

      const onMove = (ev: PointerEvent): void => {
        const localX = ev.clientX - baseLeft
        const localY = ev.clientY - baseTop
        if (!moved && Math.hypot(localX - startLocal.x, localY - startLocal.y) < 3) return
        moved = true
        setMarquee({ x0: startLocal.x, y0: startLocal.y, x1: localX, y1: localY })
      }
      const detach = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
      }
      const onCancel = (): void => {
        detach()
        setMarquee(null)
      }
      const onUp = (ev: PointerEvent): void => {
        detach()
        setMarquee(null)
        const state = useEditor.getState()

        // 只是点了一下空白：取消选择
        if (!moved) {
          state.select(null)
          return
        }

        const z = zoomRef.current
        const pan = panRef.current
        const toWorld = (client: { x: number; y: number }): { x: number; y: number } => ({
          x: (client.x - baseLeft - pan.x) / z,
          y: (client.y - baseTop - pan.y) / z
        })
        const from = toWorld(startClient)
        const to = toWorld({ x: ev.clientX, y: ev.clientY })
        const minX = Math.min(from.x, to.x)
        const maxX = Math.max(from.x, to.x)
        const minY = Math.min(from.y, to.y)
        const maxY = Math.max(from.y, to.y)

        // 与拖动中的高亮共用同一套判定（`topicsInBox`）：亮了就一定会选中
        const hits = topicsInBox(
          (layoutRef.current?.nodes ?? []).map((node) => ({
            id: node.id,
            rect: { x: node.x, y: node.y, width: node.width, height: node.height }
          })),
          { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
        )

        // 按住 Ctrl 拖动是「追加选择」
        const base = ev.ctrlKey || ev.metaKey ? state.selection : []
        state.setSelection([...base, ...hits])
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
    },
    [
      setPan,
      // 下面这些是从画布传进来的 ref / React setter / 模块级函数：身份恒定，
      // 列进依赖数组不改本回调的重建时机
      containerRef,
      layoutRef,
      panRef,
      viewGestureAtRef,
      zoomRef,
      setMarquee
    ]
  )

  return { marquee, setMarquee, handleBackgroundPointerDown }
}
