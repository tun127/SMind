import type { ReactElement } from 'react'
import {
  Angry,
  ArrowDown,
  ArrowUp,
  Award,
  CircleDollarSign,
  CircleHelp,
  Crown,
  Flag,
  Frown,
  Image,
  Laugh,
  Lightbulb,
  Link,
  Minus,
  Paperclip,
  Plus,
  Sigma,
  Smile,
  Star,
  StickyNote,
  TriangleAlert,
  Users,
  type LucideIcon
} from 'lucide-react'
import type { AccessoryItem } from '@shared/layout/types'
import { INDICATOR_STROKE_WIDTH, MARKER_STROKE_WIDTH } from '@shared/marker-art'
import { markerVisualOf, type MarkerGlyph } from '../render/markers'

/** 图形名 -> 图标组件。纯映射，判断逻辑都在 markers.ts 里 */
const GLYPH_ICONS: Record<MarkerGlyph, LucideIcon> = {
  star: Star,
  flag: Flag,
  smile: Smile,
  laugh: Laugh,
  angry: Angry,
  frown: Frown,
  plus: Plus,
  minus: Minus,
  question: CircleHelp,
  exclam: TriangleAlert,
  'arrow-up': ArrowUp,
  'arrow-down': ArrowDown,
  people: Users,
  'light-bulb': Lightbulb,
  crown: Crown,
  finance: CircleDollarSign,
  award: Award
}

/** 优先级：带数字的圆形徽标 */
function PriorityBadge({
  text,
  color,
  label,
  size
}: {
  text: string
  color: string
  label: string
  size: number
}): ReactElement {
  return (
    <span
      className="marker-badge"
      title={label}
      style={{ background: color, width: size, height: size, fontSize: Math.round(size * 0.62) }}
    >
      {text}
    </span>
  )
}

/** 任务进度：饼形，从 12 点方向顺时针填充 */
function ProgressBadge({
  ratio,
  color,
  label,
  size
}: {
  ratio: number
  color: string
  label: string
  size: number
}): ReactElement {
  const clamped = Math.max(0, Math.min(1, ratio))
  const radius = size / 2 - 1
  const center = size / 2

  let filled = ''
  if (clamped >= 1) {
    // 整圆用两段半弧拼，避免起止点重合导致渲染异常
    filled = `M ${center} ${center - radius} A ${radius} ${radius} 0 1 1 ${center} ${center + radius} A ${radius} ${radius} 0 1 1 ${center} ${center - radius} Z`
  } else if (clamped > 0) {
    const angle = clamped * Math.PI * 2 - Math.PI / 2
    const x = center + radius * Math.cos(angle)
    const y = center + radius * Math.sin(angle)
    const largeArc = clamped > 0.5 ? 1 : 0
    filled = `M ${center} ${center} L ${center} ${center - radius} A ${radius} ${radius} 0 ${largeArc} 1 ${x} ${y} Z`
  }

  return (
    <svg
      className="marker-progress"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
    >
      <title>{label}</title>
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        opacity={0.45}
      />
      {filled ? <path d={filled} fill={color} /> : null}
    </svg>
  )
}

/** 标记图标 */
export default function MarkerIcon({
  markerId,
  size = 16
}: {
  markerId: string
  size?: number
}): ReactElement {
  const visual = markerVisualOf(markerId)

  if (visual.kind === 'priority') {
    return (
      <PriorityBadge text={visual.text} color={visual.color} label={visual.label} size={size} />
    )
  }
  if (visual.kind === 'progress') {
    return (
      <ProgressBadge ratio={visual.ratio} color={visual.color} label={visual.label} size={size} />
    )
  }

  const Icon = GLYPH_ICONS[visual.glyph]
  return (
    <span
      className="marker-icon"
      title={visual.label}
      style={{ color: visual.color, width: size, height: size }}
    >
      <Icon size={size} strokeWidth={MARKER_STROKE_WIDTH} />
    </span>
  )
}

const INDICATOR_ICONS = {
  notes: StickyNote,
  link: Link,
  attachment: Paperclip,
  formula: Sigma,
  image: Image
} as const

const INDICATOR_TITLES: Record<keyof typeof INDICATOR_ICONS, string> = {
  notes: '有备注',
  link: '有超链接',
  attachment: '有附件',
  formula: '有公式',
  image: '有图片'
}

/** 「有备注 / 有超链接 / 有附件 / 有公式 / 有图片」的指示图标 */
export function IndicatorIcon({
  kind,
  size = 16
}: {
  kind: AccessoryItem['kind']
  size?: number
}): ReactElement | null {
  if (kind === 'marker') return null
  const Icon = INDICATOR_ICONS[kind]
  if (!Icon) return null
  return (
    <span
      className="topic__indicator"
      title={INDICATOR_TITLES[kind]}
      style={{ width: size, height: size }}
    >
      <Icon size={size} strokeWidth={INDICATOR_STROKE_WIDTH} />
    </span>
  )
}
