/**
 * Markdown → 思维导图大纲（纯函数，可在自检里跑）。
 *
 * 规则：
 * 1. `# 一级标题` 的层级决定节点深度；标题之间按级别嵌套；
 * 2. 标题下面的 `- 列表`（含 `*`/`+`/数字列表/任务列表）按缩进嵌套，挂在它所属的标题下；
 * 3. 行内格式全部提取成富文本：**粗体**、*斜体*、~~删除线~~、`行内代码`（等宽字体）、
 *    [链接](url)（文字进标题、url 进节点超链接）、![alt](url)（保留替代文字）；
 *    节点标题仍是纯文本（搜索 / 大纲面板用），富文本在 `rich` 字段里一并带回；
 * 4. 代码块（``` 围栏，含语言标注）挂到**最近的标题/列表项**上成为该节点的代码块；
 *    挂不上（已有代码或已有子节点）时生成一个「代码」子主题；
 * 5. 引用块与普通段落作为**最近节点**的备注（一篇有正文的 md 不再被整段丢掉）；
 * 6. 表格的每个数据行变成一个子主题（单元格用「 / 」连接）；分隔行跳过；
 * 7. YAML front-matter 与水平线跳过；一个标题/列表都没有时，退化成「一行一个主题」。
 */

import type { OutlineNode, ParsedOutline } from '../ai'
import { matchWholeLineMath } from '../formula'
import type { RichText, RichTextRun } from '../model/types'

/** 行内代码在节点里用的等宽字体（与代码块一致） */
export const MD_MONO_FONT = 'Consolas, "JetBrains Mono", Menlo, monospace'

interface InlineRun {
  text: string
  bold?: boolean
  italic?: boolean
  strike?: boolean
  underline?: boolean
  /** 高亮（`==…==` / `<mark>`） */
  highlight?: boolean
  /** 上标 / 下标（`^…^` / `~…~` / `<sup>` / `<sub>`） */
  script?: 'super' | 'sub'
  mono?: boolean
  link?: boolean
}

/** 行内解析需要的外部上下文：链接引用定义、脚注定义、引用到的脚注 id */
export interface InlineContext {
  /** `[id]: url` 形式的链接引用定义 */
  linkRefs?: Map<string, string>
  /** `[^id]: 说明` 形式的脚注定义 */
  footnotes?: Map<string, string>
  /** 本次解析用到的脚注 id（按出现顺序，去重） */
  usedFootnotes?: string[]
}

export interface ParsedInline {
  runs: InlineRun[]
  text: string
  href?: string
  /** 这一行引用到的脚注 id（导入时把定义补进节点备注） */
  usedFootnotes?: string[]
}

/** 需要转义的字符（CommonMark 的可转义字符集） */
const ESCAPABLE = '\\`*_{}[]()#+-.!~^=<>|'
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  times: '×',
  divide: '÷',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  deg: '°',
  plusmn: '±',
  ne: '≠',
  le: '≤',
  ge: '≥',
  rarr: '→',
  larr: '←',
  harr: '↔',
  check: '✓',
  cross: '✗',
  star: '★',
  heart: '♥'
}

function decodeEntity(name: string): string {
  if (name.startsWith('#')) {
    const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : `&${name};`
  }
  return ENTITIES[name.toLowerCase()] ?? `&${name};`
}

/** 行内 HTML 标签 → 它对应的富文本样式（不认识的一律剥掉） */
function inlineTagStyle(tag: string): Partial<InlineRun> | 'close' | 'break' | null {
  const name = tag.replace(/[<>/]/g, '').toLowerCase()
  switch (name) {
    case 'u':
    case 'ins':
      return { underline: true }
    case 'b':
    case 'strong':
      return { bold: true }
    case 'i':
    case 'em':
      return { italic: true }
    case 's':
    case 'del':
    case 'strike':
      return { strike: true }
    case 'mark':
      return { highlight: true }
    case 'sup':
      return { script: 'super' }
    case 'sub':
      return { script: 'sub' }
    case 'code':
      return { mono: true }
    case 'br':
      return 'break'
    default:
      return null
  }
}

