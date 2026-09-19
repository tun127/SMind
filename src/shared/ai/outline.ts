/**
 * 大纲解析与续写拼接。
 *
 * 单一职责：把模型输出的**文本大纲**解析成 OutlineNode 树（含容错与告警），
 * 以及长文档分段生成后如何**无缝拼接**两段大纲。
 */
import {
  BULLET_MARKER,
  HEADING_MARKER,
  ORDERED_MARKER,
  depthOfIndent,
  expandTabs,
  hasOutlineMarker,
  indentWidthOf
} from '../outline-dialect'
import { createTopic } from '../model/factory'
import { notesHtmlFrom } from '../richtext'
import type { RichText, Topic, TopicCode } from '../model/types'

export interface OutlineNode {
  title: string
  children: OutlineNode[]
  /** 备注（OPML 的 _note、Markdown 的引用块/段落），导入时一并带进节点 */
  notes?: string
  /** 行内 Markdown 格式解析出的富文本（粗体/斜体/删除线/行内代码/链接），导入时带进节点 */
  rich?: RichText
  /** Markdown 链接的 url（第一个 [文字](url)），导入时挂到节点超链接 */
  href?: string
  /** Markdown 围栏代码块 → 节点代码块 */
  code?: TopicCode
  /** Markdown 数学（`$…$` / `$$…$$`）→ 节点公式 */
  formula?: string
}

export interface ParsedOutline {
  /** 解析出的根节点；解析不出内容时为 null */
  root: OutlineNode | null
  /** 一共解析出多少个节点（含根） */
  count: number
  warnings: string[]
  /**
   * 根节点是不是**人工套上去的壳**（模型给了并列的多个顶层节点）。
   *
   * 这个标记必须给调用方：把壳直接落进画布，会凭空多出一个「新主题」垃圾节点
   * （AI 写工具真踩过这个坑）。知道是壳就该把它的孩子依次挂上去。
   *
   * 只有 AI 大纲解析器会产生壳；Markdown / OPML 导入器等来源没有这个概念，缺省即「不是壳」。
   */
  wrapped?: boolean
}

/** 去掉 ```lang ... ``` 包裹；模型经常多此一举地包一层 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  const lines = trimmed.split(/\r?\n/)
  lines.shift()
  const lastLine = lines[lines.length - 1]
  if (lastLine && lastLine.trim().startsWith('```')) lines.pop()
  return lines.join('\n')
}

/** 一行的解析结果：层级深度 + 文字 + 是否有列表标记；不是大纲行则返回 null */
function parseOutlineLine(line: string): { depth: number; text: string; marked: boolean } | null {
  if (line.trim().length === 0) return null

  // 制表符与缩进规则走共享方言（与 Markdown 导入一致，见 shared/outline-dialect.ts）
  const expanded = expandTabs(line)
  const indent = indentWidthOf(expanded)
  let body = expanded.trim()

  const marked = hasOutlineMarker(body)

  // 去掉列表符号：- * + • 、1. 1)、# 标题（词汇表与导入器共用）
  body = body.replace(BULLET_MARKER, '')
  body = body.replace(ORDERED_MARKER, '')
  body = body.replace(HEADING_MARKER, '')
  body = body.replace(/^\*\*(.+)\*\*$/, '$1').trim()

  if (body.length === 0) return null
  // 纯分隔线/装饰行直接跳过
  if (/^[-=_*]{3,}$/.test(body)) return null

  return { depth: depthOfIndent(indent), text: body, marked }
}

/** 短句才可能是主题；带句号的长句通常是模型的解释文字 */
function looksLikeTopic(text: string): boolean {
  const trimmed = text.trim()
  if (/[。！？!?]$/.test(trimmed)) return false
  /**
   * 阈值放宽过（24 → 40 字；多逗号那条 20 → 30 字）。
   *
   * 原因：这条规则只在「模型既没用 `- ` 标记、也没缩进」的兜底路径生效，
   * 但它会**静默丢掉**长行——而"详细的考点"恰恰是长行
   * （如「性能优化：减少重排、合并写入、避免频繁 setState」26 字，正好被旧阈值误杀）。
   * 详细内容被当成杂音丢掉，方向正好相反。宁可多收进几个长节点，
   * 也不要把用户要的细节悄悄吃掉（丢弃时另有警告，见 parseOutline）。
   */
  if (/[，,；;].*[，,；;]/.test(trimmed) && [...trimmed].length > 30) return false
  return [...trimmed].length <= 40
}

