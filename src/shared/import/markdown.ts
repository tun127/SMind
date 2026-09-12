/**
 * Markdown → 思维导图大纲（纯函数，可在自检里跑）。
 *
 * 规则：
 * 1. `# 一级标题` 的层级决定节点深度；标题之间按级别嵌套；
 * 2. 标题下面的 `- 列表`（含 `*`/`+`/数字列表）按缩进嵌套，挂在它所属的标题下；
 * 3. 代码块（``` 包裹，含围栏内的内容）、YAML front-matter、引用块、表格、水平线一律跳过——
 *    它们通常是「说明」而不是「结构」；
 * 4. 普通段落不当作节点（否则一篇有正文的 md 会导出一堆长句），只取标题与列表；
 *    如果一个标题/列表都没有，才退化成一整篇按行拆。
 */

import type { OutlineNode, ParsedOutline } from '../ai'

interface MarkdownLine {
  kind: 'heading' | 'list'
  /** heading：1–6；list：缩进层级（0 起） */
  depth: number
  level: number
  text: string
}

/** 去掉行内的 Markdown 装饰，只留文字 */
export function cleanInlineMarkdown(raw: string): string {
  let text = raw.trim()
  // 图片 ![alt](url) → 保留 alt
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 链接 [文字](url) → 保留文字
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 粗体/斜体/删除线/行内代码
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2')
  text = text.replace(/(\*|_)(.*?)\1/g, '$2')
  text = text.replace(/~~(.*?)~~/g, '$1')
  text = text.replace(/`([^`]*)`/g, '$1')
  // 行尾的标题锚点 ### 之类
  text = text.replace(/\s*#+\s*$/, '')
  return text.trim()
}

/** 解析一行；不是标题/列表则返回 null */
export function parseMarkdownLine(line: string): MarkdownLine | null {
  if (line.trim().length === 0) return null

  const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim())
  if (heading) {
    const text = cleanInlineMarkdown(heading[2])
    if (text.length === 0) return null
    const level = heading[1].length
    return { kind: 'heading', depth: level, level, text }
  }

  const expanded = line.replace(/\t/g, '  ')
  const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(expanded)
  if (list) {
    const indent = list[1].length
    const text = cleanInlineMarkdown(list[3])
    if (text.length === 0) return null
    return { kind: 'list', depth: Math.floor(indent / 2), level: 0, text }
  }

  return null
}

export function parseMarkdownOutline(text: string, fallbackTitle = '导入的大纲'): ParsedOutline {
  const warnings: string[] = []
  const source = (text ?? '').replace(/^\ufeff/, '')

  // 先剔掉 front-matter 与代码块
  const lines: string[] = []
  let inFence = false
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
      inFence = !inFence
      return
    }
    if (inFence) return
    if (/^>/.test(trimmed)) return // 引用块
    if (/^\|.*\|$/.test(trimmed)) return // 表格
    if (/^([-*_])\1{2,}$/.test(trimmed)) return // 水平线
    lines.push(line)
  })

  const parsed: MarkdownLine[] = []
  for (const line of lines) {
    const item = parseMarkdownLine(line)
    if (item) parsed.push(item)
  }

  if (parsed.length === 0) {
    // 一个标题/列表都没有：退化成「每行一句」，但只收短句
    const terse = lines
      .map((line) => cleanInlineMarkdown(line))
      .filter((line) => line.length > 0 && line.length <= 40)
    if (terse.length === 0) {
      return { root: null, count: 0, warnings: ['文件里没有找到标题或列表，无法生成导图'] }
    }
    const roots = terse.map<OutlineNode>((title) => ({ title, children: [] }))
    const root = roots.length === 1 ? roots[0] : { title: fallbackTitle, children: roots }
    warnings.push('文件里没有标题/列表，已按「一行一个主题」导入')
    return { root, count: countNodes(root), warnings }
  }

  const roots: OutlineNode[] = []
  const headingStack: Array<{ level: number; node: OutlineNode }> = []
  let listStack: Array<{ depth: number; node: OutlineNode }> = []
  let sectionRoot: OutlineNode | null = null

  const pushRoot = (node: OutlineNode, parent: OutlineNode | null): void => {
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  for (const item of parsed) {
    const node: OutlineNode = { title: item.text, children: [] }

    if (item.kind === 'heading') {
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= item.level) {
        headingStack.pop()
      }
      const parent = headingStack[headingStack.length - 1]?.node ?? null
      pushRoot(node, parent)
      headingStack.push({ level: item.level, node })
      listStack = []
      sectionRoot = node
      continue
    }

    // 列表项：挂在标题下，或按缩进挂在上一个列表项下
    while (listStack.length > 0 && listStack[listStack.length - 1].depth >= item.depth) {
      listStack.pop()
    }
    const parent = listStack[listStack.length - 1]?.node ?? sectionRoot
    pushRoot(node, parent)
    listStack.push({ depth: item.depth, node })
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
