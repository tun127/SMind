/**
 * 打开历史的持久化（主进程）。
 *
 * 存在 userData/history.json 里；同时记住「上次保存到的目录」，
 * 这样「另存为」默认就落在用户上次用的地方（需求里的「存储路径」诉求）。
 */

import { app } from 'electron'
import { promises as fs, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { writeJsonAtomic } from './atomic-write'
import {
  clearHistory as clearHistoryPure,
  emptyHistory,
  normalizeHistory,
  recordVisit as recordVisitPure,
  removeEntry as removeEntryPure,
  togglePin as togglePinPure,
  type HistoryEntry,
  type HistoryFile
} from '@shared/history'

const historyFile = (): string => join(app.getPath('userData'), 'history.json')

/** 默认保存目录：文档/思维导图（需求里约定的位置） */
export function defaultSaveDir(): string {
  return join(app.getPath('documents'), '思维导图')
}

export async function ensureDir(dir: string): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

export async function loadHistory(): Promise<HistoryFile> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(historyFile(), 'utf8'))
    return normalizeHistory(raw)
  } catch {
    return emptyHistory()
  }
}

async function saveHistory(file: HistoryFile): Promise<void> {
  try {
    // 原子写：历史索引被截断就整份读不出来（用户看到"打开历史空了"）
    await writeJsonAtomic(historyFile(), file)
  } catch {
    // 历史写不进去不该影响正常使用
  }
}

/** 记一次打开/保存；title 用来在界面上显示「是哪张图」 */
export async function recordVisit(path: string, title: string): Promise<void> {
  const file = await loadHistory()
  await saveHistory(recordVisitPure(file, { path, name: basename(path), title, at: Date.now() }))
}

/** 历史列表（带 missing 标记：文件是否还在原位置） */
export async function listHistory(): Promise<HistoryEntry[]> {
  const file = await loadHistory()
  return file.entries.map((entry) => ({ ...entry, missing: !existsSync(entry.path) }))
}

export async function togglePin(path: string): Promise<HistoryEntry[]> {
  const file = await loadHistory()
  await saveHistory(togglePinPure(file, path))
  return listHistory()
}

export async function removeEntry(path: string): Promise<HistoryEntry[]> {
  const file = await loadHistory()
  await saveHistory(removeEntryPure(file, path))
  return listHistory()
}

export async function clearAllHistory(): Promise<HistoryEntry[]> {
  const file = await loadHistory()
  await saveHistory(clearHistoryPure(file))
  return listHistory()
}

/** 取当前保存目录（没设置过或目录已不存在时回到默认目录并尝试创建） */
export async function currentSaveDir(): Promise<string> {
  const file = await loadHistory()
  const dir = file.saveDir && existsSync(file.saveDir) ? file.saveDir : defaultSaveDir()
  await ensureDir(dir)
  return dir
}

/** 记住新的保存目录 */
export async function rememberSaveDir(dir: string): Promise<string> {
  const file = await loadHistory()
  const next = dir.trim().length > 0 ? dir.trim() : defaultSaveDir()
  await ensureDir(next)
  await saveHistory({ ...file, saveDir: next })
  return next
}
