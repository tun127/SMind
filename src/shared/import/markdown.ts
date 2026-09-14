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
  mono?: boolean
  link?: boolean
}

const INLINE_PATTERN =
  /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3|~~(.+?)~~|`([^`]+)`|!\[([^\]]*)\]\(([^)]*)\)|\[([^\]]*)\]\(([^)]*)\)/g

export interface ParsedInline {
  runs: InlineRun[]
  text: string
  href?: string
}

/** 行内 Markdown → 富文本 run 序列；第一个链接的 url 单独带回 */
export function parseInlineMarkdown(raw: string): ParsedInline {
  const runs: InlineRun[] = []
  let plain = ''
  let href: string | undefined
  let last = 0

  const pushPlain = (segment: string): void => {
    if (segment.length === 0) return
    plain += segment
    const previous = runs[runs.length - 1]
    if (
      previous &&
      !previous.bold &&
      !previous.italic &&
      !previous.strike &&
      !previous.mono &&
      !previous.link
    ) {
      previous.text += segment
    } else {
      runs.push({ text: segment })
    }
  }

  for (const match of raw.matchAll(INLINE_PATTERN)) {
    const start = match.index ?? 0
    pushPlain(raw.slice(last, start))
    let visible = ''
    if (match[2] !== undefined) {
      runs.push({ text: match[2], bold: true })
      visible = match[2]
    } else if (match[4] !== undefined) {
      runs.push({ text: match[4], italic: true })
      visible = match[4]
    } else if (match[5] !== undefined) {
      runs.push({ text: match[5], strike: true })
      visible = match[5]
    } else if (match[6] !== undefined) {
      runs.push({ text: match[6], mono: true })
      visible = match[6]
    } else if (match[7] !== undefined) {
      // 图片：保留替代文字
      runs.push({ text: match[7] })
      visible = match[7]
    } else if (match[9] !== undefined) {
      // 链接：文字留下，url 挂到节点超链接
      if (!href) href = match[10]
      runs.push({ text: match[9], link: true })
      visible = match[9]
    }
    plain += visible
    last = start + match[0].length
  }
  pushPlain(raw.slice(last))

  const text = plain.trim()
  if (text.length !== plain.length) {
    // 去掉首尾空白后，同步修剪首尾 run，避免留下纯空白的 run
    while (runs.length > 0 && runs[0].text.trim().length === 0) runs.shift()
    while (runs.length > 0 && runs[runs.length - 1].text.trim().length === 0) runs.pop()
  }
  return { runs, text, href }
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
      underline: run.link || undefined,
      fontFamily: run.mono ? MD_MONO_FONT : undefined
    }))
  if (mapped.length === 0) return undefined
  const hasFormat = mapped.some(
    (run) => run.bold || run.italic || run.strike || run.underline || run.fontFamily
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
}

/** 解析一行；不是标题/列表则返回 null */
export function parseMarkdownLine(line: string): MarkdownLine | null {
  if (line.trim().length === 0) return null

  const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim())
  if (heading) {
    const body = heading[2].replace(/\s*#+\s*$/, '') // 行尾的标题锚点 ### 之类
    // 整句是数学 → 变成节点的公式
    const math = matchWholeLineMath(body)
    if (math) return { kind: 'heading', depth: heading[1].length, level: heading[1].length, text: '', formula: math }
    const inline = parseInlineMarkdown(body)
    if (inline.text.length === 0) return null
    const level = heading[1].length
    return {
      kind: 'heading',
      depth: level,
      level,
      text: inline.text,
      rich: inlineRunsToRich(inline.runs),
      href: inline.href
    }
  }

  const expanded = line.replace(/\t/g, '  ')
  const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(expanded)
  if (list) {
    // 任务列表：勾选框不进标题（- [x] 已完成 → 「已完成」）
    const body = list[3].replace(/^\[[ xX]\]\s+/, '')
    const depth = Math.floor(list[1].length / 2)
    // 整句是数学 → 变成节点的公式（节点标题留空，公式自成一块）
    const math = matchWholeLineMath(body)
    if (math) return { kind: 'list', depth, level: 0, text: '', formula: math }
    const inline = parseInlineMarkdown(body)
    if (inline.text.length === 0) return null
    return {
      kind: 'list',
      depth,
      level: 0,
      text: inline.text,
      rich: inlineRunsToRich(inline.runs),
      href: inline.href
    }
  }

  return null
}

type MdEvent =
  | { type: 'node'; line: MarkdownLine }
  | { type: 'code'; language: string; text: string }
  | { type: 'formula'; text: string }
  | { type: 'note'; text: string }
  | { type: 'tableRow'; cells: string[] }

/** 把全文扫成事件流：节点 / 代码块 / 备注 / 表格行 */
function scanMarkdown(source: string): MdEvent[] {
  const events: MdEvent[] = []
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
    const item = parseMarkdownLine(line)
    if (item) {
      events.push({ type: 'node', line: item })
      return
    }
    // 普通段落 → 最近节点的备注
    const plain = cleanInlineMarkdown(line)
    if (plain.length > 0) events.push({ type: 'note', text: plain })
  })

  return events
}

export function parseMarkdownOutline(text: string, fallbackTitle = '导入的大纲'): ParsedOutline {
  const warnings: string[] = []
  const source = (text ?? '').replace(/^\ufeff/, '')
  const events = scanMarkdown(source)

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

    if (item.kind === 'heading') {
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= item.level) {
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
    while (listStack.length > 0 && listStack[listStack.length - 1].depth >= item.depth) {
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
    const root = fallbackRoots.length === 1 ? fallbackRoots[0] : { title: fallbackTitle, children: fallbackRoots }
    warnings.push('文件里没有标题/列表，已按「一行一个主题」导入')
    return { root, count: countNodes(root), warnings }
  }

  let root: OutlineNode
  if (roots.length === 1) {
    root = roots[0]
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
