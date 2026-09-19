/**
 * 打开历史与「常用导图」（纯函数，可在自检里跑）。
 *
 * 设计：
 * 1. 历史按「最近打开时间」倒序，常用（收藏）永远排在最前面且**不会被数量上限挤掉**；
 * 2. 同一个文件重复打开只留一条，并累加打开次数；
 * 3. 历史文件本身可能被手改坏，读取时一律走 normalize 兜底，坏数据直接丢掉而不是崩掉；
 * 4. 文件是否存在由调用方检查后写入 `missing`，这里只负责数据结构。
 */

import { isRecord } from '../guards'
import { baseNameOf } from '../model/path-text'

export interface HistoryEntry {
  /** 绝对路径 */
  path: string
  /** 文件名（用于显示） */
  name: string
  /** 打开/保存时的中心主题名（便于一眼认出是哪张图） */
  title: string
  /** 最近一次打开时间 */
  openedAt: number
  /** 打开过多少次 */
  openCount: number
  /** 常用（收藏） */
  pinned: boolean
  /** 文件当前是否已不在原位置（运行时探测，不落盘） */
  missing?: boolean
}

export interface HistoryFile {
  version: number
  entries: HistoryEntry[]
  /** 上次保存到的目录（「另存为」默认落在这里） */
  saveDir: string | null
}

export const HISTORY_LIMIT = 30
const HISTORY_VERSION = 1

export function emptyHistory(): HistoryFile {
  return { version: HISTORY_VERSION, entries: [], saveDir: null }
}

/** 排序：常用优先，其次按最近打开时间倒序 */
export function sortEntries(entries: HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.openedAt - a.openedAt
  })
}

/** 校验并整理历史文件；坏数据丢弃，超量裁剪（常用不受影响） */
export function normalizeHistory(raw: unknown): HistoryFile {
  const source = isRecord(raw) ? raw : {}
  const rawEntries = Array.isArray(source.entries) ? source.entries : []

  const seen = new Set<string>()
  const entries: HistoryEntry[] = []
  for (const item of rawEntries) {
    if (!isRecord(item)) continue
    const path = typeof item.path === 'string' ? item.path.trim() : ''
    if (path.length === 0) continue
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    // 名字与标题都先去掉首尾空格：纯空格的「名字」在界面上就是一片空白，
    // 必须当成没有值来处理，才能正确回退到文件名
    const rawName = typeof item.name === 'string' ? item.name.trim() : ''
    entries.push({
      path,
      name: rawName.length > 0 ? rawName : baseNameOf(path),
      title: typeof item.title === 'string' ? item.title.trim() : '',
      openedAt:
        typeof item.openedAt === 'number' && Number.isFinite(item.openedAt) ? item.openedAt : 0,
      openCount:
        typeof item.openCount === 'number' && item.openCount > 0 ? Math.floor(item.openCount) : 1,
      pinned: item.pinned === true
    })
  }

  const sorted = sortEntries(entries)
  const pinned = sorted.filter((entry) => entry.pinned)
  const recent = sorted.filter((entry) => !entry.pinned).slice(0, HISTORY_LIMIT)

  const saveDir =
    typeof source.saveDir === 'string' && source.saveDir.trim().length > 0
      ? source.saveDir.trim()
      : null

  return { version: HISTORY_VERSION, entries: [...pinned, ...recent], saveDir }
}

/** 记录一次打开（已存在则移到最前并累加次数） */
export function recordVisit(
  file: HistoryFile,
  visit: { path: string; name?: string; title?: string; at?: number }
): HistoryFile {
  const path = visit.path.trim()
  if (path.length === 0) return file

  const at = visit.at ?? Date.now()
  const rawName = visit.name?.trim() ?? ''
  const name = rawName.length > 0 ? rawName : baseNameOf(path)
  const rawTitle = visit.title?.trim() ?? ''
  const existing = file.entries.find((entry) => entry.path.toLowerCase() === path.toLowerCase())

  const others = file.entries.filter((entry) => entry.path.toLowerCase() !== path.toLowerCase())
  const merged: HistoryEntry = existing
    ? {
        ...existing,
        path,
        name,
        // 用 trim 后的长度判断：纯空格的标题不算「有标题」，
        // 否则界面上会显示成一片空白，而不是沿用上一次的名字
        title: rawTitle.length > 0 ? rawTitle : existing.title,
        openedAt: at,
        openCount: existing.openCount + 1
      }
    : { path, name, title: rawTitle, openedAt: at, openCount: 1, pinned: false }

  return normalizeHistory({ ...file, entries: [merged, ...others] })
}

/** 切换常用（收藏） */
export function togglePin(file: HistoryFile, path: string): HistoryFile {
  const target = path.trim().toLowerCase()
  const entries = file.entries.map((entry) =>
    entry.path.toLowerCase() === target ? { ...entry, pinned: !entry.pinned } : entry
  )
  return normalizeHistory({ ...file, entries })
}

/** 从历史里移除一条 */
export function removeEntry(file: HistoryFile, path: string): HistoryFile {
  const target = path.trim().toLowerCase()
  return normalizeHistory({
    ...file,
    entries: file.entries.filter((entry) => entry.path.toLowerCase() !== target)
  })
}

/** 清空（常用也一起清，用户明确点是清空） */
export function clearHistory(file: HistoryFile): HistoryFile {
  return { ...file, entries: [] }
}

/**
 * 人类可读的相对时间。
 * 只用于界面展示，所以规则简单直白：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 具体日期。
 */
export function relativeTime(at: number, now = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return ''
  const diff = now - at
  if (diff < 0) return '刚刚'
  const minute = 60_000
  const hour = 60 * minute

  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`

  /**
   * 「昨天 / N 天前」按**日历日**算，不按流逝时长算。
   *
   * 以前是 `diff < 2 * day → 昨天`：于是一小时前刚过午夜的人看到"昨天"（其实才 1 小时），
   * 而前天晚上（比如现在 01:00、时间是前天 19:00）却被叫"昨天"——两者都是错的。
   * 按日期差算才对：跨过午夜一次就是昨天，跨两次就是前天。
   * 用「当地零点」的毫秒差再取整，夏令时那种 23/25 小时的日子也不会算歪。
   */
  const startOfDay = (value: number): number => {
    const date = new Date(value)
    date.setHours(0, 0, 0, 0)
    return date.getTime()
  }
  const dayDiff = Math.round((startOfDay(now) - startOfDay(at)) / (24 * hour))
  if (dayDiff <= 0) return `${Math.floor(diff / hour)} 小时前`
  if (dayDiff === 1) return '昨天'
  if (dayDiff < 30) return `${dayDiff} 天前`

  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