interface InlineStyle {
  bold?: boolean
  italic?: boolean
  strike?: boolean
  underline?: boolean
  highlight?: boolean
  script?: 'super' | 'sub'
  mono?: boolean
  link?: boolean
}

/**
 * 行内 Markdown → run 序列（**扫描器**实现，不是一个大正则）。
 *
 * 支持 Typora 用到的全部行内语法：
 * `**粗体**`、`*斜体*`、`~~删除线~~`、`==高亮==`、`^上标^`、`~下标~`、
 * `` `行内代码` ``、`![alt](url)`、`[文字](url)`、`[文字][引用]`、`[^脚注]`、
 * 行内 HTML（`<u>`/`<sup>`/`<sub>`/`<mark>`/`<br>`/`<b>`/`<i>`…，不认识的剥掉）、
 * 实体（`&amp;` / `&#39;`）、反斜杠转义。
 *
 * 采用「找配对闭合符」而不是「见到就切换状态」：这样 `2 * 3` 里那个孤立的 `*`
 * 不会被误当成斜体开关（否则后面的文字会整段变斜）。
 */
export function parseInlineMarkdown(raw: string, context: InlineContext = {}): ParsedInline {
  const runs: InlineRun[] = []
  let href: string | undefined
  /** 这一行引用到的脚注（去重，按出现顺序） */
  const usedFootnotes: string[] = []
  const scanContext: InlineContext = { ...context, usedFootnotes }

  const push = (text: string, style: InlineStyle): void => {
    if (text.length === 0) return
    const previous = runs[runs.length - 1]
    const sameAsPrevious =
      previous &&
      Boolean(previous.bold) === Boolean(style.bold) &&
      Boolean(previous.italic) === Boolean(style.italic) &&
      Boolean(previous.strike) === Boolean(style.strike) &&
      Boolean(previous.underline) === Boolean(style.underline) &&
      Boolean(previous.highlight) === Boolean(style.highlight) &&
      previous.script === style.script &&
      Boolean(previous.mono) === Boolean(style.mono) &&
      Boolean(previous.link) === Boolean(style.link)
    if (sameAsPrevious) previous.text += text
    else runs.push({ text, ...style })
  }

  /** 逐字符扫描；`style` 是当前生效的样式（由外层递归传入） */
  const walk = (source: string, style: InlineStyle): void => {
    let i = 0
    let buffer = ''
    const flush = (): void => {
      if (buffer.length === 0) return
      push(buffer, style)
      buffer = ''
    }

    while (i < source.length) {
      const ch = source[i]

      // 1) 反斜杠转义
      const escaped = source[i + 1] ?? ''
      if (ch === '\\' && i + 1 < source.length && ESCAPABLE.includes(escaped)) {
        buffer += escaped
        i += 2
        continue
      }

      // 2) HTML 实体
      if (ch === '&') {
        const entity = /^&([a-zA-Z]+|#[0-9]+|#x[0-9a-fA-F]+);/.exec(source.slice(i))
        if (entity) {
          buffer += decodeEntity(entity[1] ?? '')
          i += entity[0].length
          continue
        }
      }

      // 3) 行内 HTML
      if (ch === '<') {
        // 允许带属性（`<span class="x">` 这种也要被识别出来才有机会剥掉）
        const tag = /^<\/?[a-zA-Z][a-zA-Z0-9]*(\s[^>]*)?\/?>/.exec(source.slice(i))
        if (tag) {
          const isClose = tag[0].startsWith('</')
          const mapped = inlineTagStyle(tag[0])
          i += tag[0].length
          if (mapped === 'break') {
            buffer += '\n'
            continue
          }
          if (mapped === null || mapped === 'close' || isClose) continue // 剥掉 / 结束标签
          const tagStyle: Partial<InlineRun> = mapped
          // 开标签：找到配对的结束标签，区间内套用样式
          const name = /^<([a-zA-Z0-9]+)/.exec(tag[0])![1]
          const closer = new RegExp(`</${name}\\s*>`, 'i')
          const rest = source.slice(i)
          const end = rest.search(closer)
          if (end < 0) {
            walk(rest, { ...style, ...tagStyle })
            i = source.length
          } else {
            walk(rest.slice(0, end), { ...style, ...tagStyle })
            const closed = closer.exec(rest)!
            i += end + closed[0].length
          }
          continue
        }
      }

      // 4) 行内代码（内部不做任何解析）
      if (ch === '`') {
        const end = source.indexOf('`', i + 1)
        if (end > i) {
          flush()
          push(source.slice(i + 1, end), { ...style, mono: true })
          i = end + 1
          continue
        }
      }

      // 5) 图片（保留替代文字）
      if (ch === '!' && source[i + 1] === '[') {
        const image = /^!\[([^\]]*)\]\(([^)]*)\)/.exec(source.slice(i))
        if (image) {
          flush()
          push(image[1] ?? '', style)
          i += image[0].length
          continue
        }
      }

      // 6) 脚注引用 `[^id]`
      if (ch === '[' && source[i + 1] === '^') {
        const footnote = /^\[\^([^\]]+)\]/.exec(source.slice(i))
        if (footnote) {
          flush()
          const id = footnote[1] ?? ''
          if (!scanContext.usedFootnotes!.includes(id)) scanContext.usedFootnotes!.push(id)
          push(footnote[0], { ...style, link: true, script: 'super' })
          i += footnote[0].length
          continue
        }
      }

      // 7) 链接 `[文字](url)` 与引用式链接 `[文字][id]`
      if (ch === '[') {
        const inlineLink = /^\[([^\]]*)\]\(([^)]*)\)/.exec(source.slice(i))
        if (inlineLink) {
          flush()
          const url = inlineLink[2] ?? ''
          if (!href && url.length > 0) href = url
          push(inlineLink[1] ?? '', { ...style, link: true })
          i += inlineLink[0].length
          continue
        }
        const refLink = /^\[([^\]]*)\]\[([^\]]*)\]/.exec(source.slice(i))
        if (refLink) {
          const label = refLink[1] ?? ''
          const refId = refLink[2] ?? ''
          const id = refId.length > 0 ? refId : label
          const url = context.linkRefs?.get(id.toLowerCase())
          flush()
          if (!href && url) href = url
          push(label, { ...style, link: true })
          i += refLink[0].length
          continue
        }
        // 快捷引用式 `[id]`
        const shortcut = /^\[([^\]^][^\]]*)\]/.exec(source.slice(i))
        const shortcutText = shortcut?.[1] ?? ''
        const shortcutUrl = shortcut ? context.linkRefs?.get(shortcutText.toLowerCase()) : undefined
        if (shortcut && shortcutUrl) {
          flush()
          if (!href) href = shortcutUrl
          push(shortcutText, { ...style, link: true })
          i += shortcut[0].length
          continue
        }
      }

      // 8) 强调类：找配对闭合符，找到才当格式，否则按字面字符
      const emphasis = matchEmphasis(source, i)
      if (emphasis) {
        flush()
        walk(emphasis.inner, { ...style, ...emphasis.style })
        i = emphasis.end
        continue
      }

      buffer += ch
      i += 1
    }
    flush()
  }

  walk(raw, {})
  const text = runs.map((run) => run.text).join('')
  const trimmed = text.trim()
  if (trimmed.length !== text.length) {
    while (runs.length > 0 && (runs[0]?.text.trim().length ?? 0) === 0) runs.shift()
    while (runs.length > 0 && (runs[runs.length - 1]?.text.trim().length ?? 0) === 0) runs.pop()
  }
  return { runs, text: trimmed, href, usedFootnotes: usedFootnotes.length > 0 ? usedFootnotes : undefined }
}

