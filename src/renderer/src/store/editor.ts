import { create } from 'zustand'
import { enablePatches, produce } from 'immer'
import { type AppSettings } from '@shared/ipc'
import type { Workbook } from '@shared/model/types'
import { hasFormatting, normalizeRich } from '@shared/richtext'

import { activeRoot, findTopic } from '@shared/model/tree'

import type { EditorState } from './slices/types'
import { createViewSlice } from './slices/view'
import { createSearchSlice } from './slices/search'
import { createOutlineSlice } from './slices/outline'
import { createHistorySlice } from './slices/history'
import { createDocumentSlice } from './slices/document'
import { createSelectionSlice } from './slices/selection'
import { createStructureSlice } from './slices/structure'
import { createMoveSlice } from './slices/move'
import { createFloatingSlice } from './slices/floating'
import { createNodeContentSlice } from './slices/node-content'
import { createOverlaysSlice } from './slices/overlays'
import { createThemeSlice } from './slices/theme'

/**
 * 公开面：`themeColorsOf` / `overlayToggleOf` 已下沉到 `@shared/model/editor-pure`。
 * 这里再导出一次，Canvas / export/index / ThemePanel / overlay-group 的调用点一行都不用改。
 */
export type { EditorState, SearchState } from './slices/types'
export { overlayToggleOf, themeColorsOf } from '@shared/model/editor-pure'

enablePatches()

/**
 * 改应用设置：写进 store 并落盘。所有「默认值」入口（格式栏默认样式面板 /
 * 主题面板的默认主题 / 工具栏收纳）都走这一个门，保证 settings.json 是唯一真相。
 */
export async function patchAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...useEditor.getState().appSettings, ...patch }
  useEditor.getState().setAppSettings(next)
  try {
    await window.api.settingsSave(next)
  } catch {
    /* 落盘失败不影响本次会话 */
  }
  return next
}

export const useEditor = create<EditorState>()((...a) => ({
  ...createViewSlice(...a),
  ...createSearchSlice(...a),
  ...createOutlineSlice(...a),
  ...createHistorySlice(...a),
  ...createDocumentSlice(...a),
  ...createSelectionSlice(...a),
  ...createStructureSlice(...a),
  ...createMoveSlice(...a),
  ...createFloatingSlice(...a),
  ...createNodeContentSlice(...a),
  ...createOverlaysSlice(...a),
  ...createThemeSlice(...a)
}))

/* ------------------------------------------------------------------ */
/* 派生工具                                                            */
/* ------------------------------------------------------------------ */

/**
 * 落盘用的快照。
 * 把「正在编辑但还没提交」的内容也包含进去，
 * 这样自动保存不会因为用户还在输入而丢掉最后几个字，
 * 同时也不需要打断用户的输入（不会改动编辑态）。
 */
export function snapshotForSave(state: EditorState): Workbook {
  if (!state.editingId) return state.workbook
  const editingId = state.editingId
  const rich = state.editingRich
  const text = state.editingText
  return produce(state.workbook, (draft) => {
    const topic = findTopic(activeRoot(draft), editingId)
    if (!topic) return
    topic.title = text
    const normalized = rich ? normalizeRich(rich) : null
    topic.titleRich = normalized && hasFormatting(normalized) ? normalized : undefined
  })
}
