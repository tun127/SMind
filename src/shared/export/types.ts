/**
 * 图片导出的公共定义（主进程与渲染进程共用，避免两边各写一份格式表）。
 */

export type ImageExportFormat = 'png' | 'svg' | 'pdf'
export type ExportBackground = 'theme' | 'white' | 'transparent'

export interface ImageExportFormatDef {
  id: ImageExportFormat
  label: string
  ext: string
  /** 位图才有多倍率可选 */
  scalable: boolean
  hint: string
}

export const IMAGE_EXPORT_FORMATS: ImageExportFormatDef[] = [
  { id: 'png', label: 'PNG 图片', ext: 'png', scalable: true, hint: '位图，适合发群、贴文档' },
  { id: 'svg', label: 'SVG 矢量图', ext: 'svg', scalable: false, hint: '矢量，放大不糊' },
  { id: 'pdf', label: 'PDF 文档', ext: 'pdf', scalable: true, hint: '单页 PDF，适合打印归档' }
]

export const IMAGE_EXPORT_SCALES = [1, 2, 3, 4]

export function imageExportFormatDef(format: ImageExportFormat): ImageExportFormatDef {
  const found = IMAGE_EXPORT_FORMATS.find((item) => item.id === format)
  if (!found) throw new Error(`不支持的导出格式：${format}`)
  return found
}
