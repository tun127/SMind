/**
 * 主题切片（自 `editor.ts` 的「主题」分节整块搬出，成员体逐字未改）：套用内置默认主题（不写历史）、
 * 应用整套主题（写历史、且已同款时直接 return）、微调配色（`coalesceKey` 合并成一步撤销）。
 *
 * 本文件同时拥有这些成员在 `EditorState` 里的**声明**（接口逐字搬来）。
 */

import type { ThemeColors } from '@shared/model/types'

export interface ThemeSlice {
  /* ---- 主题 ---- */
  /** 应用一整套主题（会把配色写进当前画布） */
  applyTheme(theme: { id: string; name: string; colors: ThemeColors }): void
  /**
   * 把主题直接烤进当前文档，**不写撤销历史、不改「未保存」状态**。
   * 用于「新建文档时套用设置里的默认主题」：那一步是初始化而不是用户的编辑动作，
   * 走 `applyTheme`（内部是 mutate）会让新文档一建出来就顶着未保存标记。
   */
  primeTheme(theme: { id: string; name: string; colors: ThemeColors }): void
  /** 微调当前画布的配色 */
  updateThemeColors(patch: Partial<ThemeColors>, coalesceKey?: string): void
}

/** 实现（状态初值与动作）随「B1 第二步 B」的对应批次搬入；本文件此刻只有类型声明。 */
