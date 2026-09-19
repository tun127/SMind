import { app } from 'electron'
import { isRecord } from '../shared/guards'
import { writeJsonAtomic } from './atomic-write'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { normalizeThemeDefinition, type ThemeDefinition } from '@shared/theme'

/* ------------------------------------------------------------------ */
/* 自定义主题的持久化                                                  */
/* ------------------------------------------------------------------ */

const themesFile = (): string => join(app.getPath('userData'), 'themes.json')

export async function readThemes(): Promise<ThemeDefinition[]> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(themesFile(), 'utf8'))
    const list = isRecord(raw) && Array.isArray(raw.themes) ? raw.themes : []
    return list
      .map((item) => normalizeThemeDefinition(item, { builtin: false }))
      .filter((item): item is ThemeDefinition => item !== null)
  } catch {
    return []
  }
}

export async function writeThemes(themes: ThemeDefinition[]): Promise<void> {
  // 用户自定义主题是**唯一副本**：断在半路就没了，必须原子写（见 writeJsonAtomic）
  await writeJsonAtomic(themesFile(), { version: 1, themes })
}