/**
 * 「解释行」：`> 文字` —— 成为**上一个主题的备注**。
 *
 * 这是本项目"详细图"的载体：模型在缩进大纲里给某个考点跟一行 `> …`，
 * 这行就落到该主题的备注里（可搜索、可导出、不占画布宽度）。
 * 语法与 Markdown 引用块一致——`shared/import/markdown.ts` 的导入器也是这么认的，
 * 于是「AI 生成的详细大纲」与「Markdown 导入的详细大纲」是同一套写法。
 */
function parseNoteLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('>')) return null
  const text = trimmed.replace(/^>\s?/, '').trim()
  return text.length > 0 ? text : null
}

/**
 * 把模型输出解析成大纲树。
 *
 * 容错策略：
 * 1. 优先只认「明确像大纲」的行——带列表/标题标记，或者有缩进；
 *    模型常见的开场白（「好的，以下是……」）因此会被自动跳过；
 * 2. 一行标记都没有时，退化成「一行一个主题」，但只收简短的行，
 *    这样既容错又不会把一整段解释文字变成节点；
 * 3. 连短句都没有 → 判定为不可用，返回 null 并给出提示（界面上会展示原文）。
 */
export function parseOutline(text: string, fallbackRootTitle = 'AI 生成'): ParsedOutline {
  const warnings: string[] = []
  const body = stripCodeFence(text ?? '')
  const lines = body.split(/\r?\n/)

  const all: Array<{ depth: number; text: string; marked: boolean }> = []
  /** 与 all 一一对应：该行的解释（`> …`），没有则为空串 */
  const notesOf: string[] = []
  /** 还没出现任何主题时的解释行：无处挂靠，计入警告而不是静默丢弃 */
  let orphanNotes = 0
  for (const line of lines) {
    const note = parseNoteLine(line)
    if (note !== null) {
      const index = all.length - 1
      if (index < 0) {
        orphanNotes += 1
      } else {
        const previous = notesOf[index] ?? ''
        notesOf[index] = previous.length > 0 ? `${previous}\n${note}` : note
      }
      continue
    }
    const item = parseOutlineLine(line)
    if (item) {
      all.push(item)
      notesOf.push('')
    }
  }
  if (orphanNotes > 0) {
    warnings.push(
      `有 ${orphanNotes} 行「> 解释」出现在任何主题之前，已忽略（解释要写在对应主题的下一行）`
    )
  }

  const indexed = all.map((item, index) => ({ item, note: notesOf[index] ?? '' }))
  let parsed = indexed.filter(({ item }) => item.marked || item.depth > 0)

  if (parsed.length === 0) {
    const terse = indexed.filter(({ item }) => looksLikeTopic(item.text))
    if (terse.length === 0) {
      return {
        root: null,
        count: 0,
        warnings: ['模型没有返回可解析的大纲（只看到说明文字），请重试或换个模型'],
        wrapped: false
      }
    }
    // 丢弃要**说出来**：以前是静默丢，用户只看到"内容怎么变少了"，无从查起
    const rejected = indexed.length - terse.length
    parsed = terse
    warnings.push('模型没有用缩进大纲的格式，已按「一行一个主题」解析')
    if (rejected > 0) {
      warnings.push(
        `其中 ${rejected} 行不像主题（过长或像解释文字）被跳过；` +
          '想要完整保留细节，可以让它用「- 」开头的缩进大纲、解释写成「> 」行'
      )
    }
  }

  // 归一化深度：第一行深度当作 0，避免模型整体缩进导致层级错位
  // 模型偶尔会回一段没有任何大纲行的内容：这时 parsed 为空，
  // 直接取 parsed[0].depth 会抛异常，把"模型答得不好"升级成一次崩溃
  const baseDepth = parsed[0]?.item.depth ?? 0

  const roots: OutlineNode[] = []
  const stack: Array<{ depth: number; node: OutlineNode }> = []

  for (const { item, note } of parsed) {
    const depth = Math.max(0, item.depth - baseDepth)
    const node: OutlineNode = { title: item.text, children: [] }
    // `> 解释` 落到备注：详细内容不占画布宽度，但能搜索、能导出、能看见
    if (note.length > 0) node.notes = note
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (!top || top.depth < depth) break
      stack.pop()
    }

    const parent = stack[stack.length - 1]
    if (parent) parent.node.children.push(node)
    else roots.push(node)

    stack.push({ depth, node })
  }

  let root: OutlineNode
  let wrapped = false
  const onlyRoot = roots[0]
  if (roots.length === 1 && onlyRoot) {
    root = onlyRoot
  } else {
    // 模型给了并列的多个顶层节点：套一个根节点，别让它们散着
    root = { title: fallbackRootTitle, children: roots }
    wrapped = true
    warnings.push(
      `模型返回了 ${roots.length} 个并列的顶层节点，已统一挂到「${fallbackRootTitle}」下`
    )
  }

  const count = countOutlineNodes(root)
  return { root, count, warnings, wrapped }
}

