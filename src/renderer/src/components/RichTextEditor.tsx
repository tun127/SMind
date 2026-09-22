import { useEffect, useRef, type ReactElement } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { useEditor as useEditorStore } from '../store/editor'
import StarterKit from '@tiptap/starter-kit'
import { Color, FontSize, TextStyle } from '@tiptap/extension-text-style'
import TextAlign from '@tiptap/extension-text-align'
import { Slice } from '@tiptap/pm/model'
import { inlineRunsToRich, looksLikeMarkdown, parseInlineMarkdown } from '@shared/import/markdown'
import type { NodeLayout } from '@shared/layout/types'
import type { RichText } from '@shared/model/types'
import { richToTiptap, tiptapToRich, type TipTapDoc } from '@shared/richtext'
import { readFormatState, useFormatStore } from '../editor/formatStore'
// 三个自定义 mark（高亮 / 上标 / 下标）与中文紧贴的输入规则都拆在 editor/ 下单独成文件
// （各自的头部写了来龙去脉）：这样它们能被实测脚本原样复用，而不是只活在组件里。
import { CjkInlineRules } from '../editor/cjk-inline-rules'
import { Highlight, Subscript, Superscript } from '../editor/rich-marks'
import { TEXT_MAX, TEXT_MAX_ROOT } from '../render/measure'
import { takeTypedChar } from '../editor/typedChar'

export interface RichTextEditorProps {
  node: NodeLayout
  rich: RichText
  onChange(rich: RichText): void
  onCancel(): void
  /** 提交本次编辑并退出（编辑中按 `Enter`）：**不**顺便新建同级主题 */
  onCommit(): void
  onAddChild(): void
  onAddSibling(): void
  /**
   * 在**空主题**里按方向键：退出编辑并移动到相邻主题。
   *
   * 刚用 `Tab` / `Enter` 建出来的主题是空的，此时按方向键若只是让光标在空段里挪，
   * 用户看到的就是"方向键失灵"。空主题本来也没有"段落内导航"可言，
   * 所以直接把这次按键交给选择导航（与 Xmind 的手感一致）。
   */
  onNavigate(key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'): void
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
      TextAlign.configure({ types: ['paragraph'] }),
      Highlight,
      Superscript,
      Subscript,
      // 中文紧贴的行内写法（`神经网络**粗体**` / `a^2^` 等，见 CjkInlineRules）
      CjkInlineRules
    ],
    content: richToTiptap(rich),
    autofocus: true,
    // 让格式栏能实时反映选区状态
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: { class: 'rich-editor__content', spellcheck: 'false' },

      /**
       * 粘贴 Markdown 片段时按语法落地：`==高亮==`、`^上标^`、`~下标~`、`[^1]` 等。
       *
       * 三条防呆：
       * 1. 剪贴板里**有 HTML**（从网页/文档复制）时不动它——那是真正的富文本；
       * 2. 只处理**单行**纯文本，多行粘贴照旧当普通文本（免得把一段代码里的 `*` 当语法）；
       * 3. 解析后文字没变化（说明本来就没有标记）就放行，交给默认粘贴。
       */
      handlePaste: (view, event) => {
        const clipboard = event.clipboardData
        if (!clipboard) return false
        const text = clipboard.getData('text/plain')
        // 剪贴板里带 HTML（从网页/文档复制）时，只有纯文本本身**明显是 Markdown 标记**
        // 才抢过来按语法解析；否则交给编辑器默认粘贴（那是真正的富文本）
        if (clipboard.getData('text/html').length > 0 && !looksLikeMarkdown(text)) return false
        if (text.length === 0 || text.includes('\n')) return false
        const inline = parseInlineMarkdown(text)
        if (inline.text === text || inline.runs.length === 0) return false
        const pasted = inlineRunsToRich(inline.runs)
        if (!pasted) return false
        const paragraph = richToTiptap(pasted).content[0]
        try {
          const inlineNodes = view.state.schema.nodeFromJSON(paragraph).content
          event.preventDefault()
          view.dispatch(view.state.tr.replaceSelection(new Slice(inlineNodes, 0, 0)))
        } catch {
          // 解析失败就退回默认粘贴，别让用户粘不进去
          return false
        }
        return true
      },