interface EmphasisMatch {
  inner: string
  style: InlineStyle
  /** 闭合符之后的下标 */
  end: number
}

/**
 * 从 `index` 起尝试匹配一段强调语法。
 *
 * 闭合符必须存在且内部非空、不以空白开头结尾——否则返回 null，
 * 让调用方把当前字符当普通文字（`2 * 3`、`a~b` 这类不会误伤）。
 */
function matchEmphasis(source: string, index: number): EmphasisMatch | null {
  const tryMatch = (marker: string, style: InlineStyle): EmphasisMatch | null => {
    if (!source.startsWith(marker, index)) return null
    const rest = source.slice(index + marker.length)
    const end = rest.indexOf(marker)
    if (end <= 0) return null
    const inner = rest.slice(0, end)
    if (inner.trim().length === 0) return null
    if (/^\s/.test(inner) || /\s$/.test(inner)) return null
    return { inner, style, end: index + marker.length + end + marker.length }
  }

  // 顺序要紧：长的标记在前（`**` 先于 `*`，`~~` 先于 `~`）
  return (
    tryMatch('**', { bold: true }) ??
    tryMatch('__', { bold: true }) ??
    tryMatch('~~', { strike: true }) ??
    tryMatch('==', { highlight: true }) ??
    tryMatch('*', { italic: true }) ??
    tryMatch('_', { italic: true }) ??
    tryMatch('^', { script: 'super' }) ??
    tryMatch('~', { script: 'sub' })
  )
}

