import { create } from 'zustand'
import type { useEditor } from '@tiptap/react'

/** 取 useEditor 返回的非空类型，避免直接依赖 @tiptap/core 的类型导出 */
export type RichEditor = NonNullable<ReturnType<typeof useEditor>>

export interface FormatState {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  /** 高亮（`==高亮==` 与格式栏的高亮按钮是同一个 mark） */
  highlight: boolean
  /** 上标 / 下标（互斥，都没有时为 null） */
  script: 'super' | 'sub' | null
  color: string | null
  fontSize: number | null
  align: 'left' | 'center' | 'right'
  bullet: boolean
}

const INITIAL: FormatState = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  highlight: false,
  script: null,
  color: null,
  fontSize: null,
  align: 'center',
  bullet: false
}

interface FormatStore {
  state: FormatState
  editor: RichEditor | null
  setState(patch: Partial<FormatState>): void
  setEditor(editor: RichEditor | null): void
}

/** 当前正在编辑的富文本编辑器与格式状态，供底部格式栏使用 */
export const useFormatStore = create<FormatStore>()((set) => ({
  state: INITIAL,
  editor: null,
  setState: (patch) => set((store) => ({ state: { ...store.state, ...patch } })),
  setEditor: (editor) => set({ editor, state: INITIAL })
}))

/** 从编辑器读出当前选区/光标处的格式，用于高亮格式栏按钮 */
export function readFormatState(editor: RichEditor): FormatState {
  const attributes = editor.getAttributes('textStyle') as { color?: unknown; fontSize?: unknown }
  const parsedSize =
    typeof attributes.fontSize === 'string' ? Number.parseFloat(attributes.fontSize) : Number.NaN
  const align: FormatState['align'] = editor.isActive({ textAlign: 'right' })
    ? 'right'
    : editor.isActive({ textAlign: 'left' })
      ? 'left'
      : 'center'

  return {
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    underline: editor.isActive('underline'),
    strike: editor.isActive('strike'),
    highlight: editor.isActive('highlight'),
    script: editor.isActive('superscript') ? 'super' : editor.isActive('subscript') ? 'sub' : null,
    color: typeof attributes.color === 'string' ? attributes.color : null,
    fontSize: Number.isFinite(parsedSize) ? parsedSize : null,
    align,
    bullet: editor.isActive('bulletList')
  }
}