export function countOutlineNodes(node: OutlineNode | null): number {
  if (!node) return 0
  let total = 1
  for (const child of node.children) total += countOutlineNodes(child)
  return total
}

/** 把解析出来的大纲转成模型里的主题树（AI 结果与导入落盘都用它） */
export function outlineToTopic(node: OutlineNode, structureClass?: string): Topic {
  const topic = createTopic(node.title, structureClass)
  topic.children = node.children.map((child) => outlineToTopic(child))
  if (node.rich) topic.titleRich = node.rich
  if (node.href) topic.href = node.href
  if (node.code) topic.code = { language: node.code.language, text: node.code.text }
  if (node.formula) topic.formula = node.formula
  if (node.notes && node.notes.trim().length > 0) {
    topic.notes = node.notes
    topic.notesHtml = notesHtmlFrom(node.notes)
  }
  return topic
}

/* ------------------------------------------------------------------ */
/* 续写拼接                                                            */
/* ------------------------------------------------------------------ */

/** 续写首行与前一段尾行的关系 */
export type ContinuationRelation =
  /** 逐字相同：模型把上一行重发了一遍 */
  | 'repeat'
  /** 续写首行是尾行的**加长版**：模型在补完这一行 */
  | 'extended'
  /** 两行内容无关：各自独立 */
  | 'fresh'
  /** 尾行为空（前一段正好以换行结尾）：没有可拼的东西 */
  | 'none'

export interface ContinuationMerge {
  text: string
  relation: ContinuationRelation
  /** 前一段的最后一行（原样，未 trim）——出问题时靠它定位 */
  tail: string
  /** 续写的第一行（原样，未 trim） */
  head: string
}

/** 「加长版」判定所需的最短重叠：太短会把「缓存 / 缓存策略」这种兄弟节点误判成同一行 */
export const CONTINUATION_MIN_OVERLAP = 6

/**
 * 这一行看起来像「被截断的残片」吗？
 *
 * 只认**括号没配平**这一条：残片最常见的形状是「- 考点（重点」这种半截括号，
 * 而完整标题里出现不配对括号极少。**不用**「以逗号/冒号结尾」这类信号——
 * 「考点一：」本身就是合法标题，那样会误伤。
 */
function looksTruncatedLine(line: string): boolean {
  const pairs: Array<[string, string]> = [
    ['（', '）'],
    ['【', '】'],
    ['《', '》'],
    ['「', '」'],
    ['(', ')'],
    ['[', ']'],
    ['{', '}']
  ]
  for (const [open, close] of pairs) {
    const opens = [...line].filter((ch) => ch === open).length
    const closes = [...line].filter((ch) => ch === close).length
    if (opens > closes) return true
  }
  return false
}

