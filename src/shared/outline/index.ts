/**
 * 大纲：把导图树摊平成行，以及导出 TXT / Markdown / OPML。
 *
 * 这里全是纯函数（不依赖 DOM 与 Electron）：
 * 面板的渲染、三种导出格式、以及自检都共用同一份「树 → 行」的展开逻辑，
 * 保证界面上看到的顺序与导出文件里的顺序永远一致。
 */

import type { RichText, Sheet, Topic, Workbook } from '../model/types'

export type OutlineFormat = 'txt' | 'md' | 'opml'

export interface OutlineFormatDef {
  id: OutlineFormat
  label: string
  /** 文件扩展名（不含点） */
  ext: string
  /** 保存对话框的标题 */
  dialogTitle: string
}

export const OUTLINE_FORMATS: OutlineFormatDef[] = [
  { id: 'txt', label: 'TXT 纯文本', ext: 'txt', dialogTitle: '导出为 TXT' },
  { id: 'md', label: 'Markdown', ext: 'md', dialogTitle: '导出为 Markdown' },
  { id: 'opml', label: 'OPML', ext: 'opml', dialogTitle: '导出为 OPML' }
]

export function outlineFormatDef(format: OutlineFormat): OutlineFormatDef {
  const found = OUTLINE_FORMATS.find((item) => item.id === format)
  if (!found) throw new Error(`不支持的导出格式：${format}`)
  return found
}

/** 展开后的一行（面板直接用这个数组渲染） */
export interface OutlineRow {
  id: string
  title: string
  depth: number
  hasChildren: boolean
  collapsed: boolean
  /** 附加元素的数量，仅用于在大纲里给个提示 */
  markerCount: number
  labelCount: number
  hasNotes: boolean
  hasLink: boolean
  hasAttachment: boolean
  hasImage: boolean
  hasFormula: boolean
}

export interface OutlineRowsOptions {
  /** 折叠的分支是否连子节点一起跳过（面板用 true，导出用 false） */
  skipCollapsed?: boolean
}

/**
 * 把一棵树摊平成大纲行。
 * 顺序就是「深度优先、按 children 顺序」，和画布上的排布、导出的文本完全一致。
 */
export function outlineRows(root: Topic, options: OutlineRowsOptions = {}): OutlineRow[] {
  const rows: OutlineRow[] = []
  const skipCollapsed = options.skipCollapsed ?? false

  const walk = (topic: Topic, depth: number): void => {
    rows.push({
      id: topic.id,
      title: topic.title,
      depth,
      hasChildren: topic.children.length > 0,
      collapsed: Boolean(topic.collapsed),
      markerCount: topic.markers?.length ?? 0,
      labelCount: topic.labels?.length ?? 0,
      hasNotes: Boolean(topic.notes && topic.notes.length > 0),
      hasLink: Boolean(topic.href),
      hasAttachment: (topic.attachments?.length ?? 0) > 0,
      hasImage: Boolean(topic.image),
      hasFormula: Boolean(topic.formula)
    })
    if (skipCollapsed && topic.collapsed) return
    for (const child of topic.children) walk(child, depth + 1)
    // 浮动主题没有固定的树位置，但也不该在大纲里消失，排在最后
    for (const floating of topic.detachedChildren) walk(floating, depth + 1)
  }

  walk(root, 0)
  return rows
}

/** 只取标题的最简形式（大纲导出用） */
function linesOf(root: Topic): Array<{ title: string; depth: number; notes?: string }> {
  const lines: Array<{ title: string; depth: number; notes?: string }> = []
  const walk = (topic: Topic, depth: number): void => {
    lines.push({ title: topic.title, depth, notes: topic.notes })
    for (const child of topic.children) walk(child, depth + 1)
    for (const floating of topic.detachedChildren) walk(floating, depth + 1)
  }
  walk(root, 0)
  return lines
}

/** TXT：一行一个主题，按层级缩进两个空格 */
export function toPlainText(root: Topic): string {
  return (
    linesOf(root)
      .map((line) => `${'  '.repeat(line.depth)}${line.title}`)
      .join('\r\n') + '\r\n'
  )
}

