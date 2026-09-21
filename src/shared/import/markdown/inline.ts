/**
 * Markdown 的**内联解析**（由 ../markdown.ts 按行范围搬出，行为零变化）。
 *
 * 处理行内语法：转义、实体、`**粗**`/`*斜*`/`~~删~~`/`==高亮==`/`^上标^`、行内 formula、
 * 链接与行内代码，以及 `parseMarkdownLine`（单行判定）。相关的类型**跟着一起搬来**。
 * 块级扫描与大纲构建留在入口 ../markdown.ts，依赖方向单一：入口 → 本模块。
 */
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

import { decodeEntityBody } from '../../entities'
import { matchWholeLineMath } from '../../formula'
import { MARKDOWN_ESCAPABLE } from '../../markdown-escape'
import { depthOfIndent, expandTabs } from '../../outline-dialect'
import type { RichText, RichTextRun } from '../../model/types'
import { MD_MONO_FONT } from '../../mono-font'

/**
 * 行内代码的等宽字体栈。
 *
 * 常量本体已搬到中立模块 `shared/mono-font.ts`（richtext 数据层也要用它，
 * 反过来 import 导入器会形成反向依赖）；这里**原样再导出**，调用点与既有导出一律不动。
 */
export { MD_MONO_FONT }

export interface InlineRun {
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

export const ENTITIES: Record<string, string> = {
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

export function decodeEntity(name: string): string {
  // 名字表是完整 HTML 名集、查表折叠大小写——策略留在这里；数字引用与
  // 「解不出就把 `&…;` 原样还原」（越界如 `&#x110000;` 不再抛 RangeError）走 shared/entities.ts。
  return decodeEntityBody(name, (n) => ENTITIES[n.toLowerCase()] ?? null)
}

/** 行内 HTML 标签 → 它对应的富文本样式（不认识的一律剥掉） */

export function inlineTagStyle(tag: string): Partial<InlineRun> | 'close' | 'break' | null {
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

export interface InlineStyle {
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
      if (ch === '\\' && i + 1 < source.length && MARKDOWN_ESCAPABLE.includes(escaped)) {
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
  return {
    runs,
    text: trimmed,
    href,
    usedFootnotes: usedFootnotes.length > 0 ? usedFootnotes : undefined
  }
}

export interface EmphasisMatch {
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

export function matchEmphasis(source: string, index: number): EmphasisMatch | null {
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
    (run) =>
      run.bold ||
      run.italic ||
      run.strike ||
      run.underline ||
      run.highlight ||
      run.script ||
      run.fontFamily
  )
  if (!hasFormat) return undefined
  return { paragraphs: [{ runs: mapped }] }
}

/** 去掉行内的 Markdown 装饰，只留文字（表格单元格、备注等纯文本场合用） */

export function cleanInlineMarkdown(raw: string): string {
  return parseInlineMarkdown(raw).text
}

export interface MarkdownLine {
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

  const expanded = expandTabs(line)
  const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(expanded)
  if (list) {
    // 任务列表：勾选框不进标题（- [x] 已完成 → 「已完成」）
    const body = (list[3] ?? '').replace(/^\[[ xX]\]\s+/, '')
    // 缩进→层级走共享方言（两格一级），别在这里再写一遍 Math.floor(len / 2)
    const depth = depthOfIndent((list[1] ?? '').length)
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
