/**
 * 亿图脑图（EdrawMind / MindMaster）的 .emmx 支持。
 *
 * .emmx 实际有两种：
 *
 * 1. **里面是 content.json** —— 与 Xmind 格式完全一致（实际就是 Xmind 包换了后缀），
 *    走正常解析即可，不需要这里介入；
 * 2. **新版专有格式** —— 内容放在 `mmpage/page.bin` 里，是一份二进制对象图
 *    （varint 编码的引用 + 定型数据），**没有公开规范**，层级结构无法还原。
 *
 * 这里只处理第 2 种，做法是「尽力而为的文字提取」：
 * 把 page.bin 里可读的文字按出现顺序取出来，保证**用户的文字内容不丢**。
 * 层级需要导入后自行整理——因为对象图里的父子关系需要完整逆向才能得到，
 * 那既不可靠也不该假装做到。界面上会明确告诉用户这一点。
 */

import { createId } from '../model/factory'
import { isRecord } from '../guards'
import {
  CREATOR,
  MODEL_VERSION,
  type NodeStyle,
  type Relationship,
  type RichText,
  type RichTextParagraph,
  type Sheet,
  type StructureClass,
  type Summary,
  type Topic,
  type Workbook
} from '../model/types'
import { hasFormatting } from '../richtext'

/** 专有格式里存放页内容的包内路径 */
export const EMMX_PAGE_FILE = 'mmpage/page.bin'
/** 专有格式的文档级属性文件（只有版面设置，没有正文） */
export const EMMX_DOCUMENT_FILE = 'document.xml'

/**
 * page.bin 开头是文档属性区与格式常量表，里面混着 `Rnewmoren` 这类标记，
 * 跳过它就不会把常量当成正文。
 */
const HEADER_SKIP = 512
/** 兜底上限：防止异常文件把内存吃光 */
const MAX_TEXTS = 3000
const MAX_TEXT_LENGTH = 2000

let decoder: TextDecoder | null = null

/** 严格解码：序列非法时返回 null（用它来筛掉二进制噪音） */
function decodeStrict(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null
  if (!decoder) decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    return decoder.decode(bytes)
  } catch {
    return null
  }
}

/**
 * 判断一段字节是不是「像样的文字」。
 *
 * 规则是在真实样本上调出来的：
 * - 含中文的段落一律保留（那就是正文）；
 * - 纯 ASCII 要求以字母开头、含元音、**至少两个小写字母**，且不是全大写短词。
 *   「至少两个小写字母」这条是滤掉 `Vw0E`、`h81E`、`jO8E`、`XtD`、`Jk.E` 这类
 *   格式常量表噪音的关键（它们要么只有一个小写字母，要么没有元音），
 *   同时不会误伤 `Tool`、`cpu`、`coze`、`DataFrame`、`df.rename(`、`self-Host`、`Python3`。
 */
