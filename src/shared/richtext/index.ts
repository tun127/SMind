/**
 * 富文本数据层。
 *
 * 两个方向的职责：
 *  1. 富文本 <-> 纯文本：`.xmind` 的 `title` 只认纯文本，
 *     所以富文本必须能无损地降级成纯文本写进 title，保证外部编辑器可读。
 *  2. 富文本 <-> TipTap(ProseMirror) JSON：编辑器与内核模型之间的互转。
 *
 * 这里的函数全部是纯函数，不依赖浏览器，可以直接被自检脚本覆盖。
 */
import type { RichText, RichTextParagraph, RichTextRun } from '../model/types'
import { MD_MONO_FONT, isMonoFontFamily } from '../mono-font'

/* ------------------------------------------------------------------ */
/* 基础构造与纯文本互转                                                */
/* ------------------------------------------------------------------ */

/** 纯文本 -> 富文本（按 \n 切段落） */
export function richFromPlain(text: string): RichText {
  return {
    paragraphs: text
      .split('\n')
      .map((line) => (line.length > 0 ? { runs: [{ text: line }] } : { runs: [] }))
  }
}

/**
 * 把一段文本**接到富文本末尾**（用于「选中主题后直接打字就进入编辑」）。
 *
 * 刻意**不覆盖**原有文字：误按一个字母就把整句标题冲掉太危险，所以是追加。
 * 追加的 run 不带任何格式，避免凭空继承上一段的加粗 / 颜色。
 */
export function appendToRich(rich: RichText, text: string): RichText {
  const paragraphs =
    rich.paragraphs.length > 0
      ? rich.paragraphs.map((paragraph) => ({ ...paragraph, runs: [...paragraph.runs] }))
      : [{ runs: [] }]
  const last = paragraphs[paragraphs.length - 1]
  if (last) last.runs.push({ text })
  return { paragraphs }
}

export function paragraphText(paragraph: RichTextParagraph): string {
  return paragraph.runs.map((run) => run.text).join('')
}

/** 富文本 -> 纯文本。项目符号降级为 "• " 前缀，外部编辑器至少能看出层次 */
export function plainTextOf(rich: RichText | undefined): string {
  if (!rich) return ''
  return rich.paragraphs
    .map((paragraph) => (paragraph.bullet ? '• ' : '') + paragraphText(paragraph))
    .join('\n')
}

/**
 * 节点文本的默认对齐方式是居中。
 * 因此只有显式的 left / right 才被当作「有格式」，
 * 否则每次编辑都会被判定为富文本，.xmind 里会塞满无意义的 titleRich。
 */
export function isExplicitAlign(align: RichTextParagraph['align']): boolean {
  return align === 'left' || align === 'right'
}

/** 高亮底色：画布、编辑框、导出三处共用同一份颜色 */
export const HIGHLIGHT_BG = 'rgba(255, 214, 0, 0.35)'

/**
 * 上下标相对正文的字号比例。
 * 测量与渲染必须一致：测量按这个比例算宽高，渲染直接把缩小后的字号交给字体。
 */
export const SCRIPT_FONT_RATIO = 0.72

/**
 * HTML 转义（粘贴 Markdown 片段、派生备注 HTML 时都要拼成 HTML，不能让内容逃出去）。
 * 项目里一度有 4 份实现，统一到这里，避免哪天只补了一处、被别的入口绕过去。
 */
