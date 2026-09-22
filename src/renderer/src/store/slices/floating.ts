import type { StateCreator } from 'zustand'
import {
  activeRoot,
  detachToFloating as detachToFloatingPure,
  reattachFloating as reattachFloatingPure
} from '@shared/model/tree'
import type { EditorState } from './types'

/**
 * 独立主题（浮动主题）动作：变成独立主题 / 放回结构。
 *
 * 位置计算与结构改动都放在**一次 mutate** 里，保持一步撤销；不设置 coalesceKey，
 * 因为 children/detachedChildren 的数组重排 patch 带下标，合并会错位（与 moveNode 同理）。
 */
export interface FloatingSlice {
  /** 把主题从树里摘出、挂到中心主题的 detachedChildren；position 由调用方按布局反算。 */
  detachToFloating(id: string, position?: { x: number; y: number }): boolean
  /** 把独立主题放回目标父级的 children；缺省 parentId 时放回中心主题下。 */
  attachBackFromFloating(id: string, parentId?: string, index?: number): boolean
}

export const createFloatingSlice: StateCreator<EditorState, [], [], FloatingSlice> = (
  set,
  get
) => ({
  detachToFloating: (id, position) => {
    const changed = get().mutate((draft) => {
      detachToFloatingPure(activeRoot(draft), id, position)
    }, '变为独立主题')
    if (changed) set({ selection: [id] })
    return changed
  },

  attachBackFromFloating: (id, parentId, index) => {
    const changed = get().mutate((draft) => {
      reattachFloatingPure(activeRoot(draft), id, parentId, index)
    }, '放回结构')
    if (changed) set({ selection: [id] })
    return changed
  }
})
