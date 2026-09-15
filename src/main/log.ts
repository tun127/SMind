/**
 * 主进程日志。
 *
 * 只做一件事：把崩溃与异常落到文件里，让人有据可查。
 * 「出错时一片空白、什么都没留下」是最难查的故障——用户能反馈的往往只有"它突然没了"。
 *
 * 刻意用**同步**写入：崩溃路径上异步写很可能还没落盘，进程就被带走了。
 */
import { app } from 'electron'
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 单个日志文件上限；超过就轮转成 .old，避免无限增长 */
const MAX_LOG_BYTES = 1024 * 1024

let cachedFile: string | null = null

/** 日志目录（错误提示里要告诉用户去哪找） */
export function logDirectory(): string {
  return join(app.getPath('userData'), 'logs')
}

function logFile(): string {
  if (cachedFile) return cachedFile
  const dir = logDirectory()
  mkdirSync(dir, { recursive: true })
  cachedFile = join(dir, `main-${new Date().toISOString().slice(0, 10)}.log`)
  return cachedFile
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function rotateIfNeeded(file: string): void {
  try {
    if (statSync(file).size < MAX_LOG_BYTES) return
    // Windows 上 rename 不能覆盖已存在的目标，先清掉旧的
    rmSync(`${file}.old`, { force: true })
    renameSync(file, `${file}.old`)
  } catch {
    // 文件还不存在、或没有权限：都不该影响调用方
  }
}

/**
 * 记一行日志。
 * 任何失败都咽掉——**记日志本身绝不能把应用弄崩**。
 */
export function logMain(scope: string, detail: unknown, extra?: unknown): void {
  try {
    const file = logFile()
    rotateIfNeeded(file)
    const line = [new Date().toISOString(), scope, describe(detail), extra === undefined ? '' : describe(extra)]
      .filter((part) => part.length > 0)
      .join(' | ')
    appendFileSync(file, `${line}\n`, 'utf8')
  } catch {
    // 忽略
  }
}