export function escapeHtml(text: string): string {
  return (
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // 单引号也转：原来各处的实现里有的转、有的不转，
      // 合并后取**超集**——将来若被用进属性值（'…'）也不会漏。
      .replace(/'/g, '&#39;')
  )
}

/**
 * 由纯文本派生备注的 HTML。
 *
 * `notes`（纯文本）与 `notesHtml`（XHTML）在 .xmind 里是同一份内容的两种表示，
 * 必须从**同一处**派生——这个表达式原先在两个文件里一字不差地各写了一遍，
 * 哪天要调整（比如换行改用 `<br />`）很容易只改一处、留下不一致。
 */
export function notesHtmlFrom(text: string): string {
  return `<p>${escapeHtml(text).replace(/\n/g, '<br/>')}</p>`
}

/**
 * 行内 run → HTML 片段。
 *
 * 用途：把 Markdown 行内语法**粘贴进节点**时，先转成 HTML 再交给编辑器，
 * 编辑器（TipTap）会按自己的 schema 解析成带 mark 的文本。
 * 与编辑器里注册的 mark 名字一一对应（mark/strong/em/s/code/sup/sub）。
 *
 * ⚠️ 参数类型与真实模型**不完全一致**：这里的 `mono?: boolean` 在 `RichTextRun`
 * （`model/types.ts`）里并不存在——代码库里"等宽"的唯一表示是 `fontFamily`
 * （`import/markdown.ts` 写入、`outline/index.ts` 用 `/mono/i` 嗅探）。也就是说
 * `<code>` 那条分支**不可能被真实的 `RichTextRun` 触发**，它只服务调用方现造的临时对象
 * （自检就是这么用的）。审计建议删掉这个函数，但**自检里有断言在用它**，故保留；
 * 哪天真要走到 `<code>`，先把类型对齐到 `fontFamily` 口径，别再凭空多一个 `mono`。
 *
 * 编辑器那头的 `code` mark 与这里的 `fontFamily` 是**同一件事**的两种表示，
 * 对齐由下面的 `runToMarks` / `marksToStyle` 负责（见「行内代码」那两条注释）。
 */
export function runsToHtml(
  runs: Array<{
    text: string
    bold?: boolean
    italic?: boolean
    strike?: boolean
    underline?: boolean
    highlight?: boolean
    script?: 'super' | 'sub'
    mono?: boolean
  }>
): string {
  return runs
    .map((run) => {
      let html = escapeHtml(run.text).replace(/\n/g, '<br>')
      if (run.mono) html = `<code>${html}</code>`
      if (run.bold) html = `<strong>${html}</strong>`
      if (run.italic) html = `<em>${html}</em>`
      if (run.strike) html = `<s>${html}</s>`
      if (run.underline) html = `<u>${html}</u>`
      if (run.highlight) html = `<mark>${html}</mark>`
      if (run.script === 'super') html = `<sup>${html}</sup>`
      if (run.script === 'sub') html = `<sub>${html}</sub>`
      return html
    })
    .join('')
}

/** 是否带有任何格式；为 false 时可以不用保存 titleRich，保持 .xmind 干净 */
export function hasFormatting(rich: RichText): boolean {
  if (rich.paragraphs.length > 1) return true
  for (const paragraph of rich.paragraphs) {
    if (paragraph.bullet) return true
    if (isExplicitAlign(paragraph.align)) return true
    for (const run of paragraph.runs) {
      if (run.bold || run.italic || run.underline || run.strike) return true
      if (run.highlight || run.script) return true
      if (run.color || run.fontSize || run.fontFamily) return true
    }
  }
  return false
}

/**
 * 把整段富文本的**高亮**统一打开或关掉（节点属性面板那个「高亮」开关用它）。
 *
 * 只动 `highlight` 一个属性，粗体 / 颜色 / 字号等原样保留 —— 面板上的开关是**整个节点**
 * 的粒度，不能顺手把用户其它格式抹掉。结果直接交给 `setRichText`：
 * 那里的 `hasFormatting` 会在"取消高亮之后再也没有别的格式"时自动清掉 `titleRich`，
 * 所以不需要在这里额外判断。
 */
export function withHighlightAll(rich: RichText, on: boolean): RichText {
  return {
    paragraphs: rich.paragraphs.map((paragraph) => ({
      ...paragraph,
      runs: paragraph.runs.map((run) => {
        const next: RichTextRun = { ...run }
        if (on) next.highlight = true
        else delete next.highlight
        return next
      })
    }))
  }
}

/** 清掉空 run、去掉尾部多余空段落，保证模型干净 */ export function normalizeRich(
  rich: RichText
): RichText {
  const paragraphs: RichTextParagraph[] = rich.paragraphs.map((paragraph) => {
    const next: RichTextParagraph = { runs: paragraph.runs.filter((run) => run.text.length > 0) }
    if (isExplicitAlign(paragraph.align)) next.align = paragraph.align
    if (paragraph.bullet) next.bullet = true
    return next
  })
  while (paragraphs.length > 1) {
    const last = paragraphs[paragraphs.length - 1]
    if (!last || last.runs.length > 0) break
    paragraphs.pop()
  }
  return { paragraphs: paragraphs.length > 0 ? paragraphs : [{ runs: [] }] }
}

/* ------------------------------------------------------------------ */
/* TipTap(ProseMirror) JSON 互转                                       */
/* ------------------------------------------------------------------ */

export interface TipTapMark {
  type: string
  attrs?: Record<string, unknown>
}

export interface TipTapNode {
  type: string
  attrs?: Record<string, unknown>
  content?: TipTapNode[]
  text?: string
  marks?: TipTapMark[]
}

export interface TipTapDoc {
  type: 'doc'
  content: TipTapNode[]
}

function runToMarks(run: RichTextRun): TipTapMark[] {
  const marks: TipTapMark[] = []
  if (run.bold) marks.push({ type: 'bold' })
  if (run.italic) marks.push({ type: 'italic' })
  if (run.underline) marks.push({ type: 'underline' })
  if (run.strike) marks.push({ type: 'strike' })
  // 高亮 / 上下标：用自定义 mark（渲染层与编辑器共用同一套名字）
  if (run.highlight) marks.push({ type: 'highlight' })
  if (run.script === 'super') marks.push({ type: 'superscript' })
  if (run.script === 'sub') marks.push({ type: 'subscript' })
  /**
   * 行内代码：模型里是「字体族为等宽」（见 `shared/mono-font.ts`），TipTap 里是 `code` mark。
   * 不还原成 `code` 的话，再进编辑态就不是代码格式（工具条状态、后续输入的行为都按普通文字走）。
   */
  if (isMonoFontFamily(run.fontFamily)) marks.push({ type: 'code' })
  const attrs: Record<string, unknown> = {}
  if (run.color) attrs.color = run.color
  if (run.fontSize) attrs.fontSize = `${run.fontSize}px`
  // 等宽照旧也写进 textStyle：用户挑的可能就是别的等宽字体（`Fira Code, monospace`），
  // 内联样式优先于 `code` 自身的样式，字体选择才不会被覆盖掉。
  if (run.fontFamily) attrs.fontFamily = run.fontFamily
  if (Object.keys(attrs).length > 0) marks.push({ type: 'textStyle', attrs })
  return marks
}

function runsToInline(runs: RichTextRun[]): TipTapNode[] {
  const inline: TipTapNode[] = []
  for (const run of runs) {
    if (run.text.length === 0) continue
    // 段落内部的换行在 TipTap 里是 hardBreak
    const parts = run.text.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) inline.push({ type: 'hardBreak' })
      if (part.length === 0) return
      const node: TipTapNode = { type: 'text', text: part }
      const marks = runToMarks(run)
      if (marks.length > 0) node.marks = marks
      inline.push(node)
    })
  }
  return inline
}

