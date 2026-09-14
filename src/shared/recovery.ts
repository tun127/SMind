/**
 * 崩溃恢复的判定逻辑。
 *
 * 抽成纯函数的目的：这段逻辑决定了「启动时到底该不该弹恢复提示」，
 * 用户对反复提示非常敏感，必须有可执行的测试兜底，
 * 不能只靠人工点。
 */

import { isRecord } from './guards'

export interface RecoveryMeta {
  /** 自动保存时对应的原始文件路径；全新未保存的文档为 null */
  originalPath: string | null
  title: string
  /** 自动保存的时间戳（毫秒） */
  savedAt: number
}

/** 校验自动存档的元信息；返回 null 表示这份存档不可用 */
export function parseRecoveryMeta(raw: unknown): RecoveryMeta | null {
  if (!isRecord(raw)) return null

  const savedAt = typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : 0
  if (savedAt <= 0) return null

  const originalPath =
    typeof raw.originalPath === 'string' && raw.originalPath.length > 0 ? raw.originalPath : null
  const title = typeof raw.title === 'string' && raw.title.length > 0 ? raw.title : '未命名导图'

  return { originalPath, title, savedAt }
}

/**
 * 是否需要提示用户「恢复上次未保存的内容」。
 *
 * @param meta 自动存档元信息；null 表示没有可用存档
 * @param originalMtime 原始文件在磁盘上的最新修改时间；文件不存在或不适用时传 null
 */
export function shouldOfferRecovery(meta: RecoveryMeta | null, originalMtime: number | null): boolean {
  if (!meta) return false
  // 原始文件在自动保存之后又被正常保存过 → 磁盘上的版本不比存档旧，不需要恢复。
  // 用 >= 而不是 >：宁可少提示，也不要因为时间戳相等而反复打扰用户。
  if (meta.originalPath && originalMtime !== null && originalMtime >= meta.savedAt) return false
  return true
}
