import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { parseRecoveryMeta, type RecoveryMeta } from '@shared/recovery'

/* ------------------------------------------------------------------ */
/* 自动保存路径                                                        */
/* ------------------------------------------------------------------ */

export const autosaveDir = (): string => join(app.getPath('userData'), 'autosave')
/** 「在新窗口打开画布副本」用的临时文件目录（关窗即删） */
export const copyDir = (): string => join(app.getPath('userData'), 'copies')
/**
 * 自动存档按**窗口**分槽位：多窗口时各存各的，互不覆盖。
 * 槽位名按窗口创建顺序（slot-1 / slot-2 …），重启后新会话的窗口按同样顺序认领。
 */
export const autosaveFile = (slot: string): string => join(autosaveDir(), `${slot}.xmind`)
export const autosaveMeta = (slot: string): string => join(autosaveDir(), `${slot}.json`)

export async function readAutosaveMeta(slot: string): Promise<RecoveryMeta | null> {
  try {
    return parseRecoveryMeta(JSON.parse(await fs.readFile(autosaveMeta(slot), 'utf8')))
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
