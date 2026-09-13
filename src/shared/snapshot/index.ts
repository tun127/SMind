/**
 * 文档版本快照（纯逻辑，可在自检里跑）。
 *
 * 与「打开历史」（最近用过哪些文件）是两件事：
 * 这里记录的是**同一个文档在不同时间点的内容版本**，用于回溯与恢复。
 *
 * 设计：
 * 1. 快照按文档分组（docKey）。已保存的文档用文件路径做键，未保存的用会话序号，
 *    这样「新建但还没落盘」的文档也能有自己的版本记录。
 * 2. 手动快照（manual / before-restore）优先保留；数量超限时先裁自动快照，
 *    避免用户特意存下的版本被自动快照挤掉。
 * 3. 自动快照会先用内容指纹去重：内容没变就不重复存，不会把盘写爆。
 * 4. 版本文件本身可能被手删或半写坏，读取一律走 normalize 兜底，坏数据丢弃而不是崩掉。
 */

export type SnapshotReason = 'auto' | 'manual' | 'before-restore'

export interface SnapshotItem {
  id: string
  /** 归属文档：`file:<小写路径>` 或 `untitled:<会话序号>` */
  docKey: string
  /** 存快照时的文档名（中心主题名），便于在列表里辨认 */
  title: string
  /** 存快照时的文件路径；未保存过为 null */
  path: string | null
  /** 时间戳 */
  at: number
  /** 序列化后的字节数 */
  size: number
  reason: SnapshotReason
  /** 手动快照可填备注 */
  note?: string
  /** 内容指纹，用于「内容没变就不重复存」 */
  hash: string
}

export interface SnapshotIndex {
  version: number
  items: SnapshotItem[]
}

export const SNAPSHOT_VERSION = 1

export const SNAPSHOT_LIMITS = {
  /** 单个文档最多保留多少个快照 */
  perDoc: 30,
  /** 手动快照的硬上限（超过才会裁） */
  manual: 50,
  /** 两次快照之间的最小间隔，避免频繁写盘 */
  minGap: 5 * 60_000
} as const

const REASONS: SnapshotReason[] = ['auto', 'manual', 'before-restore']

