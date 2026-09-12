/**
 * 导出当前画布为 PNG / SVG / PDF。
 *
 * 流程：布局（与画布同一份 measureTopic + layoutSheet）
 *   → 绘图指令（drawing.ts）
 *   → 三种后端的其中之一（SVG 字符串 / Canvas 位图 / PDF）。
 *
 * 三者的排版来自同一份布局数据，所以导出的图与屏幕上的画布一致。
 */

import { layoutSheet } from '@shared/layout'
import type { LayoutResult } from '@shared/layout/types'
import type { Topic, Workbook } from '@shared/model/types'
import { activeSheet, walk } from '@shared/model/tree'
import { defaultDocumentName } from '@shared/model/naming'
import { buildImagePdf } from '@shared/export/pdf'
import {
  IMAGE_EXPORT_FORMATS,
  IMAGE_EXPORT_SCALES,
  imageExportFormatDef,
  type ExportBackground,
  type ImageExportFormat
} from '@shared/export/types'
import { measureTopic } from '../render/measure'
import { formulaHtml, formulaSize } from '../render/formula'
import { resourceUrl } from '../render/resource'
import { themeColorsOf } from '../store/editor'
import { buildDrawing } from './drawing'
import { canvasToPngBytes, canvasToRgbBytes, deflateBytes, renderDrawing } from './raster'
import { drawingToSvg } from './svg'

export type ExportFormat = ImageExportFormat

export { IMAGE_EXPORT_FORMATS as EXPORT_FORMATS, IMAGE_EXPORT_SCALES as EXPORT_SCALES, imageExportFormatDef }

export interface ExportOptions {
  format: ExportFormat
  /** 位图倍率（SVG 忽略） */
  scale: number
  background: ExportBackground
}

export interface ExportResult {
  /** 文本格式（SVG）给字符串，位图给字节 */
  data: string | Uint8Array
  fileName: string
  ext: string
}

/** 位图上限：浏览器 canvas 单边约 16384px，留点余量 */
const MAX_PIXELS = 14000

function backgroundOf(colors: { canvas: string }, choice: ExportBackground): string | null {
  if (choice === 'transparent') return null
  if (choice === 'white') return '#ffffff'
  return colors.canvas
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('资源读取失败'))
    reader.readAsDataURL(blob)
  })
}

/** 收集画布上用到的图片资源，转成 data URL（导出的文件必须自带图片） */
async function collectImages(root: Topic): Promise<Map<string, string>> {
  const paths = new Set<string>()
  walk(root, (topic) => {
    if (topic.image?.path) paths.add(topic.image.path)
  })

  const map = new Map<string, string>()
  await Promise.all(
    [...paths].map(async (path) => {
      try {
        const response = await fetch(resourceUrl(path))
        if (!response.ok) return
        map.set(path, await blobToDataUrl(await response.blob()))
      } catch {
        // 单张图片取不到就不放图，其余内容照常导出
      }
    })
  )
  return map
}

/** 把一段 SVG 字符串栅格化成 PNG data URL */
async function svgToPngDataUrl(svg: string, width: number, height: number): Promise<string> {
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('SVG 栅格化失败'))
    image.src = url
  })

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前环境不支持 Canvas 2D')
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

/**
 * 把公式栅格化成位图。
 *
 * 公式是 KaTeX 的 HTML，没法直接变成 SVG 图元，所以用 foreignObject 包一层
 * 再用浏览器栅格化；KaTeX 的 CSS 与字体在构建期已经内联进 katex-assets.ts
 * （动态 import，只有导出含公式时才加载）。任何一步失败都返回 null，
 * 调用方会退化成「画 LaTeX 源码」，不会让整次导出失败。
 */
async function rasterizeFormula(
  source: string,
  fontSize: number,
  box: { width: number; height: number },
  scale: number
): Promise<string | null> {
  try {
    const { KATEX_INLINE_CSS } = await import('./katex-assets')
    const width = Math.max(1, Math.ceil(box.width * scale))
    const height = Math.max(1, Math.ceil(box.height * scale))
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<style>${KATEX_INLINE_CSS}</style>
<foreignObject x="0" y="0" width="${width}" height="${height}">
<div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;display:flex;align-items:center;justify-content:center;font-size:${fontSize * scale}px;line-height:1;">${formulaHtml(source)}</div>
</foreignObject>
</svg>`
    return await svgToPngDataUrl(svg, width, height)
  } catch {
    return null
  }
}

/** 收集画布上用到的公式，栅格化成位图（尺寸与字号直接取布局结果，避免猜） */
async function collectFormulas(layout: LayoutResult, scale: number): Promise<Map<string, string>> {
  // 同一个公式在不同层级字号可能不同，取面积最大的那一份来栅格化，缩小使用时不会糊
  const wanted = new Map<string, { fontSize: number; width: number; height: number }>()
  for (const node of layout.nodes) {
    const source = node.topic.formula
    if (!source) continue
    const width = node.formulaBox?.width ?? formulaSize(source, node.fontSize).width
    const height = node.formulaBox?.height ?? formulaSize(source, node.fontSize).height
    const current = wanted.get(source)
    if (!current || width * height > current.width * current.height) {
      wanted.set(source, { fontSize: node.fontSize, width, height })
    }
  }

  const map = new Map<string, string>()
  for (const [source, box] of wanted) {
    const dataUrl = await rasterizeFormula(source, box.fontSize, box, scale)
    if (dataUrl) map.set(source, dataUrl)
  }
  return map
}

/** 导出当前画布 */
export async function exportActiveSheet(workbook: Workbook, options: ExportOptions): Promise<ExportResult> {
  const sheet = activeSheet(workbook)
  if (!sheet) throw new Error('当前没有可导出的画布')

  const colors = themeColorsOf(workbook)
  const layout = layoutSheet(sheet.rootTopic, measureTopic, {}, sheet)
  const background = backgroundOf(colors, options.background)

  // 超大画布自动降倍率，避免超出 canvas 尺寸上限
  const longest = Math.max(layout.bounds.width, layout.bounds.height)
  const effectiveScale = Math.max(1, Math.min(options.scale, Math.floor(MAX_PIXELS / Math.max(1, longest))))

  const images = await collectImages(sheet.rootTopic)
  const formulas = await collectFormulas(layout, effectiveScale)

  const drawing = buildDrawing({
    layout,
    colors,
    images,
    formulas,
    background
  })

  const safeName = defaultDocumentName(workbook)

  if (options.format === 'svg') {
    return { data: drawingToSvg(drawing), fileName: `${safeName}.svg`, ext: 'svg' }
  }

  const canvas = await renderDrawing(drawing, effectiveScale)

  if (options.format === 'png') {
    return { data: await canvasToPngBytes(canvas), fileName: `${safeName}.png`, ext: 'png' }
  }

  const rgb = canvasToRgbBytes(canvas)
  const compressed = await deflateBytes(rgb)
  const pdf = buildImagePdf({
    pixelWidth: canvas.width,
    pixelHeight: canvas.height,
    rgb,
    compressed,
    rasterScale: effectiveScale,
    title: safeName
  })
  return { data: pdf, fileName: `${safeName}.pdf`, ext: 'pdf' }
}
