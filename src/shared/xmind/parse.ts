import JSZip from 'jszip'
import {
  CREATOR,
  MODEL_VERSION,
  type Attachment,
  type Boundary,
  type MindPackage,
  type NodeStyle,
  type Relationship,
  type Sheet,
  type Summary,
  type Theme,
  type Topic,
  type Workbook
} from '../model/types'
import { createId } from '../model/factory'
import { normalizeThemeColors } from '../theme'
import { DEFAULT_STRUCTURE, STRUCTURES, THEME_NAMESPACE, XMIND_FILES } from './constants'

/** 我们自己的扩展 provider 标识，用于承载 Xmind 不认识的字段 */
export const OUR_PROVIDER = 'com.mindmap.local'

export interface ParseResult extends MindPackage {
  /** 解析过程中产生的兼容性提示，用于界面告知用户 */
  warnings: string[]
}

/* ------------------------------------------------------------------ */
/* 解析辅助                                                            */
/* ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 剥离 xap: 前缀，得到包内相对路径 */
function normalizeResourcePath(p: string): string {
  return p.replace(/^xap:/, '').replace(/^\.?\//, '')
}

function parseNotes(raw: unknown): { notes?: string; notesHtml?: string } {
  if (typeof raw === 'string') return { notes: raw }
  if (!isRecord(raw)) return {}
  const plain = isRecord(raw.plain) ? asString(raw.plain.content) : undefined
  const html = isRecord(raw.realHTML) ? asString(raw.realHTML.content) : undefined
  return { notes: plain ?? asString(raw.content), notesHtml: html }
}

function parseStyle(raw: unknown): NodeStyle | undefined {
  if (!isRecord(raw)) return undefined
  const properties: Record<string, string> = {}
  if (isRecord(raw.properties)) {
    for (const [k, v] of Object.entries(raw.properties)) {
      if (typeof v === 'string') properties[k] = v
      else if (typeof v === 'number' || typeof v === 'boolean') properties[k] = String(v)
    }
  }
  const id = asString(raw.id)
  if (!id && Object.keys(properties).length === 0) return undefined
  return { id, properties }
}

function parseAttachments(raw: unknown): Attachment[] {
  return asArray(raw).flatMap((item) => {
    if (!isRecord(item)) return []
    const rawPath = asString(item.path) ?? asString(item.src)
    if (!rawPath) return []
    const path = normalizeResourcePath(rawPath)
    return [
      {
        id: asString(item.id) ?? createId('att'),
        path,
        name: asString(item.name) ?? path.split('/').pop() ?? '附件',
        size: asNumber(item.size),
        mime: asString(item.mime)
      }
    ]
  })
}

function parseImage(raw: unknown): Topic['image'] {
  if (!isRecord(raw)) return undefined
  const rawPath = asString(raw.src) ?? asString(raw.path)
  if (!rawPath) return undefined
  return {
    path: normalizeResourcePath(rawPath),
    width: asNumber(raw.width),
    height: asNumber(raw.height)
  }
}

/** 从 extensions 里读回本软件自己的字段 */
function readOurExtensions(raw: unknown): { titleRich?: Topic['titleRich']; formula?: string } {
  const out: { titleRich?: Topic['titleRich']; formula?: string } = {}
  for (const item of asArray(raw)) {
    if (!isRecord(item)) continue
    if (item.provider !== OUR_PROVIDER) continue
    const content = item.content
    if (isRecord(content)) {
      if (isRecord(content.titleRich) && Array.isArray(content.titleRich.paragraphs)) {
        out.titleRich = content.titleRich as unknown as Topic['titleRich']
      }
      if (typeof content.formula === 'string') out.formula = content.formula
    }
  }
  return out
}

function parseTopic(raw: unknown): Topic | null {
  if (!isRecord(raw)) return null
  const childrenRaw = isRecord(raw.children) ? raw.children : {}
  const ours = readOurExtensions(raw.extensions)
  const notes = parseNotes(raw.notes)

  const topic: Topic = {
    id: asString(raw.id) ?? createId('topic'),
    title: asString(raw.title) ?? '',
    structureClass: asString(raw.structureClass),
    children: asArray(childrenRaw.attached)
      .map(parseTopic)
      .filter((t): t is Topic => t !== null),
    detachedChildren: asArray(childrenRaw.detached)
      .map(parseTopic)
      .filter((t): t is Topic => t !== null),
    labels: asArray(raw.labels).filter((l): l is string => typeof l === 'string'),
    markers: asArray(raw.markers).flatMap((m) => {
      if (typeof m === 'string') return [{ markerId: m }]
      if (isRecord(m) && typeof m.markerId === 'string') return [{ markerId: m.markerId }]
      return []
    }),
    attachments: parseAttachments(raw.attachments)
  }

  if (notes.notes !== undefined) topic.notes = notes.notes
  if (notes.notesHtml !== undefined) topic.notesHtml = notes.notesHtml

  const href = asString(raw.href)
  if (href) topic.href = href

  const image = parseImage(raw.image)
  if (image) topic.image = image

  const style = parseStyle(raw.style)
  if (style) topic.style = style

  if (raw.branch === 'folded') topic.collapsed = true
  if (ours.titleRich) topic.titleRich = ours.titleRich
  if (ours.formula) topic.formula = ours.formula
  if (isRecord(raw.position)) {
    const px = asNumber(raw.position.x)
    const py = asNumber(raw.position.y)
    if (px !== undefined || py !== undefined) {
      topic.position = { x: px ?? 0, y: py ?? 0 }
    }
  }

  // 本软件自己的扩展字段已经在上面还原成 titleRich / formula，
  // 这里必须把它们剔除，否则「打开→另存」会凭空多出一份重复数据。
  if (Array.isArray(raw.extensions)) {
    const external = raw.extensions.filter((ext) => !(isRecord(ext) && ext.provider === OUR_PROVIDER))
    if (external.length > 0) topic.extensions = external
  }

  return topic
}

/**
 * 读取 theme 对象。
 * id/name 由模型自己持有，我们自己的配色放在命名空间键里，
 * 其余键（即 Xmind 原生主题结构）原样收进 raw，保证往返完全稳定。
 */
function parseTheme(raw: unknown): Theme | undefined {
  if (!isRecord(raw)) return undefined

  const structure: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === THEME_NAMESPACE || key === 'id' || key === 'name') continue
    structure[key] = value
  }

  const namespace = raw[THEME_NAMESPACE]
  const colors = isRecord(namespace) ? normalizeThemeColors(namespace.colors) : null

  const theme: Theme = {
    id: asString(raw.id),
    name: asString(raw.name)
  }
  if (colors) theme.colors = colors
  if (Object.keys(structure).length > 0) theme.raw = structure
  return theme
}

