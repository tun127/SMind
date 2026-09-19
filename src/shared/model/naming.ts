/**
 * 默认文件名的取名规则（纯函数，可在自检里跑）。
 *
 * 约定：**优先用中心主题的文字**——这是用户看到的第一眼名字，
 * 比「画布 1」「未命名导图」更符合直觉（Xmind 也是这么做的）。
 * 中心主题为空时退回画布名，再退回「未命名导图」。
 */

import type { Workbook } from './types'
import { baseNameOf } from './path-text'

/** Windows 不允许出现在文件名里的字符 */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g

/** Windows 的保留设备名，直接用会创建失败 */
const RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9'
])

/** 清理成可用的文件名（不含扩展名）；清完为空则返回空串 */
export function sanitizeFileName(name: string, maxLength = 60): string {
  let text = (name ?? '').replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim()
  // Windows 会把结尾的点和空格吃掉，干脆自己先去掉
  text = text.replace(/[. ]+$/, '')

  if (text.length > maxLength) {
    text = text.slice(0, maxLength).replace(/[. ]+$/, '')
  }
  if (text.length > 0 && RESERVED.has(text.toLowerCase())) text = `${text}_`
  return text
}

/** 取工作簿的默认名字：中心主题 → 画布名 → 未命名导图 */
export function defaultDocumentName(workbook: Workbook | undefined): string {
  const sheet =
    workbook?.sheets.find((item) => item.id === workbook.activeSheetId) ??
    workbook?.sheets[0] ??
    undefined

  const rootTitle = sanitizeFileName(sheet?.rootTopic?.title ?? '')
  if (rootTitle.length > 0) return rootTitle

  const sheetTitle = sanitizeFileName(sheet?.title ?? '')
  if (sheetTitle.length > 0) return sheetTitle

  return '未命名导图'
}

/** 带上扩展名的默认文件名 */
export function defaultFileName(workbook: Workbook | undefined, extension: string): string {
  const ext = extension.replace(/^\./, '')
  return `${defaultDocumentName(workbook)}.${ext}`
}

/**
 * 从完整路径里取出文件名（含扩展名）；没有路径时返回 null。
 *
 * 以前 App 与状态栏各写了一份逐字相同的实现，这里收成唯一来源。
 * 路径以分隔符结尾（取不到文件名）时**回退整条路径**——调用点策略，保持原样。
 */
export function fileNameOf(path: string | null): string | null {
  if (!path) return null
  return baseNameOf(path) || path
}
