/**
 * 画布级元素的尺寸常量：**唯一来源**。
 *
 * 预留（往哪儿让出多少空间）与绘制（边框、标题带、括号画多大）必须用同一批数字，
 * 否则「留出来的白」与「画出来的黑」会各说各话，边界就会压住相邻分支。
 */
export const BOUNDARY_PAD = 16
export const BOUNDARY_TITLE_H = 22
export const BOUNDARY_RADIUS = 12

export const SUMMARY_GAP = 12
export const SUMMARY_SPINE = 10
export const SUMMARY_NIB = 20
/** 概要与边界标题的默认字号（与画布上的默认值一致，样式里写了就以样式为准） */
export const SUMMARY_FONT_SIZE = 13
export const BOUNDARY_FONT_SIZE = 12
export const RELATIONSHIP_FONT_SIZE = 12
