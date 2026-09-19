/**
 * 富文本段落 → 行内样式（由 ../TopicNode.tsx 按行范围搬出，行为零变化）。
 *
 * 纯函数、不依赖组件状态：画布上每一段的字体/装饰/颜色都由它决定，
 * 与测量（render/measure）和导出（export/*）保持同一份口径。
 */
import type { CSSProperties } from 'react'
import type { StyledSegment } from '@shared/layout/types'
import { HIGHLIGHT_BG } from '@shared/richtext'

export function segmentStyle(segment: StyledSegment): CSSProperties {
  const decoration = [segment.underline ? 'underline' : '', segment.strike ? 'line-through' : '']
    .filter(Boolean)
    .join(' ')
  const style: CSSProperties = {
    fontWeight: segment.weight,
    fontSize: segment.fontSize
  }
  if (segment.italic) style.fontStyle = 'italic'
  if (decoration) style.textDecoration = decoration
  if (segment.color) style.color = segment.color
  if (segment.fontFamily) style.fontFamily = segment.fontFamily
  // 高亮：底色（与自检里的 HIGHLIGHT_BG 一致，导出也用同一份颜色）
  if (segment.highlight) {
    style.background = HIGHLIGHT_BG
    style.borderRadius = 2
  }
  // 上下标：字号已经在测量里缩小过，这里只做上下偏移（line-height: 1 避免把行高撑开）
  if (segment.script === 'super' || segment.script === 'sub') {
    style.verticalAlign = segment.script === 'super' ? 'super' : 'sub'
    style.lineHeight = 1
  }
  return style
}
