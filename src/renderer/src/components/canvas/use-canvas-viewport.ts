import { useCallback, useEffect, type RefObject } from 'react'
import type { LayoutResult } from '@shared/layout/types'
import type { Topic } from '@shared/model/types'
import { NOOP_VIEWPORT_ACTIONS, viewportActions } from '../../render/viewport'

/**
 * 视口动作（适应画布 / 回中心 / 缩放 / 保证可见 / 居中到某节点）（自 `Canvas.tsx` 整块搬出）。
 *
 * **搬迁单位说明**：五个 `useCallback` 与**两个 effect** 一起搬，hook 的调用点落在原来那个
 * 注册 effect 的位置上——所以 effect 的先后顺序一字未变（`viewportActions` 注册仍在
 * 「容器尺寸」effect 之后、「进入编辑态保证可见」之后是 `prevViewLock` 那条）。
 * 搬运时各 `useCallback` 的依赖数组原样保留（`[setPan, setZoom]` / `[setPan]`）。
 *
 * 两个 effect：
 * 1. 把五个动作与「闪一下」注册进 `viewportActions`（模块级单例），**卸载必须复位**；
 * 2. 进入编辑态时保证节点可见（视角锁定开着时交给跟随循环，见函数体注释）。
 *
 * `viewGestureAtRef` 是「用户接管视角的次数」，由本 hook 与画布里的滚轮 effect、拖拽处理器
 * 共同读写（视角锁定是自动动镜头、用户手动操作是意图，两者不能对拉），所以它**留在画布**、
 * 以参数传进来（ref 身份稳定，不影响任何依赖数组的语义）。
 */

interface Deps {
  containerRef: RefObject<HTMLDivElement | null>
  layoutRef: RefObject<LayoutResult>
  zoomRef: RefObject<number>
  panRef: RefObject<{ x: number; y: number }>
  rootRef: RefObject<Topic>
  viewGestureAtRef: RefObject<number>
  setPan(pan: { x: number; y: number }): void
  setZoom(zoom: number): void
  flashNodes(ids: string[]): void
  editingId: string | null
  viewLock: boolean
}

