/**
 * 检索：全局搜索、替换、按标记/标签筛选、统计。
 *
 * 全是纯函数，不依赖 DOM 与 Electron：
 * 面板、画布高亮、自检都用同一份实现，保证「面板里列出的命中」与「画布上高亮的节点」完全一致。
 */

import type { Sheet, Topic, Workbook } from '../model/types'
import { walk } from '../model/tree'

/* ------------------------------------------------------------------ */
/* 搜索                                                                */
/* ------------------------------------------------------------------ */

export interface SearchOptions {
  /** 区分大小写（默认不区分） */
  caseSensitive?: boolean
  /** 是否搜索备注（默认否） */
  inNotes?: boolean
  /** 是否搜索标签（默认否） */
  inLabels?: boolean
}

export const DEFAULT_SEARCH_OPTIONS: Required<SearchOptions> = {
  caseSensitive: false,
  inNotes: false,
  inLabels: false
}

export type SearchField = 'title' | 'notes' | 'label'

export interface SearchHit {
  topicId: string
  sheetId: string
  /** 节点标题（用于列表显示） */
  title: string
  depth: number
  /** 命中的字段 */
  field: SearchField
  /** 命中字段里的命中次数 */
  count: number
  /** 命中处的上下文片段 */
  snippet: string
}

/** 统计一段文本里出现关键词的次数（空关键词返回 0） */
export function countOccurrences(text: string, query: string, caseSensitive = false): number {
  if (query.length === 0) return 0
  const haystack = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    count += 1
    from = at + needle.length
  }
  return count
}

/**
 * 替换文本里的关键词。
 * @returns 替换后的文本与替换次数；关键词为空时原样返回
 */
export function replaceInText(
  text: string,
  query: string,
  replacement: string,
  caseSensitive = false
): { text: string; count: number } {
  if (query.length === 0) return { text, count: 0 }

  const haystack = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  let out = ''
  let from = 0
  let count = 0

  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    out += text.slice(from, at) + replacement
    from = at + needle.length
    count += 1
  }

  if (count === 0) return { text, count: 0 }
  return { text: out + text.slice(from), count }
}

/** 取命中处前后一小段作为预览 */
export function snippetOf(text: string, query: string, caseSensitive = false, radius = 18): string {
  if (query.length === 0) return text.slice(0, radius * 2)
  const haystack = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const at = haystack.indexOf(needle)
  if (at < 0) return text.slice(0, radius * 2)

  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + query.length + radius)
  const body = text.slice(start, end).replace(/\s+/g, ' ')
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

/** 在单个节点的各字段里找命中（一个字段最多产出一条命中） */
function hitsInTopic(topic: Topic, sheetId: string, depth: number, query: string, options: Required<SearchOptions>): SearchHit[] {
  const out: SearchHit[] = []
  const base = { topicId: topic.id, sheetId, title: topic.title, depth }

  const titleCount = countOccurrences(topic.title, query, options.caseSensitive)
  if (titleCount > 0) {
    out.push({
      ...base,
      field: 'title',
      count: titleCount,
      snippet: snippetOf(topic.title, query, options.caseSensitive)
    })
  }

  if (options.inNotes && topic.notes) {
    const notesCount = countOccurrences(topic.notes, query, options.caseSensitive)
    if (notesCount > 0) {
      out.push({
        ...base,
        field: 'notes',
        count: notesCount,
        snippet: snippetOf(topic.notes, query, options.caseSensitive)
      })
    }
  }

  if (options.inLabels) {
    const matched = topic.labels.filter(
      (label) => countOccurrences(label, query, options.caseSensitive) > 0
    )
    if (matched.length > 0) {
      out.push({
        ...base,
        field: 'label',
        count: matched.length,
        snippet: matched.join('、')
      })
    }
  }

  return out
}

function normalizeOptions(options: SearchOptions = {}): Required<SearchOptions> {
  return { ...DEFAULT_SEARCH_OPTIONS, ...options }
}

/** 在整张画布里搜索，按树的顺序返回命中 */
export function searchSheet(sheet: Sheet, query: string, options: SearchOptions = {}): SearchHit[] {
  const trimmed = query
  if (trimmed.length === 0) return []
  const opts = normalizeOptions(options)

  const out: SearchHit[] = []
  walk(sheet.rootTopic, (topic, _parent, depth) => {
    out.push(...hitsInTopic(topic, sheet.id, depth, trimmed, opts))
  })
  return out
}

/** 在整个工作簿里搜索（多画布时按画布顺序） */
export function searchWorkbook(workbook: Workbook, query: string, options: SearchOptions = {}): SearchHit[] {
  const out: SearchHit[] = []
  for (const sheet of workbook.sheets) out.push(...searchSheet(sheet, query, options))
  return out
}

/** 命中节点 id 集合（画布高亮用） */
export function hitTopicIds(hits: SearchHit[]): Set<string> {
  return new Set(hits.map((hit) => hit.topicId))
}