function asText(bytes: Uint8Array): string | null {
  const text = decodeStrict(bytes)
  if (!text) return null

  const value = text.trim()
  if (value.length < 2 || value.length > MAX_TEXT_LENGTH) return null

  if (/[\u4e00-\u9fa5]/.test(value)) {
    return /^[\u4e00-\u9fa5A-Za-z0-9\s\u3000-\u303f\uff00-\uffef()（）\-_/,.、。：:；;！!？?+&@#%*'"]+$/.test(
      value
    )
      ? value
      : null
  }

  if (value.length < 3) return null
  if (!/^[A-Za-z][A-Za-z0-9 ().,_+\-/&']*$/.test(value)) return null
  if (!/[aeiouAEIOU]/.test(value)) return null
  if (!/[a-z].*[a-z]/.test(value)) return null
  if (value === value.toUpperCase() && value.length <= 4) return null
  return value
}

/** 字节是否属于「文字区」：可打印 ASCII、UTF-8 首字节、UTF-8 连续字节 */
function isTextByte(byte: number): boolean {
  return (
    (byte >= 0x20 && byte <= 0x7e) || (byte >= 0xc2 && byte <= 0xf4) || (byte >= 0x80 && byte <= 0xbf)
  )
}

/** 从专有页数据里按出现顺序提取文字 */
export function extractEmmxTexts(pageBin: Uint8Array): string[] {
  const texts: string[] = []
  let start = -1

  const flush = (end: number): void => {
    if (start < 0) return
    if (start >= HEADER_SKIP) {
      const text = asText(pageBin.subarray(start, end))
      if (text) texts.push(text)
    }
    start = -1
  }

  for (let index = 0; index < pageBin.length; index += 1) {
    const byte = pageBin[index]
    if (byte !== undefined && isTextByte(byte)) {
      if (start < 0) start = index
      continue
    }
    flush(index)
    if (texts.length >= MAX_TEXTS) break
  }
  flush(pageBin.length)

  return texts.slice(0, MAX_TEXTS)
}

/* ------------------------------------------------------------------ */
/* ver:2 结构化格式（内容层级可以完整还原）                             */
/* ------------------------------------------------------------------ */

/** 亿图的版面模板 -> 本软件的结构类型 */
const TEMPLATE_STRUCTURES: Record<string, StructureClass> = {
  right: 'org.xmind.ui.logic.right',
  left: 'org.xmind.ui.logic.left',
  mindmap: 'org.xmind.ui.map.unbalanced',
  mind: 'org.xmind.ui.map.unbalanced',
  clockwise: 'org.xmind.ui.map.clockwise',
  tree: 'org.xmind.ui.tree.right',
  organization: 'org.xmind.ui.org-chart.down',
  org: 'org.xmind.ui.org-chart.down',
  timeline: 'org.xmind.ui.timeline.horizontal',
  fishbone: 'org.xmind.ui.fishbone.leftHeaded',
  brace: 'org.xmind.ui.brace.right',
  matrix: 'org.xmind.ui.matrix',
  spreadsheet: 'org.xmind.ui.spreadsheet'
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 亿图的文字常带结尾换行，去掉它 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\n+$/, '') : ''
}

/** 把 Quill Delta 的 ops 还原成本软件的富文本（只保留有格式的部分） */
function richOf(data: Record<string, unknown>): RichText | undefined {
  const richText = isRecord(data.richText) ? data.richText : null
  const ops = richText ? asArray(richText.ops) : []
  if (ops.length === 0) return undefined

  const paragraphs: RichTextParagraph[] = [{ runs: [] }]
  for (const op of ops) {
    if (!isRecord(op)) continue
    const insert = typeof op.insert === 'string' ? op.insert : ''
    if (insert.length === 0) continue
    const attributes = isRecord(op.attributes) ? op.attributes : {}
    const color = asString(attributes.color)

    const parts = insert.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) paragraphs.push({ runs: [] })
      if (part.length === 0) return
      const last = paragraphs[paragraphs.length - 1]
      if (!last) return
      last.runs.push(color ? { text: part, color } : { text: part })
    })
  }

  const cleaned = paragraphs.filter((paragraph) => paragraph.runs.length > 0)
  if (cleaned.length === 0) return undefined
  return hasFormatting({ paragraphs: cleaned }) ? { paragraphs: cleaned } : undefined
}

/** 节点底色：存进 NodeStyle，保存时不丢（沿用 Xmind 的键名） */
function styleOf(data: Record<string, unknown>): NodeStyle | undefined {
  const background = asString(data.background)
  if (!background) return undefined
  return { properties: { 'svg:fill': background } }
}

/**
 * 解析亿图的 ver:2 结构化格式。
 * 不是这种格式时返回 null，交由常规的 Xmind 解析处理。
 */
export function parseEmmxDocument(
  raw: unknown,
  fileName?: string
): { workbook: Workbook; warnings: string[] } | null {
  if (!isRecord(raw) || !Array.isArray(raw.contents)) return null
  const contents = raw.contents.filter(isRecord).filter((item) => isRecord(item.root))
  if (contents.length === 0) return null

  const sheets: Sheet[] = []
  contents.forEach((content, index) => {
    const sheet = parseEmmxSheet(content, index, fileName)
    if (sheet) sheets.push(sheet)
  })
  const first = sheets[0]
  if (!first) return null

  const rootTitle = first.rootTopic.title
  const warnings = [
    '这是亿图脑图（EdrawMind / MindMaster）的 .emmx 文件，已按兼容方式读取。',
    `文字、层级、概要、关系线均已还原（中心主题「${rootTitle}」）。`,
    '原文件的字体与主题配色未完整还原，会改用本软件当前的主题。'
  ]

  return {
    workbook: {
      version: MODEL_VERSION,
      sheets,
      activeSheetId: first.id,
      creator: { ...CREATOR }
    },
    warnings
  }
}

