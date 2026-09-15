/**
 * OPML → 思维导图大纲（纯函数）。
 *
 * OPML 是思维导图软件之间最通用的交换格式（Xmind、幕布、亿图脑图都能导出），
 * 所以「导入别人的导图」这条路主要靠它。
 * 复用读 Xmind 8 时写的自研 XML 解析器，不额外引依赖。
 */

import { childOf, childrenOf, type XmlNode } from '../xmind/xml'
import type { OutlineNode, ParsedOutline } from '../ai'
import { parseXml } from '../xmind/xml'

function attr(node: XmlNode, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = node.attrs[name]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * 把一个 <outline> 转成 0..n 个节点。
 * 返回数组是为了处理「没有 text 的容器节点」：把它的子节点提上来，而不是整段丢掉。
 */
function toOutlineNodes(node: XmlNode): OutlineNode[] {
  const title = attr(node, 'text', 'title', '_text')
  const notes = attr(node, '_note', 'note', 'description')
  const children = childrenOf(node, 'outline').flatMap(toOutlineNodes)

  if (!title) return children
  const result: OutlineNode = { title, children }
  if (notes) result.notes = notes
  return [result]
}

function countNodes(node: OutlineNode | null): number {
  if (!node) return 0
  let total = 1
  for (const child of node.children) total += countNodes(child)
  return total
}

/** 解析 OPML 文本；失败时抛出可读错误 */
export function parseOpmlOutline(text: string, fallbackTitle = '导入的大纲'): ParsedOutline {
  const warnings: string[] = []
  const tree = parseXml((text ?? '').replace(/^\ufeff/, ''))
  if (!tree) throw new Error('OPML 解析失败：不是合法的 XML')

  const opml = tree.local === 'opml' ? tree : null
  // 没有 <body> 不算致命错误：有些实现把 outline 直接挂在根下，下面会兜底找
  const body = childOf(opml ?? tree, 'body')

  let topLevel = body ? childrenOf(body, 'outline').flatMap(toOutlineNodes) : []

  if (topLevel.length === 0) {
    // 兜底：直接找根下的 outline（不限于有没有 body）
    topLevel = childrenOf(tree, 'outline').flatMap(toOutlineNodes)
    if (topLevel.length === 0) {
      return { root: null, count: 0, warnings: ['OPML 里没有找到任何 outline 节点'] }
    }
  }

  const head = childOf(opml ?? tree, 'head')
  const fileTitle = head ? childOf(head, 'title')?.text.trim() : undefined

  let root: OutlineNode
  const single = topLevel[0]
  if (topLevel.length === 1 && single) {
    root = single
  } else {
    const title = fileTitle && fileTitle.length > 0 ? fileTitle : fallbackTitle
    root = { title, children: topLevel }
    warnings.push(`OPML 里有 ${topLevel.length} 个并列节点，已统一挂到「${title}」下`)
  }

  return { root, count: countNodes(root), warnings }
}
