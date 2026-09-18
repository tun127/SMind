/**
 * 绘图指令 → 矢量 SVG。
 *
 * 纯字符串拼接，不依赖 DOM，所以可以在自检里直接比对输出。
 * 特殊字符一律转义；字体用系统字体名（导出后在任何机器上都能正常显示中文）。
 */

import { FONT_FAMILY } from '../render/measure'
import { HIGHLIGHT_BG } from '@shared/richtext'
import { escapeXmlAttr, escapeXmlText } from '@shared/xml-escape'
import { ICON_ART, ICON_VIEWBOX, MARKER_STROKE_WIDTH, type IconShape } from '@shared/marker-art'
import type { Drawing, DrawOp } from './drawing'

/**
 * 一块图标图元 → SVG 元素。
 *
 * 坐标都还在 lucide 的 24×24 视图盒里，缩放由外层的 `<g transform=...>` 负责——
 * 这样每个图元都不必自己换算，也不会因为四舍五入把曲线画变形。
 */
function iconShapeSvg(shape: IconShape): string {
  switch (shape.k) {
    case 'path':
      return `<path d="${escapeXmlAttr(shape.d)}"/>`
    case 'circle':
      return `<circle${attrs([
        ['cx', shape.cx],
        ['cy', shape.cy],
        ['r', shape.r]
      ])}/>`
    case 'line':
      return `<line${attrs([
        ['x1', shape.x1],
        ['y1', shape.y1],
        ['x2', shape.x2],
        ['y2', shape.y2]
      ])}/>`
    case 'polyline':
      return `<polyline points="${escapeXmlAttr(shape.points)}"/>`
    case 'polygon':
      return `<polygon points="${escapeXmlAttr(shape.points)}"/>`
    default:
      return `<rect${attrs([
        ['x', shape.x],
        ['y', shape.y],
        ['width', shape.w],
        ['height', shape.h],
        ['rx', shape.rx]
      ])}/>`
  }
}

const FONT_STACK = `${FONT_FAMILY.replace(/"/g, "'")}`

function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
}

