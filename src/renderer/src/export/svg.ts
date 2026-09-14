/**
 * 绘图指令 → 矢量 SVG。
 *
 * 纯字符串拼接，不依赖 DOM，所以可以在自检里直接比对输出。
 * 特殊字符一律转义；字体用系统字体名（导出后在任何机器上都能正常显示中文）。
 */

import { FONT_FAMILY } from '../render/measure'
import type { Drawing, DrawOp } from './drawing'

const FONT_STACK = `${FONT_FAMILY.replace(/"/g, "'")}`

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;')
}

function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
}

function attrs(pairs: Array<[string, string | number | undefined]>): string {
  const parts: string[] = []
  for (const [key, value] of pairs) {
    if (value === undefined || value === '') continue
    parts.push(`${key}="${typeof value === 'number' ? num(value) : escapeAttr(value)}"`)
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
      const paint = op.stroke ? ` stroke="${escapeAttr(op.stroke)}" stroke-width="${num(op.strokeWidth ?? 4)}" paint-order="stroke" stroke-linejoin="round"` : ''
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
      ])}${paint}>${escapeText(op.text)}</text>`
    }

    case 'lineText': {
      const tspans = op.segments
        .map(
          (segment) =>
            `<tspan${attrs([
              ['font-size', segment.fontSize],
              ['font-weight', segment.weight ?? 400],
              ['font-style', segment.italic ? 'italic' : undefined],
              ['fill', segment.color ?? op.color],
              ['text-decoration', segment.underline || segment.strike ? 'underline' : undefined]
            ])}>${escapeText(segment.text)}</tspan>`
        )
        .join('')
      return `<text${attrs([
        ['x', op.x],
        ['y', op.baseline],
        ['font-family', FONT_STACK],
        ['text-anchor', op.align === 'center' ? 'middle' : op.align === 'right' ? 'end' : 'start'],
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
      ])}>${escapeText(op.fallbackText)}</text>`
    }

    case 'badge': {
      const radius = op.size / 2
      const cx = op.x + radius
      const cy = op.y + radius
      return (
        `<circle${attrs([['cx', cx], ['cy', cy], ['r', radius], ['fill', op.color]])}/>` +
        `<text${attrs([
          ['x', cx],
          ['y', cy],
          ['font-family', FONT_STACK],
          ['font-size', op.fontSize],
          ['font-weight', 700],
          ['fill', '#ffffff'],
          ['text-anchor', 'middle'],
          ['dominant-baseline', 'middle']
        ])}>${escapeText(op.text)}</text>`
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
      return circle + `<path d="${escapeAttr(d)}" fill="${escapeAttr(op.color)}"/>`
    }

    case 'glyph': {
      const cx = op.x + op.size / 2
      const cy = op.y + op.size / 2
      const r = op.size / 2
      if (op.glyph === 'star') {
        // 五角星：按外/内半径交替取十个点
        const points: string[] = []
        for (let i = 0; i < 10; i += 1) {
          const radius = i % 2 === 0 ? r : r * 0.45
          const angle = -Math.PI / 2 + (i * Math.PI) / 5
          points.push(`${num(cx + radius * Math.cos(angle))},${num(cy + radius * Math.sin(angle))}`)
        }
        return `<polygon points="${points.join(' ')}" fill="${escapeAttr(op.color)}"/>`
      }
      if (op.glyph === 'flag') {
        return `<path${attrs([
          [
            'd',
            `M ${num(op.x + 3)} ${num(op.y + 1)} L ${num(op.x + op.size - 2)} ${num(op.y + op.size * 0.35)} L ${num(op.x + 3)} ${num(op.y + op.size * 0.68)} Z`
          ],
          ['fill', op.color]
        ])}/>`
      }
      // 其它图形（笑脸/箭头/灯泡等）在导出里统一画成圆点，避免引入整套图标
      return `<circle${attrs([['cx', cx], ['cy', cy], ['r', r * 0.62], ['fill', op.color]])}/>`
    }

    default:
      return ''
  }
}

/** 生成完整的 SVG 文档 */
export function drawingToSvg(drawing: Drawing): string {
  const body = drawing.ops.map(opToSvg).filter((item) => item.length > 0).join('\n  ')
  const background =
    drawing.background === null
      ? ''
      : `\n  <rect x="0" y="0" width="${num(drawing.width)}" height="${num(drawing.height)}" fill="${escapeAttr(drawing.background)}"/>`

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
