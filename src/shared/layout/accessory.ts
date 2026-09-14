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

/** 手动拉伸节点时，代码块最多放大到自然尺寸的几倍 */
export const CODE_GROW_LIMIT = 2
/** 代码块缩放下限：再小就看不清了（宁可溢出也不糊成一团） */
export const CODE_MIN_SCALE = 0.5

/**
 * 代码块的**全套排版指标**。
 *
 * 为什么返回整套指标而不是只返回尺寸：手动拉伸节点时，代码块要像图片一样
 * 等比缩放——字号、行高、内边距**必须一起缩**，否则"测量说这么大、画出来那么大"
 * 就对不上了（会出现文字溢出节点框）。
 * 渲染层与导出层都从这里取指标，保证三处一致。
 */
export interface CodeMetrics {
  /** 相对自然尺寸的缩放系数 */
  scale: number
  fontSize: number
  lineHeight: number
  paddingX: number
  paddingY: number
  /** 顶部语言标签占的高度 */
  header: number
  width: number
  height: number
}

/**
 * 代码块指标：等宽字体按字符数估宽，**行数与列宽都不封顶**（要完整展示整段代码）。
 *
 * 给了 `bounds`（节点被手动拉伸）时按可用空间**等比缩放**：字号、行高、内边距一起缩，
 * 于是代码块永远待在节点框里——这就是"像图片一样有缩放功能"。
 */
export function codeBlockMetrics(code: TopicCode | undefined, bounds?: Size): CodeMetrics | null {
  if (!code) return null
  const lines = code.text.length > 0 ? code.text.split('\n') : ['']
  let maxUnits = 8
  for (const line of lines) maxUnits = Math.max(maxUnits, codeUnitLength(line))

  const naturalWidth = Math.max(CODE_MIN_WIDTH, Math.round(maxUnits * CODE_CHAR_WIDTH) + CODE_PADDING_X * 2)
  const naturalLineHeight = Math.round(CODE_FONT_SIZE * CODE_LINE_RATIO)
  const naturalHeight = CODE_HEADER + CODE_PADDING_Y * 2 + lines.length * naturalLineHeight

  /** 按给定比例算出全套指标（字号、行高、内边距都有可读性下限） */
  const metricsAt = (value: number): CodeMetrics => {
    const fontSize = Math.max(6, Math.round(CODE_FONT_SIZE * value))
    const lineHeight = Math.round(fontSize * CODE_LINE_RATIO)
    const paddingX = Math.max(4, Math.round(CODE_PADDING_X * value))
    const paddingY = Math.max(3, Math.round(CODE_PADDING_Y * value))
    const header = Math.max(12, Math.round(CODE_HEADER * value))
    // 等宽字体：单字宽随字号等比变化（CODE_CHAR_WIDTH 就是自然字号下的单字宽）
    const charWidth = (fontSize * CODE_CHAR_WIDTH) / CODE_FONT_SIZE
    return {
      scale: value,
      fontSize,
      lineHeight,
      paddingX,
      paddingY,
      header,
      width: Math.max(CODE_MIN_WIDTH * value, Math.round(maxUnits * charWidth) + paddingX * 2),
      height: header + paddingY * 2 + lines.length * lineHeight
    }
  }

  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return metricsAt(1)

  // 先按比例估算，再根据**取整与可读性下限**带来的误差回调几次：
  // 目标是把整块塞进给定空间（塞不下就接受下限值，宁可略大也不能糊）
  let scale = Math.max(
    CODE_MIN_SCALE,
    Math.min(CODE_GROW_LIMIT, bounds.width / naturalWidth, bounds.height / naturalHeight)
  )
  for (let i = 0; i < 8 && scale > CODE_MIN_SCALE; i += 1) {
    const test = metricsAt(scale)
    if (test.width <= bounds.width && test.height <= bounds.height) break
    scale = Math.max(CODE_MIN_SCALE, scale * 0.94)
  }
  return metricsAt(scale)
}

/** 代码块显示框（尺寸；渲染层要完整指标时用 {@link codeBlockMetrics}） */
export function codeBoxSize(code: TopicCode | undefined, bounds?: Size): Size {
  const metrics = codeBlockMetrics(code, bounds)
  return metrics ? { width: metrics.width, height: metrics.height } : { width: 0, height: 0 }
}

/**
 * 带代码块的节点**最小尺寸**：不能小于「代码块缩到下限时的尺寸 + 节点内边距」。
 *
 * 为什么需要它：代码块最小只能缩到 {@link CODE_MIN_SCALE}（再小就看不清了），
 * 如果允许把节点框拖得比这更小，代码块就会**溢出到节点框外面**——
 * 用户报的"框比代码块还小"就是这么来的。
 */
export function codeMinNodeSize(code: TopicCode | undefined, padding: { x: number; y: number }): Size | null {
  if (!code) return null
  // 用"极小空间"逼出缩放下限下的那套指标
  const floor = codeBlockMetrics(code, { width: 1, height: 1 })
  if (!floor) return null
  return {
    width: floor.width + padding.x * 2,
    height: floor.height + padding.y * 2
  }
}
