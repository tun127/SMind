/**
 * 文档版本快照的持久化（主进程）。
 *
 * 目录结构：
 *   userData/snapshots/index.json      版本索引（列表、时间、大小、指纹）
 *   userData/snapshots/files/<id>.xmind 每个版本一份完整 .xmind 包
 *
 * 存的是**完整 .xmind 包**而不是增量：这样恢复时走的是同一条「打开文件」通路，
 * 图片与附件一并还原，不会出现「恢复了文字但图丢了」。
 */

import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { collectResourceRefs } from '@shared/model/resources'
import type { Workbook } from '@shared/model/types'
import {
  addSnapshot,
  clearDocSnapshots,
  documentKeyOf,
  emptySnapshotIndex,
  normalizeSnapshotIndex,
  removeSnapshot,
  shouldAutoSnapshot,
  snapshotsOf,
  type SnapshotIndex,
  type SnapshotItem,
  type SnapshotReason
} from '@shared/snapshot'
import { serializeXmind } from '@shared/xmind/serialize'

const rootDir = (): string => join(app.getPath('userData'), 'snapshots')
const indexFile = (): string => join(rootDir(), 'index.json')
const filesDir = (): string => join(rootDir(), 'files')

/** id 只允许安全字符，避免索引被手改后出现越出目录的路径 */
const safeId = (id: string): string =>
  typeof id === 'string' ? id.replace(/[^a-zA-Z0-9_-]/g, '') : ''
const fileOf = (id: string): string => join(filesDir(), `${safeId(id)}.xmind`)

const newId = (): string => `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`

async function removeFiles(ids: string[]): Promise<void> {
  for (const id of ids) {
    const safe = safeId(id)
    if (safe.length === 0) continue
    try {
      await fs.rm(fileOf(safe), { force: true })
    } catch {
      // 删不掉就算了，索引里已经不再引用它
    }
  }
}

async function loadIndex(): Promise<SnapshotIndex> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(indexFile(), 'utf8'))
    const { index, dropped } = normalizeSnapshotIndex(raw)
    // 校验时被裁掉的条目，文件也一并清掉，避免留下永远访问不到的垃圾
    if (dropped.length > 0) await removeFiles(dropped)
    return index
  } catch {
    return emptySnapshotIndex()
  }
}

async function saveIndex(index: SnapshotIndex): Promise<void> {
  try {
    await fs.mkdir(rootDir(), { recursive: true })
    await fs.writeFile(indexFile(), JSON.stringify(index, null, 2), 'utf8')
  } catch {
    // 快照写不进去不该影响正常使用
  }
}

/**
 * 打包成 .xmind 字节。
 * 只带上模型真正引用的资源，避免把已经被删掉的图片也一起塞进每个版本里。
 */
async function serializeSnapshot(
  workbook: Workbook,
  resources: Record<string, Uint8Array>
): Promise<Uint8Array> {
  const refs = collectResourceRefs(workbook)
  const kept: Record<string, Uint8Array> = {}
  for (const path of refs) {
    const bytes = resources[path]
    if (bytes) kept[path] = bytes
  }
  return serializeXmind({ workbook, resources: kept })
}

/** 只服务「已保存过的文档」；没有路径时不记录版本 */
export async function listSnapshots(path: string | null): Promise<SnapshotItem[]> {
  const docKey = documentKeyOf(path)
  if (!docKey) return []
  return snapshotsOf(await loadIndex(), docKey)
}

/**
 * 存一份版本。
 * - `auto`：内容没变或距上次太近时直接返回原列表，不写盘
 * - `manual` / `before-restore`：总是存
 * - 文档还没有路径（从未保存过）时不记录，返回空列表
 */
export async function createSnapshot(input: {
  workbook: Workbook
  resources: Record<string, Uint8Array>
  path: string | null
  title: string
  reason: SnapshotReason
  note?: string
}): Promise<SnapshotItem[]> {
  const docKey = documentKeyOf(input.path)
  if (!docKey) return []

  let bytes: Uint8Array
  try {
    bytes = await serializeSnapshot(input.workbook, input.resources)
  } catch {
    // 序列化失败（例如模型里有异常数据）时静默跳过，不能影响用户正在做的事
    return listSnapshots(input.path)
  }

  const hash = createHash('sha1').update(Buffer.from(bytes)).digest('hex')
  const at = Date.now()
  const index = await loadIndex()
  const existing = snapshotsOf(index, docKey)

  if (input.reason === 'auto' && !shouldAutoSnapshot(existing, hash, at)) return existing

  const note = typeof input.note === 'string' ? input.note.trim() : ''
  const item: SnapshotItem = {
    id: newId(),
    docKey,
    title: input.title,
    path: input.path,
    at,
    size: bytes.byteLength,
    reason: input.reason,
    note: note.length > 0 ? note : undefined,
    hash
  }

  try {
    await fs.mkdir(filesDir(), { recursive: true })
    await fs.writeFile(fileOf(item.id), Buffer.from(bytes))
  } catch {
    return existing
  }

  const { index: next, dropped } = addSnapshot(index, item)
  await removeFiles(dropped.filter((id) => id !== item.id))
  await saveIndex(next)
  return snapshotsOf(next, docKey)
}

/** 读出某个版本的字节（恢复时用），不存在返回 null */
export async function readSnapshotBytes(id: string): Promise<Uint8Array | null> {
  const safe = safeId(id)
  if (safe.length === 0) return null
  try {
    const buf = await fs.readFile(fileOf(safe))
    return new Uint8Array(buf)
  } catch {
    return null
  }
}

export async function removeSnapshotById(id: string, path: string | null): Promise<SnapshotItem[]> {
  const index = await loadIndex()
  const { index: next, dropped } = removeSnapshot(index, id)
  await removeFiles(dropped)
  await saveIndex(next)
  return listSnapshots(path)
}

export async function clearSnapshotsFor(path: string | null): Promise<SnapshotItem[]> {
  const docKey = documentKeyOf(path)
  if (!docKey) return []
  const index = await loadIndex()
  const { index: next, dropped } = clearDocSnapshots(index, docKey)
  await removeFiles(dropped)
  await saveIndex(next)
  return snapshotsOf(next, docKey)
}
