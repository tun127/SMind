/**
 * 绘图指令 → Canvas 2D 位图（PNG 与 PDF 共用）。
 *
 * 与 svg.ts 消费同一份指令，所以矢量版与位图版的排版完全一致。
 * 这里的字体、行宽测量与画布测量用同一套字体栈，导出的文字不会跑位。
 */

import { FONT_FAMILY } from '../render/measure'
import { HIGHLIGHT_BG } from '@shared/richtext'
import type { Drawing, DrawOp, LineTextOp } from './drawing'

/** 统一的字体串：粗斜体 + 字号 + 字体栈 */
function fontOf(size: number, weight: number, italic = false, family?: string): string {
  return `${italic ? 'italic ' : ''}${weight} ${size}px ${family ?? FONT_FAMILY}`
}

/** 预先解码所有位图（图片与公式位图），避免边画边等 */
async function loadImages(hrefs: string[]): Promise<Map<string, HTMLImageElement>> {
  const map = new Map<string, HTMLImageElement>()
  await Promise.all(
    hrefs.map(
      (href) =>
        new Promise<void>((resolve) => {
          const image = new Image()
          image.onload = () => {
            map.set(href, image)
            resolve()
          }
          // 单张图失败不能拖垮整张导出
          image.onerror = () => resolve()
          image.src = href
        })
    )
  )
  return map
}

function roundRectPath(ctx: CanvasRenderingContext2D, op: Extract<DrawOp, { kind: 'rect' }>): void {
  const r = Math.max(0, Math.min(op.r, op.w / 2, op.h / 2))
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(op.x, op.y, op.w, op.h, r)
    return
  }
  // 兜底：手画圆角矩形
  ctx.moveTo(op.x + r, op.y)
  ctx.lineTo(op.x + op.w - r, op.y)
  ctx.quadraticCurveTo(op.x + op.w, op.y, op.x + op.w, op.y + r)
  ctx.lineTo(op.x + op.w, op.y + op.h - r)
  ctx.quadraticCurveTo(op.x + op.w, op.y + op.h, op.x + op.w - r, op.y + op.h)
  ctx.lineTo(op.x + r, op.y + op.h)
  ctx.quadraticCurveTo(op.x, op.y + op.h, op.x, op.y + op.h - r)
  ctx.lineTo(op.x, op.y + r)
  ctx.quadraticCurveTo(op.x, op.y, op.x + r, op.y)
  ctx.closePath()
}

function drawLineText(ctx: CanvasRenderingContext2D, op: LineTextOp): void {
  // 构建指令时已经按字符宽度算好了每段的绝对 x/宽度（画高亮底色要用），有就直接用；
  // 没有（老数据/兜底）再自己量一遍——Canvas 的 textAlign 对多段富文本不好用
  let total = 0
  for (const segment of op.segments) {
    if (typeof segment.width === 'number') {
      total += segment.width
      continue
    }
    ctx.font = fontOf(
      segment.fontSize,
      segment.weight ?? 400,
      Boolean(segment.italic),
      segment.fontFamily
    )
    total += ctx.measureText(segment.text).width
  }

  let x = op.align === 'center' ? op.x - total / 2 : op.align === 'right' ? op.x - total : op.x
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  for (const segment of op.segments) {
    const width =
      typeof segment.width === 'number'
        ? segment.width
        : ((): number => {
            ctx.font = fontOf(
              segment.fontSize,
              segment.weight ?? 400,
              Boolean(segment.italic),
              segment.fontFamily
            )
            return ctx.measureText(segment.text).width
          })()

    // 高亮底色画在文字下面
    if (segment.highlight) {
      ctx.save()
      ctx.fillStyle = HIGHLIGHT_BG
      ctx.fillRect(x - 1, op.baseline - segment.fontSize * 0.95, width + 2, segment.fontSize * 1.25)
      ctx.restore()
    }

    // 上下标：字号已经在测量里缩小过，这里只做基线偏移（画布上是 vertical-align）
    const shift =
      segment.script === 'super'
        ? -segment.fontSize * 0.35
        : segment.script === 'sub'
          ? segment.fontSize * 0.15
          : 0

    ctx.font = fontOf(
      segment.fontSize,
      segment.weight ?? 400,
      Boolean(segment.italic),
      segment.fontFamily
    )
    ctx.fillStyle = segment.color ?? op.color
    ctx.fillText(segment.text, x, op.baseline + shift)
    x += width
  }
}