function parseSheet(raw: unknown, index: number): Sheet | null {
  if (!isRecord(raw)) return null
  const root = parseTopic(raw.rootTopic)
  if (!root) return null

  return {
    id: asString(raw.id) ?? createId('sheet'),
    title: asString(raw.title) ?? `画布 ${index + 1}`,
    rootTopic: root,
    theme: parseTheme(raw.theme),
    relationships: asArray(raw.relationships).flatMap((r): Relationship[] => {
      if (!isRecord(r)) return []
      const end1Id = asString(r.end1Id)
      const end2Id = asString(r.end2Id)
      if (!end1Id || !end2Id) return []
      return [
        {
          id: asString(r.id) ?? createId('rel'),
          end1Id,
          end2Id,
          title: asString(r.title),
          style: parseStyle(r.style),
          extensions: Array.isArray(r.extensions) ? r.extensions : undefined
        }
      ]
    }),
    boundaries: asArray(raw.boundaries).flatMap((b): Boundary[] => {
      if (!isRecord(b)) return []
      const range = asString(b.range)
      if (!range) return []
      return [
        {
          id: asString(b.id) ?? createId('boundary'),
          range,
          title: asString(b.title),
          style: parseStyle(b.style),
          extensions: Array.isArray(b.extensions) ? b.extensions : undefined
        }
      ]
    }),
    summaries: asArray(raw.summaries).flatMap((s): Summary[] => {
      if (!isRecord(s)) return []
      const range = asString(s.range)
      const topicId = asString(s.topicId)
      if (!range || !topicId) return []
      return [
        {
          id: asString(s.id) ?? createId('summary'),
          topicId,
          range,
          title: asString(s.title),
          style: parseStyle(s.style),
          extensions: Array.isArray(s.extensions) ? s.extensions : undefined
        }
      ]
    }),
    topicPositioning: raw.topicPositioning === 'fixed' ? 'fixed' : undefined,
    extensions: Array.isArray(raw.extensions) ? raw.extensions : undefined
  }
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/** 判断一个 zip 是否为 Xmind 8 旧版（content.xml）格式 */
export async function isLegacyXmind(data: Uint8Array): Promise<boolean> {
  try {
    const zip = await JSZip.loadAsync(data)
    return !!zip.file(XMIND_FILES.legacyContent) && !zip.file(XMIND_FILES.content)
  } catch {
    return false
  }
}

/**
 * 解析 .xmind 文件。
 * 兼容 Xmind 2020+（content.json）；旧版 Xmind 8（content.xml）在 P6 阶段实现。
 */
export async function parseXmind(data: Uint8Array): Promise<ParseResult> {
  const warnings: string[] = []
  const zip = await JSZip.loadAsync(data)

  const contentFile = zip.file(XMIND_FILES.content)
  if (!contentFile) {
    if (zip.file(XMIND_FILES.legacyContent)) {
      throw new Error('这是 Xmind 8 旧版格式（content.xml），暂未支持，将在 P6 阶段实现兼容。')
    }
    throw new Error('文件不是有效的 .xmind 文件：缺少 content.json')
  }

  const text = await contentFile.async('string')
  let rawSheets: unknown
  try {
    rawSheets = JSON.parse(text)
  } catch {
    throw new Error('content.json 解析失败：文件已损坏或格式不正确')
  }

  const sheets = asArray(rawSheets)
    .map((s, i) => parseSheet(s, i))
    .filter((s): s is Sheet => s !== null)

  if (sheets.length === 0) {
    throw new Error('文件中没有找到任何画布')
  }

  // 兼容性提示：只对「完全不认识」的结构给出提醒，已知结构都能正常布局
  const usedStructures = new Set<string>()
  for (const sheet of sheets) {
    collectStructures(sheet.rootTopic, usedStructures)
  }
  const unknownStructures = [...usedStructures].filter((c) => !KNOWN_STRUCTURES.has(c))
  if (unknownStructures.length > 0) {
    warnings.push(
      `文件中包含 ${unknownStructures.length} 种本软件未识别的结构，已按思维导图方式显示，数据结构完整保留。`
    )
  }

  // 读取资源文件
  const resources: Record<string, Uint8Array> = {}
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue
    if (!name.startsWith(XMIND_FILES.resourcesDir)) continue
    resources[name] = await file.async('uint8array')
  }

  const workbook: Workbook = {
    version: MODEL_VERSION,
    sheets,
    activeSheetId: sheets[0].id,
    creator: { ...CREATOR }
  }

  // 读取 metadata 里的 activeSheetId
  const metaFile = zip.file(XMIND_FILES.metadata)
  if (metaFile) {
    try {
      const meta = JSON.parse(await metaFile.async('string')) as Record<string, unknown>
      const activeId = asString(meta.activeSheetId)
      if (activeId && sheets.some((s) => s.id === activeId)) {
        workbook.activeSheetId = activeId
      }
    } catch {
      warnings.push('metadata.json 解析失败，已忽略。')
    }
  }

  return { workbook, resources, warnings }
}

const KNOWN_STRUCTURES = new Set<string>(STRUCTURES.map((item) => item.class))

function collectStructures(topic: Topic, out: Set<string>): void {
  if (topic.structureClass) out.add(topic.structureClass)
  for (const c of topic.children) collectStructures(c, out)
  for (const c of topic.detachedChildren) collectStructures(c, out)
}
