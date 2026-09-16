/**
 * Xmind 8 旧版格式（content.xml）读取。
 *
 * Xmind 8 的包结构与 2020+ 不同：地图数据是 XML（命名空间 urn:xmind:xmap:xmlns:content:2.0），
 * 样式在 styles.xml 里。本文件只负责把 XML 映射成我们的模型：
 *
 * 1. 认识的元素 → 映射到对应字段；
 * 2. 不认识的元素 → 原样收进 extensions，保证「另存不丢信息」；
 * 3. styles.xml 里的主题/样式不解析，改为给出一条明确提示（而不是装作支持）。
 *
 * 解析是宽松的：同一含义的多种写法（x/y 与 svg:x/svg:y、image 与 xhtml:img 等）都认。
 */

import { createId } from '../model/factory'
import type {
  Attachment,
  Boundary,
  NodeStyle,
  Relationship,
  Sheet,
  Summary,
  Topic,
  Workbook
} from '../model/types'
import { MODEL_VERSION, CREATOR } from '../model/types'
import { childOf, childText, childrenOf, textOf, type XmlNode } from './xml'

/** 旧版特有数据（原样保留用）的 provider 标识 */
export const LEGACY_PROVIDER = 'org.xmind.content.xml'

export interface LegacyParseResult {
  workbook: Workbook
  warnings: string[]
}

/* ------------------------------------------------------------------ */
/* 属性 / 元素取值                                                     */
/* ------------------------------------------------------------------ */

