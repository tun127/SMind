/**
 * 只读工具的执行：纯逻辑，只吃一棵主题树，方便自检直接跑。
 *
 * 单一职责：把（工具名 + 参数文本）变成 ToolResult。寻址交给 address.ts，
 * schema 声明见 tools-read.ts。结果文本有长度上限，防止把上下文撑爆。
 */
import type { Sheet, Topic } from '../model/types'
import { countHiddenNodes, findTopic, foldedSidesOf, titlePathOf, walk } from '../model/tree'
import { isRecord } from '../guards'
import { parseRange } from '../layout'
import { MARKER_LABELS } from '../xmind/constants'
import { FOLD_SIDE_LABELS } from './write-intents'
import { resolveTopicAddress, shortHandleOf, topicPathOf } from './address'

/* ------------------------------------------------------------------ */
/* 工具执行（纯逻辑：只吃一棵主题树，方便自检直接跑）                   */
/* ------------------------------------------------------------------ */

export interface ToolContext {
  root: Topic
  /** 当前选中的主题 id（没有则 null） */
  selectedId: string | null
  sheetCount: number
  /**
   * 当前画布（关系线 / 边界 / 概要挂在它上面）。
   * 第二批工具要能列出/修改这些元素，光有主题树不够。
   */
  sheet: Sheet
  /**
   * 用户挂在这个会话上的文档（拖进聊天面板或点 📎 选进来的）。
   *
   * 内容是**纯文本**——读取与解析在主进程完成（`shared/document`），
   * 这里只拿到结果。`readDocument` 工具靠它把文档变成可问答的上下文。
   */
  documents?: Array<{ name: string; text: string }>
}

export interface ToolResult {
  ok: boolean
  /** 回喂给模型的文本（成败都在这里；失败信息要能让它自我纠正） */
  content: string
  /** 面板上给用户看的一行摘要 */
  summary: string
}

/** 缩进大纲；到底或超行数上限时标注「未展开」 */
function outlineOf(
  topic: Topic,
  depth: number,
  maxLines = 120
): { text: string; truncated: boolean } {
  const lines: string[] = []
  let truncated = false
  const visit = (node: Topic, level: number): void => {
    if (lines.length >= maxLines) {
      truncated = true
      return
    }
    const title = node.title.length > 0 ? node.title : '（未命名）'
    /**
     * 折起状态要**读得出来**：模型看到的树必须与画布一致，否则它不知道
     * 「右边为什么只有一条线」，还会把已经收起的一侧再收一遍。
     * 只在真的折起时才附注（正常文档一个字都不多花）。
     */
    const folded = foldedSidesOf(node)
    const foldNote = node.collapsed
      ? '，已整体折叠'
      : folded.length > 0
        ? `，已收起${folded.map((item) => FOLD_SIDE_LABELS[item]).join('/')}侧`
        : ''
    const suffix = node.children.length > 0 ? `（${node.children.length} 个子节点${foldNote}）` : ''
    // 每行带上短句柄：模型可以直接用它当 address（重名、超长、带斜杠的标题都因此变得可寻址）
    lines.push(`${'  '.repeat(level)}- [#${shortHandleOf(node.id)}] ${title}${suffix}`)
    if (level >= depth) {
      if (node.children.length > 0) {
        lines.push(`${'  '.repeat(level + 1)}…（${node.children.length} 个子节点未展开）`)
      }
      return
    }
    for (const child of node.children) visit(child, level + 1)
  }
  visit(topic, 0)
  return { text: lines.join('\n'), truncated }
}

function countsOf(root: Topic): {
  total: number
  branches: number
  maxLevel: number
  notes: number
  codes: number
  formulas: number
} {
  let total = 0
  let notes = 0
  let codes = 0
  let formulas = 0
  let maxLevel = 0
  const visit = (topic: Topic, level: number): void => {
    total += 1
    if (level > maxLevel) maxLevel = level
    if (topic.notes && topic.notes.trim().length > 0) notes += 1
    if (topic.code) codes += 1
    if (topic.formula && topic.formula.trim().length > 0) formulas += 1
    for (const child of topic.children) visit(child, level + 1)
  }
  visit(root, 1)
  // 上面数的是**文档里的全部内容**；`countHiddenNodes` 另算「画布上当前看不到的」，
  // 两件事分开报，模型才不会把"收起来的节点"当成"不存在"
  return { total, branches: root.children.length, maxLevel, notes, codes, formulas }
}

