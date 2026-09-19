/**
 * 文档 → 纯文本：给「拖一份文档进来，让 AI 读完做成导图」用。
 *
 * **纯函数**（zip 解包由调用方做完、把 entry 文本传进来），所以整套抽取逻辑都能在自检里跑。
 *
 * 支持范围（**刻意不引入新依赖**：.docx / .xlsx / .pptx 本质都是 zip + XML，
 * 用项目里已有的 jszip 解包 + 自己抽文本即可）：
 * - 纯文本类：md / txt / csv / tsv / json / yaml / xml / html / 各种代码与日志
 * - Word（.docx）、Excel（.xlsx）、PowerPoint（.pptx）
 * - **PDF 不支持**：可靠的中文 PDF 文本抽取需要额外解析库，做不好就是"看着成功、
 *   实际全是乱码"。这里明确说"不支持"并给出可行替代（在阅读器里另存 / 导出为
 *   docx 或 txt），而不是静默失败。
 */

import { decodeNumericEntity } from '../entities'
import { extensionOf } from '../model/resources'

export type DocumentKind = 'text' | 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'unsupported'

export interface DocumentClass {
  kind: DocumentKind
  /** 给用户看的名字（「Word 文档」等） */
  label: string
  /** 不支持 / 需要提醒时的一句话 */
  note?: string
}

/** 读完之后交给渲染层的东西（界面要显示文件名、字数与"被截断"的说明） */
export interface ExtractedDocument {
  /** 文件名（含扩展名） */
  name: string
  kind: DocumentKind
  /** 中文类型名：「Word 文档」「文本文件」… */
  label: string
  /** 抽取并清洗后的正文 */
  text: string
  /** 原文被截断 / 有损时的说明（null = 完整） */
  note: string | null
  chars: number
  lines: number
}

/** 纯文本类扩展名（含常见代码与配置文件） */
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'mdx',
  'rst',
  'log',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'cfg',
  'env',
  'xml',
  'html',
  'htm',
  'srt',
  'vtt',
  'tex',
  'sql',
  'sh',
  'bash',
  'ps1',
  'bat',
  'cmd',
  'py',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'java',
  'kt',
  'go',
  'rs',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'rb',
  'php',
  'swift',
  'scala',
  'lua',
  'r',
  'dart',
  'vue',
  'svelte',
  'css',
  'scss',
  'less'
])

/** 扩展名 → 语言名（界面与提示词里用，顺便让 AI 知道自己在读什么） */
const OFFICE_LABELS: Record<string, string> = {
  docx: 'Word 文档',
  xlsx: 'Excel 表格',
  pptx: 'PowerPoint 演示'
}

/** 这份文件能不能读？读成什么？ */
export function classifyDocument(name: string): DocumentClass {
  const ext = extensionOf(name)
  if (ext === 'pdf') {
    return {
      kind: 'pdf',
      label: 'PDF 文档',
      note:
        'PDF 暂不支持直接读取（可靠的中文 PDF 文本抽取需要额外的解析库）。' +
        '可以先用阅读器另存 / 导出为 Word 或 TXT，再拖进来。'
    }
  }
  if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') {
    return { kind: ext, label: OFFICE_LABELS[ext] ?? ext }
  }
  if (TEXT_EXTENSIONS.has(ext)) return { kind: 'text', label: '文本文件' }
  return {
    kind: 'unsupported',
    label: ext.length > 0 ? `.${ext} 文件` : '未知格式',
    note: '这个格式读不了。支持：docx / xlsx / pptx / md / txt / csv / json / 各种代码与日志。'
  }
}

/** 需要先解 zip 的格式 */
export function isZipDocument(kind: DocumentKind): boolean {
  return kind === 'docx' || kind === 'xlsx' || kind === 'pptx'
}

/**
 * 解包后要读哪些 entry（返回前缀列表，调用方按前缀筛选）。
 * 只读**文本所在的那几个 XML**，不碰图片与嵌入对象——省内存也省时间。
 */
export function zipEntryPrefixesFor(kind: DocumentKind): string[] {
  if (kind === 'docx') return ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']
  if (kind === 'xlsx') return ['xl/workbook.xml', 'xl/sharedStrings.xml', 'xl/worksheets/']
  if (kind === 'pptx') return ['ppt/slides/']
  return []
}

/* ------------------------------------------------------------------ */
/* XML → 纯文本                                                        */
/* ------------------------------------------------------------------ */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