function attr(node: XmlNode, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = node.attrs[name]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function numberOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Xmind 8 用 xap: 前缀表示包内资源；这里统一剥成包内相对路径 */
function normalizeResourcePath(path: string): string {
  return path.replace(/^xap:/, '').replace(/^\.?\//, '')
}

/** 把没映射到的子元素原样收进 extensions */
function collectUnknown(node: XmlNode, known: Set<string>, into: unknown[]): void {
  for (const child of node.children) {
    if (known.has(child.local)) continue
    into.push({
      provider: LEGACY_PROVIDER,
      name: child.name,
      attrs: child.attrs,
      // 只保留一层文本内容，足够表达数据且不会无限膨胀
      text: child.text.trim().length > 0 ? child.text : undefined
    })
  }
}

/**
 * <extensions><extension provider="…" content="…"/></extensions>
 * 直接按属性原样收下来：新版 content.json 的 extensions 就是这个形状，
 * 存回去既不丢数据，Xmind 也能继续忽略它不认识的 provider。
 */
function parseExtensions(node: XmlNode): unknown[] {
  const container = childOf(node, 'extensions')
  if (!container) return []

  return container.children.map((child) =>
    child.local === 'extension'
      ? { ...child.attrs }
      : {
          provider: LEGACY_PROVIDER,
          name: child.name,
          attrs: child.attrs,
          text: child.text.trim().length > 0 ? child.text : undefined
        }
  )
}

const KNOWN_TOPIC_CHILDREN = new Set([
  'title',
  'children',
  'notes',
  'labels',
  'marker-refs',
  'markers',
  'href',
  'image',
  'img',
  'branch',
  'position',
  'attachments',
  'extensions',
  'style',
  'style-id'
])

function parseNotes(node: XmlNode): { notes?: string; notesHtml?: string } {
  const notes = childOf(node, 'notes')
  if (!notes) return {}
  const plain = childText(notes, 'plain') ?? textOf(notes)
  const html = childText(notes, 'html')
  const out: { notes?: string; notesHtml?: string } = {}
  if (plain !== undefined) out.notes = plain
  if (html !== undefined) out.notesHtml = html
  return out
}

/** 图片：Xmind 8 里可能是 <image src=…>，也可能写成 xhtml:img */
function parseImage(node: XmlNode): Topic['image'] {
  const image = childOf(node, 'image') ?? childOf(node, 'img') ?? null
  if (!image) return undefined
  const src = attr(image, 'src', 'xlink:href', 'href')
  if (!src) return undefined
  return {
    path: normalizeResourcePath(src),
    width: numberOf(attr(image, 'width', 'svg:width')),
    height: numberOf(attr(image, 'height', 'svg:height'))
  }
}

function parseAttachments(node: XmlNode): Attachment[] {
  const container = childOf(node, 'attachments')
  if (!container) return []

  const items = [...childrenOf(container, 'attachment'), ...childrenOf(container, 'file')]
  const out: Attachment[] = []
  for (const item of items) {
    const raw = attr(item, 'path', 'src', 'href')
    if (!raw) continue
    const path = normalizeResourcePath(raw)
    out.push({
      id: attr(item, 'id') ?? createId('att'),
      path,
      name: attr(item, 'name') ?? path.split('/').pop() ?? '附件',
      size: numberOf(attr(item, 'size')),
      mime: attr(item, 'mime', 'content-type')
    })
  }
  return out
}

function parseStyleOf(node: XmlNode): NodeStyle | undefined {
  const styleId = attr(node, 'style-id')
  const svg = childOf(node, 'style')
  if (!styleId && !svg) return undefined
  const properties: Record<string, string> = {}
  if (svg) {
    for (const [key, value] of Object.entries(svg.attrs)) properties[key] = value
  }
  return { id: styleId, properties }
}

function parseTopic(node: XmlNode): Topic {
  const extensions: unknown[] = parseExtensions(node)
  collectUnknown(node, KNOWN_TOPIC_CHILDREN, extensions)

  const { notes, notesHtml } = parseNotes(node)
  const image = parseImage(node)
  const attachments = parseAttachments(node)

  const childrenNode = childOf(node, 'children')
  const attachedGroup = childrenOf(childrenNode, 'topics').find(
    (group) => attr(group, 'type') !== 'detached'
  )
  const detachedGroup = childrenOf(childrenNode, 'topics').find(
    (group) => attr(group, 'type') === 'detached'
  )

  const topic: Topic = {
    id: attr(node, 'id') ?? createId('topic'),
    title: childText(node, 'title') ?? '',
    structureClass: attr(node, 'structure-class'),
    children: childrenOf(attachedGroup ?? null, 'topic').map(parseTopic),
    detachedChildren: childrenOf(detachedGroup ?? null, 'topic').map(parseTopic),
    labels: childrenOf(childOf(node, 'labels'), 'label')
      .map((label) => textOf(label))
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
    markers: [
      ...childrenOf(childOf(node, 'marker-refs'), 'marker-ref'),
      ...childrenOf(childOf(node, 'markers'), 'marker')
    ]
      .map((marker) => attr(marker, 'marker-id', 'markerId', 'id'))
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .map((markerId) => ({ markerId })),
    attachments
  }

  if (notes !== undefined) topic.notes = notes
  if (notesHtml !== undefined) topic.notesHtml = notesHtml
  const href = childText(node, 'href')
  if (href !== undefined) topic.href = href
  if (image) topic.image = image

  // 折叠：Xmind 8 用 <branch>folded</branch>
  if ((childText(node, 'branch') ?? '') === 'folded') topic.collapsed = true

  // 自由定位：坐标可能写成 x/y，也可能写成 svg:x/svg:y
  const position = childOf(node, 'position')
  if (position) {
    const px = numberOf(attr(position, 'x', 'svg:x'))
    const py = numberOf(attr(position, 'y', 'svg:y'))
    if (px !== undefined || py !== undefined) topic.position = { x: px ?? 0, y: py ?? 0 }
  }

  const style = parseStyleOf(node)
  if (style) topic.style = style

  if (extensions.length > 0) topic.extensions = extensions
  return topic
}

function parseSheet(node: XmlNode, index: number): Sheet | null {
  const topics = childrenOf(node, 'topic')
  const rootTopic = topics[0]
  if (!rootTopic) return null

  const extensions: unknown[] = []
  collectUnknown(
    node,
    new Set(['topic', 'relationships', 'boundaries', 'summaries', 'title']),
    extensions
  )

  const relationships: Relationship[] = childrenOf(
    childOf(node, 'relationships'),
    'relationship'
  ).flatMap((rel) => {
    const end1Id = attr(rel, 'end1', 'end1Id')
    const end2Id = attr(rel, 'end2', 'end2Id')
    if (!end1Id || !end2Id) return []
    return [
      {
        id: attr(rel, 'id') ?? createId('rel'),
        end1Id,
        end2Id,
        title: childText(rel, 'title')
      }
    ]
  })

  const boundaries: Boundary[] = childrenOf(childOf(node, 'boundaries'), 'boundary').flatMap(
    (item) => {
      const range = attr(item, 'range')
      if (!range) return []
      return [
        { id: attr(item, 'id') ?? createId('boundary'), range, title: childText(item, 'title') }
      ]
    }
  )

  const summaries: Summary[] = childrenOf(childOf(node, 'summaries'), 'summary').flatMap((item) => {
    const range = attr(item, 'range')
    const topicId = attr(item, 'topic-id', 'topicId')
    if (!range || !topicId) return []
    return [
      {
        id: attr(item, 'id') ?? createId('summary'),
        topicId,
        range,
        title: childText(item, 'title')
      }
    ]
  })

  const sheet: Sheet = {
    id: attr(node, 'id') ?? createId('sheet'),
    title: childText(node, 'title') ?? `画布 ${index + 1}`,
    rootTopic: parseTopic(rootTopic),
    relationships,
    boundaries,
    summaries
  }
  if (extensions.length > 0) sheet.extensions = extensions
  return sheet
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 解析 Xmind 8 的 content.xml（传进来的是已经解析好的 XML 树）。
 * 找不到画布、或根本不是 XML 时抛出可读错误。
 */
export function parseLegacyContent(tree: XmlNode): LegacyParseResult {
  const warnings: string[] = []

  const sheetNodes = childrenOf(tree, 'sheet')
  const sheets = sheetNodes
    .map((node, index) => parseSheet(node, index))
    .filter((sheet): sheet is Sheet => sheet !== null)

  const first = sheets[0]
  if (!first) {
    throw new Error('content.xml 里没有找到任何画布')
  }

  warnings.push('这是 Xmind 8 旧版格式（content.xml），已按兼容模式读取。')
  warnings.push(
    '原文件的主题与样式来自 styles.xml，本软件暂不解析；保存时会转换为新版（content.json）格式。'
  )

  const workbook: Workbook = {
    version: MODEL_VERSION,
    sheets,
    activeSheetId: first.id,
    creator: { ...CREATOR }
  }

  return { workbook, warnings }
}
