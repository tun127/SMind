/**
 * 贪心断行（由 render/measure.ts 按行范围搬出，行为零变化）。
 * 逐字符测量而不是逐词：中文没有词边界。
 */
import { widthOf, type StyledChar } from './text-metrics'

/**
 * 贪心断行，优先在空白处折行。
 * 逐字符测量而不是逐词，是因为中文没有词边界。
 */
export function wrapChars(chars: StyledChar[], maxWidth: number): StyledChar[][] {
  if (chars.length === 0) return [[]]
  const lines: StyledChar[][] = []
  let start = 0
  let index = 0
  let width = 0
  let lastSpace = -1

  while (index < chars.length) {
    const char = chars[index]
    if (!char) break
    const charWidth = widthOf(char)
    if (width + charWidth > maxWidth && index > start) {
      const breakAt = lastSpace > start ? lastSpace + 1 : index
      lines.push(chars.slice(start, breakAt))
      start = breakAt
      // 行首空格不参与排版
      while (start < chars.length && chars[start]?.ch === ' ') start += 1
      index = start
      width = 0
      lastSpace = -1
      continue
    }
    if (char.ch === ' ') lastSpace = index
    width += charWidth
    index += 1
  }

  if (start < chars.length) lines.push(chars.slice(start))
  return lines.length > 0 ? lines : [[]]
}
