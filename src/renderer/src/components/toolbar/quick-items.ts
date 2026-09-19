/**
 * 快捷栏条目的公共类型与「更多 ▾」原生条目清单（自 Toolbar.tsx 原样搬出）。
 */

import type { ReactElement, ReactNode } from 'react'

/** 快捷栏功能清单：id → 更多菜单里的展示与动作（收纳后用它渲染） */
export interface QuickItemMeta {
  label: string
  icon: ReactNode
  run(): void
}

/**
 * 「更多 ▾」菜单里**原生**的条目 id：这些项默认不在快捷栏，
 * 只有在菜单里点过「拿出到快捷栏」（toolbarHidden 里存 `show:${id}` 标记）才出现。
 * 其余 quickMeta 项（新建/保存等）默认在快捷栏，存裸 id 表示「已收进更多」。
 */
export const MENU_PINNABLE: ReadonlySet<string> = new Set([
  'new-window',
  'sheet-copy',
  'history',
  'default-view-lock',
  'shortcuts'
])

/**
 * 快捷栏按钮的统一渲染壳（pinwrap 外壳 + 更多菜单里的对应条目）。
 * 由入口组件按「收纳状态 / 收纳动作」构造后传给各组。
 */
export type QuickRender = (id: string, node: ReactNode, hint?: string) => ReactElement | null
