import { ipcMain } from 'electron'
import { isRecord } from '../../shared/guards'
import { promises as fs } from 'node:fs'
import { IPC } from '@shared/ipc'

import { normalizeThemeDefinition, type ThemeDefinition } from '@shared/theme'
import { showOpenIn, showSaveIn } from '../dialogs'
import { firstPathOf } from '../files'
import { readThemes, writeThemes } from '../themes'
import type { MainContext } from '../context'

/**
 * 这些处理器原来都在 `main/index.ts` 的 `registerIpc()` 里，整块搬来：
 * 函数体、先后顺序、通道名逐字未改（搬迁只做剪切粘贴）。
 */
export function registerThemeIpc(ctx: MainContext): void {
  ipcMain.handle(IPC.themesList, async (): Promise<ThemeDefinition[]> => readThemes())
  ipcMain.handle(IPC.themesSave, async (_e, theme: ThemeDefinition): Promise<void> => {
    const normalized = normalizeThemeDefinition(theme, { builtin: false })
    if (!normalized) return
    const list = await readThemes()
    const index = list.findIndex((item) => item.id === normalized.id)
    if (index >= 0) list[index] = normalized
    else list.push(normalized)
    await writeThemes(list)
  })
  ipcMain.handle(IPC.themesDelete, async (_e, id: string): Promise<void> => {
    await writeThemes((await readThemes()).filter((item) => item.id !== id))
  })
  ipcMain.handle(IPC.themesImport, async (e): Promise<ThemeDefinition | null> => {
    const result = await showOpenIn(ctx.winOf(e.sender), {
      title: '导入主题',
      filters: [{ name: '主题文件', extensions: ['json'] }],
      properties: ['openFile']
    })
    const file = firstPathOf(result)
    if (!file) return null

    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    const candidate = isRecord(parsed) && 'theme' in parsed ? parsed.theme : parsed
    const theme = normalizeThemeDefinition(candidate, { builtin: false })
    if (!theme) throw new Error('主题文件格式不正确，请确认是本软件导出的主题文件')
    // 分配新 id，避免覆盖已有的自定义主题
    return { ...theme, id: `custom-${Date.now().toString(36)}`, builtin: false }
  })
  ipcMain.handle(IPC.themesExport, async (e, theme: ThemeDefinition): Promise<boolean> => {
    const result = await showSaveIn(ctx.winOf(e.sender), {
      title: '导出主题',
      defaultPath: `${theme.name || '主题'}.json`,
      filters: [{ name: '主题文件', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return false
    const target = result.filePath.toLowerCase().endsWith('.json')
      ? result.filePath
      : `${result.filePath}.json`
    await fs.writeFile(
      target,
      JSON.stringify({ type: 'mindmap-theme', version: 1, theme }, null, 2)
    )
    return true
  })
}