      handleKeyDown: (view, event) => {
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
        // Enter：**只提交并退出编辑**，不顺便新建同级主题（想接着建，再按一次 Enter 即可，
        // 那时已不在编辑态，走的是"添加同级主题"）。Shift+Enter 仍是在段内换行。
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          handlers.current.onCommit()
          return true
        }

        // 空主题上的方向键 = 退出编辑并移动选择（见 RichTextEditorProps.onNavigate）
        const arrow =
          event.key === 'ArrowUp' ||
          event.key === 'ArrowDown' ||
          event.key === 'ArrowLeft' ||
          event.key === 'ArrowRight'
            ? event.key
            : null
        if (
          arrow &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          view.state.doc.childCount <= 1 &&
          view.state.doc.textContent === ''
        ) {
          event.preventDefault()
          handlers.current.onNavigate(arrow)
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

  /**
   * 把编辑区的宽度**写死成测量出来的文字宽度**。
   *
   * 为什么非写死不可：从 `.topic__editor` 到内容区，中间每一层都是 flex 子项
   * （Tiptap 的 `EditorContent` 还会再包一层 div），而 flex 子项的 `min-width: auto`
   * 以「最长不可断片段」为下限——一串没有空格的 `aaaa…`（长 URL 同理）会把内层顶得比节点还宽，
   * 文字于是排成一条长线、一路冲出节点外框。只改 CSS 收不住所有中间层（试过，不行）。
   *
   * 给了确定宽度还顺带保证**断行位置与 `measureTopic` 一致**（它就是按这个宽度贪心断行的），
   * 所以编辑态与提交后的排版不会"跳一下"。末尾 +1px 是留给小数宽度的余量，
   * 免得最后一个字被挤到下一行去。
   */
  /**
   * 当前编辑框的**测量宽度**（组词加宽的还原基准）。
   *
   * 它只由下面那个宽度 effect 写 —— 合并前它被两个 effect 同时改，是 D-08 的另一半。
   */
  const baseWidthRef = useRef(0)

  /**
   * 编辑框宽度：**唯一写入点**。
   *
   * 宽度只取「测量出来的文字宽度」，`maxWidth` **只允许 `100%`**。
   *
   * 曾经为了"组词不折行"在这里写过 `flex: 0 0 auto` + `maxWidth: none` —— 那是拿**溢出节点框**换不折行：
   * 实测组词期节点框 124px、编辑区 201px（报告 §15.2）。那不是修好，是把一个问题换成了另一个。
   * 现在改成让**框自己跟着内容长**（第 2 步：store 的 `editingDraftText` 喂给布局测量），
   * 编辑区永远待在框里。
   *
   * `flex` 必须**无条件**清空：上一次渲染可能已经把 inline `flex` 写进 DOM，只删赋值会留下顽固的逃逸。
   */
  useEffect(() => {
    if (!editor) return
    const cap = node.depth === 0 ? TEXT_MAX_ROOT : TEXT_MAX
    const textWidth = Math.min(cap, Math.ceil(Math.max(24, node.width - node.paddingX * 2))) + 1
    const dom = editor.view.dom
    baseWidthRef.current = textWidth
    dom.style.flex = ''
    dom.style.maxWidth = '100%'
    dom.style.width = `${textWidth}px`
  }, [editor, node.width, node.paddingX, node.depth])

  /**
   * 把编辑区里**还没提交进文档**的实时文本上报给 store，只喂布局测量用（D-07/D-08 第 2 步）。
   *
   * 为什么需要：组词/输入中的文本只存在于 DOM（ProseMirror 到提交才同步），布局看不到它 ——
   * 框不会长，拼音只能在窄框里折行。有了这条通道，框会跟着内容长，编辑区就不必（也不许）逃出框。
   *
   * **四条约束**：
   * ① 只写 `editingDraftText`，**不进文档、不动 editingRich**（提交仍以它们为准）；
   * ② **同步上报 + 按值去重**（不挂在 rAF 上）：override 读的是 `editingDraftText || editingText`，
   *   草稿只要落后一次就会**永久盖住真值** —— 实测「删掉文字后框不缩回」正是这么来的（报告 §30）：
   *   清空那一帧的 rAF 没跑到，草稿停在旧文本，于是"框永远按旧文本量"。
   *   去重（值没变就不写 store）保证同步上报不会带来多余重排；
   * ③ 卸载时**报空**收回，别把这一份草稿留给下一个编辑框；
   * ④ 去掉末尾换行 —— 编辑器总有一个收尾段落，不 trim 的话每次都会多量出一行空白。
   */
  useEffect(() => {
    if (!editor) return
    const dom = editor.view.dom
    const setDraft = useEditorStore.getState().setEditingDraftText
    let last = ''
    const report = (): void => {
      const text = (dom.textContent ?? '').replace(/\n+$/, '')
      if (text === last) return
      last = text
      setDraft(text)
    }
    const types = [
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'input',
      'beforeinput',
      'keyup'
    ]
    for (const type of types) dom.addEventListener(type, report, true)
    report()
    return () => {
      for (const type of types) dom.removeEventListener(type, report, true)
      setDraft('')
    }
  }, [editor])

  useEffect(() => {
    if (!editor) return
    // 进入编辑时把光标放到**末尾**：从「选中主题后直接打字」进来时，
    // 刚敲的那个字符就接在末尾，光标自然也该在末尾（否则会"打在别处"的错觉）。
    editor.commands.focus('end')

    /**
     * 「选中后直接打字」那一下塞进来的字符是**可让位**的。
     *
     * 中文输入法组词时，拼音的第一个字母（比如 `wo` 的 `w`）会先来一个看不出任何
     * 组词迹象的 keydown，我们据此把 `w` 写进了节点；紧接着输入法才 `compositionstart`。
     * 不处理的话，用户就会在空白框里看到一个凭空多出来的 `w`。
     *
     * 处理办法：
     * - 组词一开始，就把那个字符**选起来**——输入法的组词会直接替换掉它，
     *   文档不动（不打断正在进行的组词）；
     * - 组词结束时它若还赖着没被替换（有的输入法不替换选区），再兜底删掉。
     *
     * 判断依据是"那个区间里还是不是当初那个字符"：用户只要自己改过文本，区间对不上，
     * 我们就绝不插手——宁可留着一个字符，也不能误删用户刚打的东西。
     */
    const injected = takeTypedChar(node.id)
    if (!injected) return
    const view = editor.view
    const dom = view.dom
    const rangeOf = (): { from: number; to: number } | null => {
      const to = editor.state.doc.content.size - 1
      const from = to - injected.length
      if (from < 0) return null
      if (editor.state.doc.textBetween(from, to) !== injected) return null
      return { from, to }
    }
    if (!rangeOf()) return

    const onCompositionStart = (): void => {
      const range = rangeOf()
      if (!range) return
      editor.commands.setTextSelection(range)
    }
    const onCompositionEnd = (): void => {
      window.setTimeout(() => {
        if (editor.isDestroyed) return
        const range = rangeOf()
        if (!range) return
        editor.commands.deleteRange(range)
      }, 0)
    }

    dom.addEventListener('compositionstart', onCompositionStart, true)
    dom.addEventListener('compositionend', onCompositionEnd, true)
    return () => {
      dom.removeEventListener('compositionstart', onCompositionStart, true)
      dom.removeEventListener('compositionend', onCompositionEnd, true)
    }
  }, [editor, node.id])

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