/** 内核富文本 -> TipTap 文档 */
export function richToTiptap(rich: RichText): TipTapDoc {
  const content: TipTapNode[] = []
  let pendingList: TipTapNode | null = null

  const flushList = (): void => {
    if (pendingList) {
      content.push(pendingList)
      pendingList = null
    }
  }

  for (const paragraph of rich.paragraphs) {
    const paragraphNode: TipTapNode = { type: 'paragraph' }
    const inline = runsToInline(paragraph.runs)
    if (inline.length > 0) paragraphNode.content = inline
    // 居中是默认值，交给编辑器样式处理，不写进 attrs
    if (isExplicitAlign(paragraph.align)) paragraphNode.attrs = { textAlign: paragraph.align }

    if (paragraph.bullet) {
      if (!pendingList) pendingList = { type: 'bulletList', content: [] }
      pendingList.content!.push({ type: 'listItem', content: [paragraphNode] })
    } else {
      flushList()
      content.push(paragraphNode)
    }
  }
  flushList()

  if (content.length === 0) content.push({ type: 'paragraph' })
  return { type: 'doc', content }
}

function marksToStyle(marks: TipTapMark[] | undefined): Partial<RichTextRun> {
  const style: Partial<RichTextRun> = {}
  for (const mark of marks ?? []) {
    if (mark.type === 'bold') style.bold = true
    else if (mark.type === 'italic') style.italic = true
    else if (mark.type === 'underline') style.underline = true
    else if (mark.type === 'strike') style.strike = true
    else if (mark.type === 'highlight') style.highlight = true
    else if (mark.type === 'superscript') style.script = 'super'
    else if (mark.type === 'subscript') style.script = 'sub'
    /**
     * 行内代码 → 等宽 `fontFamily`（模型里「等宽」的唯一表示，见 `shared/mono-font.ts`）。
     *
     * 只在 textStyle 还没给出字体时兜底：marks 的顺序由 schema 决定、我们控制不了，
     * 这样写才能保证「格式栏里挑的字体」优先，且两种顺序得到的 run 完全一致。
     * 缺了这条分支，行内代码在提交（`tiptapToRich`）时会被整个丢掉——格式真丢，不只是显示问题。
     */
    else if (mark.type === 'code' && style.fontFamily === undefined) style.fontFamily = MD_MONO_FONT
    else if (mark.type === 'textStyle' && mark.attrs) {
      if (typeof mark.attrs.color === 'string') style.color = mark.attrs.color
      if (typeof mark.attrs.fontFamily === 'string') style.fontFamily = mark.attrs.fontFamily
      if (typeof mark.attrs.fontSize === 'string') {
        const size = Number.parseFloat(mark.attrs.fontSize)
        if (Number.isFinite(size) && size > 0) style.fontSize = size
      }
    }
  }
  return style
}