/** 把两段文本接起来：各自去掉首尾空白，中间一个换行；空段直接跳过 */
function joinText(before: string, after: string): string {
  return [before.trimEnd(), after.trim()].filter((part) => part.length > 0).join('\n')
}

/**
 * 拼接「被截断的前半段」与「续写的后半段」，并说明是**按哪种关系**拼的。
 *
 * 为什么要区分关系：截断点可能落在一行中间，也可能正好落在行尾；
 * 而「最后一行到底写完没有」这个信息**不在字符串里**——同样两段文本，
 * 可能对应「模型在补完残行」与「模型另起一行」两种完全不同的意图。
 *
 * 所以这里**不猜**：只在能确认模型重写了那一行时才丢掉它，其余一律保留。
 * 宁可多留一个看得见的残句，也不静默吃掉一个用户要的节点
 * （少一个考点的表现和「AI 又漏了」一模一样，用户无从发现）。
 *
 * 三条规则（按优先级）：
 * 1. **加长版**（尾行是续写首行的前缀，且重叠 ≥ `CONTINUATION_MIN_OVERLAP`）
 *    → 模型在补完这行：丢掉尾行、保留续写首行。这是唯一「丢掉的内容已经在新文本里」的情形。
 * 2. **逐字相同**：残片（括号没配平）→ 两份都丢（只是把残片原样重发了一遍）；
 *    否则说明这行本来就完整 → 保留一份。
 * 3. **两行无关** → 都保留。这里以前是无条件丢掉尾行，于是「截断正好落在行尾」时
 *    会静默少一个节点——修复的正是这一条。
 *
 * 配套的提示词也一起改了（`renderer/src/ai/outlineRun.ts` 的续写指令：
 * 没写完就**从行首完整重写一遍**）——让「残行」变成「加长版」，正好落在第 1 条上。
 *
 * 为什么住在 shared：渲染层的文件跑不进 node 自检，而这条启发式坏掉的后果是**静默**的。
 */
export function mergeContinuation(previous: string, next: string): ContinuationMerge {
  const previousLines = previous.split(/\r?\n/)
  const tail = previousLines[previousLines.length - 1] ?? ''
  const head = next.split(/\r?\n/)[0] ?? ''
  const trimmedTail = tail.trim()
  const trimmedHead = head.trim()

  // 前一段正好以换行结尾：没有半行要处理，直接接上
  if (trimmedTail.length === 0) {
    return { text: joinText(previous, next), relation: 'none', tail, head }
  }

  // 1. 加长版：模型把这一行重写得更长了 → 丢掉旧的那份，保留模型这份
  if (
    trimmedHead.length > trimmedTail.length &&
    trimmedTail.length >= CONTINUATION_MIN_OVERLAP &&
    trimmedHead.startsWith(trimmedTail)
  ) {
    previousLines.pop()
    return {
      text: joinText(previousLines.join('\n'), next),
      relation: 'extended',
      tail,
      head
    }
  }

  // 2. 逐字相同
  if (trimmedHead === trimmedTail) {
    if (looksTruncatedLine(trimmedTail)) {
      // 残片被原样重发：两份都去掉（它不构成内容）
      const nextLines = next.split(/\r?\n/)
      previousLines.pop()
      nextLines.shift()
      return {
        text: joinText(previousLines.join('\n'), nextLines.join('\n')),
        relation: 'repeat',
        tail,
        head
      }
    }
    // 完整的一行被重发：保留一份（丢掉前一份，留下模型这份）
    previousLines.pop()
    return { text: joinText(previousLines.join('\n'), next), relation: 'repeat', tail, head }
  }

  // 3. 两行无关：都保留（不再无条件丢尾行）
  return { text: joinText(previous, next), relation: 'fresh', tail, head }
}

/** 只要拼好的文本（调用方不关心关系时用它） */
export function joinContinuation(previous: string, next: string): string {
  return mergeContinuation(previous, next).text
}
