/**
 * 附件/图片资源（.xmind 包内 resources/ 目录）相关的纯逻辑。
 *
 * 这里刻意不依赖 Electron 与 DOM，方便放进自检里跑：
 * 资源的「引用收集」「本次会话新增资源的清理」「文件名与 MIME 推断」都是纯函数。
 */

import type { Topic, Workbook } from './types'
import { baseNameOf } from './path-text'

/**
 * 包内资源目录前缀：**唯一来源**。
 *
 * 现役写法是 `resources/`；旧版（Xmind 8 / 亿图）的包里写作 `attachments/`——
 * 两个都要认，所以别再在别处各写一份字面量（`xmind/constants.ts` 的
 * `XMIND_FILES.resourcesDir` 由这里派生，`xmind/parse.ts` 读包时两个前缀都收）。
 */
export const RESOURCES_DIR = 'resources/'
export const LEGACY_ATTACHMENTS_DIR = 'attachments/'

/** 收集工作簿里被引用的资源路径（图片 + 附件） */
export function collectResourceRefs(workbook: Workbook): Set<string> {
  const refs = new Set<string>()

  const walk = (topic: Topic): void => {
    const imagePath = topic.image?.path
    if (imagePath) refs.add(imagePath)
    for (const attachment of topic.attachments ?? []) {
      if (attachment?.path) refs.add(attachment.path)
    }
    for (const child of topic.children) walk(child)
    for (const child of topic.detachedChildren) walk(child)
  }

  for (const sheet of workbook.sheets) walk(sheet.rootTopic)
  return refs
}

/**
 * 只清理「本次会话新插入、且已经不再被任何节点引用」的资源。
 *
 * 不直接按引用全集裁剪，是因为文件里可能带着本软件尚未建模的资源
 * （例如备注 HTML 里引用的图片），一刀切会把它们删掉、造成静默数据丢失。
 */
export function pruneSessionResources(
  resources: Record<string, Uint8Array>,
  sessionAdded: Iterable<string>,
  workbook: Workbook
): { resources: Record<string, Uint8Array>; removed: string[] } {
  const refs = collectResourceRefs(workbook)
  const added = new Set(sessionAdded)
  const removed: string[] = []
  const next: Record<string, Uint8Array> = {}

  for (const [path, bytes] of Object.entries(resources)) {
    if (added.has(path) && !refs.has(path)) {
      removed.push(path)
      continue
    }
    next[path] = bytes
  }

  return { resources: next, removed }
}

/** 去掉路径里的目录部分与不安全字符，得到可放进 resources/ 的文件名 */
export function safeResourceName(name: string): string {
  const base = baseNameOf(name)
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'file'
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  zip: 'application/zip',
  xmind: 'application/zip'
}

export function extensionOf(path: string): string {
  const base = baseNameOf(path)
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** 按扩展名推断 MIME；推断不出来时用通用的二进制类型 */
export function mimeOfPath(path: string): string {
  return MIME_BY_EXT[extensionOf(path)] ?? 'application/octet-stream'
}

/** 图片扩展名白名单（插入图片时用） */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']

/**
 * 生成包内资源路径：resources/<唯一 id>[-原名].<ext>。
 * 带唯一前缀是为了同名文件互不覆盖。
 */
export function resourcePathFor(id: string, originalName: string): string {
  const name = safeResourceName(originalName)
  return `${RESOURCES_DIR}${id}-${name}`
}
