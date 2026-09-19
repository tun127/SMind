import { useEffect, type RefObject } from 'react'
import { type AppSettings } from '@shared/ipc'
import { type ThemeDefinition } from '@shared/theme'
import { useEditor } from '../store/editor'

/**
 * 启动时读一次「应用设置」与「主题库」（自 App.tsx 整块搬出，effect 体逐字未改）。
 *
 * 默认参数影响新建文档、主题下拉可选项；启动这一份空白文档也按「默认主题」起手，
 * 必须等主题库读完再套，否则自定义主题还查不到。
 */

interface Deps {
  resolveTheme(id: string | null): ThemeDefinition | null
  themesRef: RefObject<ThemeDefinition[]>
  applyRenderDefaults(settings: AppSettings): void
}

export function useThemeLibrary({ resolveTheme, themesRef, applyRenderDefaults }: Deps): void {
  /* 启动时读一次应用设置与主题库：默认参数影响新建文档、主题下拉可选项 */
  useEffect(() => {
    void (async () => {
      try {
        const loaded = await window.api.settingsLoad()
        useEditor.getState().setAppSettings(loaded)
        applyRenderDefaults(loaded)
      } catch {
        /* 读不到就用内置默认值 */
      }
      try {
        themesRef.current = await window.api.themesList()
      } catch {
        themesRef.current = []
      }
      // 启动这一份空白文档也按「默认主题」起手。
      // 必须等主题库读完再套，否则自定义主题还查不到。
      const theme = resolveTheme(useEditor.getState().appSettings.defaultThemeId)
      if (theme) useEditor.getState().primeTheme(theme)
    })()
  }, [resolveTheme, themesRef, applyRenderDefaults])
}
