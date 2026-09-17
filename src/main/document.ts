/**
 * 读文档给 AI 用：拖进来的文件在这里被读成**纯文本**。
 *
 * 分工：抽取逻辑（XML → 文本、清洗、统计）在 `@shared/document` 里是纯函数，
 * 这里只管 IO 与 zip 解包——渲染进程**不碰文件系统**，字节经 IPC 送过来
 * （Electron 32+ 已经拿不到 `File.path`，传字节反而更稳）。
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import * as JSZip from 'jszip'
import {
  classifyDocument,
  documentStats,
  extractDocumentText,
  isZipDocument,
  normalizeDocumentText,
  zipEntryPrefixesFor,
  type ExtractedDocument
} from '@shared/document'

/** 原始文件上限：再大就不是"拖一份文档"了（也不该整份塞进提示词） */
const MAX_FILE_BYTES = 32 * 1024 * 1024
/** 解包后累积的文本上限：防 zip 炸弹把内存吃光 */
const MAX_UNZIP_CHARS = 48 * 1024 * 1024
/** 交给模型前的字符上限（超出部分如实告知，不静默截断） */
const MAX_DOC_CHARS = 300_000

/**
 * 解码文本：优先 UTF-8；出现替换符（说明不是 UTF-8）时试 GBK/GB18030。
 *
 * 为什么值得做：Windows 上的中文 txt / csv / 老式 ppt 导出的文本大量是 GBK，
 * 用 UTF-8 硬读会得到一片「锟斤拷」——模型拿到那种东西只会胡说。
 */
function decodeText(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8').decode(bytes)
  const brokenUtf8 = (utf8.match(/\ufffd/g) ?? []).length
  if (brokenUtf8 === 0) return utf8
  try {
    const gbk = new TextDecoder('gbk').decode(bytes)
    const brokenGbk = (gbk.match(/\ufffd/g) ?? []).length
    return brokenGbk < brokenUtf8 ? gbk : utf8
  } catch {
    // 运行时的 ICU 不带 gbk 表：只能退回 UTF-8 的结果
    return utf8
  }
}

/** 按前缀取出需要的 XML 条目（只读文本所在的那几个，不碰图片与嵌入对象） */
async function unzipTextEntries(
  bytes: Uint8Array,
  prefixes: string[]
): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(bytes)
  const names = Object.keys(zip.files).filter((name) =>
    prefixes.some((prefix) => name.startsWith(prefix))
  )
  const out: Record<string, string> = {}
  let total = 0
  for (const name of names.slice(0, 400)) {
    const entry = zip.file(name)
    if (!entry) continue
    const text = await entry.async('string')
    total += text.length
    if (total > MAX_UNZIP_CHARS) break
    out[name] = text
  }
  return out
}

/**
 * 把一份文件的字节读成可交给模型的文本。
 *
 * 不支持 / 读不出内容时**抛出人话错误**（界面直接 toast），
 * 而不是返回空字符串让用户对着"分析结果为空"发呆。
 */
export async function extractDocumentFromBytes(
  name: string,
  bytes: Uint8Array
): Promise<ExtractedDocument> {
  const cls = classifyDocument(name)
  if (cls.kind === 'pdf' || cls.kind === 'unsupported') {
    throw new Error(cls.note ?? '这个格式读不了。')
  }
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error(
      `文件太大（${Math.round(bytes.byteLength / 1024 / 1024)}MB，上限 ${MAX_FILE_BYTES / 1024 / 1024}MB）：` +
        '可以先节选出一部分再拖进来。'
    )
  }

  const raw = isZipDocument(cls.kind)
    ? await unzipTextEntries(bytes, zipEntryPrefixesFor(cls.kind))
    : {}
  const extracted = extractDocumentText(
    isZipDocument(cls.kind)
      ? { kind: cls.kind, files: raw }
      : { kind: cls.kind, rawText: decodeText(bytes) }
  )
  const text = normalizeDocumentText(extracted)

  if (text.length === 0) {
    throw new Error(
      cls.kind === 'text'
        ? '这个文件里没有可读的文字（可能是二进制文件，或编码读不出来）。'
        : `这份${cls.label}里没有抽到文字（可能是纯图片 / 扫描件 / 空文档）。`
    )
  }

  const truncated = text.length > MAX_DOC_CHARS
  return {
    name: basename(name),
    kind: cls.kind,
    label: cls.label,
    text: truncated ? text.slice(0, MAX_DOC_CHARS) : text,
    note: truncated
      ? `文档很长（${documentStats(text).chars.toLocaleString()} 字），只取了前 ${MAX_DOC_CHARS.toLocaleString()} 字。`
      : null,
    ...documentStats(truncated ? text.slice(0, MAX_DOC_CHARS) : text)
  }
}

/** 从磁盘读一份文件（「导入文档生成导图」菜单用） */
export async function extractDocumentFromPath(path: string): Promise<ExtractedDocument> {
  const bytes = await readFile(path)
  return extractDocumentFromBytes(basename(path), new Uint8Array(bytes))
}

/** 支持读取的扩展名（打开对话框的过滤器用；与 classifyDocument 保持一致） */
export const DOCUMENT_EXTENSIONS = [
  'docx',
  'xlsx',
  'pptx',
  'md',
  'markdown',
  'txt',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'xml',
  'html',
  'log',
  'tex',
  'sql'
] as const