/**
 * 标题规范化：判断"是不是同一个主题"用。
 *
 * 去空白、全角转半角、去常见标点、去掉尾部编号与「（补充）/ 副本」这类后缀、小写。
 * **只用于查重**，不改动任何真实标题——判错了也只是多列一组候选。
 */
export function normalizeTopicTitle(raw: string): string {
  let text = raw.trim().toLowerCase()
  // 全角 → 半角（字母、数字与常见标点）
  text = text.replace(/[\uff01-\uff5e]/g, (ch) =>
    String.fromCharCode((ch.charCodeAt(0) - 0xfee0) | 0)
  )
  text = text.replace(/\s+/g, '')
  // 尾部「(1)」「（补充）」「- 副本」这类后缀
  text = text.replace(/[(（[【][^)）\]】]*[)）\]】]$/, '')
  text = text.replace(/[-—–_]*(副本|copy|补充|续|待补)\d*$/i, '')
  // 标点全去掉：`性能优化` 与 `性能优化！` 是同一个主题
  text = text.replace(/[.,:;!?'"`~!@#$%^&*()[\]{}<>/\\|+=_-]/g, '')
  return text
}

/** 规范化后同名的分组（只有 ≥2 个成员的组才返回）；按文档顺序 */
export function duplicateGroups(scope: Topic): Array<{ title: string; ids: string[] }> {
  const byKey = new Map<string, { title: string; ids: string[] }>()
  walk(scope, (topic) => {
    const key = normalizeTopicTitle(topic.title)
    // 太短的标题（"一"、"a"）不参与查重：误判代价大于收益
    if (key.length < 2) return
    const group = byKey.get(key)
    if (group) group.ids.push(topic.id)
    else byKey.set(key, { title: topic.title, ids: [topic.id] })
  })
  return [...byKey.values()].filter((group) => group.ids.length > 1)
}

/** 「疑似近义」：一个标题包含另一个（长度 ≥3），只作为候选提示，不自动合并 */
function similarTitleHints(scope: Topic): string[] {
  const entries: Array<{ id: string; key: string }> = []
  walk(scope, (topic) => {
    const key = normalizeTopicTitle(topic.title)
    if (key.length >= 3) entries.push({ id: topic.id, key })
  })
  const hints: string[] = []
  for (let a = 0; a < entries.length && hints.length < 6; a += 1) {
    for (let b = a + 1; b < entries.length && hints.length < 6; b += 1) {
      const left = entries[a]
      const right = entries[b]
      if (!left || !right || left.key === right.key) continue
      if (left.key.includes(right.key) || right.key.includes(left.key)) {
        hints.push(`[#${shortHandleOf(left.id)}] 与 [#${shortHandleOf(right.id)}]`)
      }
    }
  }
  return hints
}

export function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : ''
}

export function intArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * 执行一次只读工具。
 *
 * 失败**不抛错而是返回文本**：抛错会让整轮对话中断，
 * 而模型看到「没找到 X，标题里包含它的是 Y」才能自我纠正。
 */
