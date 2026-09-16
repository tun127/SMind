/**
 * 主题系统。
 *
 * 设计要点：
 *  1. 应用主题时会把配色「烤」进文档（与 Xmind 一致），
 *     这样即使以后内置主题改了，老文件的样子也不会变。
 *  2. 校验逻辑（normalizeThemeDefinition）是纯函数，可被自检覆盖，
 *     用于校验导入的主题文件与自定义主题。
 */
import type { Theme, ThemeColors } from '../model/types'
import { isRecord } from '../guards'

export interface ThemeDefinition {
  id: string
  name: string
  /** 是否内置主题；内置主题不可删除 */
  builtin: boolean
  colors: ThemeColors
}

const cloneColors = (colors: ThemeColors): ThemeColors => ({
  ...colors,
  branches: [...colors.branches]
})

function theme(id: string, name: string, colors: ThemeColors): ThemeDefinition {
  return { id, name, builtin: true, colors }
}

export const BUILTIN_THEMES: ThemeDefinition[] = [
  theme('builtin-blue', '默认蓝', {
    canvas: '#f7f8fa',
    grid: '#d9dce2',
    rootFill: '#2F6BFF',
    rootText: '#ffffff',
    level1Fill: '#ffffff',
    level1Text: '#1f2328',
    deepText: '#333a45',
    branches: [
      '#2F6BFF',
      '#00A38B',
      '#F2994A',
      '#EB5757',
      '#9B51E0',
      '#2D9CDB',
      '#27AE60',
      '#E2B93B'
    ],
    edgeWidth: 1.6,
    edgeOpacity: 0.85
  }),
  theme('builtin-minimal', '极简白', {
    canvas: '#ffffff',
    grid: '#eceef1',
    rootFill: '#1f2328',
    rootText: '#ffffff',
    level1Fill: '#ffffff',
    level1Text: '#1f2328',
    deepText: '#5b6472',
    branches: ['#1f2328', '#4b5563', '#6b7280', '#9ca3af', '#374151', '#111827'],
    edgeWidth: 1.2,
    edgeOpacity: 0.6
  }),
  theme('builtin-forest', '森林', {
    canvas: '#f4f8f4',
    grid: '#d6e3d6',
    rootFill: '#2E7D5B',
    rootText: '#ffffff',
    level1Fill: '#ffffff',
    level1Text: '#1f3a2e',
    deepText: '#33513f',
    branches: ['#2E7D5B', '#5AA469', '#8BC34A', '#2F8F7A', '#7CB342', '#33691E'],
    edgeWidth: 1.6,
    edgeOpacity: 0.85
  }),
  theme('builtin-sunset', '暖阳', {
    canvas: '#fdf8f3',
    grid: '#f0e2d4',
    rootFill: '#E8752B',
    rootText: '#ffffff',
    level1Fill: '#ffffff',
    level1Text: '#4a2f1a',
    deepText: '#6b4a2f',
    branches: ['#E8752B', '#F2994A', '#E2B93B', '#EB5757', '#C25E00', '#D97706'],
    edgeWidth: 1.6,
    edgeOpacity: 0.85
  }),
  theme('builtin-dark', '深色', {
    canvas: '#1f2329',
    grid: '#2e343d',
    rootFill: '#4C8DFF',
    rootText: '#ffffff',
    level1Fill: '#2a3038',
    level1Text: '#e8eaed',
    deepText: '#b9c0ca',
    branches: ['#4C8DFF', '#3ECF8E', '#F5A623', '#F16A6A', '#A78BFA', '#38BDF8'],
    edgeWidth: 1.6,
    edgeOpacity: 0.9
  }),
  theme('builtin-business', '商务', {
    canvas: '#f5f7fa',
    grid: '#dfe4ec',
    rootFill: '#1F3A5F',
    rootText: '#ffffff',
    level1Fill: '#ffffff',
    level1Text: '#1F3A5F',
    deepText: '#44546a',
    branches: ['#1F3A5F', '#2E6DA4', '#5B8DB8', '#7FA8C9', '#3D5A80', '#98A6B3'],
    edgeWidth: 1.4,
    edgeOpacity: 0.8
  })
]

