/**
 * 视图切片（自 `editor.ts` 的「视图」分节整块搬出，成员体逐字未改）。
 *
 * **`viewLock` 归本切片**（计划表 §八 的实测归属）：它的初值与读写在 `localStorage` 上，
 * `tabs.ts` 的快照会带上它，`newDocument` / `loadDocument` 还要按「启动默认视角锁定」重算它；
 * 把状态与写入口放在一处，跨切片的读取只在文档切片那一处（写 `viewLock` 不需要额外动作）。
 *
 * `readPersistedViewLock` / `persistViewLock` 随本切片搬来（**仍在 store 内**、仍是文件私有函数、
 * 逻辑逐字未改）：它们要跨切片用（文档切片的新建/打开也要读），若留在 `editor.ts` 会让切片反向
 * import 组合根、形成运行期循环依赖。这正是计划表「不要搬」要防的事——它们没有离开 store 层。
 *
 * `lastFold` 也在这里：它在 `editor.ts` 内只写不读，唯一消费者是 Canvas 的镜头锚点。
 *
 * 本文件同时拥有这些成员在 `EditorState` 里的**声明**（接口逐字搬来）。
 */

import { clampZoom } from '@shared/model/editor-pure'

import type { StateCreator } from 'zustand'
import type { EditorState } from './types'

/* ---- 视角锁定的会话间持久化 ----
 * viewLock 原来是纯会话状态：每次重启 / 新开文档都回到设置里的默认值——
 * 用户刚把开关打开，窗口一重启就"消失"了（关闭态不显眼，看起来像功能坏了）。
 * 这里用 localStorage 记住最近一次的开关选择：启动、新开文档、打开文档都恢复它；
 * 「启动默认视角锁定」设置只在用户从未动过开关时作为初值。 */
const VIEW_LOCK_KEY = 'smind.viewLock'

export function readPersistedViewLock(): boolean | null {
  try {
    const raw = localStorage.getItem(VIEW_LOCK_KEY)
    if (raw === '1') return true
    if (raw === '0') return false
    return null
  } catch {
    return null
  }
}

function persistViewLock(on: boolean): void {
  try {
    localStorage.setItem(VIEW_LOCK_KEY, on ? '1' : '0')
  } catch {
    /* 存不了就算了，只是下次不记忆 */
  }
}

export interface ViewSlice {
  zoom: number
  pan: { x: number; y: number }

  /* ---- 视图 ---- */
  setZoom(zoom: number): void
  setPan(pan: { x: number; y: number }): void
  /**
   * 视角锁定：开启后画布始终把**选中的主题**按在视口中央。
   *
   * 方向键在主题间移动、点大纲、搜索跳转、拖完重排……视角都会跟过去，
   * 长导图里不必再手动拖画布去找"现在到底选到哪了"。
   */
  viewLock: boolean
  setViewLock(on: boolean): void
  /** 切换视角锁定，返回切换后的状态（提示语要用） */
  toggleViewLock(): boolean
  /**
   * 最近一次折叠 / 展开的是哪个节点（`at` 是时间戳，用来去重）。
   *
   * 画布据此做**镜头锚点补偿**：折叠会让整张图重排，被折叠的那个节点会跟着挪位置，
   * 于是"视角丢失"（用户原话）。锚定它、让它在屏幕上原地不动，才符合直觉——
   * 而不是把镜头拉去居中中心主题。所有折叠入口（工具栏 / 菜单 / 空格 / 按侧徽标 / AI）
   * 都走 `setCollapsed` / `setFoldSide`，所以这个信号在 store 里记一次就全覆盖。
   */
  lastFold: { id: string; at: number } | null
}

export const createViewSlice: StateCreator<EditorState, [], [], ViewSlice> = (set, get) => ({
  zoom: 1,
  pan: { x: 0, y: 0 },
  // 上次会话的开关选择优先；从未动过开关才用设置默认值
  viewLock: readPersistedViewLock() ?? false,
  lastFold: null,

  /* ------------------------------------------------------------------ */
  /* 视图                                                                */
  /* ------------------------------------------------------------------ */

  setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),

  setPan: (pan) => set({ pan }),

  setViewLock: (on) => {
    persistViewLock(on)
    set({ viewLock: on })
  },

  toggleViewLock: () => {
    const next = !get().viewLock
    persistViewLock(next)
    set({ viewLock: next })
    return next
  }
})
