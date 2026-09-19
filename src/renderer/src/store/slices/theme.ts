/**
 * 主题切片（自 `editor.ts` 的「主题」分节整块搬出，成员体逐字未改）：套用内置默认主题（不写历史）、
 * 应用整套主题（写历史、且已同款时直接 return）、微调配色（`coalesceKey` 合并成一步撤销）。
 *
 * 本文件同时拥有这些成员在 `EditorState` 里的**声明**（接口逐字搬来）。
 */
import { produce } from 'immer'

import type { ThemeColors } from '@shared/model/types'

import { DEFAULT_THEME } from '@shared/theme'

import type { StateCreator } from 'zustand'
import type { EditorState } from './types'

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

export const createThemeSlice: StateCreator<EditorState, [], [], ThemeSlice> = (set, get) => ({
  /* ------------------------------------------------------------------ */
  /* 主题                                                                */
  /* ------------------------------------------------------------------ */

  primeTheme: (theme) => {
    set((state) => ({
      workbook: produce(state.workbook, (draft) => {
        for (const sheet of draft.sheets) {
          // 把配色「烤」进文档，与 applyTheme 保持同一套写法
          sheet.theme = {
            ...(sheet.theme ?? {}),
            id: theme.id,
            name: theme.name,
            colors: { ...theme.colors, branches: [...theme.colors.branches] }
          }
        }
      })
    }))
  },

  applyTheme: (theme) => {
    const current = (() => {
      const { workbook } = get()
      return (workbook.sheets.find((s) => s.id === workbook.activeSheetId) ?? workbook.sheets[0])
        ?.theme
    })()
    // 已经是这个主题（例如启动时套用「设置」里的默认主题）就别再写一次：
    // 否则新建文档一上来就被记成"有未保存改动"，标题栏立刻出现 ●
    if (
      current &&
      current.id === theme.id &&
      JSON.stringify(current.colors) === JSON.stringify(theme.colors)
    ) {
      return
    }
    get().mutate((draft) => {
      const sheet = draft.sheets.find((s) => s.id === draft.activeSheetId) ?? draft.sheets[0]
      if (!sheet) return
      // 把配色「烤」进文档，内置主题日后调整也不会改变老文件的样子
      sheet.theme = {
        ...(sheet.theme ?? {}),
        id: theme.id,
        name: theme.name,
        colors: { ...theme.colors, branches: [...theme.colors.branches] }
      }
    }, '应用主题')
  },

  updateThemeColors: (patch, coalesceKey) => {
    get().mutate(
      (draft) => {
        const sheet = draft.sheets.find((s) => s.id === draft.activeSheetId) ?? draft.sheets[0]
        if (!sheet) return
        const current = sheet.theme?.colors ?? DEFAULT_THEME.colors
        sheet.theme = {
          ...(sheet.theme ?? {}),
          id: sheet.theme?.id ?? 'custom',
          name: sheet.theme?.name ?? DEFAULT_THEME.name,
          colors: {
            ...current,
            ...patch,
            branches: patch.branches ? [...patch.branches] : [...current.branches]
          }
        }
      },
      '调整主题',
      coalesceKey
    )
  }
})