/** 行内 run → 节点富文本；全部都是普通文字时返回 undefined（没必要存 rich） */
export function inlineRunsToRich(runs: InlineRun[]): RichText | undefined {
  const mapped: RichTextRun[] = runs
    .filter((run) => run.text.length > 0)
    .map((run) => ({
      text: run.text,
      bold: run.bold || undefined,
      italic: run.italic || undefined,
      strike: run.strike || undefined,
      underline: run.underline || run.link || undefined,
      highlight: run.highlight || undefined,
      script: run.script,
      fontFamily: run.mono ? MD_MONO_FONT : undefined
    }))
  if (mapped.length === 0) return undefined
  const hasFormat = mapped.some(
    (run) => run.bold || run.italic || run.strike || run.underline || run.highlight || run.script || run.fontFamily
  )
  if (!hasFormat) return undefined
  return { paragraphs: [{ runs: mapped }] }
}

/** 去掉行内的 Markdown 装饰，只留文字（表格单元格、备注等纯文本场合用） */
export function cleanInlineMarkdown(raw: string): string {
  return parseInlineMarkdown(raw).text
}

interface MarkdownLine {
  kind: 'heading' | 'list'
  /** heading：1–6；list：缩进层级（0 起） */
  depth: number
  level: number
  text: string
  rich?: RichText
  href?: string
  /** 整句就是数学（`$…$` / `$$…$$`）时，这里放公式源码，标题留空 */
  formula?: string
  /** 这一行里引用到的脚注 id（导入时把定义补进该节点的备注） */
  footnotes?: string[]
}

/** 解析一行；不是标题/列表则返回 null */
export function parseMarkdownLine(line: string, context: InlineContext = {}): MarkdownLine | null {
  if (line.trim().length === 0) return null

  const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim())
  if (heading) {
    const level = (heading[1] ?? '').length
    const body = (heading[2] ?? '').replace(/\s*#+\s*$/, '') // 行尾的标题锚点 ### 之类
    // 整句是数学 → 变成节点的公式
    const math = matchWholeLineMath(body)
    if (math) return { kind: 'heading', depth: level, level, text: '', formula: math }
    const inline = parseInlineMarkdown(body, context)
    if (inline.text.length === 0) return null
    return {
      kind: 'heading',
      depth: level,
      level,
      text: inline.text,
      rich: inlineRunsToRich(inline.runs),
      href: inline.href,
      footnotes: inline.usedFootnotes
    }
  }

  const expanded = line.replace(/\t/g, '  ')
  const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(expanded)
  if (list) {
    // 任务列表：勾选框不进标题（- [x] 已完成 → 「已完成」）
    const body = (list[3] ?? '').replace(/^\[[ xX]\]\s+/, '')
    const depth = Math.floor((list[1] ?? '').length / 2)
    // 整句是数学 → 变成节点的公式（节点标题留空，公式自成一块）
    const math = matchWholeLineMath(body)
    if (math) return { kind: 'list', depth, level: 0, text: '', formula: math }
    const inline = parseInlineMarkdown(body, context)
    if (inline.text.length === 0) return null
    return {
      kind: 'list',
      depth,
      level: 0,
      text: inline.text,
      rich: inlineRunsToRich(inline.runs),
      href: inline.href,
      footnotes: inline.usedFootnotes
    }
  }

  return null
}