export function emptySnapshotIndex(): SnapshotIndex {
  return { version: SNAPSHOT_VERSION, items: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 文档键：按**文件路径**归并（大小写与斜杠方向不敏感）。
 *
 * 刻意不做「未保存文档」的分组：那种键要么在重启后与新的未保存文档撞车，
 * 要么在文档首次保存时失联，还会留下没人回收的孤儿文件。
 * 未保存文档的内容安全由「自动保存 + 崩溃恢复」负责（那本来就是它的职责），
 * 版本快照只服务**文件**——这也正是需求里「文件历史快照」的含义。
 *
 * @returns 没有路径时返回 null，调用方应据此跳过快照操作
 */
export function documentKeyOf(path: string | null | undefined): string | null {
  const trimmed = typeof path === 'string' ? path.trim() : ''
  if (trimmed.length === 0) return null
  return `file:${trimmed.replace(/\//g, '\\').toLowerCase()}`
}

function normalizeItem(raw: unknown): SnapshotItem | null {
  if (!isRecord(raw)) return null

  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const docKey = typeof raw.docKey === 'string' ? raw.docKey.trim() : ''
  const hash = typeof raw.hash === 'string' ? raw.hash.trim() : ''
  if (id.length === 0 || docKey.length === 0) return null

  const reason = REASONS.includes(raw.reason as SnapshotReason) ? (raw.reason as SnapshotReason) : 'auto'
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) && raw.at > 0 ? raw.at : 0
  const size = typeof raw.size === 'number' && Number.isFinite(raw.size) && raw.size > 0 ? Math.floor(raw.size) : 0

  return {
    id,
    docKey,
    title: typeof raw.title === 'string' ? raw.title.trim() : '',
    path: typeof raw.path === 'string' && raw.path.trim().length > 0 ? raw.path.trim() : null,
    at,
    size,
    reason,
    note: typeof raw.note === 'string' && raw.note.trim().length > 0 ? raw.note.trim() : undefined,
    hash
  }
}

export interface PruneResult {
  index: SnapshotIndex
  /** 被裁掉的快照 id，调用方需要把对应文件删掉 */
  dropped: string[]
}

function prune(items: SnapshotItem[]): PruneResult {
  const byDoc = new Map<string, SnapshotItem[]>()
  for (const item of items) {
    const bucket = byDoc.get(item.docKey) ?? []
    bucket.push(item)
    byDoc.set(item.docKey, bucket)
  }

  const kept: SnapshotItem[] = []
  const dropped: string[] = []

  for (const bucket of byDoc.values()) {
    const sorted = [...bucket].sort((a, b) => b.at - a.at)
    // 手动存下的版本优先保留，剩下的名额才留给自动快照
    const manual = sorted.filter((item) => item.reason !== 'auto').slice(0, SNAPSHOT_LIMITS.manual)
    const room = Math.max(0, SNAPSHOT_LIMITS.perDoc - manual.length)
    const auto = sorted.filter((item) => item.reason === 'auto').slice(0, room)

    const survivors = new Set([...manual, ...auto].map((item) => item.id))
    for (const item of sorted) {
      if (!survivors.has(item.id)) dropped.push(item.id)
    }
    kept.push(...manual, ...auto)
  }

  kept.sort((a, b) => b.at - a.at)
  return { index: { version: SNAPSHOT_VERSION, items: kept }, dropped }
}

/** id 只允许安全字符：它会被拼成文件名，不能让手改过的索引指到别的文件上 */
const SAFE_ID = /^[a-zA-Z0-9_-]+$/

/**
 * 校验并整理快照索引。
 * 除了裁剪超量条目，还会把「被丢弃的坏条目 id」一并报出来——
 * 否则那些条目的文件会永远留在磁盘上，谁也不知道该删它们。
 */
export function normalizeSnapshotIndex(raw: unknown): PruneResult {
  const source = isRecord(raw) ? raw : {}
  const rawItems = Array.isArray(source.items) ? source.items : []

  const seen = new Set<string>()
  const items: SnapshotItem[] = []
  const discarded: string[] = []

  for (const entry of rawItems) {
    const item = normalizeItem(entry)
    if (!item || seen.has(item.id)) {
      // 重复 id 不进 discarded：它的文件还被保留的那条引用着
      if (isRecord(entry) && typeof entry.id === 'string' && SAFE_ID.test(entry.id)) {
        discarded.push(entry.id)
      }
      continue
    }
    seen.add(item.id)
    items.push(item)
  }

  const result = prune(items)
  const keptIds = new Set(result.index.items.map((item) => item.id))
  const orphans = discarded.filter((id) => !keptIds.has(id))

  return { index: result.index, dropped: [...new Set(orphans), ...result.dropped] }
}

/** 某个文档的快照列表（按时间倒序） */
export function snapshotsOf(index: SnapshotIndex, docKey: string): SnapshotItem[] {
  return index.items.filter((item) => item.docKey === docKey).sort((a, b) => b.at - a.at)
}

/** 新增一份快照 */
export function addSnapshot(index: SnapshotIndex, item: SnapshotItem): PruneResult {
  return prune([item, ...index.items.filter((entry) => entry.id !== item.id)])
}

export function removeSnapshot(index: SnapshotIndex, id: string): PruneResult {
  // 主动删掉的条目必须报进 dropped，否则它的 .xmind 文件会留在磁盘上没人回收
  const removed = index.items.filter((item) => item.id === id).map((item) => item.id)
  const result = prune(index.items.filter((item) => item.id !== id))
  return { index: result.index, dropped: [...removed, ...result.dropped] }
}

export function clearDocSnapshots(index: SnapshotIndex, docKey: string): PruneResult {
  const removed = index.items.filter((item) => item.docKey === docKey).map((item) => item.id)
  const result = prune(index.items.filter((item) => item.docKey !== docKey))
  return { index: result.index, dropped: [...removed, ...result.dropped] }
}

/**
 * 要不要存一份自动快照。
 * 内容没变（指纹相同）不存；距上一次太近也不存，避免频繁写盘。
 */
export function shouldAutoSnapshot(items: SnapshotItem[], hash: string, at: number): boolean {
  if (items.length === 0) return true
  const newest = items.reduce((a, b) => (a.at >= b.at ? a : b))
  if (newest.hash.length > 0 && newest.hash === hash) return false
  return at - newest.at >= SNAPSHOT_LIMITS.minGap
}

const REASON_LABELS: Record<SnapshotReason, string> = {
  auto: '自动',
  manual: '手动',
  'before-restore': '恢复前'
}

export function snapshotReasonLabel(reason: SnapshotReason): string {
  return REASON_LABELS[reason] ?? '快照'
}

/** 人类可读的字节数 */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  if (size < 1024) return `${Math.round(size)} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 版本条目的主标题。
 * 优先用用户填的备注；没有备注就退回「原因 + 文档名」，保证每行都有可读的标签。
 */
export function snapshotLabel(item: SnapshotItem): string {
  if (item.note && item.note.length > 0) return item.note
  const reason = snapshotReasonLabel(item.reason)
  return item.title.length > 0 ? `${reason} · ${item.title}` : `${reason}版本`
}
