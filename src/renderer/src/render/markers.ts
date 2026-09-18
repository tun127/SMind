import { MARKER_LABELS } from '@shared/xmind/constants'

/**
 * 标记图标可用的图形名。
 * 这里刻意不直接引用图标组件：保持本模块是纯函数，
 * 可以被自检脚本直接覆盖（没有 DOM 也能跑）。
 */
export type MarkerGlyph =
  | 'star'
  | 'flag'
  | 'smile'
  | 'laugh'
  | 'angry'
  | 'frown'
  | 'plus'
  | 'minus'
  | 'question'
  | 'exclam'
  | 'arrow-up'
  | 'arrow-down'
  | 'people'
  | 'light-bulb'
  | 'crown'
  | 'finance'
  | 'award'

/**
 * 标记的表现形式。
 * 优先级用数字徽标、任务进度用饼形，其余用图标——这是贴近 Xmind 观感的关键。
 */
export type MarkerVisual =
  | { kind: 'priority'; text: string; color: string; label: string }
  | { kind: 'progress'; ratio: number; color: string; label: string }
  | { kind: 'glyph'; glyph: MarkerGlyph; color: string; label: string }

const NEUTRAL = '#8b93a1'

const PRIORITY_COLORS = ['#EB5757', '#F2994A', '#E2B93B', '#2D9CDB', '#8b93a1']

const COLOR_WORDS: Record<string, string> = {
  red: '#EB5757',
  orange: '#F2994A',
  yellow: '#E2B93B',
  green: '#27AE60',
  blue: '#2D9CDB',
  purple: '#9B51E0',
  grey: '#8b93a1',
  gray: '#8b93a1'
}

const TASK_RATIOS: Record<string, number> = {
  start: 0,
  oct: 0.25,
  quarter: 0.5,
  '3quar': 0.75,
  done: 1
}
const TASK_COLORS: Record<string, string> = {
  start: NEUTRAL,
  oct: '#2D9CDB',
  quarter: '#2D9CDB',
  '3quar': '#2D9CDB',
  done: '#27AE60'
}

const SYMBOL_GLYPHS: Record<string, { glyph: MarkerGlyph; color: string }> = {
  plus: { glyph: 'plus', color: '#27AE60' },
  minus: { glyph: 'minus', color: '#EB5757' },
  question: { glyph: 'question', color: '#2D9CDB' },
  exclam: { glyph: 'exclam', color: '#F2994A' }
}

const NAMED_GLYPHS: Record<string, { glyph: MarkerGlyph; color: string }> = {
  'arrow-up': { glyph: 'arrow-up', color: '#27AE60' },
  'arrow-down': { glyph: 'arrow-down', color: '#EB5757' },
  people: { glyph: 'people', color: '#2D9CDB' },
  'light-bulb': { glyph: 'light-bulb', color: '#E2B93B' },
  crown: { glyph: 'crown', color: '#E2B93B' },
  finance: { glyph: 'finance', color: '#27AE60' }
}

function labelOf(markerId: string): string {
  return MARKER_LABELS[markerId] ?? markerId
}

/**
 * 把 Xmind 的标记 id 映射成可渲染的视觉。
 * 未知标记也返回兜底图形——文件里的标记不能因为不认识就「消失」。
 */
export function markerVisualOf(markerId: string): MarkerVisual {
  if (!markerId) return { kind: 'glyph', glyph: 'award', color: NEUTRAL, label: '标记' }

  const priority = /^priority-(\d+)$/.exec(markerId)
  if (priority) {
    const value = Number(priority[1])
    const color = PRIORITY_COLORS[(value - 1) % PRIORITY_COLORS.length] ?? NEUTRAL
    return { kind: 'priority', text: String(value), color, label: labelOf(markerId) }
  }

  const task = /^task-(start|oct|quarter|3quar|done)$/.exec(markerId)
  if (task) {
    const key = task[1] ?? ''
    return {
      kind: 'progress',
      ratio: TASK_RATIOS[key] ?? 0,
      color: TASK_COLORS[key] ?? NEUTRAL,
      label: labelOf(markerId)
    }
  }

  const smiley = /^smiley-(\w+)$/.exec(markerId)
  if (smiley) {
    const mood = smiley[1]
    const glyph: MarkerGlyph =
      mood === 'laugh' ? 'laugh' : mood === 'angry' ? 'angry' : mood === 'cry' ? 'frown' : 'smile'
    const color = mood === 'angry' ? '#EB5757' : mood === 'cry' ? '#2D9CDB' : '#E2B93B'
    return { kind: 'glyph', glyph, color, label: labelOf(markerId) }
  }

  const star = /^star-(\w+)$/.exec(markerId)
  if (star) {
    return {
      kind: 'glyph',
      glyph: 'star',
      color: COLOR_WORDS[star[1] ?? ''] ?? '#E2B93B',
      label: labelOf(markerId)
    }
  }

  const flag = /^flag-(\w+)$/.exec(markerId)
  if (flag) {
    return {
      kind: 'glyph',
      glyph: 'flag',
      color: COLOR_WORDS[flag[1] ?? ''] ?? NEUTRAL,
      label: labelOf(markerId)
    }
  }

  const symbol = /^symbol-(\w+)$/.exec(markerId)
  if (symbol) {
    const hit = SYMBOL_GLYPHS[symbol[1] ?? '']
    if (hit) return { kind: 'glyph', glyph: hit.glyph, color: hit.color, label: labelOf(markerId) }
  }

  const named = NAMED_GLYPHS[markerId]
  if (named)
    return { kind: 'glyph', glyph: named.glyph, color: named.color, label: labelOf(markerId) }

  return { kind: 'glyph', glyph: 'award', color: NEUTRAL, label: labelOf(markerId) }
}

/**
 * 分组表在 `@shared/xmind/constants`：**互斥规则**（一行一个）与它同源，
 * 所以它不能只住在渲染层——渲染层的东西跑不进 node 自检，规则也就没法被钉住。
 */