/** 只按标题统计某个工作簿里有多少处会被替换（替换前用来报数） */
export function countTitleMatches(workbook: Workbook, query: string, options: SearchOptions = {}): number {
  const opts = normalizeOptions(options)
  if (query.length === 0) return 0
  let total = 0
  for (const sheet of workbook.sheets) {
    walk(sheet.rootTopic, (topic) => {
      total += countOccurrences(topic.title, query, opts.caseSensitive)
    })
  }
  return total
}

/* ------------------------------------------------------------------ */
/* 筛选（按标记 / 标签）                                                */
/* ------------------------------------------------------------------ */

export interface TopicFilter {
  markers: string[]
  labels: string[]
}

export const EMPTY_FILTER: TopicFilter = { markers: [], labels: [] }

export function isFilterActive(filter: TopicFilter): boolean {
  return filter.markers.length > 0 || filter.labels.length > 0
}

/**
 * 单个节点是否命中筛选。
 * 规则：组内「或」（选中多个标记，有其中任意一个就算命中），组间「且」
 * （同时选了标记和标签时，两样都要满足）。
 */
export function topicMatchesFilter(topic: Topic, filter: TopicFilter): boolean {
  if (!isFilterActive(filter)) return true

  if (filter.markers.length > 0) {
    const ids = new Set((topic.markers ?? []).map((marker) => marker.markerId))
    if (!filter.markers.some((markerId) => ids.has(markerId))) return false
  }

  if (filter.labels.length > 0) {
    if (!filter.labels.some((label) => (topic.labels ?? []).includes(label))) return false
  }

  return true
}

export interface FilterResult {
  /** 真正命中的节点 */
  hits: Set<string>
  /** 需要保持正常显示的节点：命中节点 + 它们的祖先（否则命中节点会被折叠逻辑挡在外面看不见） */
  keep: Set<string>
}

/** 基于整棵树算出筛选结果 */
export function applyTopicFilter(root: Topic, filter: TopicFilter): FilterResult {
  const hits = new Set<string>()
  const keep = new Set<string>()

  if (!isFilterActive(filter)) return { hits, keep }

  const visit = (topic: Topic, trail: string[]): boolean => {
    const matched = topicMatchesFilter(topic, filter)
    const childMatched = topic.children.map((child) => visit(child, [...trail, topic.id])).some(Boolean)
    const floatingMatched = topic.detachedChildren
      .map((child) => visit(child, [...trail, topic.id]))
      .some(Boolean)

    const anyBelow = childMatched || floatingMatched
    if (matched) {
      hits.add(topic.id)
      keep.add(topic.id)
      for (const id of trail) keep.add(id)
    } else if (anyBelow) {
      // 没命中但有后代命中：保留路径，保证命中节点可见
      keep.add(topic.id)
    }
    return matched || anyBelow
  }

  visit(root, [])
  return { hits, keep }
}

/** 收集工作簿里出现过的所有标签及次数（筛选项与统计用） */
export function collectLabels(workbook: Workbook): Array<{ label: string; count: number }> {
  const counter = new Map<string, number>()
  for (const sheet of workbook.sheets) {
    walk(sheet.rootTopic, (topic) => {
      for (const label of topic.labels ?? []) {
        counter.set(label, (counter.get(label) ?? 0) + 1)
      }
    })
  }
  return [...counter.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN'))
}

/* ------------------------------------------------------------------ */
/* 统计                                                                */
/* ------------------------------------------------------------------ */

export interface SheetStats {
  topics: number
  /** 标题总字数（不含空白） */
  characters: number
  maxDepth: number
  leaves: number
  withNotes: number
  withAttachments: number
  withImages: number
  withFormulas: number
  markers: Array<{ markerId: string; count: number }>
  labels: Array<{ label: string; count: number }>
}

/** 统计一张画布 */
export function sheetStats(sheet: Sheet): SheetStats {
  let topics = 0
  let characters = 0
  let maxDepth = 0
  let leaves = 0
  let withNotes = 0
  let withAttachments = 0
  let withImages = 0
  let withFormulas = 0
  const markers = new Map<string, number>()
  const labels = new Map<string, number>()

  walk(sheet.rootTopic, (topic, _parent, depth) => {
    topics += 1
    if (depth > maxDepth) maxDepth = depth
    if (topic.children.length === 0 && topic.detachedChildren.length === 0) leaves += 1
    characters += [...topic.title].filter((ch) => !/\s/.test(ch)).length
    if (topic.notes) withNotes += 1
    if ((topic.attachments?.length ?? 0) > 0) withAttachments += 1
    if (topic.image) withImages += 1
    if (topic.formula) withFormulas += 1
    for (const marker of topic.markers ?? []) {
      markers.set(marker.markerId, (markers.get(marker.markerId) ?? 0) + 1)
    }
    for (const label of topic.labels ?? []) {
      labels.set(label, (labels.get(label) ?? 0) + 1)
    }
  })

  return {
    topics,
    characters,
    maxDepth,
    leaves,
    withNotes,
    withAttachments,
    withImages,
    withFormulas,
    markers: [...markers.entries()]
      .map(([markerId, count]) => ({ markerId, count }))
      .sort((a, b) => b.count - a.count || a.markerId.localeCompare(b.markerId)),
    labels: [...labels.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN'))
  }
}
