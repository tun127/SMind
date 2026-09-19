import { useCallback, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { useEditor } from '../../store/editor'

/**
 * 拖动关系线（自 `Canvas.tsx` 整块搬出，函数体逐字未改）：
 *
 * 1. **端点改接**：拖两端的小圆手柄到别的主题上，松手即改接这一端（`handleRelationshipPointerDown`）。
 * 2. **线身移动**：拖线身改弧线弯度（`handleCurvePointerDown`），点线身顺带选中 + 打开属性面板。
 * 3. **元素选中**：`pickOverlay`——概要 / 边界 / 关系线的统一「点一下选中并开面板」。
 *
 * 两段处理器**各自的依赖数组逐字保留**（`[hitTest, screenToWorld]` 与 `[]`）。
 * lint 要求补进来的 `zoomRef` 是恒等身份的 `RefObject`，列进依赖数组不改回调的重建时机
 * （与 A8-2/A8-3/A8-4 同一条既有做法）。
 *
 * `handleDrag`（正在拖的那一端 + 预览线）**由本 hook 持有并返回**：它只被这两段写，
 * 但画布 JSX（手柄高亮 / 预览线）要读，所以不能留在 hook 里。
 */

/** 正在拖拽的关系线端点（拖到别的主题上即可改接）——同时是那份 `useState` 的类型 */
export interface HandleDrag {
  relationshipId: string
  end: 'end1Id' | 'end2Id'
  /** 不动的那一端（世界坐标），用来画预览线 */
  anchor: { x: number; y: number }
  pointer: { x: number; y: number }
  targetId: string | null
}

interface Deps {
  /** 线身拖动要按缩放把屏幕位移换算成世界位移 */
  zoomRef: RefObject<number>
  /** 端点改接：屏幕坐标 → 世界坐标 */
  screenToWorld(clientX: number, clientY: number): { x: number; y: number }
  /** 端点改接：世界里那一点命中了哪个主题 */
  hitTest(wx: number, wy: number, excludeId?: string): string | null
}

export function useRelationshipDrag({ zoomRef, screenToWorld, hitTest }: Deps): {
  /** 正在拖的那一端（画布 JSX 用它高亮手柄 / 画预览线） */
  handleDrag: HandleDrag | null
  /** state setter 原样带出：签名必须与 `useState` 的 `Dispatch<SetStateAction<…>>` 同型，
   *  否则画布那边 `setHandleDrag((current) => …)` 的**更新函数写法**会失去重载（A8-5 实测踩到） */
  setHandleDrag: Dispatch<SetStateAction<HandleDrag | null>>
  pickOverlay(
    event: ReactPointerEvent<SVGElement>,
    kind: 'summary' | 'boundary' | 'relationship',
    id: string
  ): void
  handleRelationshipPointerDown(
    e: ReactPointerEvent<SVGCircleElement>,
    relationshipId: string,
    end: 'end1Id' | 'end2Id',
    anchor: { x: number; y: number }
  ): void
  handleCurvePointerDown(e: ReactPointerEvent<SVGPathElement>, relationshipId: string): void
} {
  /** 正在拖拽的关系线端点（拖到别的主题上即可改接） */
  const [handleDrag, setHandleDrag] = useState<{
    relationshipId: string
    end: 'end1Id' | 'end2Id'
    /** 不动的那一端（世界坐标），用来画预览线 */
    anchor: { x: number; y: number }
    pointer: { x: number; y: number }
    targetId: string | null
  } | null>(null)

  /* ---- 端点改接（R1） ---- */
  /* ---- 拖动关系线的端点改接 ---- */
  const handleRelationshipPointerDown = useCallback(
    (
      e: ReactPointerEvent<SVGCircleElement>,
      relationshipId: string,
      end: 'end1Id' | 'end2Id',
      anchor: { x: number; y: number }
    ): void => {
      if (e.button !== 0) return
      // 必须阻止冒泡，否则画布会把这次按下当成「拖拽平移」
      e.stopPropagation()
      const store = useEditor.getState()
      if (store.editingId) store.commitEdit()

      const origin = screenToWorld(e.clientX, e.clientY)
      setHandleDrag({ relationshipId, end, anchor, pointer: origin, targetId: null })

      const onMove = (ev: PointerEvent): void => {
        const world = screenToWorld(ev.clientX, ev.clientY)
        setHandleDrag((current) =>
          current ? { ...current, pointer: world, targetId: hitTest(world.x, world.y) } : current
        )
      }
      const detach = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
      }
      const onCancel = (): void => {
        detach()
        setHandleDrag(null)
      }
      const onUp = (ev: PointerEvent): void => {
        detach()
        const world = screenToWorld(ev.clientX, ev.clientY)
        const target = hitTest(world.x, world.y)
        setHandleDrag(null)
        if (target) useEditor.getState().setRelationshipEnd(relationshipId, end, target)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
    },
    [hitTest, screenToWorld]
  )

  /* ---- 选中元素 + 线身移动（R3） ---- */
  /** 选中画布元素（概要 / 边界 / 关系线）并打开属性面板：文字、字体、删除都在面板里 */
  const pickOverlay = useCallback(
    (
      event: ReactPointerEvent<SVGElement>,
      kind: 'summary' | 'boundary' | 'relationship',
      id: string
    ): void => {
      event.stopPropagation()
      const store = useEditor.getState()
      store.selectOverlay(kind, id)
      store.requestNodePanel()
    },
    []
  )

  /* ---- 拖动关系线的线身：整体移动弧线（弯度偏移） ---- */
  const handleCurvePointerDown = useCallback(
    (e: ReactPointerEvent<SVGPathElement>, relationshipId: string): void => {
      if (e.button !== 0) return
      e.stopPropagation()
      const store = useEditor.getState()
      // 点线身 = 选中这条关系线（顺手把属性面板打开），拖才改弯度：
      // 否则「点一下线上什么都没有发生」，看起来就像这条线选不中
      store.selectOverlay('relationship', relationshipId)
      store.requestNodePanel()
      if (store.editingId) store.commitEdit()

      let lastX = e.clientX
      let lastY = e.clientY

      const onMove = (ev: PointerEvent): void => {
        const z = zoomRef.current
        const dx = (ev.clientX - lastX) / z
        const dy = (ev.clientY - lastY) / z
        lastX = ev.clientX
        lastY = ev.clientY
        if (dx === 0 && dy === 0) return
        useEditor.getState().offsetRelationshipCurve(relationshipId, dx, dy)
      }
      const detach = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }
      const onUp = (): void => detach()

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [
      // 从画布传进来的 ref：身份恒定，列进依赖数组不改本回调的重建时机
      zoomRef
    ]
  )

  return {
    handleDrag,
    setHandleDrag,
    pickOverlay,
    handleRelationshipPointerDown,
    handleCurvePointerDown
  }
}
