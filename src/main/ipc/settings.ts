import { ipcMain } from 'electron'
import { writeJsonAtomic } from '../atomic-write'
import { promises as fs } from 'node:fs'
import { DEFAULT_APP_SETTINGS, IPC, type AppSettings } from '@shared/ipc'

import { normalizeConfirmSkip } from '@shared/agent'

import { CODE_LANGUAGES } from '@shared/code-language'

import { settingsFile } from '../ai'

/**
 * 这些处理器原来都在 `main/index.ts` 的 `registerIpc()` 里，整块搬来：
 * 函数体、先后顺序、通道名逐字未改（搬迁只做剪切粘贴）。
 *
 * 这一域不需要任何共享状态（设置直接读写 `settings.json`），所以不收 `ctx`——
 * 签名如实反映依赖，比为了整齐而收一个用不上的参数更清楚。
 */
export function registerSettingsIpc(): void {
  ipcMain.handle(IPC.settingsLoad, async (): Promise<AppSettings> => {
    try {
      const raw = await fs.readFile(settingsFile(), 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      // 与默认值合并：文件缺字段 / 老版本写过的都还能读
      return {
        defaultViewLock:
          typeof parsed.defaultViewLock === 'boolean'
            ? parsed.defaultViewLock
            : DEFAULT_APP_SETTINGS.defaultViewLock,
        defaultThemeId:
          typeof parsed.defaultThemeId === 'string' && parsed.defaultThemeId.length > 0
            ? parsed.defaultThemeId
            : null,
        defaultAlign:
          parsed.defaultAlign === 'left' || parsed.defaultAlign === 'right'
            ? parsed.defaultAlign
            : DEFAULT_APP_SETTINGS.defaultAlign,
        defaultFontFamily:
          typeof parsed.defaultFontFamily === 'string' && parsed.defaultFontFamily.length > 0
            ? parsed.defaultFontFamily
            : null,
        defaultFontSize:
          typeof parsed.defaultFontSize === 'number' && parsed.defaultFontSize > 0
            ? parsed.defaultFontSize
            : null,
        defaultColor:
          typeof parsed.defaultColor === 'string' && parsed.defaultColor.length > 0
            ? parsed.defaultColor
            : null,
        defaultCodeFontSize:
          typeof parsed.defaultCodeFontSize === 'number' &&
          Number.isFinite(parsed.defaultCodeFontSize) &&
          parsed.defaultCodeFontSize >= 8
            ? Math.round(parsed.defaultCodeFontSize)
            : null,
        defaultCodeLanguage: CODE_LANGUAGES.includes(parsed.defaultCodeLanguage as never)
          ? (parsed.defaultCodeLanguage as string)
          : null,
        toolbarHidden: Array.isArray(parsed.toolbarHidden)
          ? parsed.toolbarHidden.filter((item): item is string => typeof item === 'string')
          : [],
        // 手改坏 / 旧版本的脏值不许把确认框永久关掉
        aiConfirmSkip: normalizeConfirmSkip(parsed.aiConfirmSkip)
      }
    } catch {
      return { ...DEFAULT_APP_SETTINGS }
    }
  })
  ipcMain.handle(IPC.settingsSave, async (_e, settings: AppSettings): Promise<void> => {
    const next: AppSettings = {
      defaultViewLock: Boolean(settings?.defaultViewLock),
      defaultThemeId:
        typeof settings?.defaultThemeId === 'string' && settings.defaultThemeId.length > 0
          ? settings.defaultThemeId
          : null,
      defaultAlign:
        settings?.defaultAlign === 'left' || settings?.defaultAlign === 'right'
          ? settings.defaultAlign
          : 'center',
      defaultFontFamily:
        typeof settings?.defaultFontFamily === 'string' && settings.defaultFontFamily.length > 0
          ? settings.defaultFontFamily
          : null,
      defaultFontSize:
        typeof settings?.defaultFontSize === 'number' && settings.defaultFontSize > 0
          ? settings.defaultFontSize
          : null,
      defaultColor:
        typeof settings?.defaultColor === 'string' && settings.defaultColor.length > 0
          ? settings.defaultColor
          : null,
      defaultCodeFontSize:
        typeof settings?.defaultCodeFontSize === 'number' &&
        Number.isFinite(settings.defaultCodeFontSize) &&
        settings.defaultCodeFontSize >= 8
          ? Math.round(settings.defaultCodeFontSize)
          : null,
      defaultCodeLanguage: CODE_LANGUAGES.includes(settings?.defaultCodeLanguage as never)
        ? (settings.defaultCodeLanguage as string)
        : null,
      toolbarHidden: Array.isArray(settings?.toolbarHidden)
        ? settings.toolbarHidden.filter((item) => typeof item === 'string')
        : [],
      // 只认清单里认识的破坏性种类：脏数据不许把确认框永久关掉
      aiConfirmSkip: normalizeConfirmSkip(settings?.aiConfirmSkip)
    }
    await writeJsonAtomic(settingsFile(), next)
  })
}
