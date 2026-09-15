/**
 * 极简 PDF 写入器（把一张位图放成一页 PDF）。
 *
 * 为什么不引 pdf-lib：PDF 的矢量能力要用它自己的绘图 API 重写一遍排版，
 * 而我们已经有「同一份布局数据画成 SVG/Canvas」的能力，所以这里只需要
 * 把栅格化结果按 PDF 规范打包，用自研的几十行代码就够，且零依赖。
 *
 * 结果是**位图 PDF**（页面上是高清位图，不是矢量图形），这一点在文档里写清楚。
 */

export interface PdfImageInput {
  /** 位图像素宽高 */
  pixelWidth: number
  pixelHeight: number
  /** RGB 原始像素（每像素 3 字节，长度必须是 pixelWidth * pixelHeight * 3） */
  rgb: Uint8Array
  /** 已经 zlib/deflate 压缩过的同一个 RGB 数据 */
  compressed: Uint8Array
  /** 栅格化倍率（页面上按 CSS 像素大小排版用） */
  rasterScale?: number
  title?: string
}

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function pad10(value: number): string {
  return value.toString().padStart(10, '0')
}

/**
 * PDF 文本串。
 * 纯 ASCII 用字面量写法；含非 ASCII（例如中文标题）时必须写成
 * UTF-16BE 的十六进制串（前面加 FEFF BOM），否则会被按单字节截断成乱码。
 */
export function pdfTextString(value: string): string {
  const ascii = value.replace(/([\\()])/g, '\\$1')
  if (/^[\x20-\x7e]*$/.test(value)) return `(${ascii})`

  let hex = 'FEFF'
  for (let i = 0; i < value.length; i += 1) {
    hex += value.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase()
  }
  return `<${hex}>`
}

/**
 * 生成单页 PDF。
 * 页面尺寸按「CSS 像素 × 0.75」换算成点（72dpi 与 96dpi 的换算），
 * 这样导出的 PDF 打印出来与屏幕上的尺寸一致。
 */
export function buildImagePdf(input: PdfImageInput): Uint8Array {
  const { pixelWidth, pixelHeight, rgb, compressed } = input
  if (pixelWidth <= 0 || pixelHeight <= 0) throw new Error('PDF：位图尺寸非法')
  if (rgb.length !== pixelWidth * pixelHeight * 3) {
    throw new Error('PDF：RGB 数据长度与尺寸不匹配')
  }

  const scale = input.rasterScale && input.rasterScale > 0 ? input.rasterScale : 1
  const pageWidth = Math.round(((pixelWidth / scale) * 0.75 + Number.EPSILON) * 100) / 100
  const pageHeight = Math.round(((pixelHeight / scale) * 0.75 + Number.EPSILON) * 100) / 100

  const objects: Array<Uint8Array | { stream: Uint8Array; header: string }> = [
    // 1 目录
    latin1('<< /Type /Catalog /Pages 2 0 R >>'),
    // 2 页面树
    latin1('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    // 3 页面
    latin1(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
        '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'
    ),
    // 4 图像 XObject
    {
      header:
        `<< /Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>`,
      stream: compressed
    },
    // 5 内容流：把图铺满整页
    {
      header: `<< /Length ${`q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`.length} >>`,
      stream: latin1(`q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`)
    },
    // 6 文档信息
    latin1(`<< /Title ${pdfTextString(input.title ?? '思维导图')} /Producer (MindMap) >>`)
  ]

  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let cursor = 0

  const push = (bytes: Uint8Array): void => {
    chunks.push(bytes)
    cursor += bytes.length
  }

  push(latin1('%PDF-1.4\n'))

  objects.forEach((object, index) => {
    offsets.push(cursor)
    const number = index + 1
    if (object instanceof Uint8Array) {
      push(latin1(`${number} 0 obj\n`))
      push(object)
      push(latin1('\nendobj\n'))
      return
    }
    push(latin1(`${number} 0 obj\n${object.header}\nstream\n`))
    push(object.stream)
    push(latin1('\nendstream\nendobj\n'))
  })

  const xrefOffset = cursor
  const xrefLines: string[] = ['xref\n', `0 ${objects.length + 1}\n`, '0000000000 65535 f \n']
  for (const offset of offsets) xrefLines.push(`${pad10(offset)} 00000 n \n`)
  push(latin1(xrefLines.join('')))

  push(
    latin1(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\n` +
        `startxref\n${xrefOffset}\n%%EOF\n`
    )
  )

  return concat(chunks)
}
