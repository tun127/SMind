/**
 * 布局入口：按结构类型分派到对应的算法。
 * 未识别的结构统一降级为思维导图，保证任何文件都能正常打开。
 *
 * 画布级元素（关系线/边界/概要）不在树里，但依赖节点的最终坐标，
 * 所以在结构算法跑完、坐标归一化之后统一补上（见 `run.ts`）。
 *
 * 两条入口：
 * - `layoutSheet`：全量布局（导出、自检、以及不需要缓存的一次性调用）；
 * - `layoutSheetCached`：增量布局（画布用它，见 `incremental.ts`）。
 */
import type { Sheet, Topic } from '../model/types'
import { LAYOUT_DEFAULTS, LayoutBuilder } from './core'
import { runLayout } from './run'
import type { LayoutOptions, LayoutResult, MeasureFn } from './types'

export * from './types'
export { LAYOUT_DEFAULTS, collapseBadgeSide } from './core'
export type { CollapseSide, LayoutMemo, LayoutStats, MemoEntry } from './core'
export { createLayoutMemo, emptyLayoutStats, resetLayoutGeometry, resetLayoutMemo } from './core'
export { createLayoutCache, layoutSheetCached } from './incremental'
export type { LayoutCache, LayoutPass } from './incremental'
export { runLayout } from './run'
export {
  buildRange,
  indexTree,
  overlayReserves,
  parseRange,
  readCurveOffset,
  resolveRange,
  sameRange,
  withCurveOffset
} from './overlays'
export type { OverlayReserves } from './overlays'
export { identityId, mix, subtreeStamp } from './stamp'

/** 全量布局（不带跨轮缓存） */
export function layoutSheet(
  rootTopic: Topic,
  measure: MeasureFn,
  options: LayoutOptions = {},
  sheet?: Sheet
): LayoutResult {
  const builder = new LayoutBuilder(
    measure,
    options.gapX ?? LAYOUT_DEFAULTS.gapX,
    options.gapY ?? LAYOUT_DEFAULTS.gapY,
    options.padding ?? LAYOUT_DEFAULTS.padding
  )
  return runLayout(builder, rootTopic, sheet)
}
