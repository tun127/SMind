import JSZip from 'jszip'
import { isRecord } from '../guards'
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
import { coerceCode, coerceRichText } from '../model/coerce'
import { normalizeThemeColors } from '../theme'
import { STRUCTURES, THEME_NAMESPACE, XMIND_FILES } from './constants'
import { buildEmmxWorkbook, extractEmmxTexts, parseEmmxDocument, EMMX_PAGE_FILE } from './emmx'
import { parseLegacyContent } from './legacy'
import { parseXml } from './xml'

/** 我们自己的扩展 provider 标识，用于承载 Xmind 不认识的字段 */
export const OUR_PROVIDER = 'com.mindmap.local'

export interface ParseResult extends MindPackage {
  /** 解析过程中产生的兼容性提示，用于界面告知用户 */
  warnings: string[]
}

/* ------------------------------------------------------------------ */
/* 解析辅助                                                            */
/* ------------------------------------------------------------------ */

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
function readOurExtensions(raw: unknown): {
  titleRich?: Topic['titleRich']
  formula?: string
  code?: Topic['code']
  sizeOverride?: Topic['sizeOverride']
} {
  const out: {
    titleRich?: Topic['titleRich']
    formula?: string
    code?: Topic['code']
    sizeOverride?: Topic['sizeOverride']
  } = {}
  for (const item of asArray(raw)) {
    if (!isRecord(item)) continue
    if (item.provider !== OUR_PROVIDER) continue
    const content = item.content
    if (isRecord(content)) {
      // 逐字段收敛后再收下：这是**别人的文件**，字段缺失/类型不对都是常态，
      // 强转会让坏数据一路流进测量与渲染
      const titleRich = coerceRichText(content.titleRich)
      if (titleRich) out.titleRich = titleRich
      if (typeof content.formula === 'string') out.formula = content.formula
      const code = coerceCode(content.code)
      if (code) out.code = code
      if (isRecord(content.sizeOverride)) {
        const width = asNumber(content.sizeOverride.width)
        const height = asNumber(content.sizeOverride.height)
        if (width !== undefined && height !== undefined && width > 0 && height > 0) {
          out.sizeOverride = { width: Math.round(width), height: Math.round(height) }
        }
      }
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
  if (ours.code) topic.code = ours.code
  if (ours.sizeOverride) topic.sizeOverride = ours.sizeOverride
  if (isRecord(raw.position)) {
    const px = asNumber(raw.position.x)
    const py = asNumber(raw.position.y)
    if (px !== undefined || py !== undefined) {
      topic.position = { x: px ?? 0, y: py ?? 0 }
    }
  }

  // 本软件自己的扩展字段已经在上面还原成 titleRich / formula / code，
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
 * 打开压缩包。
 *
 * JSZip 抛的是英文原文（`Corrupted zip: can't find end of central directory` 之类），
 * 直接摊给用户看没有任何意义——换成能指导下一步动作的说法。
 */
async function loadZip(data: Uint8Array): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(data)
  } catch {
    throw new Error('这个文件不是有效的 .xmind：压缩包已损坏或不完整（可试试在原软件里重新导出）')
  }
}

/**
 * 解析 .xmind / .emmx 文件。
 * 兼容 Xmind 2020+（content.json）、Xmind 8 旧版（content.xml），
 * 以及亿图脑图的 .emmx（本身是 Xmind 格式时走正常解析；专有二进制格式走文字提取）。
 *
 * @param options.fileName 文件名（不带路径），用于给「无标题」的导入结果取名
 */
export async function parseXmind(
  data: Uint8Array,
  options: { fileName?: string } = {}
): Promise<ParseResult> {
  const warnings: string[] = []
  const zip = await loadZip(data)

  const contentFile = zip.file(XMIND_FILES.content)
  if (!contentFile) {
    const legacyFile = zip.file(XMIND_FILES.legacyContent)
    if (!legacyFile) {
      // 亿图脑图的专有格式：内容在 mmpage/page.bin 里，只能做文字提取
      const emmxPage = zip.file(EMMX_PAGE_FILE)
      if (emmxPage) return parseEmmxPackage(emmxPage, options.fileName)
      throw new Error(
        '文件不是有效的 .xmind / .emmx：既没有 content.json、content.xml，也没有亿图脑图的页数据'
      )
    }
    return parseLegacyPackage(zip, legacyFile)
  }

  const text = await contentFile.async('string')
  let rawSheets: unknown
  try {
    rawSheets = JSON.parse(text)
  } catch {
    throw new Error('content.json 解析失败：文件已损坏或格式不正确')
  }

  // 亿图脑图的 ver:2 结构（{ver, contents}）与 Xmind 完全不同，走专用解析
  const emmx = parseEmmxDocument(rawSheets, options.fileName)
  if (emmx) {
    return { workbook: emmx.workbook, resources: await readResources(zip), warnings: emmx.warnings }
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
  const resources = await readResources(zip)

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

/** 读取包内的图片/附件资源（resources/ 与旧版的 attachments/ 都收） */
async function readResources(zip: JSZip): Promise<Record<string, Uint8Array>> {
  const resources: Record<string, Uint8Array> = {}
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue
    if (!name.startsWith(XMIND_FILES.resourcesDir) && !name.startsWith('attachments/')) continue
    resources[name] = await file.async('uint8array')
  }
  return resources
}

/**
 * 读取亿图脑图的专有 .emmx。
 *
 * 只能做文字提取：节点之间的父子关系存在专有对象图里，需要完整逆向才拿得到，
 * 与其猜一个错的层级，不如老实告诉用户「文字都在、结构要自己整理」。
 */
async function parseEmmxPackage(
  pageFile: JSZip.JSZipObject,
  fileName?: string
): Promise<ParseResult> {
  let pageBin: Uint8Array
  try {
    pageBin = await pageFile.async('uint8array')
  } catch {
    throw new Error('亿图脑图的页数据读取失败：文件可能已损坏')
  }

  const texts = extractEmmxTexts(pageBin)
  if (texts.length === 0) {
    throw new Error(
      '这是亿图脑图的专有 .emmx 格式，但没有从页数据里提取到任何文字，暂时打不开。建议在亿图脑图里「导出为 .xmind」后再打开。'
    )
  }

  const { workbook, warnings } = buildEmmxWorkbook(texts, fileName)
  // 专有格式里的图片无法定位到具体节点，不做导入：
  // 否则会在文件里留下一堆没有归属的资源，反而更难处理
  return { workbook, resources: {}, warnings }
}

/** 读取 Xmind 8 旧版（content.xml） */
async function parseLegacyPackage(zip: JSZip, contentFile: JSZip.JSZipObject): Promise<ParseResult> {
  let text: string
  try {
    text = await contentFile.async('string')
  } catch {
    throw new Error('content.xml 读取失败：文件已损坏')
  }

  const tree = parseXml(text)
  if (!tree) {
    throw new Error('content.xml 解析失败：文件已损坏或不是合法的 XML')
  }

  const { workbook, warnings } = parseLegacyContent(tree)
  const resources = await readResources(zip)
  return { workbook, resources, warnings }
}

const KNOWN_STRUCTURES = new Set<string>(STRUCTURES.map((item) => item.class))

function collectStructures(topic: Topic, out: Set<string>): void {
  if (topic.structureClass) out.add(topic.structureClass)
  for (const c of topic.children) collectStructures(c, out)
  for (const c of topic.detachedChildren) collectStructures(c, out)
}
