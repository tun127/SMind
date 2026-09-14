/**
 * 画布级元素（概要 / 边界 / 关系线）的**标题样式**读写。
 *
 * 它们的数据结构里本来就有 `style?: NodeStyle`（与主题同一套 properties 命名），
 * 但此前没人读也没人写——表现就是「概要改不了字体」。这里把读写收成两个纯函数：
 * 渲染（画布 + 导出）读、面板写，两边认同一个键，不会各写各的。
 *
 * 用 Xmind 的属性名（`fo:*`）：`fo:font-size` 能写 `14px` 或 `14`，
 * 所以读的时候两种都要认。
 */

import type { NodeStyle } from './types'

export interface OverlayTextStyle {
  /** 字号（px） */
  fontSize: number
  bold: boolean
  italic: boolean
  /** 文字颜色；不填＝用分支配色 */
  color?: string
}

/** 三类画布级元素：它们都有标题与样式，且都能被选中 */
export type OverlayKind = 'summary' | 'boundary' | 'relationship'

/**
 * 样式改动。
 *
 * 显式给 `undefined` 表示「恢复元素默认」——对应属性键会被删掉；
 * 其余情况按值写入。这样「取消加粗」能写成 `fo:font-weight: normal`，
 * 不会因为删键又落回「概要默认加粗」。
 */
export type OverlayTextStylePatch = {
  fontSize?: number | undefined
  bold?: boolean | undefined
  italic?: boolean | undefined
  color?: string | undefined
}

export const OVERLAY_FONT_SIZE_KEY = 'fo:font-size'
export const OVERLAY_FONT_WEIGHT_KEY = 'fo:font-weight'
export const OVERLAY_FONT_STYLE_KEY = 'fo:font-style'
export const OVERLAY_FONT_COLOR_KEY = 'fo:color'

/** 读字号：`14px` / `14` / 数字字符串都认，读不到用兜底值 */
export function readOverlayFontSize(style: NodeStyle | undefined, fallback: number): number {
  const raw = style?.properties?.[OVERLAY_FONT_SIZE_KEY]
  if (typeof raw !== 'string') return fallback
  const value = Number.parseFloat(raw.replace(/px$/i, '').trim())
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** 读一整套标题样式；`fallback` 给的是元素自身的默认值（概要与边界不同） */
export function readOverlayTextStyle(
  style: NodeStyle | undefined,
  fallback: { fontSize: number; bold: boolean }
): OverlayTextStyle {
  const properties = style?.properties ?? {}
  const weight = properties[OVERLAY_FONT_WEIGHT_KEY]
  const fontStyle = properties[OVERLAY_FONT_STYLE_KEY]
  return {
    fontSize: readOverlayFontSize(style, fallback.fontSize),
    // 没显式写过就用元素自己的默认粗细（概要默认加粗、边界默认加粗）
    bold: weight === undefined ? fallback.bold : weight === 'bold' || Number(weight) >= 600,
    italic: fontStyle === 'italic',
    color: typeof properties[OVERLAY_FONT_COLOR_KEY] === 'string' ? properties[OVERLAY_FONT_COLOR_KEY] : undefined
  }
}

/**
 * 把一段样式改动写回 `style`。
 *
 * `undefined` 表示「恢复默认」——对应的键会被删掉而不是写成空串，
 * 这样「另存 → 再打开」不会留下一堆空属性；全都删空时返回 undefined（等于没有 style）。
 */
export function withOverlayTextStyle(
  style: NodeStyle | undefined,
  patch: Partial<OverlayTextStyle>
): NodeStyle | undefined {
  const properties: Record<string, string> = { ...(style?.properties ?? {}) }

  const write = (key: string, value: string | undefined): void => {
    if (value === undefined || value === '') delete properties[key]
    else properties[key] = value
  }

  if ('fontSize' in patch) write(OVERLAY_FONT_SIZE_KEY, patch.fontSize ? `${patch.fontSize}px` : undefined)
  // 加粗要写 'normal' 而不是删键：删键会落回「概要默认加粗」
  if ('bold' in patch) {
    write(OVERLAY_FONT_WEIGHT_KEY, patch.bold === undefined ? undefined : patch.bold ? 'bold' : 'normal')
  }
  if ('italic' in patch) write(OVERLAY_FONT_STYLE_KEY, patch.italic ? 'italic' : undefined)
  if ('color' in patch) write(OVERLAY_FONT_COLOR_KEY, patch.color)

  if (Object.keys(properties).length === 0) {
    // 只保留其他用途的字段：全空就等于没样式
    return style?.id ? { ...style, properties } : undefined
  }
  return { ...(style ?? {}), properties }
}
