import { useEffect, useRef, type ReactElement } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Color, FontSize, TextStyle } from '@tiptap/extension-text-style'
import TextAlign from '@tiptap/extension-text-align'
import type { NodeLayout } from '@shared/layout/types'
import type { RichText } from '@shared/model/types'
import { richToTiptap, tiptapToRich, type TipTapDoc } from '@shared/richtext'
import { readFormatState, useFormatStore } from '../editor/formatStore'

export interface RichTextEditorProps {
  node: NodeLayout
  rich: RichText
  onChange(rich: RichText): void
  onCancel(): void
  onAddChild(): void
  onAddSibling(): void
}

export default function RichTextEditor(props: RichTextEditorProps): ReactElement {
  const { node, rich } = props

  // 编辑器实例只创建一次，回调统一走 ref，避免闭包过期
  const handlers = useRef(props)
  handlers.current = props

  const setEditor = useFormatStore((store) => store.setEditor)
  const setState = useFormatStore((store) => store.setState)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        blockquote: false,
        horizontalRule: false,
        orderedList: false,
        link: false
      }),
      TextStyle,
      Color,
      FontSize,
      TextAlign.configure({ types: ['paragraph'] })
    ],
    content: richToTiptap(rich),
    autofocus: true,
    // 让格式栏能实时反映选区状态
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: { class: 'rich-editor__content', spellcheck: 'false' },
      handleKeyDown: (_view, event) => {
        // 中文输入法组词期间的按键交还输入法
        if (event.isComposing || event.keyCode === 229) return false

        if (event.key === 'Escape') {
          event.preventDefault()
          handlers.current.onCancel()
          return true
        }
        // 与 Xmind 一致：Tab 新建子主题
        if (event.key === 'Tab') {
          event.preventDefault()
          handlers.current.onAddChild()
          return true
        }
        // 与 Xmind 一致：Enter 新建同级主题；Shift+Enter 在段内换行
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          handlers.current.onAddSibling()
          return true
        }
        return false
      }
    },
    onUpdate: ({ editor: instance }) => {
      handlers.current.onChange(tiptapToRich(instance.getJSON() as unknown as TipTapDoc))
    },
    onTransaction: ({ editor: instance }) => {
      setState(readFormatState(instance))
    }
    // 注意：这里刻意不做「失焦即提交」。
    // 点底部格式栏的下拉框时焦点会离开编辑器，若在 blur 里提交，
    // 编辑态会被立刻关掉、格式栏消失，用户根本来不及选字号。
    // 提交统一由「点击画布 / 点击其他节点 / 保存 / 关闭窗口」触发。
  })

  useEffect(() => {
    if (!editor) return
    setEditor(editor)
    setState(readFormatState(editor))
    return () => setEditor(null)
  }, [editor, setEditor, setState])

  return (
    <div
      className="topic__editor"
      style={{ padding: `${node.paddingY}px ${node.paddingX}px`, fontSize: node.fontSize }}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <EditorContent editor={editor} />
    </div>
  )
}