function executeReadTool(name: string, argumentsText: string, context: ToolContext): ToolResult {
  let args: Record<string, unknown> = {}
  const trimmed = argumentsText.trim()
  if (trimmed.length > 0) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      return {
        ok: false,
        content: `参数不是合法 JSON（${(error as Error).message}）。请重新调用 ${name} 并传入合法参数。`,
        summary: `${name}：参数错误`
      }
    }
    if (!isRecord(parsed)) {
      return { ok: false, content: '参数必须是 JSON 对象。', summary: `${name}：参数错误` }
    }
    args = parsed
  }

  if (name === 'getSelection') {
    const id = context.selectedId
    const topic = id ? findTopic(context.root, id) : null
    const path = id ? topicPathOf(context.root, id) : null
    if (!topic || !path) {
      return { ok: true, content: '用户当前没有选中任何主题。', summary: '读取选中：无' }
    }
    const lines = [
      `当前选中：${path.join(' → ')}`,
      `- 子节点数：${topic.children.length}`,
      `- 备注：${topic.notes && topic.notes.trim().length > 0 ? `有（${topic.notes.trim().length} 字）` : '无'}`,
      `- 代码块：${topic.code ? `有（${topic.code.language}）` : '无'}`,
      `- 公式：${topic.formula && topic.formula.trim().length > 0 ? '有' : '无'}`
    ]
    return { ok: true, content: lines.join('\n'), summary: `读取选中：${topic.title}` }
  }

  if (name === 'searchNodes') {
    const query = stringArg(args, 'query')
    if (query.length === 0) {
      return { ok: false, content: 'query 不能为空。', summary: '搜索：缺关键词' }
    }
    const limit = intArg(args, 'limit', 20, 1, 50)
    const needle = query.toLowerCase()
    const hits: Array<{ title: string; path: string; handle: string }> = []
    let scanned = 0
    const visit = (topic: Topic): void => {
      scanned += 1
      if (topic.title.toLowerCase().includes(needle)) {
        const path = topicPathOf(context.root, topic.id)
        hits.push({
          title: topic.title,
          path: path ? path.join(' → ') : topic.title,
          handle: shortHandleOf(topic.id)
        })
      }
      for (const child of topic.children) visit(child)
    }
    visit(context.root)

    if (hits.length === 0) {
      return {
        ok: true,
        content: `在 ${scanned} 个节点里没有找到标题包含「${query}」的主题。可以换个更短的关键词再搜。`,
        summary: `搜索「${query}」：0 个`
      }
    }
    const shown = hits.slice(0, limit)
    const lines = shown.map((hit) => `- [#${hit.handle}] ${hit.title}（路径：${hit.path}）`)
    if (hits.length > shown.length) lines.push(`…另有 ${hits.length - shown.length} 个结果未列出`)
    return {
      ok: true,
      content: `在 ${scanned} 个节点里找到 ${hits.length} 个标题包含「${query}」的主题：\n${lines.join('\n')}`,
      summary: `搜索「${query}」：${hits.length} 个`
    }
  }

  if (name === 'getSubtree') {
    const address = stringArg(args, 'address')
    if (address.length === 0) {
      return { ok: false, content: 'address 不能为空。', summary: '读取子树：缺 address' }
    }
    const resolved = resolveTopicAddress(context.root, address)
    if (!resolved.ok) {
      return { ok: false, content: resolved.error, summary: `读取子树失败：${address}` }
    }
    const depth = intArg(args, 'depth', 2, 1, 4)
    const { topic, path } = resolved.resolved
    const outline = outlineOf(topic, depth)
    const header = `「${topic.title}」的子树（展开 ${depth} 层，路径：${path.join(' → ')}）：`
    const tail = outline.truncated
      ? '\n（内容较多已截断——需要细节请缩小 depth 或指定更具体的分支）'
      : ''
    return {
      ok: true,
      content: `${header}\n${outline.text}${tail}`,
      summary: `读取子树：${topic.title}`
    }
  }

  if (name === 'listAttachments') {
    const sheet = context.sheet
    const titleOf = (id: string): string => findTopic(context.root, id)?.title ?? '(已删除)'
    const raw = typeof args.address === 'string' ? args.address.trim() : ''
    let focus: string | null = null
    if (raw.length > 0) {
      const resolved = resolveTopicAddress(context.root, raw)
      if (!resolved.ok) return { ok: false, content: resolved.error, summary: `列元素失败：${raw}` }
      focus = resolved.resolved.topic.id
    }
    const touches = (ids: string[]): boolean => focus === null || ids.includes(focus)

    const lines: string[] = []
    const relationships = sheet.relationships.filter((item) => touches([item.end1Id, item.end2Id]))
    for (const item of relationships) {
      lines.push(
        `- 关系线 id=${item.id}：${titleOf(item.end1Id)} → ${titleOf(item.end2Id)}` +
          (item.title ? `（标注：${item.title}）` : '')
      )
    }
    const rangesOf = (range: string): string[] => parseRange(range) ?? []
    const boundaries = sheet.boundaries.filter((item) => touches(rangesOf(item.range)))
    for (const item of boundaries) {
      const titles = rangesOf(item.range).map(titleOf).join(' ~ ')
      lines.push(`- 边界 id=${item.id}：${titles}${item.title ? `（标题：${item.title}）` : ''}`)
    }
    const summaries = sheet.summaries.filter((item) => touches(rangesOf(item.range)))
    for (const item of summaries) {
      const titles = rangesOf(item.range).map(titleOf).join(' ~ ')
      lines.push(`- 概要 id=${item.id}：${titles}${item.title ? `（标题：${item.title}）` : ''}`)
    }
    if (relationships.length + boundaries.length + summaries.length === 0) {
      lines.push('画布上还没有关系线 / 边界 / 概要。')
    }
    // 标记 id 清单：模型不查这份清单就会自己编一个不存在的 markerId
    lines.push(
      '可用标记 id（给 setMarkers 用，格式 markerId=含义）。' +
        '**同一类别只能给一个**（优先级 / 进度 / 星标 / 旗帜 / 表情 / 符号 / 趋势 / 其他）：' +
        Object.entries(MARKER_LABELS)
          .map(([id, label]) => `${id}=${label}`)
          .join('、')
    )
    return {
      ok: true,
      content: lines.join('\n'),
      summary: `画布元素：${relationships.length} 条关系线、${boundaries.length} 个边界、${summaries.length} 个概要`
    }
  }

  if (name === 'getDocStats') {
    const counts = countsOf(context.root)
    const hidden = countHiddenNodes(context.root)
    const lines = [
      '当前文档概况：',
      `- 画布数：${context.sheetCount}`,
      `- 节点总数：${counts.total}`,
      `- 一级分支数：${counts.branches}`,
      `- 最大层级：${counts.maxLevel} 层`,
      `- 带备注的节点：${counts.notes}`,
      `- 带代码块的节点：${counts.codes}`,
      `- 带公式的节点：${counts.formulas}`,
      /**
       * 折叠是**显示**状态：节点总数把它算在内，但模型必须知道"有多少不在画布上"，
       * 否则会把收起来的分支当成不存在（或反过来，以为它正显示着）。
       */
      ...(hidden > 0
        ? [`- 画布上当前看不到的节点：${hidden}（被折叠收起；内容仍在文档里，展开或导出即可看到）`]
        : [])
    ]
    return { ok: true, content: lines.join('\n'), summary: `文档概况：${counts.total} 个节点` }
  }

  /**
   * 读用户挂上来的文档。
   *
   * 文档内容可能很长（几十万字），所以默认**只给一段**、并支持按关键词取片段：
   * 问答场景里 model 要的是"哪几行说了这件事"，不是"把整份文档再读一遍"。
   */
  if (name === 'readDocument') {
    const docs = context.documents ?? []
    if (docs.length === 0) {
      return {
        ok: false,
        content:
          '这个会话里还没有挂文档。请告诉用户：把文档（docx / md / txt / csv / xlsx / pptx）' +
          '拖进聊天面板、或点输入框旁的 📎 选一份，然后我再读。',
        summary: '读文档：会话里没有文档'
      }
    }
    const wanted = stringArg(args, 'name').toLowerCase()
    const picked =
      wanted.length === 0
        ? docs.length === 1
          ? docs[0]
          : null
        : (docs.find((doc) => doc.name.toLowerCase() === wanted) ??
          docs.find((doc) => doc.name.toLowerCase().includes(wanted)))
    if (!picked) {
      const list = docs.map((doc) => `${doc.name}（${doc.text.length} 字）`).join('、')
      return {
        ok: false,
        content:
          docs.length === 1
            ? `这个会话里只有一份文档：${list}。请不填 name 直接读它。`
            : `name 不明确或没找到。可用文档：${list}。请从中挑一个（可只写一部分名字）。`,
        summary: '读文档：需要指定文档'
      }
    }

    const query = stringArg(args, 'query')
    if (query.length > 0) {
      const lines = picked.text.split('\n')
      const hits: string[] = []
      const needle = query.toLowerCase()
      for (let index = 0; index < lines.length && hits.length < 12; index += 1) {
        const line = lines[index] ?? ''
        if (!line.toLowerCase().includes(needle)) continue
        // 命中行带上前后各一行：只看孤立一行常常读不出上下文
        const from = Math.max(0, index - 1)
        const to = Math.min(lines.length - 1, index + 1)
        const block = lines
          .slice(from, to + 1)
          .map((text, offset) => `${from + offset + 1}| ${text}`)
        hits.push(block.join('\n'))
      }
      return {
        ok: true,
        content:
          hits.length === 0
            ? `《${picked.name}》里没有找到「${query}」。可以换个关键词，或先不填 query 读一段看结构。`
            : `《${picked.name}》中含「${query}」的片段（行号|原文）：\n\n${hits.join('\n\n')}`,
        summary: `读文档：${picked.name} 命中「${query}」${hits.length} 处`
      }
    }

    const offset = intArg(args, 'offset', 0, 0, picked.text.length)
    const limit = intArg(args, 'limit', 6000, 200, 12000)
    const slice = picked.text.slice(offset, offset + limit)
    const more = offset + limit < picked.text.length
    return {
      ok: true,
      content:
        `《${picked.name}》第 ${offset}~${offset + slice.length} 字（共 ${picked.text.length} 字）` +
        `${more ? '——还有更多，可加大 offset 继续读，或直接用 query 查关键词' : '（已到末尾）'}：\n\n${slice}`,
      summary: `读文档：${picked.name}（${offset}~${offset + slice.length} 字）`
    }
  }

  if (name === 'exportOutline') {
    // 真正的导出由渲染层执行（要弹系统保存对话框）；走到这里说明宿主没有接管
    const format = stringArg(args, 'format') || 'md'
    return {
      ok: true,
      content: `导出请求已交给界面执行（格式：${format}）。`,
      summary: `导出大纲：${format}`
    }
  }

  /**
   * 查重：按「规范化后同名」找出重复主题（只读，不改画布）。
   *
   * 自动合并前先让模型看清楚有哪些重复——它可能认出"这两个其实不是一件事"。
   */
  if (name === 'findDuplicates') {
    const scope = stringArg(args, 'scope')
    let base = context.root
    let scopeNote = '整篇'
    if (scope.length > 0) {
      const resolved = resolveTopicAddress(context.root, scope)
      if (!resolved.ok) return { ok: false, content: resolved.error, summary: `查重失败：${scope}` }
      base = resolved.resolved.topic
      scopeNote = `「${base.title}」这一支`
    }
    const pathOf = (id: string): string => titlePathOf(context.root, id).join(' → ')
    const groups = duplicateGroups(base)
    const lines: string[] = [`按「同名」查重（范围：${scopeNote}）：`]
    if (groups.length === 0) lines.push('- 没有发现同名主题 ✅')
    for (const group of groups) {
      lines.push(`- 「${group.title}」×${group.ids.length}：`)
      for (const id of group.ids) {
        const title = findTopic(context.root, id)?.title ?? ''
        lines.push(`    [#${shortHandleOf(id)}] ${title}（路径：${pathOf(id)}）`)
      }
    }
    const hints = similarTitleHints(base)
    if (hints.length > 0) {
      lines.push(
        '- **疑似近义**（一个是另一个的一部分，需你自己判断要不要合）：' + hints.join('、')
      )
    }
    if (groups.length > 0) {
      lines.push('要合并就调 mergeDuplicates（会删掉多余的那几个，界面上会请用户确认）。')
    }
    return {
      ok: true,
      content: lines.join('\n'),
      summary: `查重：${groups.length} 组同名`
    }
  }

  /**
   * 执行计划：**不改画布**，只是把计划与进度回显给模型和用户。
   *
   * 为什么做成工具而不是"让它先说一段计划"：说一段话没有任何约束力，下一步它就可能跑偏；
   * 而一份显式清单会出现在界面上、也留在消息线里，模型每轮都能看到自己走到哪一步——
   * 这是"生成上百节点的详细图"这类长任务最容易缺的东西。
   */
  if (name === 'updatePlan') {
    const rawSteps = Array.isArray(args.steps) ? args.steps : []
    const steps = rawSteps
      .filter((step): step is string => typeof step === 'string' && step.trim().length > 0)
      .slice(0, 8)
      .map((step) => step.trim())
    if (steps.length === 0) {
      return {
        ok: false,
        content: 'steps 不能为空：给 2~6 步的执行计划（字符串数组，按执行顺序）。',
        summary: '更新计划：steps 为空'
      }
    }
    const done = intArg(args, 'done', 0, 0, steps.length)
    const lines = steps.map((step, index) => {
      const mark = index < done ? '✓' : index === done ? '▶' : '·'
      return `${mark} ${index + 1}. ${step}`
    })
    const next = steps[done]
    return {
      ok: true,
      content:
        `计划已记录（完成 ${done}/${steps.length}）：\n${lines.join('\n')}\n` +
        (next
          ? `当前这一步：${next}`
          : '全部步骤已完成——接下来做最后自检（复查改动区域、核对数量）再总结。'),
      summary: `计划 ${done}/${steps.length}：${steps[done] ?? '已完成'}`
    }
  }

  /**
   * 覆盖度自检：哪些节点缺备注 / 是叶子 / 缺代码块。
   *
   * 「用户要详细、模型说"都写好了"」之间的差距，靠印象是查不出来的——
   * 这个工具把"漏在哪"变成一份带句柄的清单，模型可以直接照着补。
   */
  if (name === 'findIncompleteNodes') {
    const raw = stringArg(args, 'missing')
    const missing = raw === 'children' || raw === 'code' ? raw : 'notes'
    const label =
      missing === 'notes' ? '缺备注（解释）' : missing === 'children' ? '是叶子' : '缺代码块'
    const scope = stringArg(args, 'scope')
    let base = context.root
    let scopeNote = '整篇'
    if (scope.length > 0) {
      const resolved = resolveTopicAddress(context.root, scope)
      if (!resolved.ok) return { ok: false, content: resolved.error, summary: `自检失败：${scope}` }
      base = resolved.resolved.topic
      scopeNote = `「${base.title}」这一支`
    }
    const limit = intArg(args, 'limit', 20, 1, 50)

    /** 祖先路径（含中心主题，不含自己）；空标题跳过——走共用的 titlePathOf */
    const pathOf = (id: string): string[] => titlePathOf(context.root, id)

    const hits: Array<{ topic: Topic; path: string[] }> = []
    let total = 0
    walk(base, (topic) => {
      total += 1
      const lacks =
        missing === 'notes'
          ? !(topic.notes && topic.notes.trim().length > 0)
          : missing === 'children'
            ? topic.children.length === 0
            : !topic.code
      if (lacks) hits.push({ topic, path: pathOf(topic.id) })
    })

    const lines: string[] = [
      `按「${label}」筛查（范围：${scopeNote}，共 ${total} 个节点）：`,
      `- 命中 ${hits.length} 个（${total > 0 ? Math.round((hits.length / total) * 100) : 0}%）`
    ]
    if (hits.length === 0) {
      lines.push('- 没有漏的：这一项全部达标 ✅')
    } else {
      const shown = hits.slice(0, limit)
      for (const hit of shown) {
        const where = hit.path.length > 0 ? hit.path.join(' → ') : hit.topic.title
        lines.push(
          `- [#${shortHandleOf(hit.topic.id)}] ${hit.topic.title || '（未命名）'}（路径：${where}）`
        )
      }
      if (hits.length > shown.length) {
        lines.push(
          `…（还有 ${hits.length - shown.length} 个没列出；需要就缩小 scope 或调大 limit）`
        )
      }
      // 按一级分支汇总：先补"漏得最多"的那一支，比平均用力有效
      const byBranch = new Map<string, number>()
      for (const hit of hits) {
        const branch = hit.path[1] ?? hit.topic.title ?? '（中心主题）'
        byBranch.set(branch, (byBranch.get(branch) ?? 0) + 1)
      }
      const ranking = [...byBranch.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      lines.push(
        `- 按分支汇总（从多到少）：${ranking.map(([name, count]) => `${name} ${count}`).join('、')}`
      )
    }
    return {
      ok: true,
      content: lines.join('\n'),
      summary: `自检「${label}」：${hits.length}/${total} 个命中`
    }
  }

  return { ok: false, content: `未知工具：${name}`, summary: `未知工具：${name}` }
}

/** 回喂给模型的单条结果长度上限：工具结果再长也不能把上下文撑爆 */
const AGENT_TOOL_RESULT_MAX = 8000

/** 执行一次只读工具（带结果长度保护） */
export function runReadTool(name: string, argumentsText: string, context: ToolContext): ToolResult {
  const result = executeReadTool(name, argumentsText, context)
  if (result.content.length <= AGENT_TOOL_RESULT_MAX) return result
  return {
    ...result,
    content: `${result.content.slice(0, AGENT_TOOL_RESULT_MAX)}\n…（结果过长已截断）`
  }
}
