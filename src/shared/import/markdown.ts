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

/* ---- G1：内联解析搬进 ./markdown/inline.ts；公开面（含类型）在此原样再导出 ---- */
export * from './markdown/inline'
import { parseInlineMarkdown, cleanInlineMarkdown, parseMarkdownLine } from './markdown/inline'
import type { InlineContext, MarkdownLine } from './markdown/inline'

/** 行内代码在节点里用的等宽字体（与代码块一致） */

function collectDefinitions(source: string): {
  footnotes: Map<string, string>
  linkRefs: Map<string, string>
} {
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

  const lines = source.split(/\r?\n/)

  /**
   * 只有「开头就是 `---`」**且后面另有闭合行**时才算 front-matter。
   *
   * 以前只判断了第一行，于是「文档以一条水平线 `---` 开场」会被当成 front-matter 的开始，
   * 正文一路被吞到下一个 `---` 或 `...`；要是全文再没有第二个 `---`，
   * **整篇文档直接消失**（用户看到的是「导入成功但什么都没有」）。
   */
  const hasFrontMatter = ((): boolean => {
    if ((lines[0] ?? '').trim() !== '---') return false
    for (let i = 1; i < lines.length; i += 1) {
      const candidate = (lines[i] ?? '').trim()
      if (candidate === '---' || candidate === '...') return true
    }
    return false
  })()

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (hasFrontMatter && index === 0) {
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

  /**
   * 到文件末尾还没闭合的围栏：**照样算一块代码**。
   *
   * 以前这里什么都不做，于是「复制了一段没写完的代码」这种很常见的情况
   * 会让整块内容凭空消失，而且没有任何提示。少一个收尾标记不该吞掉用户的内容。
   */
  if (inFence) {
    events.push({ type: 'code', language: fenceLanguage, text: fenceLines.join('\n') })
  }

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