export function useCanvasViewport({
  containerRef,
  layoutRef,
  zoomRef,
  panRef,
  rootRef,
  viewGestureAtRef,
  setPan,
  setZoom,
  flashNodes,
  editingId,
  viewLock
}: Deps): {
  centerRoot(): void
  fit(): void
  zoomTo(next: number): void
  ensureVisible(id: string): void
  centerOn(id: string): void
} {
  const centerRoot = useCallback((): void => {
    const el = containerRef.current
    const lay = layoutRef.current
    if (!el || !lay) return
    // 显式把镜头拉回中心＝接管视角，别让跟随循环两帧后把镜头又拽走
    viewGestureAtRef.current += 1
    const rootNode = lay.nodeMap.get(rootRef.current.id)
    if (!rootNode) return
    const width = el.clientWidth
    const height = el.clientHeight
    if (width === 0 || height === 0) return
    setZoom(1)
    setPan({
      x: width / 2 - (rootNode.x + rootNode.width / 2),
      y: height / 2 - (rootNode.y + rootNode.height / 2)
    })
    // ref 是稳定身份：列进依赖数组不改变本回调的重建时机（与搬迁前等价，见文件头说明）
  }, [setPan, setZoom, containerRef, layoutRef, rootRef, viewGestureAtRef])

  const fit = useCallback((): void => {
    const el = containerRef.current
    const lay = layoutRef.current
    if (!el || !lay) return
    // 适应画布同样是显式接管视角
    viewGestureAtRef.current += 1
    const width = el.clientWidth
    const height = el.clientHeight
    if (width === 0 || height === 0) return
    const margin = 48
    const scale = Math.min(
      (width - margin * 2) / lay.bounds.width,
      (height - margin * 2) / lay.bounds.height,
      1.5
    )
    const z = Math.max(0.1, Math.min(4, scale))
    setZoom(z)
    setPan({ x: (width - lay.bounds.width * z) / 2, y: (height - lay.bounds.height * z) / 2 })
  }, [setPan, setZoom, containerRef, layoutRef, viewGestureAtRef])

  const zoomTo = useCallback(
    (next: number): void => {
      const el = containerRef.current
      if (!el) return
      // 缩放按钮/快捷键＝接管视角
      viewGestureAtRef.current += 1
      const px = el.clientWidth / 2
      const py = el.clientHeight / 2
      const oldZoom = zoomRef.current
      const currentPan = panRef.current
      const z = Math.max(0.1, Math.min(4, next))
      const wx = (px - currentPan.x) / oldZoom
      const wy = (py - currentPan.y) / oldZoom
      setZoom(z)
      setPan({ x: px - wx * z, y: py - wy * z })
    },
    [setPan, setZoom, containerRef, panRef, zoomRef, viewGestureAtRef]
  )

  /** 把节点滚动到可见范围内，避免新建的主题落在视口外 */
  const ensureVisible = useCallback(
    (id: string): void => {
      const el = containerRef.current
      const lay = layoutRef.current
      if (!el || !lay) return
      const node = lay.nodeMap.get(id)
      if (!node) return
      const z = zoomRef.current
      const currentPan = panRef.current
      const width = el.clientWidth
      const height = el.clientHeight
      if (width === 0 || height === 0) return
      const margin = 56
      const left = node.x * z + currentPan.x
      const top = node.y * z + currentPan.y
      const right = (node.x + node.width) * z + currentPan.x
      const bottom = (node.y + node.height) * z + currentPan.y

      let dx = 0
      let dy = 0
      if (left < margin) dx = margin - left
      else if (right > width - margin) dx = width - margin - right
      if (top < margin) dy = margin - top
      else if (bottom > height - margin) dy = height - margin - bottom

      if (dx !== 0 || dy !== 0) {
        setPan({ x: currentPan.x + dx, y: currentPan.y + dy })
      }
    },
    [setPan, containerRef, layoutRef, panRef, zoomRef]
  )

  /** 把某个节点移到视口正中（搜索跳转用，缩放保持不变） */
  const centerOn = useCallback(
    (id: string): void => {
      const el = containerRef.current
      const lay = layoutRef.current
      if (!el || !lay) return
      const node = lay.nodeMap.get(id)
      if (!node) return
      const z = zoomRef.current
      const width = el.clientWidth
      const height = el.clientHeight
      if (width === 0 || height === 0) return
      // 让节点中心落在视口中心；搜索面板占了右侧，这里往左让出一点，避免被面板挡住
      const targetX = width / 2 - 150
      const targetY = height / 2
      const centerX = (node.x + node.width / 2) * z
      const centerY = (node.y + node.height / 2) * z
      setPan({ x: targetX - centerX, y: targetY - centerY })
    },
    [setPan, containerRef, layoutRef, zoomRef]
  )

  useEffect(() => {
    viewportActions.fit = fit
    viewportActions.centerRoot = centerRoot
    viewportActions.zoomTo = zoomTo
    viewportActions.ensureVisible = ensureVisible
    viewportActions.centerOn = centerOn
    viewportActions.flash = flashNodes
    /**
     * **卸载必须复位**：`viewportActions` 是模块级单例（见 render/viewport.ts 的说明）。
     * 画布换掉/关掉之后若还留着这里的闭包，工具栏、搜索面板、AI 面板再触发
     * 「适应画布 / 跳到命中 / 闪一下」就是在操作一个已经不存在的画布——
     * 那些闭包读的是旧组件的 ref 与旧 DOM。复位成空实现，最坏是"什么也不做"。
     */
    return () => {
      Object.assign(viewportActions, NOOP_VIEWPORT_ACTIONS)
    }
  }, [fit, centerRoot, zoomTo, ensureVisible, centerOn, flashNodes])

  useEffect(() => {
    // 视角锁定开着时交给下面的跟随循环处理：它会把编辑中的节点居中，
    // ensureVisible 只保证可见不居中，两套逻辑同时跑会互相打架
    if (!editingId || viewLock) return
    const target = editingId
    const frame = window.requestAnimationFrame(() => viewportActions.ensureVisible(target))
    return () => window.cancelAnimationFrame(frame)
  }, [editingId, viewLock])

  return { centerRoot, fit, zoomTo, ensureVisible, centerOn }
}