function drawOp(
  ctx: CanvasRenderingContext2D,
  op: DrawOp,
  images: Map<string, HTMLImageElement>
): void {
  switch (op.kind) {
    case 'rect': {
      ctx.save()
      if (op.shadow) {
        ctx.shadowColor = 'rgba(16, 24, 40, 0.18)'
        ctx.shadowBlur = 14
        ctx.shadowOffsetY = 6
      }
      roundRectPath(ctx, op)
      if (op.fill) {
        ctx.fillStyle = op.fill
        ctx.fill()
      }
      ctx.restore()

      if (op.stroke) {
        roundRectPath(ctx, op)
        ctx.strokeStyle = op.stroke
        ctx.lineWidth = op.strokeWidth ?? 1
        ctx.stroke()
      }
      return
    }

    case 'path': {
      ctx.save()
      if (op.fill) {
        ctx.fillStyle = op.fill
        ctx.globalAlpha = op.fillOpacity ?? 1
        ctx.fill(new Path2D(op.d), op.fillRule === 'evenodd' ? 'evenodd' : 'nonzero')
      }
      if (op.stroke) {
        ctx.globalAlpha = op.strokeOpacity ?? op.opacity ?? 1
        ctx.strokeStyle = op.stroke
        ctx.lineWidth = op.strokeWidth ?? 1
        ctx.lineCap = op.cap === 'butt' ? 'butt' : 'round'
        ctx.lineJoin = 'round'
        if (op.dash) ctx.setLineDash([6, 5])
        ctx.stroke(new Path2D(op.d))
      }
      ctx.restore()
      return
    }

    case 'text': {
      ctx.save()
      ctx.font = fontOf(op.fontSize, op.fontWeight, Boolean(op.italic), op.fontFamily)
      ctx.textAlign = op.anchor === 'middle' ? 'center' : op.anchor === 'end' ? 'right' : 'left'
      ctx.textBaseline = op.baseline === 'middle' ? 'middle' : 'alphabetic'
      // 描边先画（等价于 SVG 的 paint-order: stroke），文字压在别的内容上也读得清
      if (op.stroke) {
        ctx.strokeStyle = op.stroke
        ctx.lineWidth = op.strokeWidth ?? 4
        ctx.lineJoin = 'round'
        ctx.strokeText(op.text, op.x, op.y)
      }
      ctx.fillStyle = op.fill
      ctx.fillText(op.text, op.x, op.y)
      ctx.restore()
      return
    }

    case 'lineText':
      ctx.save()
      drawLineText(ctx, op)
      ctx.restore()
      return

    case 'image':
    case 'formula': {
      const href = op.kind === 'image' ? op.href : op.href
      const image = href ? images.get(href) : undefined
      if (image) {
        ctx.drawImage(image, op.x, op.y, op.w, op.h)
        return
      }
      if (op.kind === 'formula') {
        // 没拿到公式位图时退化成源码
        ctx.save()
        ctx.font = fontOf(Math.max(10, op.fontSize - 2), 400, false, 'Consolas, monospace')
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = op.color
        ctx.fillText(op.fallbackText, op.x + op.w / 2, op.y + op.h / 2)
        ctx.restore()
      }
      return
    }

    case 'badge': {
      const radius = op.size / 2
      ctx.save()
      ctx.beginPath()
      ctx.arc(op.x + radius, op.y + radius, radius, 0, Math.PI * 2)
      ctx.fillStyle = op.color
      ctx.fill()
      ctx.font = fontOf(op.fontSize, 700)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#ffffff'
      ctx.fillText(op.text, op.x + radius, op.y + radius + 0.5)
      ctx.restore()
      return
    }

    case 'pie': {
      const radius = op.size / 2 - 1
      const center = op.size / 2
      const cx = op.x + center
      const cy = op.y + center
      const clamped = Math.max(0, Math.min(1, op.ratio))

      ctx.save()
      ctx.beginPath()
      ctx.arc(cx, cy, radius, 0, Math.PI * 2)
      ctx.strokeStyle = op.color
      ctx.globalAlpha = 0.45
      ctx.lineWidth = 1.5
      ctx.stroke()

      if (clamped > 0) {
        ctx.globalAlpha = 1
        ctx.beginPath()
        const start = -Math.PI / 2
        ctx.moveTo(cx, cy)
        ctx.arc(cx, cy, radius, start, start + clamped * Math.PI * 2)
        ctx.closePath()
        ctx.fillStyle = op.color
        ctx.fill()
      }
      ctx.restore()
      return
    }

    case 'glyph': {
      const cx = op.x + op.size / 2
      const cy = op.y + op.size / 2
      const r = op.size / 2
      ctx.save()
      ctx.fillStyle = op.color
      if (op.glyph === 'star') {
        ctx.beginPath()
        for (let i = 0; i < 10; i += 1) {
          const radius = i % 2 === 0 ? r : r * 0.45
          const angle = -Math.PI / 2 + (i * Math.PI) / 5
          const px = cx + radius * Math.cos(angle)
          const py = cy + radius * Math.sin(angle)
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
        ctx.closePath()
        ctx.fill()
      } else if (op.glyph === 'flag') {
        ctx.beginPath()
        ctx.moveTo(op.x + 3, op.y + 1)
        ctx.lineTo(op.x + op.size - 2, op.y + op.size * 0.35)
        ctx.lineTo(op.x + 3, op.y + op.size * 0.68)
        ctx.closePath()
        ctx.fill()
      } else {
        ctx.beginPath()
        ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
      return
    }

    default:
      return
  }
}

/** 把指令渲染到离屏 Canvas；scale 是像素倍率（2 表示 2 倍高清） */
export async function renderDrawing(drawing: Drawing, scale: number): Promise<HTMLCanvasElement> {
  const safeScale = Math.max(0.5, Math.min(6, scale))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(drawing.width * safeScale))
  canvas.height = Math.max(1, Math.ceil(drawing.height * safeScale))

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前环境不支持 Canvas 2D，无法导出位图')

  // 位图模式下背景必须有个底色，否则透明区域在 PNG 里是黑的
  ctx.fillStyle = drawing.background ?? '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.scale(safeScale, safeScale)

  const hrefs: string[] = []
  for (const op of drawing.ops) {
    if (op.kind === 'image') hrefs.push(op.href)
    else if (op.kind === 'formula' && op.href) hrefs.push(op.href)
  }
  const images = await loadImages(Array.from(new Set(hrefs)))

  for (const op of drawing.ops) drawOp(ctx, op, images)
  return canvas
}

/** Canvas → PNG 字节 */
export async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('PNG 编码失败')
  return new Uint8Array(await blob.arrayBuffer())
}

