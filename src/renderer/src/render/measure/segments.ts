/**
 * 字符 → 样式段（由 render/measure.ts 按行范围搬出，行为零变化）。
 * 相邻同款式的字符合并成一个 StyledSegment，渲染与导出都按段上色。
 */
import type { StyledSegment } from '@shared/layout/types'
import type { ResolvedStyle, StyledChar } from './text-metrics'

export function sameStyle(segment: StyledSegment, style: ResolvedStyle): boolean {
  return (
    segment.weight === style.weight &&
    Boolean(segment.italic) === style.italic &&
    Boolean(segment.underline) === style.underline &&
    Boolean(segment.strike) === style.strike &&
    Boolean(segment.highlight) === Boolean(style.highlight) &&
    segment.script === style.script &&
    segment.color === style.color &&
    segment.fontSize === style.fontSize &&
    segment.fontFamily === style.fontFamily
  )
}

export function segmentOf(text: string, style: ResolvedStyle): StyledSegment {
  return {
    text,
    weight: style.weight,
    italic: style.italic || undefined,
    underline: style.underline || undefined,
    strike: style.strike || undefined,
    color: style.color,
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
    highlight: style.highlight,
    script: style.script
  }
}

export function groupSegments(chars: StyledChar[]): StyledSegment[] {
  const segments: StyledSegment[] = []
  for (const char of chars) {
    // 行内公式自成一个段（不与前后文字合并，渲染时要整块交给 KaTeX）
    if (char.formula) {
      segments.push({ ...segmentOf(char.ch, char.style), formula: char.formula })
      continue
    }
    const previous = segments[segments.length - 1]
    if (previous && !previous.formula && sameStyle(previous, char.style)) previous.text += char.ch
    else segments.push(segmentOf(char.ch, char.style))
  }
  return segments
}