/** 解掉 XML 实体（含数字引用） */
export function decodeXmlEntities(text: string): string {
  // 数字引用交给 shared/entities.ts（越界不抛异常）；命名实体表保持小写查表——
  // 这里做的是「XML → 纯文本」，`&nbsp;` 当普通空格比塞一个 U+00A0 更好用
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    const numeric = decodeNumericEntity(body)
    if (numeric !== null) return numeric
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * 把一段 XML 抽成文本：只保留标签之间的文字，并按**块级边界**换行。
 *
 * `blocks` 里给的标签（只写开头，如 `</w:p>`）会在去标签前替换成换行，
 * 这样段落与表格行的边界不会糊成一坨。
 */
export function xmlToPlainText(xml: string, blocks: string[] = []): string {
  let body = xml
  for (const tag of blocks) body = body.split(tag).join('\n')
  return decodeXmlEntities(body.replace(/<[^>]*>/g, ''))
}

/** Word：段落与表格行都要换行，制表符保留（表格列不会粘在一起） */
export function extractDocxText(files: Record<string, string>): string {
  const parts: string[] = []
  for (const name of ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']) {
    const xml = files[name]
    if (typeof xml !== 'string' || xml.length === 0) continue
    parts.push(
      xmlToPlainText(xml, ['</w:p>', '</w:tr>', '</w:tc>', '<w:tab/>', '<w:br/>', '<w:cr/>'])
    )
  }
  return parts.join('\n')
}

/** 取 XML 里某个标签的全部文本（表格/演示文稿抽字用） */
function textsIn(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  const out: string[] = []
  for (const match of xml.matchAll(pattern)) {
    out.push(decodeXmlEntities((match[1] ?? '').replace(/<[^>]*>/g, '')))
  }
  return out
}

function numberInName(name: string): number {
  const match = /(\d+)(?=\.[a-z]+$)/i.exec(name)
  return match ? Number.parseInt(match[1] ?? '0', 10) : 0
}

/**
 * Excel：共享字符串表 + 各工作表。
 *
 * 单元格类型：`t="s"` 是共享字符串下标、`t="inlineStr"` 是内联字符串、
 * 其余（数字/日期/公式结果）直接取 `<v>`。行内用制表符分隔，表格结构不至于全丢。
 */
export function extractXlsxText(files: Record<string, string>): string {
  const shared = files['xl/sharedStrings.xml']
  const sharedStrings = typeof shared === 'string' && shared.length > 0 ? textsIn(shared, 'si') : []

  const workbook = files['xl/workbook.xml']
  const sheetNames =
    typeof workbook === 'string' && workbook.length > 0
      ? [...workbook.matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((match) =>
          decodeXmlEntities(match[1] ?? '')
        )
      : []

  const sheetFiles = Object.keys(files)
    .filter((name) => name.startsWith('xl/worksheets/') && name.endsWith('.xml'))
    .sort((a, b) => numberInName(a) - numberInName(b))

  const out: string[] = []
  sheetFiles.forEach((name, sheetIndex) => {
    const xml = files[name] ?? ''
    const title = sheetNames[sheetIndex] ?? `工作表 ${sheetIndex + 1}`
    const lines: string[] = [`【${title}】`]
    for (const row of xml.matchAll(/<row(?:[^>]*)?>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = []
      for (const cell of (row[1] ?? '').matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cell[1] ?? ''
        const inner = cell[2] ?? ''
        const type = /t="([^"]*)"/.exec(attrs)?.[1] ?? ''
        if (type === 's') {
          const index = Number.parseInt(textsIn(inner, 'v')[0] ?? '', 10)
          cells.push(sharedStrings[Number.isFinite(index) ? index : -1] ?? '')
          continue
        }
        if (type === 'inlineStr') {
          cells.push(textsIn(inner, 't').join(''))
          continue
        }
        cells.push((textsIn(inner, 'v')[0] ?? '').trim())
      }
      const line = cells.join('\t').replace(/\t+$/, '')
      if (line.trim().length > 0) lines.push(line)
    }
    if (lines.length > 1) out.push(lines.join('\n'))
  })
  return out.join('\n\n')
}

/** PowerPoint：按页抽文字，页码当小标题 */
export function extractPptxText(files: Record<string, string>): string {
  const slides = Object.keys(files)
    .filter((name) => name.startsWith('ppt/slides/') && name.endsWith('.xml'))
    .sort((a, b) => numberInName(a) - numberInName(b))
  const out: string[] = []
  slides.forEach((name, index) => {
    const texts = textsIn(files[name] ?? '', 'a:t').filter((text) => text.trim().length > 0)
    if (texts.length === 0) return
    out.push([`【第 ${index + 1} 页】`, ...texts].join('\n'))
  })
  return out.join('\n\n')
}

/** 顶层入口：按类型选提取器 */
export function extractDocumentText(input: {
  kind: DocumentKind
  /** 纯文本类：解码后的正文 */
  rawText?: string
  /** zip 类：entry 名 → XML 文本 */
  files?: Record<string, string>
}): string {
  const { kind, rawText = '', files = {} } = input
  if (kind === 'text') return rawText
  if (kind === 'docx') return extractDocxText(files)
  if (kind === 'xlsx') return extractXlsxText(files)
  if (kind === 'pptx') return extractPptxText(files)
  return ''
}

/* ------------------------------------------------------------------ */
/* 清洗、统计、分段                                                    */
/* ------------------------------------------------------------------ */

/** 零宽字符：模型看不见、却会占位置，还会让分词与比对出现怪现象 */
const ZERO_WIDTH = /[\u200b-\u200f\u2028\u2029\ufeff]/g

/**
 * 清洗提取出来的文本：统一换行、去掉零宽字符与行尾空白、把连续的空白行压到一行。
 * 只做"排版层面"的清洗，**不动正文内容**——文档是给模型读的证据。
 */
export function normalizeDocumentText(text: string): string {
  return text
    .replace(ZERO_WIDTH, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function documentStats(text: string): { chars: number; lines: number } {
  const chars = text.trim().length
  const lines = text.length === 0 ? 0 : text.split('\n').length
  return { chars, lines }
}

/**
 * 长文档分段（给"分段细读 + 汇总"用）。
 *
 * 切点一律落在**行边界**上（行内从不断开）：从句子中间切断会让模型把半句话
 * 当成完整要点。单行本身就超限（没有换行的巨型文本）时才硬切，否则那段永远装不下。
 *
 * **如实执行调用方给的上限**（不偷偷放大）：上限与段数由调用方按模型上下文决定。
 * 超出 `maxChunks` 的部分**报出丢了多少字**，不静默截断。
 */
export function splitDocument(
  text: string,
  maxChars: number,
  maxChunks: number
): { chunks: string[]; droppedChars: number } {
  const limit = Math.max(1, Math.floor(maxChars))
  const chunkLimit = Math.max(1, Math.floor(maxChunks))
  const lines = text.split('\n')
  const chunks: string[] = []
  let current: string[] = []
  let currentLength = 0
  let consumed = 0

  const flush = (): void => {
    if (current.length === 0) return
    const piece = current.join('\n').trim()
    if (piece.length > 0) chunks.push(piece)
    current = []
    currentLength = 0
  }

  for (const line of lines) {
    // 单行就超限（没有换行的巨型文本）：硬切，别让它永远装不下
    if (line.length > limit) {
      flush()
      for (let at = 0; at < line.length; at += limit) {
        const piece = line.slice(at, at + limit)
        if (chunks.length >= chunkLimit) {
          consumed += piece.length
          continue
        }
        chunks.push(piece)
      }
      continue
    }
    if (currentLength + line.length + 1 > limit) flush()
    current.push(line)
    currentLength += line.length + 1
  }
  flush()

  if (chunks.length <= chunkLimit) return { chunks, droppedChars: 0 }
  const kept = chunks.slice(0, chunkLimit)
  const dropped = chunks.slice(chunkLimit).join('\n').length
  return { chunks: kept, droppedChars: dropped + consumed }
}

/**
 * 把 `file://` URL 还原成本机路径；不是 file URL 就返回 null。
 *
 * 拖文件进窗口走的是 Chromium 的 `will-navigate`，给过来的就是这个 URL。
 * 三种情形必须分开处理（以前只做了第一种，第二、三种都是错的）：
 *
 * 1. Windows 盘符 `file:///D:/a.xmind` → pathname `/D:/a.xmind`，砍掉开头斜杠得到 `D:/a.xmind`；
 * 2. **UNC 共享盘** `file://server/share/a.xmind` → 主机名在 `host`、pathname 只有
 *    `/share/a.xmind`。必须拼回 `\\server\share\a.xmind`：以前同样只取 pathname 再砍斜杠，
 *    得到的是相对路径 `share/a.xmind`，被当非法路径丢掉——用户看到"拖共享盘上的文件没反应"；
 * 3. POSIX `file:///home/u/a.xmind` → 砍掉开头斜杠就毁了绝对路径，**只有盘符形式才该砍**。
 */
export function pathFromFileUrl(url: string): string | null {
  if (!url.startsWith('file://')) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'file:') return null
  const pathname = decodeURIComponent(parsed.pathname)
  if (pathname.length === 0) return null
  const host = parsed.hostname
  if (host.length > 0) return `\\\\${host}${pathname.replace(/\//g, '\\')}`
  const stripped = pathname.replace(/^\//, '')
  // `file://` 这种没有真实路径的（pathname 只有 `/`）当作无效：返回根目录没有意义
  if (stripped.length === 0) return null
  return /^[A-Za-z]:[\\/]/.test(stripped) ? stripped : pathname
}