/** Canvas → RGB 原始像素（PDF 用；透明区域按白底合成） */
export function canvasToRgbBytes(canvas: HTMLCanvasElement): Uint8Array {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前环境不支持 Canvas 2D')
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const out = new Uint8Array(canvas.width * canvas.height * 3)

  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    // 取不到就按"不透明黑"处理：这只会在缓冲区长度异常时发生，
    // 比让 undefined 参与算术、把整张图算成 NaN 要好
    const alpha = (data[i + 3] ?? 255) / 255
    out[j] = Math.round((data[i] ?? 0) * alpha + 255 * (1 - alpha))
    out[j + 1] = Math.round((data[i + 1] ?? 0) * alpha + 255 * (1 - alpha))
    out[j + 2] = Math.round((data[i + 2] ?? 0) * alpha + 255 * (1 - alpha))
  }
  return out
}

/** 用浏览器自带的 CompressionStream 做 zlib/deflate 压缩（PDF 的图像流需要） */
export async function deflateBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate')
  const writer = stream.writable.getWriter()
  // 复制成一个独立的 ArrayBuffer，避免 SharedArrayBuffer 类型不匹配
  const payload = new Uint8Array(bytes.length)
  payload.set(bytes)
  void writer.write(payload)
  void writer.close()
  const buffer = await new Response(stream.readable).arrayBuffer()
  return new Uint8Array(buffer)
}
