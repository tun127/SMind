import type { LayoutResult, NodeLayout } from '@shared/layout/types'
import type { ThemeColors } from '@shared/model/types'

/** #RGB / #RRGGBB 转 rgba，用于阴影等需要透明的场景；非法值原样返回 */
export function withAlpha(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '')
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((char) => char + char)
          .join('')
      : normalized
  // 必须逐字符校验：像 "bad" 这种恰好由十六进制字符组成的三位串是合法颜色
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return hex
  const r = Number.parseInt(full.slice(0, 2), 16)
  const g = Number.parseInt(full.slice(2, 4), 16)
  const b = Number.parseInt(full.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** 取节点所属一级分支的颜色，根节点返回中心主题填充色 */
export function branchColorOf(colors: ThemeColors, layout: LayoutResult, nodeId: string): string {
  const index = layout.branchIndex.get(nodeId)
  const palette = colors.branches.length > 0 ? colors.branches : [colors.rootFill]
  if (index === undefined || index < 0) return colors.rootFill
  return palette[index % palette.length]
}

export interface NodeVisual {
  /** 节点背景色，transparent 表示无背景 */
  background: string
  color: string
  borderRadius: number
  /**
   * 边框与下划线一律用 box-shadow 绘制，
   * 这样不会占用盒模型空间、挤压文字，也不会影响测量结果。
   */
  boxShadow: string
  fontWeight: number
}

export function visualFor(colors: ThemeColors, node: NodeLayout, layout: LayoutResult): NodeVisual {
  const branch = branchColorOf(colors, layout, node.id)

  if (node.depth === 0) {
    return {
      background: colors.rootFill,
      color: colors.rootText,
      borderRadius: 12,
      boxShadow: `0 8px 22px ${withAlpha(colors.rootFill, 0.28)}`,
      fontWeight: 700
    }
  }

  if (node.depth === 1) {
    return {
      background: colors.level1Fill,
      color: colors.level1Text,
      borderRadius: 9,
      boxShadow: `0 0 0 1.5px ${branch}, 0 2px 6px rgba(16, 24, 40, 0.08)`,
      fontWeight: 600
    }
  }

  return {
    background: 'transparent',
    color: colors.deepText,
    borderRadius: 4,
    boxShadow: `inset 0 -2px 0 0 ${branch}`,
    fontWeight: 500
  }
}