function parseEmmxSheet(
  content: Record<string, unknown>,
  index: number,
  fileName?: string
): Sheet | null {
  const rootNode = content.root
  if (!isRecord(rootNode)) return null

  const relationships: Relationship[] = []
  const summaries: Summary[] = []
  const rootTopic = parseEmmxTopic(rootNode, relationships, summaries)

  const config = isRecord(content.config) ? content.config : {}
  const template = (asString(config.template) ?? '').toLowerCase()
  const structureClass = TEMPLATE_STRUCTURES[template] ?? 'org.xmind.ui.logic.right'
  rootTopic.structureClass = structureClass

  // 画布名：亿图这里常常是空的，退回中心主题名，再退回文件名
  const sheetTitle =
    textOf(content.title) ||
    rootTopic.title ||
    (fileName ?? '').replace(/\.[^.]+$/, '').trim() ||
    `画布 ${index + 1}`

  // 关系线：relativeLinks 里的 start/end 直接指向两个节点
  for (const link of asArray(content.relativeLinks)) {
    if (!isRecord(link)) continue
    const start = isRecord(link.start) ? asString(link.start.nodeId) : undefined
    const end = isRecord(link.end) ? asString(link.end.nodeId) : undefined
    if (!start || !end || start === end) continue
    const title = textOf(link.text)
    relationships.push({
      id: asString(link.id) ?? createId('rel'),
      end1Id: start,
      end2Id: end,
      ...(title.length > 0 ? { title } : {})
    })
  }

  return {
    id: asString(content.id) ?? createId('sheet'),
    title: sheetTitle,
    rootTopic,
    relationships,
    boundaries: [],
    summaries
  }
}

function parseEmmxTopic(
  node: Record<string, unknown>,
  relationships: Relationship[],
  summaries: Summary[]
): Topic {
  const data = isRecord(node.data) ? node.data : {}
  const title = textOf(data.text)

  const topic: Topic = {
    id: asString(node.id) ?? createId('topic'),
    title,
    children: [],
    detachedChildren: [],
    labels: [],
    markers: [],
    attachments: []
  }

  const rich = richOf(data)
  if (rich) topic.titleRich = rich
  const style = styleOf(data)
  if (style) topic.style = style

  const childrenRaw = isRecord(node.children) ? node.children : {}
  for (const child of asArray(childrenRaw.normal)) {
    if (isRecord(child)) topic.children.push(parseEmmxTopic(child, relationships, summaries))
  }

  // 概要节点：它不参与普通层级（否则会同时被画成普通节点），
  // 而是登记成 Summary —— 由画布按区间画大括号
  for (const summaryNode of asArray(childrenRaw.summary)) {
    if (!isRecord(summaryNode)) continue
    const summaryData = isRecord(summaryNode.data) ? summaryNode.data : {}
    const startId = asString(summaryData.startId)
    const endId = asString(summaryData.endId)
    const id = asString(summaryNode.id)
    if (!id || !startId || !endId) continue
    summaries.push({
      id,
      topicId: id,
      range: `(${startId},${endId})`,
      title: textOf(summaryData.text)
    })
  }

  return topic
}

/**
 * 用提取到的文字拼一张导图。
 *
 * 层级信息拿不到，所以全部挂成中心主题的一级子节点——
 * 这样至少内容不丢，且用「逻辑图（向右）」呈现时读起来就是一份清单，
 * 方便用户在应用里继续整理。
 */
export function buildEmmxWorkbook(
  texts: string[],
  fileName?: string
): { workbook: Workbook; warnings: string[] } {
  const rootTitle = (fileName ?? '').replace(/\.[^.]+$/, '').trim() || '亿图脑图导入'

  // 中心主题的文字若也在提取结果里，别重复挂一次
  const children = texts.filter((text) => text !== rootTitle)

  const root: Topic = {
    id: createId('topic'),
    title: rootTitle,
    structureClass: 'org.xmind.ui.logic.right',
    children: children.map((text) => ({
      id: createId('topic'),
      title: text,
      children: [],
      detachedChildren: [],
      labels: [],
      markers: [],
      attachments: []
    })),
    detachedChildren: [],
    labels: [],
    markers: [],
    attachments: []
  }

  const sheet: Sheet = {
    id: createId('sheet'),
    title: rootTitle,
    rootTopic: root,
    relationships: [],
    boundaries: [],
    summaries: []
  }

  const warnings = [
    '这是亿图脑图的专有 .emmx 格式，已按「尽力而为」的方式提取文字。',
    `共提取到 ${children.length} 条文字，但**层级结构无法还原**（专有的二进制页数据没有公开规范），请导入后自行整理。`,
    '个别短词可能是从二进制里误判出来的，核对时留意一下。'
  ]

  return {
    workbook: {
      version: MODEL_VERSION,
      sheets: [sheet],
      activeSheetId: sheet.id,
      creator: { ...CREATOR }
    },
    warnings
  }
}
