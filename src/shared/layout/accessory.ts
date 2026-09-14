/**
 * 节点里「图片 / 公式」这两块附加内容的尺寸计算（纯函数，不依赖 DOM）。
 *
 * 放在 shared 里而不是渲染层，是为了让自检能直接覆盖尺寸规则：
 * 布局用它算高度，渲染层用它决定显示框大小，两边共用同一份计算就不会出现「测量与显示不一致」。
 */

import type { TopicCode, TopicImage } from '../model/types'
import type { Size } from './types'

export type { Size }

/** 节点内图片的显示上限（超过则等比缩小） */
export const IMAGE_MAX_WIDTH = 220
export const IMAGE_MAX_HEIGHT = 260
/** 图片尺寸未知时的兜底显示框 */
export const IMAGE_FALLBACK: Size = { width: 160, height: 120 }
export const IMAGE_MIN: Size = { width: 28, height: 20 }

/** 公式块的宽度上限与最小宽度 */
export const FORMULA_MAX_WIDTH = 260
export const FORMULA_MIN_WIDTH = 36

/** 图片/公式块与上下内容之间的间距 */
export const BLOCK_GAP = 6

/** 手动拉伸节点时，图片允许放大到自然尺寸的倍数上限（免得糊成马赛克） */
export const IMAGE_GROW_LIMIT = 3

/**
 * 图片显示框：按宽高比等比缩放，限制在给定边界（默认 IMAGE_MAX_*）之内。
 * 只填了一边时，另一边按 4:3 估算。
 *
 * - 不给 `bounds`：默认**不放大**（小图保持原样），只做等比缩小；
 * - 给 `bounds`（节点被手动拉伸时）：按节点可用空间等比**放大或缩小**，
 *   最多到自然尺寸的 {@link IMAGE_GROW_LIMIT} 倍。
 */
export function imageBoxSize(image: TopicImage | undefined, bounds?: Size): Size {
  if (!image) return { width: 0, height: 0 }

  const hasW = typeof image.width === 'number' && image.width > 0
  const hasH = typeof image.height === 'number' && image.height > 0

  let width = hasW ? (image.width as number) : 0
  let height = hasH ? (image.height as number) : 0

  if (!hasW && !hasH) {
    width = IMAGE_FALLBACK.width
    height = IMAGE_FALLBACK.height
  } else {
    if (!hasW) width = (height * 4) / 3
    if (!hasH) height = (width * 3) / 4
  }

  const maxWidth = bounds && bounds.width > 0 ? bounds.width : IMAGE_MAX_WIDTH
  const maxHeight = bounds && bounds.height > 0 ? bounds.height : IMAGE_MAX_HEIGHT
  const growLimit = bounds ? IMAGE_GROW_LIMIT : 1
  const scale = Math.min(growLimit, maxWidth / width, maxHeight / height)
  return {
    width: Math.max(IMAGE_MIN.width, Math.round(width * scale)),
    height: Math.max(IMAGE_MIN.height, Math.round(height * scale))
  }
}

/**
 * 公式块的兜底尺寸：按源码长度粗估。
 * 真实尺寸由渲染层用 KaTeX 的排版结果量出来（见 render/formula.ts），
 * 这个估算只在拿不到 DOM 时使用（例如自检环境）。
 */
export function pureFormulaSize(source: string | undefined, fontSize: number): Size {
  const text = (source ?? '').replace(/\\[a-zA-Z]+/g, 'xx').replace(/[{}$&]/g, '')
  const units = Math.max(1, [...text].length)
  const width = Math.min(FORMULA_MAX_WIDTH, Math.max(FORMULA_MIN_WIDTH, Math.round(units * fontSize * 0.5)))
  const height = Math.round(fontSize * 2.4)
  return { width, height }
}

/* ------------------------------------------------------------------ */
/* 标记条（节点左侧竖排）                                              */
/* ------------------------------------------------------------------ */

export const MARKER_SIZE = 16
export const MARKER_GAP = 3
/** 标记条与节点之间的间距（标记条挂在节点**外面**） */
export const MARKER_STRIP_GAP = 6
/** 一列最多放几个，超出换到第二列 */
export const MARKER_PER_COLUMN = 4
/**
 * 最多两列：标记条挂在节点外侧，宽度必须小于父子间距（56px），
 * 否则会盖到父节点或相邻主题上。标记再多就往**高度**涨（节点会跟着长高）。
 */
export const MARKER_MAX_COLUMNS = 2

/** 标记条占用：列数 × 单列行数（与渲染层的分列方式一致） */
export function markerStripSize(count: number): Size {
  if (count <= 0) return { width: 0, height: 0 }
  const columns = count <= MARKER_PER_COLUMN ? 1 : MARKER_MAX_COLUMNS
  const rows = Math.ceil(count / columns)
  return {
    width: columns * MARKER_SIZE + (columns - 1) * MARKER_GAP,
    height: rows * MARKER_SIZE + (rows - 1) * MARKER_GAP
  }
}

/* ------------------------------------------------------------------ */
/* 代码块                                                              */
/* ------------------------------------------------------------------ */

export const CODE_FONT_SIZE = 12
export const CODE_FONT_FAMILY = 'Consolas, "JetBrains Mono", Menlo, "Courier New", monospace'
/** 只保留一个下限：代码块**不封顶**，长宽都随内容自适应（用户要求完整展示） */
export const CODE_MIN_WIDTH = 96
export const CODE_LINE_RATIO = 1.45
export const CODE_PADDING_X = 10
export const CODE_PADDING_Y = 8
/** 顶部「语言」小标签占的高度 */
export const CODE_HEADER = 17

/** 显示宽度单位：ASCII 记 1，CJK/全角记 2 */
export function codeUnitLength(line: string): number {
  let units = 0
  for (const ch of line) units += ch.charCodeAt(0) > 0xff ? 2 : 1
  return units
}

/** 等宽字体里一个「宽度单位」对应多少像素（尺寸估算与导出绘制共用） */
export const CODE_CHAR_WIDTH = CODE_FONT_SIZE * 0.6

/**
 * 代码块显示框：等宽字体按字符数估宽，**行数与列宽都不封顶**——
 * 代码块要完整展示整段代码（滚动条会让"代码被截断"，用户明确要求长宽不限）。
 * 渲染层（TopicNode / 导出绘制）的字号、内边距、行高全部取这里的常量，
 * 保证「测量 = 显示」。
 */
export function codeBoxSize(code: TopicCode | undefined): Size {
  if (!code) return { width: 0, height: 0 }
  const lines = code.text.length > 0 ? code.text.split('\n') : ['']
  let maxUnits = 8
  for (const line of lines) maxUnits = Math.max(maxUnits, codeUnitLength(line))
  const width = Math.max(CODE_MIN_WIDTH, Math.round(maxUnits * CODE_CHAR_WIDTH) + CODE_PADDING_X * 2)
  const height = CODE_HEADER + CODE_PADDING_Y * 2 + lines.length * Math.round(CODE_FONT_SIZE * CODE_LINE_RATIO)
  return { width, height }
}
