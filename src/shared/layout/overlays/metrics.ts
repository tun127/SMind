/**
 * 画布级元素的尺寸常量：**唯一来源**。
 *
 * 预留（往哪儿让出多少空间）与绘制（边框、标题带、括号画多大）必须用同一批数字，
 * 否则「留出来的白」与「画出来的黑」会各说各话，边界就会压住相邻分支。
 *
 * 例外的是标题**字号**：那是「默认标题样式」的一部分，与渲染/导出/面板共用，
 * 所以源在 `model/overlay-style.ts`，本文件只是把名字转出去（见文件末尾）。
 */
import { OVERLAY_TITLE_DEFAULTS } from '../../model/overlay-style'
export const BOUNDARY_PAD = 16
export const BOUNDARY_TITLE_H = 22
export const BOUNDARY_RADIUS = 12

export const SUMMARY_GAP = 12
export const SUMMARY_SPINE = 10
export const SUMMARY_NIB = 20

/**
 * 标题默认字号：**取值不在这里**，一律派生自 `model/overlay-style.ts` 的
 * `OVERLAY_TITLE_DEFAULTS`（「默认标题样式」的唯一来源；画布与导出都读那一张表）。
 * 名字保留，是为了 `build.ts` 的调用点与既有导入面一行不改。
 */
export const SUMMARY_FONT_SIZE = OVERLAY_TITLE_DEFAULTS.summary.fontSize
export const BOUNDARY_FONT_SIZE = OVERLAY_TITLE_DEFAULTS.boundary.fontSize
export const RELATIONSHIP_FONT_SIZE = OVERLAY_TITLE_DEFAULTS.relationship.fontSize
