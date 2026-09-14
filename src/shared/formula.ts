/**
 * 公式输入规范化：把 **Markdown / LaTeX 的各种数学写法**统一成纯 LaTeX 源码。
 *
 * 支持（可叠加，剥到不能再剥为止）：
 * - `$x^2$`（Markdown 行内数学）
 * - `$$x^2$$`（Markdown 块级数学）
 * - `\(x^2\)` / `\[x^2\]`（LaTeX 定界符）
 *
 * 这样「从 Markdown 里复制一段数学直接粘进公式框」也能用，
 * 而节点里存的始终是干净的 LaTeX（导出时再统一写成 `$$…$$`）。
 */
export function normalizeFormulaInput(raw: string): string {
  let text = (raw ?? '').trim()
  const pairs: Array<[string, string]> = [
    ['$$', '$$'],
    ['\\[', '\\]'],
    ['\\(', '\\)'],
    ['$', '$']
  ]

  let changed = true
  while (changed) {
    changed = false
    for (const [open, close] of pairs) {
      if (
        text.length > open.length + close.length &&
        text.startsWith(open) &&
        text.endsWith(close)
      ) {
        text = text.slice(open.length, text.length - close.length).trim()
        changed = true
      }
    }
  }
  return text
}

export interface InlineMathSegment {
  /** 普通文字段 */
  text?: string
  /** 行内公式段（`$…$` 里的源码） */
  formula?: string
}

/**
 * 把一段文字按**行内公式**切成「文字 / 公式」段，供测量与渲染共用。
 * 只认 `$…$`（Markdown 的行内数学写法），不跨行、不处理 `$$` 块级写法。
 */
export function splitInlineMath(text: string): InlineMathSegment[] {
  const parts: InlineMathSegment[] = []
  const pattern = /\$([^$\n]+)\$/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > last) parts.push({ text: text.slice(last, start) })
    parts.push({ formula: match[1].trim() })
    last = start + match[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts.length > 0 ? parts : [{ text }]
}

/** 一行整句就是数学（`$…$` / `$$…$$` / `\[…\]`）：返回公式源码，否则 null */
export function matchWholeLineMath(line: string): string | null {
  const text = (line ?? '').trim()
  const patterns = [/^\$\$([\s\S]+?)\$\$$/, /^\$([\s\S]+?)\$$/, /^\\\[([\s\S]+?)\\\]$/, /^\\\(([\s\S]+?)\\\)$/]
  for (const pattern of patterns) {
    const hit = pattern.exec(text)
    if (hit && hit[1].trim().length > 0) return hit[1].trim()
  }
  return null
}
