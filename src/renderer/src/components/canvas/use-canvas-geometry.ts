import { useCallback, useMemo, type RefObject } from 'react'
import type { LayoutResult } from '@shared/layout/types'
import type { DropAxis, DropMode, DropPoint, DropRect } from '@shared/model/drop'
import { activeRoot } from '@shared/model/tree'
import type { Topic, Workbook } from '@shared/model/types'
import {
  axesOf,
  buildDropIndex,
  childGrowth,
  growthAxis,
  hitTest,
  insertAxis,
  parentStackAxis,
  screenToWorld,
  sideFlipTarget,
  snapRegionOf,
  zoneForPointer,
  type AxisPair
} from './geometry'

/**
 * 把 `geometry.ts` 里的纯函数**绑到组件当前的 ref 值上**（自 `Canvas.tsx` 整块搬出）。
 *
 * 这个 hook 是那一片几何逻辑的**薄绑定层**：函数体一行不留，全部落在 `geometry.ts`；
 * 这里只负责"调用那一刻读 ref，再传进去"——与搬迁前 `layoutRef.current` / `rootRef.current`
 * 的读法完全同源（这些函数都是同步纯计算，调用期间 ref 不会被改写）。
 *
 * **依赖数组与搬迁前等价**：原来 `axesOf` 是 `[dropIndex, childGrowth]`、
 * `snapRegionOf` 是 `[axesOf, growthAxis, insertAxis, dropIndex]`、`zoneForPointer` 是
 * `[axesOf, insertAxis]`——那些被依赖的函数身份**只在 `dropIndex` 变化时才会变**
 * （`childGrowth`/`parentStackAxis` 的 deps 就是 `[dropIndex]`，`growthAxis` 是 `[]` 常量），
 * 所以这里统一收成 `[dropIndex]` 后，每个回调"什么时候换身份"与搬迁前逐一同拍
 * （`screenToWorld` / `hitTest` / `sideFlipTarget` / `growthAxis` 仍是 `[]` 不变）。
 */

interface Deps {
  /** 画布容器：`screenToWorld` 要用它算 `getBoundingClientRect()` */
  containerRef: RefObject<HTMLDivElement | null>
  zoomRef: RefObject<number>
  panRef: RefObject<{ x: number; y: number }>
  layoutRef: RefObject<LayoutResult>
  rootRef: RefObject<Topic>
  /** 落点索引要按当前工作簿的**激活中心主题**建 */
  workbook: Workbook
  /** 落点索引随它重算（原来那个 `useMemo` 的依赖之一） */
  layout: LayoutResult
}

export function useCanvasGeometry({
  containerRef,
  zoomRef,
  panRef,
  layoutRef,
  rootRef,
  workbook,
  layout
}: Deps): {
  dropIndex: ReturnType<typeof buildDropIndex>
  siblingStacks: ReturnType<typeof buildDropIndex>['stacks']
  screenToWorld(clientX: number, clientY: number): { x: number; y: number }
  hitTest(wx: number, wy: number, excludeId?: string): string | null
  childGrowth(targetId: string): DropAxis | null
  axesOf(targetId: string): AxisPair
  parentStackAxis(targetId: string): DropAxis | null
  growthAxis(pair: AxisPair): DropAxis
  insertAxis(targetId: string, pair: AxisPair): DropAxis
  snapRegionOf(targetId: string): DropRect | null
  zoneForPointer(targetId: string, rect: DropRect, world: DropPoint): DropMode
  sideFlipTarget(world: DropPoint, draggedId: string): 'left' | 'right' | null
} {
  /* ---- 落点判定用的索引：随布局重算（一次遍历），原 `useMemo` 的依赖与位置不变 ---- */
  const dropIndex = useMemo(() => buildDropIndex(activeRoot(workbook), layout), [workbook, layout])

  /** 所有「同级节点堆」：在空白处识别"插到这两个之间"，以及推断同级排列方向 */
  const siblingStacks = dropIndex.stacks

  const screenToWorldCb = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } =>
      screenToWorld(clientX, clientY, containerRef.current, zoomRef.current, panRef.current),
    [containerRef, zoomRef, panRef]
  )

  const hitTestCb = useCallback(
    (wx: number, wy: number, excludeId = ''): string | null =>
      hitTest(layoutRef.current, rootRef.current, wx, wy, excludeId),
    [layoutRef, rootRef]
  )

  const childGrowthCb = useCallback(
    (targetId: string): DropAxis | null => childGrowth(layoutRef.current, dropIndex, targetId),
    [dropIndex, layoutRef]
  )

  const axesOfCb = useCallback(
    (targetId: string): AxisPair => axesOf(layoutRef.current, dropIndex, targetId),
    [dropIndex, layoutRef]
  )

  const parentStackAxisCb = useCallback(
    (targetId: string): DropAxis | null => parentStackAxis(layoutRef.current, dropIndex, targetId),
    [dropIndex, layoutRef]
  )

  const growthAxisCb = useCallback((pair: AxisPair): DropAxis => growthAxis(pair), [])

  const insertAxisCb = useCallback(
    (targetId: string, pair: AxisPair): DropAxis =>
      insertAxis(layoutRef.current, dropIndex, targetId, pair),
    [dropIndex, layoutRef]
  )

  const snapRegionOfCb = useCallback(
    (targetId: string): DropRect | null => snapRegionOf(layoutRef.current, dropIndex, targetId),
    [dropIndex, layoutRef]
  )

  const zoneForPointerCb = useCallback(
    (targetId: string, rect: DropRect, world: DropPoint): DropMode =>
      zoneForPointer(layoutRef.current, dropIndex, targetId, rect, world),
    [dropIndex, layoutRef]
  )

  const sideFlipTargetCb = useCallback(
    (world: DropPoint, draggedId: string): 'left' | 'right' | null =>
      sideFlipTarget(layoutRef.current, rootRef.current, world, draggedId),
    [layoutRef, rootRef]
  )

  return {
    dropIndex,
    siblingStacks,
    screenToWorld: screenToWorldCb,
    hitTest: hitTestCb,
    childGrowth: childGrowthCb,
    axesOf: axesOfCb,
    parentStackAxis: parentStackAxisCb,
    growthAxis: growthAxisCb,
    insertAxis: insertAxisCb,
    snapRegionOf: snapRegionOfCb,
    zoneForPointer: zoneForPointerCb,
    sideFlipTarget: sideFlipTargetCb
  }
}
