/**
 * 画布级元素（关系线 / 边界 / 概要）：门面。
 *
 * 这些元素不属于树结构，但依赖节点的最终坐标，所以必须在布局归一化之后计算。
 * 所有坐标都是最终坐标（含 padding 偏移），渲染层直接使用，不再做任何换算。
 *
 * 实现按职责拆在 overlays/ 下；本文件只再导出**原来的公开面**，
 * 因此 layout/index.ts、run.ts、Canvas、导出管线都不需要改 import。
 *
 *   range.ts    区间解析与索引、关系线弯度读写
 *   metrics.ts  预留与绘制共用的尺寸常量（唯一来源）
 *   reserves.ts 子树包围盒 + 外侧留白预留
 *   shapes.ts   path 形状（大括号 / 圆角矩形）+ 标题尺寸估算
 *   build.ts    关系线 / 边界 / 概要的构建与入口 addOverlays
 */
export {
  buildRange,
  indexTree,
  parseRange,
  readCurveOffset,
  resolveRange,
  sameRange,
  withCurveOffset
} from './overlays/range'
export type { CurveOffset, TreeIndex } from './overlays/range'
export { overlayReserves } from './overlays/reserves'
export type { OverlayReserves } from './overlays/reserves'
export {
  OVERLAY_TITLE_LINE_HEIGHT,
  estimateOverlayLabelSize,
  overlayTitleLines,
  roundedRectPath
} from './overlays/shapes'
export { addOverlays } from './overlays/build'