// 内置主题是紧挨着的数组字面量、恒非空，所以这里断言取值而不是判空
export const DEFAULT_THEME: ThemeDefinition = BUILTIN_THEMES[0]!

export function findBuiltinTheme(id: string | undefined): ThemeDefinition | undefined {
  if (!id) return undefined
  return BUILTIN_THEMES.find((item) => item.id === id)
}

/** 取某个主题对象最终生效的配色 */
export function getThemeColors(theme: Theme | undefined): ThemeColors {
  if (theme?.colors) return theme.colors
  const builtin = findBuiltinTheme(theme?.id)
  return builtin ? builtin.colors : DEFAULT_THEME.colors
}

export function themeNameOf(theme: Theme | undefined): string {
  if (theme?.name) return theme.name
  const builtin = findBuiltinTheme(theme?.id)
  return builtin ? builtin.name : DEFAULT_THEME.name
}

/* ------------------------------------------------------------------ */
/* 校验（供导入主题、读取自定义主题使用）                              */
/* ------------------------------------------------------------------ */

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

function readColor(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && HEX_RE.test(value.trim()) ? value.trim() : undefined
}

function readNumber(
  source: Record<string, unknown>,
  key: string,
  min: number,
  max: number
): number | undefined {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, value))
}

/** 校验并补全一份配色；返回 null 表示完全不可用，返回对象表示可用（可能补了默认值） */
export function normalizeThemeColors(raw: unknown): ThemeColors | null {
  if (!isRecord(raw)) return null

  const fallback = DEFAULT_THEME.colors
  const branchesRaw = Array.isArray(raw.branches) ? raw.branches : []
  const branches = branchesRaw
    .filter((item): item is string => typeof item === 'string' && HEX_RE.test(item.trim()))
    .map((item) => item.trim())

  const colors: ThemeColors = {
    canvas: readColor(raw, 'canvas') ?? fallback.canvas,
    grid: readColor(raw, 'grid') ?? fallback.grid,
    rootFill: readColor(raw, 'rootFill') ?? fallback.rootFill,
    rootText: readColor(raw, 'rootText') ?? fallback.rootText,
    level1Fill: readColor(raw, 'level1Fill') ?? fallback.level1Fill,
    level1Text: readColor(raw, 'level1Text') ?? fallback.level1Text,
    deepText: readColor(raw, 'deepText') ?? fallback.deepText,
    branches: branches.length > 0 ? branches : [...fallback.branches],
    edgeWidth: readNumber(raw, 'edgeWidth', 0.5, 8) ?? fallback.edgeWidth,
    edgeOpacity: readNumber(raw, 'edgeOpacity', 0.1, 1) ?? fallback.edgeOpacity
  }

  // 至少要有画布/根节点/分支三类信息之一，否则视为无效文件
  const hasAnyKey = ['canvas', 'rootFill', 'level1Fill', 'deepText', 'branches'].some(
    (key) => key in raw
  )
  return hasAnyKey ? colors : null
}

/** 校验并补全一个主题定义 */
export function normalizeThemeDefinition(
  raw: unknown,
  options: { builtin?: boolean } = {}
): ThemeDefinition | null {
  if (!isRecord(raw)) return null
  const colors = normalizeThemeColors(raw.colors ?? raw)
  if (!colors) return null

  const id =
    typeof raw.id === 'string' && raw.id.trim().length > 0
      ? raw.id.trim()
      : `custom-${Date.now().toString(36)}`
  const name =
    typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : '未命名主题'

  return { id, name, builtin: options.builtin ?? raw.builtin === true, colors }
}

/** 基于某个主题复制一份（用于「另存为我的主题」） */
export function deriveCustomTheme(
  source: ThemeDefinition,
  name: string,
  id: string
): ThemeDefinition {
  return { id, name, builtin: false, colors: cloneColors(source.colors) }
}

export { cloneColors }