function paragraphAlignOf(node: TipTapNode): 'left' | 'right' | undefined {
  const value = node.attrs?.textAlign
  if (value === 'right' || value === 'left') return value
  return undefined
}

/** 把内联节点转成 runs，遇到 hardBreak 先用 \n 表示，随后再切段落 */
function inlineToRuns(nodes: TipTapNode[] | undefined): RichTextRun[] {
  const runs: RichTextRun[] = []
  for (const node of nodes ?? []) {
    if (node.type === 'hardBreak') {
      runs.push({ text: '\n' })
      continue
    }
    if (node.type !== 'text' || !node.text) continue
    runs.push({ text: node.text, ...marksToStyle(node.marks) })
  }
  return runs
}

/** 把 runs 里的 \n 拆成真正的多个段落，保证与内核行模型一致 */
function splitRunsIntoParagraphs(
  runs: RichTextRun[],
  options: { bullet: boolean; align?: 'left' | 'right' }
): RichTextParagraph[] {
  const buckets: RichTextRun[][] = [[]]
  for (const run of runs) {
    const parts = run.text.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) buckets.push([])
      if (part.length === 0) return
      buckets[buckets.length - 1]?.push({ ...run, text: part })
    })
  }
  return buckets.map((bucket) => {
    const paragraph: RichTextParagraph = { runs: bucket }
    if (options.bullet) paragraph.bullet = true
    if (isExplicitAlign(options.align)) paragraph.align = options.align
    return paragraph
  })
}

/** TipTap 文档 -> 内核富文本 */
export function tiptapToRich(doc: TipTapDoc | null | undefined): RichText {
  const paragraphs: RichTextParagraph[] = []

  const visit = (nodes: TipTapNode[] | undefined, bullet: boolean): void => {
    for (const node of nodes ?? []) {
      switch (node.type) {
        case 'paragraph':
        case 'heading': {
          paragraphs.push(
            ...splitRunsIntoParagraphs(inlineToRuns(node.content), {
              bullet,
              align: paragraphAlignOf(node)
            })
          )
          break
        }
        case 'bulletList':
        case 'orderedList': {
          for (const item of node.content ?? []) visit(item.content, true)
          break
        }
        case 'listItem': {
          visit(node.content, bullet)
          break
        }
        default: {
          if (node.content) visit(node.content, bullet)
          break
        }
      }
    }
  }

  visit(doc?.content, false)
  return normalizeRich({ paragraphs: paragraphs.length > 0 ? paragraphs : [{ runs: [] }] })
}

/* ------------------------------------------------------------------ */
/* 展示辅助                                                            */
/* ------------------------------------------------------------------ */
