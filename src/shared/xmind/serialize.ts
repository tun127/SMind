import JSZip from 'jszip'
import { CREATOR, type MindPackage, type Theme, type Topic, type Workbook } from '../model/types'
import { OUR_PROVIDER } from './parse'
import { THEME_NAMESPACE, XMIND_FILES } from './constants'

/**
 * 把主题对象写回 .xmind。
 * 先铺开原始的 Xmind 主题结构（保证 Xmind 打开时外观基本不丢），
 * 再覆盖上 id/name 与本软件的配色命名空间。
 */
function themeToRaw(theme: Theme | undefined): Raw | undefined {
  if (!theme) return undefined
  const base: Raw = { ...(theme.raw ?? {}) }
  delete base[THEME_NAMESPACE]
  if (theme.id) base.id = theme.id
  if (theme.name) base.name = theme.name
  if (theme.colors) base[THEME_NAMESPACE] = { colors: theme.colors }
  return Object.keys(base).length > 0 ? base : undefined
}

/* ------------------------------------------------------------------ */
/* 输出辅助：剔除空值，保持生成的文件干净且与 Xmind 一致                */
/* ------------------------------------------------------------------ */

type Raw = Record<string, unknown>

/**
 * 包内资源引用统一带 `xap:` 前缀（Xmind 的写法）。
 * 已经是 URL（http:/file: 等）的路径保持原样，不硬加前缀。
 */
function toXap(path: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(path) ? path : `xap:${path}`
}

function compact<T extends Raw>(obj: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v) && v.length === 0) continue
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0)
      continue
    out[k] = v
  }
  return out as T
}

/**
 * 拼出元素自己的 `extensions`：本软件字段包成 `provider === OUR_PROVIDER` 的扩展放在最前，
 * 外部扩展原样跟在后面（**先剔除**同名 provider 的那一份，否则「打开 → 另存」会越存越多）。
 *
 * 主题与画布级元素（关系线 / 边界 / 概要）共用这一处 —— 两边各写一份的话，
 * 迟早有一边忘了剔除，于是文件里凭空多出一份重复数据。
 */
function buildExtensions(
  external: unknown[] | undefined,
  ours: Record<string, unknown>
): unknown[] | undefined {
  const kept = (external ?? []).filter(
    (ext) => !(typeof ext === 'object' && ext !== null && (ext as Raw).provider === OUR_PROVIDER)
  )
  const content = compact(ours)
  const list =
    Object.keys(content).length > 0 ? [{ provider: OUR_PROVIDER, content }, ...kept] : kept
  return list.length > 0 ? list : undefined
}

function topicToRaw(topic: Topic): Raw {
  const attached = topic.children.map(topicToRaw)
  const detached = topic.detachedChildren.map(topicToRaw)

  // 本软件自己的扩展字段（Xmind 会忽略，但不影响往返保真）+ 原样透传的外部扩展
  const extensions = buildExtensions(topic.extensions, {
    titleRich: topic.titleRich,
    formula: topic.formula,
    code: topic.code,
    sizeOverride: topic.sizeOverride
  })

  const notes =
    topic.notes !== undefined || topic.notesHtml !== undefined
      ? compact({
          plain: topic.notes !== undefined ? { content: topic.notes } : undefined,
          realHTML: topic.notesHtml !== undefined ? { content: topic.notesHtml } : undefined
        })
      : undefined

  const image = topic.image
    ? compact({
        src: toXap(topic.image.path),
        width: topic.image.width,
        height: topic.image.height
      })
    : undefined

  return compact({
    id: topic.id,
    class: 'topic',
    title: topic.title,
    structureClass: topic.structureClass,
    children: compact({ attached, detached }),
    labels: topic.labels,
    markers: topic.markers.map((m) => ({ markerId: m.markerId })),
    notes,
    href: topic.href,
    image,
    attachments: topic.attachments.map((a) =>
      compact({ id: a.id, path: toXap(a.path), name: a.name, size: a.size, mime: a.mime })
    ),
    style: topic.style,
    branch: topic.collapsed ? 'folded' : undefined,
    position: topic.position ? { x: topic.position.x, y: topic.position.y } : undefined,
    extensions
  })
}

function sheetToRaw(sheet: MindPackage['workbook']['sheets'][number]): Raw {
  return compact({
    id: sheet.id,
    class: 'sheet',
    title: sheet.title,
    rootTopic: topicToRaw(sheet.rootTopic),
    theme: themeToRaw(sheet.theme),
    relationships: sheet.relationships.map((r) =>
      compact({
        id: r.id,
        class: 'relationship',
        end1Id: r.end1Id,
        end2Id: r.end2Id,
        title: r.title,
        style: r.style,
        extensions: buildExtensions(r.extensions, { titleRich: r.titleRich })
      })
    ),
    boundaries: sheet.boundaries.map((b) =>
      compact({
        id: b.id,
        class: 'boundary',
        range: b.range,
        title: b.title,
        style: b.style,
        extensions: buildExtensions(b.extensions, { titleRich: b.titleRich })
      })
    ),
    summaries: sheet.summaries.map((s) =>
      compact({
        id: s.id,
        class: 'summary',
        topicId: s.topicId,
        range: s.range,
        title: s.title,
        style: s.style,
        extensions: buildExtensions(s.extensions, { titleRich: s.titleRich })
      })
    ),
    topicPositioning: sheet.topicPositioning,
    extensions: sheet.extensions
  })
}

/** 把工作簿转成 Xmind 的 content.json 结构 */
export function workbookToContentJson(workbook: Workbook): unknown[] {
  return workbook.sheets.map(sheetToRaw)
}

/** 序列化为 .xmind 二进制 */
export async function serializeXmind(pkg: MindPackage): Promise<Uint8Array> {
  const { workbook, resources } = pkg
  const zip = new JSZip()

  zip.file(XMIND_FILES.content, JSON.stringify(workbookToContentJson(workbook)))
  zip.file(
    XMIND_FILES.metadata,
    JSON.stringify(
      compact({
        creator: { name: CREATOR.name, version: CREATOR.version },
        activeSheetId: workbook.activeSheetId
      })
    )
  )

  const entries: Raw = {
    'content.json': {},
    'metadata.json': {}
  }
  for (const [path, bytes] of Object.entries(resources ?? {})) {
    zip.file(path, bytes)
    entries[path] = {}
  }
  zip.file(XMIND_FILES.manifest, JSON.stringify({ 'file-entries': entries }))

  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  })
}