/**
 * 文本里是否含 Markdown 行内标记。
 *
 * 粘贴时用它决定"要不要按语法解析"：
 * 剪贴板里同时带 HTML（从网页/文档复制）时，只有纯文本本身明显是 Markdown 才抢过来解析，
 * 否则交给编辑器的默认粘贴（那是真正的富文本）。
 */
export function looksLikeMarkdown(text: string): boolean {
  return (
    /==[^\s=][^=]*==/.test(text) ||
    /\^[^\s^]+\^/.test(text) ||
    /~~[^~]+~~/.test(text) ||
    /`[^`]+`/.test(text) ||
    /\*\*[^*]+\*\*/.test(text) ||
    /\[[^\]^][^\]]*\]\([^)]+\)/.test(text) ||
    /\[\^[^\]]+\]/.test(text) ||
    // 单波浪线下标：贴着字的（H~2~O）或前后有空白的（~i~ ），但不能是 ~~删除线~~
    /[^\s~]~[^\s~]+~/.test(text)
  )
}

/**
 * 收集 `[^脚注]: 说明` 与 `[链接名]: url` 这两类**定义行**。
 * 它们不是内容，主扫描里要跳过；但行内解析需要它们做查表。
 */
function collectDefinitions(source: string): { footnotes: Map<string, string>; linkRefs: Map<string, string> } {
  const footnotes = new Map<string, string>()
  const linkRefs = new Map<string, string>()
  for (const line of source.split(/\r?\n/)) {
    const footnote = /^\s*\[\^([^\]]+)\]:\s*(.*)$/.exec(line)
    if (footnote) {
      footnotes.set(footnote[1] ?? '', (footnote[2] ?? '').trim())
      continue
    }
    const linkRef = /^\s*\[([^\]^][^\]]*)\]:\s*(\S+)(?:\s+["'(].*)?$/.exec(line)
    if (linkRef) {
      linkRefs.set((linkRef[1] ?? '').trim().toLowerCase(), (linkRef[2] ?? '').trim())
    }
  }
  return { footnotes, linkRefs }
}

/** 定义行（脚注 / 链接引用）：主扫描要跳过 */
function isDefinitionLine(line: string): boolean {
  const trimmed = line.trim()
  if (/^\[\^[^\]]+\]:/.test(trimmed)) return true
  return /^\[[^\]^][^\]]*\]:\s*\S+/.test(trimmed)
}

type MdEvent =
  | { type: 'node'; line: MarkdownLine }
  | { type: 'code'; language: string; text: string }
  | { type: 'formula'; text: string }
  | { type: 'note'; text: string }
  | { type: 'tableRow'; cells: string[] }

interface ScanResult {
  events: MdEvent[]
  /** 脚注定义（行内引用到的会补进该节点的备注） */
  footnotes: Map<string, string>
}

/** 把全文扫成事件流：节点 / 代码块 / 备注 / 表格行 */
function scanMarkdown(source: string): ScanResult {
  const events: MdEvent[] = []
  const { footnotes, linkRefs } = collectDefinitions(source)
  const context: InlineContext = { footnotes, linkRefs }
  let inFence = false
  let fenceLanguage = ''
  let fenceIndent = ''
  let fenceLines: string[] = []
  let inFrontMatter = false

  source.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim()
    if (index === 0 && trimmed === '---') {
      inFrontMatter = true
      return
    }
    if (inFrontMatter) {
      if (trimmed === '---' || trimmed === '...') inFrontMatter = false
      return
    }
    if (/^(```|~~~)/.test(trimmed)) {
      if (!inFence) {
        inFence = true
        fenceLanguage = trimmed.replace(/^(```|~~~)\s*/, '').trim()
        // 记下围栏自身的缩进：列表里的围栏，内部代码行要剥掉这层缩进
        fenceIndent = line.slice(0, line.length - line.trimStart().length)
        fenceLines = []
      } else {
        inFence = false
        events.push({ type: 'code', language: fenceLanguage, text: fenceLines.join('\n') })
      }
      return
    }
    if (inFence) {
      fenceLines.push(line.startsWith(fenceIndent) ? line.slice(fenceIndent.length) : line)
      return
    }
    if (/^([-*_])\1{2,}$/.test(trimmed)) return // 水平线
    // 目录占位（Typora 的 [TOC]）：不是内容，跳过
    if (/^\[toc\]$/i.test(trimmed)) return
    // 脚注 / 链接引用的定义行：内容在解析时已查表用掉，这里不生成节点
    if (isDefinitionLine(line)) return
    // 整行是纯 HTML 标签（<div>、</div>、<br> 之类）：不是内容
    if (/^<\/?[a-zA-Z][a-zA-Z0-9]*(\s[^>]*)?\/?>$/.test(trimmed)) return
    if (trimmed.startsWith('>')) {
      const quote = cleanInlineMarkdown(trimmed.replace(/^>\s?/, ''))
      if (quote.length > 0) events.push({ type: 'note', text: quote })
      return
    }
    if (/^\|.*\|$/.test(trimmed)) {
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((cell) => cleanInlineMarkdown(cell))
      // 分隔行 | - | - | 跳过（单个短横也算分隔）
      if (cells.every((cell) => cell.length === 0 || /^:?-+:?$/.test(cell))) return
      events.push({ type: 'tableRow', cells })
      return
    }
    // 整行数学（导出的 `$$…$$` 就是这种）→ 挂到最近节点当公式
    const math = matchWholeLineMath(trimmed)
    if (math) {
      events.push({ type: 'formula', text: math })
      return
    }
    const item = parseMarkdownLine(line, context)
    if (item) {
      events.push({ type: 'node', line: item })
      return
    }
    // 普通段落 → 最近节点的备注。
    // 段落里也会有脚注引用：把对应定义一并写进备注，免得"脚注内容不见了"。
    const inline = parseInlineMarkdown(line, context)
    if (inline.text.length > 0) {
      let text = inline.text
      for (const id of inline.usedFootnotes ?? []) {
        const definition = footnotes.get(id)
        text += `\n[^${id}]${definition ? ` ${definition}` : ''}`
      }
      events.push({ type: 'note', text })
    }
  })

  return { events, footnotes }
}

export function parseMarkdownOutline(text: string, fallbackTitle = '导入的大纲'): ParsedOutline {
  const warnings: string[] = []
  const source = (text ?? '').replace(/^\ufeff/, '')
  const { events, footnotes } = scanMarkdown(source)

  const roots: OutlineNode[] = []
  const headingStack: Array<{ level: number; node: OutlineNode }> = []
  let listStack: Array<{ depth: number; node: OutlineNode }> = []
  let sectionRoot: OutlineNode | null = null
  /** 最近创建的节点（标题或最深列表项）：代码块与备注的挂靠点 */
  let currentNode: OutlineNode | null = null
  /** 还没有任何节点时收到的备注/段落（兜底「一行一主题」用） */
  const orphanNotes: string[] = []

  const pushRoot = (node: OutlineNode, parent: OutlineNode | null): void => {
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  const attachCode = (language: string, code: string): void => {
    const payload = { language, text: code }
    if (currentNode && !currentNode.code && currentNode.children.length === 0) {
      currentNode.code = payload
      return
    }
    const parent = listStack[listStack.length - 1]?.node ?? sectionRoot
    const node: OutlineNode = { title: '代码', children: [], code: payload }
    pushRoot(node, parent ?? null)
    currentNode = node
  }

  const appendNote = (text: string): void => {
    if (!currentNode) {
      orphanNotes.push(text)
      return
    }
    currentNode.notes = currentNode.notes ? `${currentNode.notes}\n${text}` : text
  }

  for (const event of events) {
    if (event.type === 'code') {
      if (event.text.trim().length === 0) continue
      attachCode(event.language, event.text)
      continue
    }
    if (event.type === 'formula') {
      if (event.text.length === 0) continue
      // 与代码块同一套挂靠规则：先挂到最近的节点，挂不上就生成「公式」子主题
      if (currentNode && !currentNode.formula && currentNode.children.length === 0) {
        currentNode.formula = event.text
      } else {
        const parent = listStack[listStack.length - 1]?.node ?? sectionRoot
        const node: OutlineNode = { title: '公式', children: [], formula: event.text }
        pushRoot(node, parent ?? null)
        currentNode = node
      }
      continue
    }
    if (event.type === 'note') {
      appendNote(event.text)
      continue
    }
    if (event.type === 'tableRow') {
      const title = event.cells.filter((cell) => cell.length > 0).join(' / ')
      if (title.length === 0) continue
      const parent = listStack[listStack.length - 1]?.node ?? sectionRoot
      const node: OutlineNode = { title, children: [] }
      pushRoot(node, parent)
      currentNode = node
      continue
    }

    const item = event.line
    const node: OutlineNode = { title: item.text, children: [] }
    if (item.rich) node.rich = item.rich
    if (item.href) node.href = item.href
    if (item.formula) node.formula = item.formula
    // 这一行引用了脚注：把定义补进该节点的备注（`[^1] 说明文字`），
    // 免得"导入后脚注内容不见了"
    if (item.footnotes && item.footnotes.length > 0) {
      const lines = item.footnotes.map((id) => {
        const text = footnotes.get(id)
        return text ? `[^${id}] ${text}` : `[^${id}]`
      })
      node.notes = node.notes ? `${node.notes}\n${lines.join('\n')}` : lines.join('\n')
    }

    if (item.kind === 'heading') {
      while (headingStack.length > 0) {
        const top = headingStack[headingStack.length - 1]
        if (!top || top.level < item.level) break
        headingStack.pop()
      }
      const parent = headingStack[headingStack.length - 1]?.node ?? null
      pushRoot(node, parent)
      headingStack.push({ level: item.level, node })
      listStack = []
      sectionRoot = node
      currentNode = node
      continue
    }

    // 列表项：挂在标题下，或按缩进挂在上一个列表项下
    while (listStack.length > 0) {
      const top = listStack[listStack.length - 1]
      if (!top || top.depth < item.depth) break
      listStack.pop()
    }
    const parent = listStack[listStack.length - 1]?.node ?? sectionRoot
    pushRoot(node, parent)
    listStack.push({ depth: item.depth, node })
    currentNode = node
  }

  if (roots.length === 0) {
    // 一个标题/列表都没有：退化成「每行一句」，但只收短句
    const terse = orphanNotes
      .flatMap((note) => note.split('\n'))
      .filter((line) => line.length > 0 && line.length <= 40)
    if (terse.length === 0) {
      return { root: null, count: 0, warnings: ['文件里没有找到标题或列表，无法生成导图'] }
    }
    const fallbackRoots = terse.map<OutlineNode>((title) => ({ title, children: [] }))
    const firstFallback = fallbackRoots[0]
    let root: OutlineNode = { title: fallbackTitle, children: fallbackRoots }
    if (fallbackRoots.length === 1 && firstFallback) root = firstFallback
    warnings.push('文件里没有标题/列表，已按「一行一个主题」导入')
    return { root, count: countNodes(root), warnings }
  }

  let root: OutlineNode
  const single = roots[0]
  if (roots.length === 1 && single) {
    root = single
  } else {
    root = { title: fallbackTitle, children: roots }
    warnings.push(`文件里有 ${roots.length} 个并列的顶层节点，已统一挂到「${fallbackTitle}」下`)
  }

  return { root, count: countNodes(root), warnings }
}

function countNodes(node: OutlineNode | null): number {
  if (!node) return 0
  let total = 1
  for (const child of node.children) total += countNodes(child)
  return total
}