function attrs(pairs: Array<[string, string | number | undefined]>): string {
  const parts: string[] = []
  for (const [key, value] of pairs) {
    if (value === undefined || value === '') continue
    parts.push(`${key}="${typeof value === 'number' ? num(value) : escapeXmlAttr(value)}"`)
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

function opToSvg(op: DrawOp): string {
  switch (op.kind) {
    case 'rect': {
      const shadow = op.shadow ? ' filter="url(#node-shadow)"' : ''
      return `<rect${attrs([
        ['x', op.x],
        ['y', op.y],
        ['width', op.w],
        ['height', op.h],
        ['rx', op.r],
        ['fill', op.fill ?? 'none'],
        ['stroke', op.stroke],
        ['stroke-width', op.strokeWidth]
      ])}${shadow}/>`
    }

    case 'path':
      return `<path${attrs([
        ['d', op.d],
        ['fill', op.fill ?? 'none'],
        ['stroke', op.stroke],
        ['stroke-width', op.strokeWidth],
        ['stroke-linecap', op.stroke ? (op.cap ?? 'round') : undefined],
        ['stroke-linejoin', op.stroke ? 'round' : undefined],
        ['opacity', op.opacity],
        ['stroke-opacity', op.strokeOpacity],
        ['fill-opacity', op.fillOpacity],
        ['stroke-dasharray', op.dash],
        ['fill-rule', op.fillRule]
      ])}/>`

    case 'text': {
      const paint = op.stroke
        ? ` stroke="${escapeXmlAttr(op.stroke)}" stroke-width="${num(op.strokeWidth ?? 4)}" paint-order="stroke" stroke-linejoin="round"`
        : ''
      return `<text${attrs([
        ['x', op.x],
        ['y', op.y],
        ['font-family', op.fontFamily ?? FONT_STACK],
        ['font-size', op.fontSize],
        ['font-weight', op.fontWeight],
        ['font-style', op.italic ? 'italic' : undefined],
        ['fill', op.fill],
        ['text-anchor', op.anchor],
        ['dominant-baseline', op.baseline === 'middle' ? 'middle' : 'auto']
      ])}${paint}>${escapeXmlText(op.text)}</text>`
    }

    case 'lineText': {
      // 每段都带绝对 x（位置在构建指令时按字符宽度算好），所以父级用 start 对齐；
      // 这样高亮矩形的坐标与文字严格对齐，不依赖浏览器的分段排版
      const tspans = op.segments
        .map(
          (segment) =>
            `<tspan${attrs([
              ['x', segment.x],
              ['font-size', segment.fontSize],
              ['font-weight', segment.weight ?? 400],
              ['font-style', segment.italic ? 'italic' : undefined],
              // 上下标交给 SVG 自己偏移（baseline-shift 不会影响后续 tspan 的基线）
              [
                'baseline-shift',
                segment.script === 'super' ? 'super' : segment.script === 'sub' ? 'sub' : undefined
              ],
              ['fill', segment.color ?? op.color],
              ['text-decoration', segment.underline || segment.strike ? 'underline' : undefined]
            ])}>${escapeXmlText(segment.text)}</tspan>`
        )
        .join('')
      // 高亮底色：先铺矩形再画文字
      const highlights = op.segments
        .filter((segment) => segment.highlight && typeof segment.width === 'number')
        .map(
          (segment) =>
            `<rect${attrs([
              ['x', segment.x],
              ['y', op.baseline - segment.fontSize * 0.95],
              ['width', segment.width],
              ['height', segment.fontSize * 1.25],
              ['rx', 2],
              ['fill', HIGHLIGHT_BG]
            ])}/>`
        )
        .join('')
      return `${highlights}<text${attrs([
        ['x', op.x],
        ['y', op.baseline],
        ['font-family', FONT_STACK],
        ['text-anchor', 'start'],
        ['xml:space', 'preserve']
      ])}>${tspans}</text>`
    }

    case 'image':
      return `<image${attrs([
        ['x', op.x],
        ['y', op.y],
        ['width', op.w],
        ['height', op.h],
        ['href', op.href],
        ['preserveAspectRatio', 'xMidYMid meet']
      ])}/>`

    case 'formula': {
      if (op.href) {
        return `<image${attrs([
          ['x', op.x],
          ['y', op.y],
          ['width', op.w],
          ['height', op.h],
          ['href', op.href],
          ['preserveAspectRatio', 'xMidYMid meet']
        ])}/>`
      }
      // 拿不到公式位图时退化成源码，至少不丢信息
      return `<text${attrs([
        ['x', op.x],
        ['y', op.y + op.h / 2],
        ['font-family', 'Consolas, monospace'],
        ['font-size', Math.max(10, op.fontSize - 2)],
        ['fill', op.color],
        ['dominant-baseline', 'middle']
      ])}>${escapeXmlText(op.fallbackText)}</text>`
    }

    case 'badge': {
      const radius = op.size / 2
      const cx = op.x + radius
      const cy = op.y + radius
      return (
        `<circle${attrs([
          ['cx', cx],
          ['cy', cy],
          ['r', radius],
          ['fill', op.color]
        ])}/>` +
        `<text${attrs([
          ['x', cx],
          ['y', cy],
          ['font-family', FONT_STACK],
          ['font-size', op.fontSize],
          ['font-weight', 700],
          ['fill', '#ffffff'],
          ['text-anchor', 'middle'],
          ['dominant-baseline', 'middle']
        ])}>${escapeXmlText(op.text)}</text>`
      )
    }

    case 'pie': {
      const radius = op.size / 2 - 1
      const center = op.size / 2
      const clamped = Math.max(0, Math.min(1, op.ratio))
      const cx = op.x + center
      const cy = op.y + center
      const circle = `<circle${attrs([
        ['cx', cx],
        ['cy', cy],
        ['r', radius],
        ['fill', 'none'],
        ['stroke', op.color],
        ['stroke-width', 1.5],
        ['opacity', 0.45]
      ])}/>`

      if (clamped <= 0) return circle
      let d: string
      if (clamped >= 1) {
        d = `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx} ${cy + radius} A ${radius} ${radius} 0 1 1 ${cx} ${cy - radius} Z`
      } else {
        const angle = clamped * Math.PI * 2 - Math.PI / 2
        const x = cx + radius * Math.cos(angle)
        const y = cy + radius * Math.sin(angle)
        d = `M ${cx} ${cy} L ${cx} ${cy - radius} A ${radius} ${radius} 0 ${clamped > 0.5 ? 1 : 0} 1 ${num(x)} ${num(y)} Z`
      }
      return circle + `<path d="${escapeXmlAttr(d)}" fill="${escapeXmlAttr(op.color)}"/>`
    }

    case 'glyph': {
      const art = ICON_ART[op.glyph]
      /**
       * 真实图标：把 lucide 的图元按视图盒缩放到 `op.size` 后画出来。
       *
       * 以前这里只画一个同色圆点（当时的理由是"避免引入整套图标"），
       * 于是导出的图里**所有标记长得一模一样**——文件名里承认的那条遗留。
       * 现在用的是画布同一批图标（`npm run marker-art` 生成），两边形状完全一致。
       */
      if (!art) {
        const radius = op.size / 2
        return `<circle${attrs([
          ['cx', op.x + radius],
          ['cy', op.y + radius],
          ['r', radius * 0.62],
          ['fill', op.color]
        ])}/>`
      }
      const scale = op.size / ICON_VIEWBOX
      return `<g${attrs([
        ['transform', `translate(${num(op.x)} ${num(op.y)}) scale(${num(scale)})`],
        ['fill', 'none'],
        ['stroke', op.color],
        ['stroke-width', op.strokeWidth ?? MARKER_STROKE_WIDTH],
        ['stroke-linecap', 'round'],
        ['stroke-linejoin', 'round'],
        ['opacity', op.opacity]
      ])}>${art.map(iconShapeSvg).join('')}</g>`
    }

    default:
      return ''
  }
}

/** 生成完整的 SVG 文档 */
export function drawingToSvg(drawing: Drawing): string {
  const body = drawing.ops
    .map(opToSvg)
    .filter((item) => item.length > 0)
    .join('\n  ')
  const background =
    drawing.background === null
      ? ''
      : `\n  <rect x="0" y="0" width="${num(drawing.width)}" height="${num(drawing.height)}" fill="${escapeXmlAttr(drawing.background)}"/>`

  // 中心主题的投影：定义一次，按 id 复用
  const defs = `  <defs>
    <filter id="node-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#101828" flood-opacity="0.18"/>
    </filter>
  </defs>`

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${num(drawing.width)}" height="${num(drawing.height)}" viewBox="0 0 ${num(drawing.width)} ${num(drawing.height)}">
${defs}${background}
  ${body}
</svg>
`
}