/** 富文本 → 行内 Markdown（粗体/斜体/删除线/行内代码）；没有格式变化时原样返回 */
function richToInlineMarkdown(rich: RichText): string {
  const parts: string[] = []
  for (const paragraph of rich.paragraphs) {
    for (const run of paragraph.runs) {
      if (run.text.length === 0) continue
      let text = run.text
      const mono = typeof run.fontFamily === 'string' && /mono/i.test(run.fontFamily)
      if (mono) text = `\`${text}\``
      if (run.bold) text = `**${text}**`
      else if (run.italic) text = `*${text}*`
      if (run.strike) text = `~~${text}~~`
      parts.push(text)
    }
  }
  return parts.join('')
}

/**
 * Markdown：根主题作为一级标题，其余用列表。
 * 节点上的代码块导出成**缩进围栏块**（跟随列表层级，归属不乱）、
 * 图片导出成 `![图片](包内路径)`、公式导出成 `$$…$$`、备注以引用块跟在后面；
 * 与 4.32 的 Markdown 导入器正好构成往返。
 */
export function toMarkdown(root: Topic): string {
  const out: string[] = []
  const walk = (topic: Topic, depth: number): void => {
    const indent = depth === 0 ? '' : '  '.repeat(depth - 1)
    const itemIndent = depth === 0 ? '' : `${indent}  `

    let title = topic.titleRich ? richToInlineMarkdown(topic.titleRich) : topic.title
    if (!topic.titleRich && topic.href && topic.title.length > 0) {
      title = `[${topic.title}](${topic.href})`
    }
    out.push(depth === 0 ? `# ${title}` : `${indent}- ${title}`)

    if (topic.image) out.push(`${itemIndent}![图片](${topic.image.path})`)
    if (topic.formula) out.push(`${itemIndent}$$${topic.formula}$$`)
    if (topic.code) {
      out.push(`${itemIndent}\`\`\`${topic.code.language}`)
      for (const codeLine of topic.code.text.split(/\r?\n/)) {
        out.push(codeLine.length > 0 ? `${itemIndent}${codeLine}` : '')
      }
      out.push(`${itemIndent}\`\`\``)
    }
    if (topic.notes) {
      for (const noteLine of topic.notes.split(/\r?\n/)) out.push(`${itemIndent}> ${noteLine}`)
    }

    for (const child of topic.children) walk(child, depth + 1)
    for (const floating of topic.detachedChildren) walk(floating, depth + 1)
  }
  walk(root, 0)
  return out.join('\n') + '\n'
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** OPML 2.0：属性里的换行与制表符会被折叠，避免破坏 XML 结构 */
function opmlAttr(value: string): string {
  return escapeXml(value.replace(/[\r\n\t]+/g, ' ').trim())
}

function outlineNode(topic: Topic, depth: number): string {
  const pad = '  '.repeat(depth + 2)
  const attrs = [`text="${opmlAttr(topic.title)}"`]
  if (topic.notes) attrs.push(`_note="${opmlAttr(topic.notes)}"`)
  if (topic.href) attrs.push(`_link="${opmlAttr(topic.href)}"`)

  const children = [...topic.children, ...topic.detachedChildren]
  if (children.length === 0) return `${pad}<outline ${attrs.join(' ')}/>`

  const inner = children.map((child) => outlineNode(child, depth + 1)).join('\n')
  return `${pad}<outline ${attrs.join(' ')}>\n${inner}\n${pad}</outline>`
}

/** OPML 2.0：能被 Xmind、幕布、Workflowy 等直接导入 */
export function toOpml(sheet: Sheet): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${escapeXml(sheet.title)}</title>
  </head>
  <body>
${outlineNode(sheet.rootTopic, 0)}
  </body>
</opml>
`
}

/** 取当前画布（没有 activeSheetId 时退到第一张画布） */
export function activeSheetOf(workbook: Workbook): Sheet | undefined {
  return workbook.sheets.find((sheet) => sheet.id === workbook.activeSheetId) ?? workbook.sheets[0]
}

/**
 * 按格式生成导出内容。
 * TXT 额外加 UTF-8 BOM：Windows 记事本 / Excel 打开中文才不会乱码；
 * Markdown 与 OPML 不加，避免某些解析器把 BOM 当成内容。
 */
export function buildOutline(workbook: Workbook, format: OutlineFormat): string {
  const sheet = activeSheetOf(workbook)
  if (!sheet) throw new Error('当前没有可导出的画布')

  switch (format) {
    case 'txt':
      return `\ufeff${toPlainText(sheet.rootTopic)}`
    case 'md':
      return toMarkdown(sheet.rootTopic)
    case 'opml':
      return toOpml(sheet)
    default:
      throw new Error(`不支持的导出格式：${String(format)}`)
  }
}
