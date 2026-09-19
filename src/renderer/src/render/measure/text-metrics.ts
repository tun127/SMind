/**
 * 画布文本测量与样式类型（由 render/measure.ts 按行范围搬出，行为零变化）。
 *
 * 这里是最底层的一块：其它 measure 子模块与入口都从它取**字体串**与**类型**，
 * 它自己不反过来依赖任何人，所以不会出现循环导入。
 * \`cssFontOf\` 是画布测量与位图导出的共用字体串（见 export/raster.ts）。
 */
import type { Size } from '@shared/layout/accessory'
import { formulaSize } from '../formula'
import { evictOldest } from '@shared/cache'

export const FONT_FAMILY =
  '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Segoe UI", system-ui, sans-serif'

/** 项目符号的前缀，参与测量也参与渲染，保证所见即所得 */
export const BULLET_PREFIX = '•  '

export interface BaseStyle {
  fontSize: number
  weight: number
  paddingX: number
  paddingY: number
  maxTextWidth: number
  minWidth: number
}

export interface ResolvedStyle {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  color?: string
  fontSize: number
  weight: number
  fontFamily: string
  highlight?: boolean
  script?: 'super' | 'sub'
}

export interface StyledChar {
  ch: string
  style: ResolvedStyle
  /** 行内公式（`$…$`）：整段作为一个「原子」参与断行，宽度取 KaTeX 的实测值 */
  formula?: string
  /** 行内公式的实测宽高（有公式时用，避免再走单字测量） */
  formulaWidth?: number
  formulaHeight?: number
}

/** 行内公式的实测尺寸（拿不到 DOM 时退回估算） */
export function inlineFormulaSize(source: string, fontSize: number): Size {
  return formulaSize(source, fontSize)
}

/* ------------------------------------------------------------------ */
/* Canvas 文本测量                                                     */
/* ------------------------------------------------------------------ */

export let measureCtx: CanvasRenderingContext2D | null = null
export let lastFont = ''

export function getCtx(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('当前环境不支持 Canvas 文本测量')
    measureCtx = ctx
  }
  return measureCtx
}

/**
 * 统一的字体串：粗斜体 + 字号 + 字体栈。
 *
 * **画布测量与位图导出共用这一份**：以前 `measure.ts` 与 `export/raster.ts` 各写一份，
 * 两处一旦不一致（比如一处漏了 `italic ` 的尾随空格），量出来的宽度与画出来的就不一样，
 * 表现为文字挤在一行或提前折行——而且往往只在导出图里看得见，极难定位。
 */
export function cssFontOf(
  size: number,
  weight: number,
  italic = false,
  family = FONT_FAMILY
): string {
  return `${italic ? 'italic ' : ''}${weight} ${size}px ${family}`
}

export function fontOf(style: ResolvedStyle): string {
  return cssFontOf(style.fontSize, style.weight, style.italic, style.fontFamily)
}

/** 单字符宽度缓存：富文本逐字符测量时必须缓存，否则 2000 节点会明显卡顿 */
export const charWidthCache = new Map<string, number>()
export const CHAR_CACHE_LIMIT = 60000

export function widthOf(char: StyledChar): number {
  if (char.formula)
    return char.formulaWidth ?? inlineFormulaSize(char.formula, char.style.fontSize).width
  const ch = char.ch
  const style = char.style
  const font = fontOf(style)
  const key = `${font}\u0000${ch}`
  const cached = charWidthCache.get(key)
  if (cached !== undefined) return cached

  const ctx = getCtx()
  if (lastFont !== font) {
    ctx.font = font
    lastFont = font
  }
  const width = ctx.measureText(ch).width
  evictOldest(charWidthCache, CHAR_CACHE_LIMIT)
  charWidthCache.set(key, width)
  return width
}
