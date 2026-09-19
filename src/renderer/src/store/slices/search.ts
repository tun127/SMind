/**
 * 检索与筛选切片（自 `editor.ts` 的「检索与筛选」分节整块搬出，成员体逐字未改）。
 *
 * 搜索条件放在 store 里，画布与搜索面板才能用同一份条件算命中；`EMPTY_SEARCH` 随本切片搬来。
 * 替换与筛选都走 `get().mutate(...)`（历史切片拥有 mutate），跨切片调用经 `get()` 不变。
 *
 * 本文件同时拥有这些成员在 `EditorState` 里的**声明**（接口逐字搬来）。
 */

import {
  EMPTY_FILTER,
  countOccurrences,
  countTitleMatches,
  normalizeQuery,
  replaceInText,
  type SearchOptions,
  type TopicFilter
} from '@shared/search'
import { activeRoot, findTopic, walk } from '@shared/model/tree'

import type { StateCreator } from 'zustand'
import type { EditorState } from './types'
import type { SearchState } from './types'

const EMPTY_SEARCH: SearchState = {
  query: '',
  replacement: '',
  options: { caseSensitive: false, inNotes: false, inLabels: false }
}

export interface SearchSlice {
  /** 搜索条件：面板与画布共用，保证两边看到的命中完全一致 */
  search: SearchState
  /** 按标记 / 标签筛选 */
  filter: TopicFilter

  /* ---- 检索（P7） ---- */
  setSearchQuery(query: string): void
  setSearchReplacement(replacement: string): void
  setSearchOption(key: keyof SearchOptions, value: boolean): void
  resetSearch(): void
  /** 把标题里的关键词全部替换掉，返回替换处数 */
  replaceAllInTitles(): number
  /** 替换某一个节点标题里的关键词，返回替换处数 */
  replaceInTopic(topicId: string): number

  /* ---- 筛选（P7） ---- */
  toggleFilterMarker(markerId: string): void
  toggleFilterLabel(label: string): void
  clearFilter(): void
}

export const createSearchSlice: StateCreator<EditorState, [], [], SearchSlice> = (set, get) => ({
  search: { ...EMPTY_SEARCH },
  filter: { ...EMPTY_FILTER },

  /* ------------------------------------------------------------------ */
  /* 检索与筛选                                                          */
  /* ------------------------------------------------------------------ */

  setSearchQuery: (query) => set((s) => ({ search: { ...s.search, query } })),

  setSearchReplacement: (replacement) => set((s) => ({ search: { ...s.search, replacement } })),

  setSearchOption: (key, value) =>
    set((s) => ({ search: { ...s.search, options: { ...s.search.options, [key]: value } } })),

  resetSearch: () => set({ search: { ...EMPTY_SEARCH } }),

  replaceAllInTitles: () => {
    const { search, workbook } = get()
    // 与搜索用同一个归一后的关键词：否则列表有命中、替换报 0 处
    const query = normalizeQuery(search.query)
    if (query.length === 0) return 0

    // 先按当前条件数出总处数（mutate 不返回值），再统一替换
    const total = countTitleMatches(workbook, query, search.options)
    if (total === 0) return 0

    get().mutate((draft) => {
      for (const sheet of draft.sheets) {
        walk(sheet.rootTopic, (topic) => {
          const result = replaceInText(
            topic.title,
            query,
            search.replacement,
            search.options.caseSensitive
          )
          if (result.count === 0) return
          topic.title = result.text
          // 文本长度变了，原来的富文本区间就对不上了，必须一并清掉
          topic.titleRich = undefined
        })
      }
    }, '替换全部')
    return total
  },

  replaceInTopic: (topicId) => {
    const { search, workbook } = get()
    const query = normalizeQuery(search.query)
    if (query.length === 0) return 0

    const root = activeRoot(workbook)
    const topic = findTopic(root, topicId)
    if (!topic) return 0
    const count = countOccurrences(topic.title, query, search.options.caseSensitive)
    if (count === 0) return 0

    get().mutate((draft) => {
      const target = findTopic(activeRoot(draft), topicId)
      if (!target) return
      const result = replaceInText(
        target.title,
        query,
        search.replacement,
        search.options.caseSensitive
      )
      target.title = result.text
      target.titleRich = undefined
    }, '替换文本')
    return count
  },

  toggleFilterMarker: (markerId) =>
    set((s) => ({
      filter: {
        ...s.filter,
        markers: s.filter.markers.includes(markerId)
          ? s.filter.markers.filter((id) => id !== markerId)
          : [...s.filter.markers, markerId]
      }
    })),

  toggleFilterLabel: (label) =>
    set((s) => ({
      filter: {
        ...s.filter,
        labels: s.filter.labels.includes(label)
          ? s.filter.labels.filter((item) => item !== label)
          : [...s.filter.labels, label]
      }
    })),

  clearFilter: () => set({ filter: { ...EMPTY_FILTER } })
})
