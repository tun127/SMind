/**
 * 画布级元素的「区间」与「弯度」：纯数据层。
 *
 * - 区间：Xmind 用 `(topicId1,topicId2)` 表示一段连续的同级主题，这里负责解析、
 *   建索引、还原成主题列表、以及由选中集合反推区间；
 * - 弯度：关系线被拖动后写在样式里的偏移量读写。
 *
 * 两者都不碰坐标，也不碰布局结果，所以可以被任何上层直接复用。
 */
import type { NodeStyle, Topic } from '../../model/types'
import { RELATIONSHIP_CURVE_KEY } from '../../xmind/constants'
import { round } from '../core'

/* ------------------------------------------------------------------ */
/* 关系线弯度偏移                                                      */
/* ------------------------------------------------------------------ */

export interface CurveOffset {
  x: number
  y: number
}

/** 读出关系线被拖动产生的弯度偏移；没有或格式不对时返回零偏移 */
export function readCurveOffset(style: NodeStyle | undefined): CurveOffset {
  const raw = style?.properties?.[RELATIONSHIP_CURVE_KEY]
  if (typeof raw !== 'string' || raw.length === 0) return { x: 0, y: 0 }
  const parts = raw.split(',')
  if (parts.length !== 2) return { x: 0, y: 0 }
  const x = Number(parts[0])
  const y = Number(parts[1])
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 }
  return { x, y }
}

/** 写回弯度偏移；零偏移时把键清掉，避免在文件里留下无用字段 */
export function withCurveOffset(
  style: NodeStyle | undefined,
  offset: CurveOffset
): NodeStyle | undefined {
  const properties: Record<string, string> = { ...(style?.properties ?? {}) }
  if (offset.x === 0 && offset.y === 0) delete properties[RELATIONSHIP_CURVE_KEY]
  else properties[RELATIONSHIP_CURVE_KEY] = `${round(offset.x)},${round(offset.y)}`

  const id = style?.id
  if (Object.keys(properties).length === 0 && id === undefined) return undefined
  return id === undefined ? { properties } : { id, properties }
}

/* ------------------------------------------------------------------ */
/* 区间（Xmind 用 (topicId1,topicId2) 表示一段连续的同级主题）           */
/* ------------------------------------------------------------------ */

export function parseRange(range: string | undefined): [string, string] | null {
  const text = typeof range === 'string' ? range.trim() : ''
  if (text.length === 0) return null
  const pair = /^\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)$/.exec(text)
  if (pair) return [pair[1] ?? '', pair[2] ?? '']
  const single = /^\(\s*([^,()]+?)\s*\)$/.exec(text)
  if (single) return [single[1] ?? '', single[1] ?? '']
  return null
}

export interface TreeIndex {
  byId: Map<string, Topic>
  /** 根主题没有父级，其值为 undefined */
  parentOf: Map<string, string | undefined>
}

export function indexTree(root: Topic): TreeIndex {
  const byId = new Map<string, Topic>()
  const parentOf = new Map<string, string | undefined>()
  const walk = (topic: Topic, parentId: string | undefined): void => {
    byId.set(topic.id, topic)
    parentOf.set(topic.id, parentId)
    for (const child of topic.children) walk(child, topic.id)
  }
  walk(root, undefined)
  return { byId, parentOf }
}

/**
 * 把区间还原成具体主题列表。
 * 只有在「同一父级下的连续兄弟」时才展开，否则退化成单个主题，
 * 避免文件里的异常区间把不相关的节点也框进来。
 */
export function resolveRange(index: TreeIndex, range: string | undefined): Topic[] {
  const parsed = parseRange(range)
  if (!parsed) return []
  const [firstId, lastId] = parsed
  const first = index.byId.get(firstId)
  if (!first) return []
  if (firstId === lastId) return [first]

  const last = index.byId.get(lastId)
  const parentId = index.parentOf.get(firstId)
  if (!last || parentId === undefined || parentId !== index.parentOf.get(lastId)) return [first]

  const siblings = index.byId.get(parentId)?.children ?? []
  const ia = siblings.findIndex((topic) => topic.id === firstId)
  const ib = siblings.findIndex((topic) => topic.id === lastId)
  if (ia < 0 || ib < 0) return [first]

  return siblings.slice(Math.min(ia, ib), Math.max(ia, ib) + 1)
}

/** 两个区间是否指向同一段主题（忽略书写顺序与空格差异） */
export function sameRange(a: string | undefined, b: string | undefined): boolean {
  const left = parseRange(a)
  const right = parseRange(b)
  if (!left || !right) return false
  return (
    (left[0] === right[0] && left[1] === right[1]) || (left[0] === right[1] && left[1] === right[0])
  )
}

/** 由一组选中的主题算出区间字符串（取同一父级下成员最多的那一组） */
export function buildRange(root: Topic, ids: string[]): string | null {
  const index = indexTree(root)
  const valid = ids.filter((id) => index.byId.has(id))
  if (valid.length === 0) return null

  const groups = new Map<string, string[]>()
  for (const id of valid) {
    const parentId = index.parentOf.get(id)
    if (parentId === undefined) continue
    const bucket = groups.get(parentId) ?? []
    bucket.push(id)
    groups.set(parentId, bucket)
  }

  let best: string[] = []
  for (const bucket of groups.values()) {
    if (bucket.length > best.length) best = bucket
  }
  if (best.length === 0) {
    // 只选中了中心主题：区间退化成它自己
    return `(${valid[0]},${valid[0]})`
  }
  if (best.length === 1) return `(${best[0]},${best[0]})`

  const firstBest = best[0]
  // 走到这里 best.length >= 2，理论上取不到 undefined；真取不到就是「算不出区间」，
  // 返回 null（调用方据此不画概要线）。以前返回 `''`——空区间字符串会被写进文件，
  // 变成一个谁也解析不了的 range 字段
  if (!firstBest) return null
  const parentId = index.parentOf.get(firstBest)
  const siblings = parentId === undefined ? [] : (index.byId.get(parentId)?.children ?? [])
  const marks = best
    .map((id) => siblings.findIndex((topic) => topic.id === id))
    .filter((position) => position >= 0)
    .sort((a, b) => a - b)
  if (marks.length === 0) return `(${firstBest},${firstBest})`

  const firstMark = marks[0]
  const lastMark = marks[marks.length - 1]
  const firstSibling = firstMark === undefined ? undefined : siblings[firstMark]
  const lastSibling = lastMark === undefined ? undefined : siblings[lastMark]
  if (!firstSibling || !lastSibling) return `(${firstBest},${firstBest})`
  return `(${firstSibling.id},${lastSibling.id})`
}
