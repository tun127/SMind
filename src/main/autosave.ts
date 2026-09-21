import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { autosaveKeyOf, parseRecoveryMeta, type RecoveryMeta } from '@shared/recovery'

/* ------------------------------------------------------------------ */
/* 自动保存路径                                                        */
/* ------------------------------------------------------------------ */

export const autosaveDir = (): string => join(app.getPath('userData'), 'autosave')
/** 「在新窗口打开画布副本」用的临时文件目录（关窗即删） */
export const copyDir = (): string => join(app.getPath('userData'), 'copies')
/**
 * 自动存档按**窗口 + 文档**分文件：`slot-N-docId.xmind`。
 *
 * 槽位（slot-N）保证多窗口互不覆盖；docId 保证**同一个窗口里的多个标签**互不覆盖 ——
 * 只按窗口分时，切标签会把上一个标签的存档盖掉，它崩溃后无从恢复（报告 D-02）。
 */
export const autosaveFile = (slot: string, docId: string): string =>
  join(autosaveDir(), `${autosaveKeyOf(slot, docId)}.xmind`)
export const autosaveMeta = (slot: string, docId: string): string =>
  join(autosaveDir(), `${autosaveKeyOf(slot, docId)}.json`)

/**
 * 「最近一份」存档：恢复链（main/ipc/recovery.ts）读的就是它。
 *
 * 它是 per-doc 存档的一份**副本**，只为让"崩溃后提示恢复"保持原样可用 ——
 * 恢复界面目前仍只提示一份（列出多个标签各自恢复属 UI 改动，未做）。
 */
export const latestAutosaveFile = (slot: string): string => join(autosaveDir(), `${slot}.xmind`)
export const latestAutosaveMeta = (slot: string): string => join(autosaveDir(), `${slot}.json`)

/** 列出某窗口槽位下**所有** per-doc 存档的 docId（用于逐份恢复与"关窗清全部"） */
export async function listAutosaveDocIds(slot: string): Promise<string[]> {
  try {
    const names = await fs.readdir(autosaveDir())
    const prefix = `${slot}-`
    const suffix = '.xmind'
    return names
      .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
      .map((name) => name.slice(prefix.length, name.length - suffix.length))
  } catch {
    return []
  }
}

/** 按**份**读 meta：docId 为空串表示读「最近一份」副本（兼容升级前的旧存档） */
export async function readAutosaveMeta(slot: string, docId = ''): Promise<RecoveryMeta | null> {
  try {
    const file = docId ? autosaveMeta(slot, docId) : latestAutosaveMeta(slot)
    return parseRecoveryMeta(JSON.parse(await fs.readFile(file, 'utf8')))
  } catch {
    return null
  }
}

/** 清理上次运行留下的画布副本（超过一天，肯定没窗口还开着它了） */
export async function pruneStaleCopies(): Promise<void> {
  try {
    const dir = copyDir()
    const names = await fs.readdir(dir)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    await Promise.all(
      names.map(async (name) => {
        const target = join(dir, name)
        try {
          const info = await fs.stat(target)
          if (info.mtimeMs < cutoff) await fs.rm(target, { force: true })
        } catch {
          /* 单个文件清理失败不影响启动 */
        }
      })
    )
  } catch {
    /* 目录不存在就是没有副本 */
  }
}
