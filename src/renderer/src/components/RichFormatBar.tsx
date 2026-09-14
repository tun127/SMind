import type { MouseEvent, ReactElement } from 'react'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Eraser,
  Italic,
  List,
  Strikethrough,
  Subscript as SubscriptIcon,
  Superscript as SuperscriptIcon,
  Underline
} from 'lucide-react'
import { useFormatStore, type RichEditor } from '../editor/formatStore'

const COLORS = ['#1f2328', '#EB5757', '#F2994A', '#E2B93B', '#27AE60', '#2D9CDB', '#2F6BFF', '#9B51E0']
const SIZES = [12, 14, 16, 18, 22, 28]

type Chain = ReturnType<RichEditor['chain']>

/** 仅在进入编辑态时出现，作用于当前节点内的文本 */
export default function RichFormatBar(): ReactElement | null {
  const editor = useFormatStore((store) => store.editor)
  const state = useFormatStore((store) => store.state)

  // 只让按钮不抢焦点；下拉框必须保留默认行为才能展开
  const keepFocus = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement | null
    if (target && target.closest('button')) event.preventDefault()
  }

  if (!editor) return null

  /**
   * 行内格式（加粗/颜色/字号等）在「光标折叠、没有选中文字」时，
   * 只会影响接下来输入的字，用户会以为点了没反应。
   * 所以没有选区时先全选整个节点，应用后再把光标放回原处。
   */
  const applyInline = (run: (chain: Chain) => Chain): void => {
    const selection = editor.state.selection
    if (selection.empty) {
      const caret = selection.from
      run(editor.chain().focus().selectAll()).run()
      if (caret <= editor.state.doc.content.size) editor.commands.setTextSelection(caret)
    } else {
      run(editor.chain().focus()).run()
    }
  }

  /** 段落级格式（对齐、列表）直接作用于光标所在段落 */
  const chain = (): Chain => editor.chain().focus()

  // 当前字号不在预设列表里时，补进选项，避免下拉框显示为空
  const sizeOptions =
    state.fontSize !== null && !SIZES.includes(state.fontSize)
      ? [...SIZES, state.fontSize].sort((a, b) => a - b)
      : SIZES

  return (
    <div className="formatbar" onMouseDown={keepFocus}>
      <div className="formatbar__group">
        <button
          type="button"
          className={state.bold ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="加粗（未选中文字时作用于整个节点）"
          onClick={() => applyInline((c) => c.toggleBold())}
        >
          <Bold size={15} />
        </button>
        <button
          type="button"
          className={state.italic ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="倾斜"
          onClick={() => applyInline((c) => c.toggleItalic())}
        >
          <Italic size={15} />
        </button>
        <button
          type="button"
          className={state.underline ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="下划线"
          onClick={() => applyInline((c) => c.toggleUnderline())}
        >
          <Underline size={15} />
        </button>
        <button
          type="button"
          className={state.strike ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="删除线"
          onClick={() => applyInline((c) => c.toggleStrike())}
        >
          <Strikethrough size={15} />
        </button>
        <button
          type="button"
          className={state.script === 'super' ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="上标（也可以打 ^x^，如 a^2^）"
          onClick={() => applyInline((c) => c.toggleMark('superscript'))}
        >
          <SuperscriptIcon size={15} />
        </button>
        <button
          type="button"
          className={state.script === 'sub' ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="下标（也可以打 ~x~，如 a~1~）"
          onClick={() => applyInline((c) => c.toggleMark('subscript'))}
        >
          <SubscriptIcon size={15} />
        </button>
      </div>

      <div className="formatbar__divider" />

      <div className="formatbar__group">
        <span className="formatbar__label">字号</span>
        <select
          className="fmt-select"
          value={state.fontSize ?? ''}
          onChange={(event) => {
            const value = event.target.value
            applyInline((c) => (value === '' ? c.unsetFontSize() : c.setFontSize(`${value}px`)))
          }}
        >
          <option value="">默认</option>
          {sizeOptions.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </div>

      <div className="formatbar__divider" />

      <div className="formatbar__group">
        <span className="formatbar__label">颜色</span>
        {COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={state.color === color ? 'color-dot color-dot--active' : 'color-dot'}
            style={{ background: color }}
            title={color}
            onClick={() => applyInline((c) => c.setColor(color))}
          />
        ))}
        <button
          type="button"
          className="fmt-btn"
          title="恢复默认颜色"
          onClick={() => applyInline((c) => c.unsetColor())}
        >
          <Eraser size={14} />
        </button>
      </div>

      <div className="formatbar__divider" />

      <div className="formatbar__group">
        <button
          type="button"
          className={state.align === 'left' ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="左对齐"
          onClick={() => chain().setTextAlign('left').run()}
        >
          <AlignLeft size={15} />
        </button>
        <button
          type="button"
          className={state.align === 'center' ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="居中"
          onClick={() => chain().setTextAlign('center').run()}
        >
          <AlignCenter size={15} />
        </button>
        <button
          type="button"
          className={state.align === 'right' ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="右对齐"
          onClick={() => chain().setTextAlign('right').run()}
        >
          <AlignRight size={15} />
        </button>
        <button
          type="button"
          className={state.bullet ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="项目符号"
          onClick={() => chain().toggleBulletList().run()}
        >
          <List size={15} />
        </button>
      </div>
    </div>
  )
}
