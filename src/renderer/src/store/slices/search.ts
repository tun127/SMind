/**
 * 检索与筛选切片（自 `editor.ts` 的「检索与筛选」分节整块搬出，成员体逐字未改）。
 *
 * 搜索条件放在 store 里，画布与搜索面板才能用同一份条件算命中；`EMPTY_SEARCH` 随本切片搬来。
 * 替换与筛选都走 `get().mutate(...)`（历史切片拥有 mutate），跨切片调用经 `get()` 不变。
 *
 * 本文件同时拥有这些成员在 `EditorState` 里的**声明**（接口逐字搬来）。
 */

import { type SearchOptions, type TopicFilter } from '@shared/search'

import type { SearchState } from './types'

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

/** 实现（状态初值与动作）随「B1 第二步 B」的对应批次搬入；本文件此刻只有类型声明。 */
