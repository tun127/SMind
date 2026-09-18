/**
 * 代码块高亮入口：语言归一 + 渲染热路径缓存。
 *
 * 依赖方向：lang-defs.ts（数据）← lexer.ts（纯分词）← 本文件（缓存与对外入口）。
 * 本模块零外部依赖、不碰 DOM，自检可以直接整包跑。
 */
import { ALIASES, DEFS } from './lang-defs'
import {
  scanCodeLine,
  scanCssLine,
  scanDataLine,
  scanMarkupLine,
  type CodeLine,
  type ScanState
} from './lexer'

export { CODE_TOKEN_COLORS } from './lexer'
export type { CodeLine, CodeToken, CodeTokenKind } from './lexer'

function normalizeCodeLanguage(language: string | undefined): string {
  const key = (language ?? '').trim().toLowerCase()
  if (key.length === 0) return ''
  if (key in DEFS) return key
  if (key in ALIASES) return ALIASES[key] ?? ''
  return ''
}

/* ------------------------------------------------------------------ */
/* 对外入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 逐行分词。认不出语言（`text` / 空 / 未知）时每行只有一个 plain token——
 * 也就是"不高亮"，行为与老版本完全一致。
 */
/**
 * 渲染热路径缓存。
 *
 * Canvas 的布局 useMemo 每次 workbook 变化都会产出全新 LayoutResult，
 * TopicNode 的 memo 随之整体失效——同一份代码在滚动、AI 批量写入、
 * 任何无关节点改动后都会被**重新分词一遍**（逐行逐字符，纯 CPU）。
 * 分词结果是只读的纯数据，按 `(language, code)` 复用即可，行为完全不变。
 */
const HIGHLIGHT_CACHE_LIMIT = 64
/**
 * 缓存的总字符预算。
 *
 * 早先的实现给「单个代码块」设了 20000 字符的上限（超了就不进缓存）——
 * 那是个**病理口子**：AI 往一个节点里写一整份文件时，此后每一次重排
 * （每次 store 改动、每敲一次字）都会把这段大代码**全量重新分词**，
 * 正好落在「内容依赖型冻结」的形状上。改成按总字符量限流：
 * 大代码块也能命中，内存仍有上界。
 */
const HIGHLIGHT_CACHE_CHAR_BUDGET = 4_000_000
const highlightCache = new Map<string, { lines: CodeLine[]; chars: number }>()
let highlightCacheChars = 0

export function highlightCode(code: string, language: string | undefined): CodeLine[] {
  const id = normalizeCodeLanguage(language)
  const cacheKey = `${id ?? ''}\u0000${code}`
  const cached = highlightCache.get(cacheKey)
  if (cached !== undefined) {
    // Map 按插入序淘汰：命中后挪到末尾，近似 LRU
    highlightCache.delete(cacheKey)
    highlightCache.set(cacheKey, cached)
    return cached.lines
  }
  const result = highlightUncached(code, id)
  // 单块就超过总预算的（病态输入）：本次照常返回，只是不进缓存
  if (code.length <= HIGHLIGHT_CACHE_CHAR_BUDGET) {
    while (
      highlightCache.size > 0 &&
      (highlightCache.size >= HIGHLIGHT_CACHE_LIMIT ||
        highlightCacheChars + code.length > HIGHLIGHT_CACHE_CHAR_BUDGET)
    ) {
      const oldest = highlightCache.keys().next().value
      if (oldest === undefined) break
      const evicted = highlightCache.get(oldest)
      highlightCache.delete(oldest)
      if (evicted) highlightCacheChars -= evicted.chars
    }
    highlightCache.set(cacheKey, { lines: result, chars: code.length })
    highlightCacheChars += code.length
  }
  return result
}

function highlightUncached(code: string, id: string | null): CodeLine[] {
  const lines = code.split('\n')
  const def = id ? DEFS[id] : undefined
  if (!def)
    return lines.map((line) => ({
      tokens: line.length > 0 ? [{ text: line, kind: 'plain' as const }] : []
    }))

  if (def.mode === 'markup') return lines.map((line) => ({ tokens: scanMarkupLine(line) }))
  if (def.mode === 'css') return lines.map((line) => ({ tokens: scanCssLine(line) }))
  if (def.mode === 'data') return lines.map((line) => ({ tokens: scanDataLine(line, def) }))

  // code 模式：块注释与多行字符串要跨行传递状态
  const state: ScanState = { blockEnd: null, multilineQuote: null }
  return lines.map((line) => ({ tokens: scanCodeLine(line, def, state) }))
}
