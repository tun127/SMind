import { useEffect, useRef, useState, type ReactElement } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Color, FontSize, TextStyle } from '@tiptap/extension-text-style'
import TextAlign from '@tiptap/extension-text-align'
import { Slice } from '@tiptap/pm/model'
import { inlineRunsToRich, looksLikeMarkdown, parseInlineMarkdown } from '@shared/import/markdown'
import type { NodeLayout } from '@shared/layout/types'
import type { RichText } from '@shared/model/types'
import { richToTiptap, tiptapToRich, type TipTapDoc } from '@shared/richtext'
import { readFormatState, useFormatStore } from '../editor/formatStore'
import { draftBoxWidth, measureContentWidth } from '../editor/composition-width'
// 三个自定义 mark（高亮 / 上标 / 下标）与中文紧贴的输入规则都拆在 editor/ 下单独成文件
// （各自的头部写了来龙去脉）：这样它们能被实测脚本原样复用，而不是只活在组件里。
import { CjkInlineRules } from '../editor/cjk-inline-rules'
import { Highlight, Subscript, Superscript } from '../editor/rich-marks'
import { TEXT_MAX, TEXT_MAX_ROOT } from '../render/measure'
import { takeTypedChar } from '../editor/typedChar'
// 注意别名：本文件已经从 `@tiptap/react` 导入了同名的 `useEditor`（编辑器实例），
// 直接同名导入会把 tiptap 那个遮蔽掉 —— 编辑器建不出来、画布直接空白。
import { useEditor as useEditorStore } from '../store/editor'

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
  const reportDraftText = useEditorStore((store) => store.reportDraftText)

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

  /** 编辑区**当前内容**所需的宽度（0 = 按测得宽度即可）。只存状态，DOM 宽度由下面**唯一**那处写。 */
  const [contentWidth, setContentWidth] = useState(0)

  /**
   * 编辑框宽度：**唯一写入点**。
   *
   * 宽度取 `draftBoxWidth(测得宽度, 内容所需宽度, 上限)` —— 内容更宽就放宽、否则保持测得宽度。
   *
   * 为什么不再按"是否在组词"来判（第二代做法的漏洞，报告 §18 实测）：
   * `compositionend` 一到就把加宽归零，而此时文本**还在编辑区里、没提交进文档、测量也没跟上**，
   * 于是编辑框缩回节点内宽（实测 49px），未提交的拼音被挤成 7 行；按 Enter 提交后测量才跟上、
   * 看起来"又正常了"。→ 用户看到的是"没按 Enter 会扁"。改成按内容算之后，这个中间态自动被覆盖。
   *
   * 内容更宽时还要**解除 flex 收缩**（`flex: 0 0 auto`）：`.rich-editor__content` 是
   * `.topic__editor` 的 flex 子项、自身又 `min-width: 0`，只写 `width` 会被 flex-shrink
   * 立刻压回节点内宽，再在这个窄宽度上 `overflow-wrap: anywhere` 断行 —— 拼音照样折成多行。
   * 这是报告 D-07 的根因：`515aac2` 的 A3 当初只放开了 `max-width`，**放错了约束**，实测无效。
   */
  useEffect(() => {
    if (!editor) return
    const cap = node.depth === 0 ? TEXT_MAX_ROOT : TEXT_MAX
    const textWidth = Math.min(cap, Math.ceil(Math.max(24, node.width - node.paddingX * 2))) + 1
    const dom = editor.view.dom
    baseWidthRef.current = textWidth
    const target = draftBoxWidth(textWidth, contentWidth, cap)
    if (target > textWidth) {
      dom.style.flex = '0 0 auto'
      dom.style.maxWidth = 'none'
      dom.style.width = `${target}px`
    } else {
      dom.style.flex = ''
      dom.style.maxWidth = '100%'
      dom.style.width = `${textWidth}px`
    }
  }, [editor, node.width, node.paddingX, node.depth, contentWidth])

  /**
   * 编辑区**当前内容**需要多宽 → `contentWidth`。只读 DOM、只改状态，**不碰宽度**：
   * 宽度是上面那一处的专属职责（D-08），这样两者不可能再抢写。
   *
   * 为什么读 DOM 内容而不是 `compositionupdate.data`：事件的时序不等于内容的存在。
   * 组词结束后文本仍在编辑区里，读内容才对得上；且这样才能覆盖"纯键盘草稿"。
   *
   * 量宽用 canvas（`composingTextWidth`，与画布测量共用同一份字体串），逐行取最长那行。
   * 用 rAF 合并同一帧里的多次事件（组词时每个音节都会触发一次）；变化不足 1px 不写状态，
   * 免得和宽度 effect 之间形成无谓的重渲染。
   */
  useEffect(() => {
    if (!editor) return
    const dom = editor.view.dom
    let frame = 0
    const recompute = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        if (editor.isDestroyed) return
        // 末尾换行不算内容（编辑器里总有个收尾段落），否则会多量出一行空白
        const draft = (dom.innerText ?? '').replace(/\n+$/, '')
        let widest = 0
        for (const line of draft.split('\n')) {
          if (line.length === 0) continue
          const width = measureContentWidth(dom, line)
          if (width > widest) widest = width
        }
        setContentWidth((prev) => (Math.abs(prev - widest) < 1 ? prev : widest))
        // 再报给布局：**节点框**也要跟着这段草稿变宽。
        // 只把编辑区自身撑开是不够的 —— 框不动，文字就只能在框内折行或溢出框外，
        // 用户看到的就是"打字时排版是坏的、按 Enter 才恢复正常"（报告 D-07 / §18）。
        reportDraftText(draft)
      })
    }
    recompute()
    const types = ['compositionstart', 'compositionupdate', 'compositionend', 'input']
    for (const type of types) dom.addEventListener(type, recompute, true)
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      for (const type of types) dom.removeEventListener(type, recompute, true)
      // 编辑区卸载（提交 / 取消 / 切节点）→ 收回草稿，测量回到文档内容
      reportDraftText('')
    }
  }, [editor, node.fontSize, reportDraftText])

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
