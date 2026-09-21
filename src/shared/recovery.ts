/**
 * 崩溃恢复的判定逻辑。
 *
 * 抽成纯函数的目的：这段逻辑决定了「启动时到底该不该弹恢复提示」，
 * 用户对反复提示非常敏感，必须有可执行的测试兜底，
 * 不能只靠人工点。
 */

import { isRecord } from './guards'

/**
 * 该清哪些存档（纯函数，主进程与自检共用）。
 *
 * - 给了 `docId` → **只删它那一份**：别的标签的存档不能动，那正是 D-02 的成因；
 * - **没给 `docId` → 一份都不删**（fail-safe）：漏改的调用点绝不能退化成"清全窗"。
 *   关窗要清全部，走的是另一条显式路径（main/windows.ts 枚举本窗口所有 docId）。
 */
export function autosaveKeysToClear(
  keys: readonly string[],
  docId: string | undefined | null
): string[] {
  if (!docId) return []
  return keys.filter((key) => key === docId)
}

/**
 * 自动存档的文件名主干：`<slot>-<docId>`（纯函数；主进程拿它拼路径，自检直接断言）。
 *
 * 为什么必须带 docId：一个窗口可以开多个标签，而自动存档的定时器只送**激活**标签的快照 ——
 * 按窗口分槽时，切到 B 标签就会把 A 的存档**覆盖**掉，A 崩溃后再也恢复不出来（报告 D-02）。
 * docId 参与文件名之后，每个标签各存各的。
 *
 * docId 里的路径分隔符等字符统一换成 `_`：它是外部输入，不能让它逃出存档目录。
 */
export function autosaveKeyOf(slot: string, docId: string): string {
  const safe = docId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `${slot}-${safe}`
}

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
export function shouldOfferRecovery(
  meta: RecoveryMeta | null,
  originalMtime: number | null
): boolean {
  if (!meta) return false
  // 原始文件在自动保存之后又被正常保存过 → 磁盘上的版本不比存档旧，不需要恢复。
  // 用 >= 而不是 >：宁可少提示，也不要因为时间戳相等而反复打扰用户。
  if (meta.originalPath && originalMtime !== null && originalMtime >= meta.savedAt) return false
  return true
}
