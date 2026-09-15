/**
 * Agent 模块（三期）。
 *
 * 这里放的是**纯逻辑**：不依赖 Electron、DOM 与 store，可在自检里直接跑。
 * 目前只有「把文本里提到的节点标题切成可点击片段」——聊天面板用它做
 * 「回复 → 画布」的反向链接；1b 的探查工具与循环状态机也会落在这里。
 */

import { isRecord } from '../guards'
import { ancestorsOf, findTopic } from '../model/tree'
import type { Topic } from '../model/types'

/* ------------------------------------------------------------------ */
/* 节点标题的识别与切分                                                */
/* ------------------------------------------------------------------ */

export interface TextSegment {
  text: string
  /** 命中节点时有值；纯文本片段为 null */
  topicId: string | null
}

export interface TitleIndexEntry {
  title: string
  id: string
}

/**
 * 建「首个字符 → 标题」的索引。
 *
 * 为什么不直接拿全部标题去逐条扫文本：那是 O(标题数 × 文本长度)，
 * 大文档（几千个节点）× 每条回复都扫一遍会卡。
 * 按首字分桶后，每个字符位置只比较少数几个候选。
 *
 * 桶内按标题长度**降序**：保证「先匹配长的」——
 * 否则「成本」会先把「成本控制」咬掉一半。
 */
export function buildTitleIndex(root: Topic, minLength = 2): Map<string, TitleIndexEntry[]> {
  const index = new Map<string, TitleIndexEntry[]>()

  const walk = (topic: Topic): void => {
    const title = topic.title.trim()
    const first = title[0]
    if (title.length >= minLength && first !== undefined) {
      const bucket = index.get(first)
      if (bucket) bucket.push({ title, id: topic.id })
      else index.set(first, [{ title, id: topic.id }])
    }
    for (const child of topic.children) walk(child)
  }
  walk(root)

  for (const bucket of index.values()) {
    bucket.sort((a, b) => b.title.length - a.title.length)
  }
  return index
}

/**
 * 把文本切成「纯文本 / 节点引用」两类片段。
 *
 * 只认**标题原文**（这正是 system 提示词要求模型引用节点的方式）；
 * 同一标题出现多次都会被识别。
 */
export function segmentTitleMentions(text: string, index: Map<string, TitleIndexEntry[]>): TextSegment[] {
  // 防御：内容可能来自历史记录等外部数据。坏数据最多让这段不高亮，
  // **绝不能把整个界面带崩**（这里真崩过一次：上游把 content 清成了 undefined）。
  if (typeof text !== 'string' || text.length === 0) return []

  const segments: TextSegment[] = []
  let plain = ''
  let position = 0

  const flushPlain = (): void => {
    if (plain.length > 0) {
      segments.push({ text: plain, topicId: null })
      plain = ''
    }
  }

  while (position < text.length) {
    const char = text[position]
    if (char === undefined) break
    const bucket = index.get(char)
    let matched: TitleIndexEntry | null = null
    if (bucket) {
      for (const item of bucket) {
        if (text.startsWith(item.title, position)) {
          matched = item
          break
        }
      }
    }

    if (matched) {
      flushPlain()
      segments.push({ text: matched.title, topicId: matched.id })
      position += matched.title.length
    } else {
      plain += char
      position += 1
    }
  }

  flushPlain()
  return segments
}

/* ------------------------------------------------------------------ */
/* 循环上限                                                            */
/* ------------------------------------------------------------------ */

/** 一轮对话里最多几轮「模型 → 工具 → 模型」 */
export const AGENT_MAX_ROUNDS = 6
/** 一轮对话里最多执行多少次工具调用 */
export const AGENT_MAX_TOOL_CALLS = 20

/**
 * 还能不能继续下一轮。
 *
 * 返回 reason 是为了**告诉用户为什么停了**——静默停下会让人以为 AI 坏了。
 */
export function canContinueAgentLoop(round: number, toolCallsUsed: number): { ok: boolean; reason: string } {
  if (toolCallsUsed >= AGENT_MAX_TOOL_CALLS) {
    return { ok: false, reason: `已达到本次最多 ${AGENT_MAX_TOOL_CALLS} 次工具调用的上限` }
  }
  if (round >= AGENT_MAX_ROUNDS) {
    return { ok: false, reason: `已达到本次最多 ${AGENT_MAX_ROUNDS} 轮的上限` }
  }
  return { ok: true, reason: '' }
}

/* ------------------------------------------------------------------ */
/* 工具定义：模型的唯一接口，description 就是它的 API 文档              */
/* ------------------------------------------------------------------ */

export interface AgentToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 拼 JSON Schema 的小工具：少一层括号，schema 一眼能读 */
function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required }
}

/** 三期 1b 只注册**只读**工具：模型物理上做不了改画布的事 */
export const AGENT_TOOLS: AgentToolDef[] = [
  {
    name: 'getSelection',
    description:
      '读取用户当前在画布上选中的主题（标题、从中心主题起的路径、子节点数、是否有备注/代码块/公式）。' +
      '用户说「这里」「这个」「选中的」时先用它确认指的是谁，不要凭猜测。',
    parameters: schema({})
  },
  {
    name: 'searchNodes',
    description:
      '在全部主题标题里按关键词搜索（不区分大小写），返回命中节点的标题与所在路径。' +
      '用户提到一个记不清位置的节点时用它定位。',
    parameters: schema(
      {
        query: { type: 'string', description: '关键词（用较短的核心词，命中率更高）' },
        limit: { type: 'integer', description: '最多返回几条，默认 20，最多 50' }
      },
      ['query']
    )
  },
  {
    name: 'getSubtree',
    description:
      '读取某个主题下面的结构（缩进大纲，含每个节点的子节点数）。' +
      'address 可以是主题 id、从中心主题起的标题路径（用 / 分隔，如 中心主题/成本/人力），或唯一的标题原文。' +
      '不确定用户指哪一支时先搜，不要用近似标题硬猜。',
    parameters: schema(
      {
        address: { type: 'string', description: '主题 id、标题路径或唯一标题' },
        depth: { type: 'integer', description: '展开到第几层，默认 2，最多 4' }
      },
      ['address']
    )
  },
  {
    name: 'getDocStats',
    description:
      '读取当前文档的规模与构成：画布数、节点总数、一级分支数、最大层级、带备注/代码块/公式的节点数。',
    parameters: schema({})
  }
]

/** 转成请求体里的 tools 字段 */
export function toWireTools(tools: AgentToolDef[] = AGENT_TOOLS): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }))
}

/* ------------------------------------------------------------------ */
/* 寻址：模型只会给字符串，解析成具体节点是**应用的责任**               */
/* ------------------------------------------------------------------ */

export interface ResolvedTopic {
  topic: Topic
  /** 中心主题 → 该节点 的标题链 */
  path: string[]
}

export type AddressResult = { ok: true; resolved: ResolvedTopic } | { ok: false; error: string }

/** 从中心主题到某节点的标题链；节点不存在返回 null */
export function topicPathOf(root: Topic, id: string): string[] | null {
  const self = findTopic(root, id)
  if (!self) return null
  const titles = ancestorsOf(root, id).map((item) => findTopic(root, item)?.title ?? '')
  return [...titles, self.title]
}

/** 找不到精确标题时，给模型几条「你可能想找的是」 */
function suggestTitles(root: Topic, query: string, limit = 5): string[] {
  const out: string[] = []
  const visit = (topic: Topic): void => {
    if (out.length >= limit) return
    if (topic.title.length > 0 && topic.title !== query && topic.title.includes(query)) out.push(topic.title)
    for (const child of topic.children) visit(child)
  }
  visit(root)
  return out
}

/**
 * 把模型给的 address 解析成具体节点。
 *
 * 支持三种写法，按可靠性从高到低尝试：**主题 id** → **标题路径** → **唯一标题**。
 * 失败时返回的话要能指导下一步动作（列出候选、提示改用路径），
 * 因为这段文字会原样回喂给模型让它自我纠正。
 */
export function resolveTopicAddress(root: Topic, address: string): AddressResult {
  const raw = address.trim()
  if (raw.length === 0) return { ok: false, error: 'address 不能为空' }

  // 1) 主题 id：最可靠，模型从 getSelection / searchNodes 拿到过 id 时走这条
  const byId = findTopic(root, raw)
  if (byId) {
    const path = topicPathOf(root, raw)
    if (path) return { ok: true, resolved: { topic: byId, path } }
  }

  // 2) 标题路径：中心主题/成本/人力；允许省略开头的中心主题
  const parts = raw
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length > 1) {
    const steps = parts[0] === root.title ? parts.slice(1) : parts
    let cursor: Topic = root
    let failed = false
    for (const step of steps) {
      const next = cursor.children.find((child) => child.title === step)
      if (!next) {
        failed = true
        return {
          ok: false,
          error: `路径「${raw}」中找不到「${step}」（在「${cursor.title}」下没有这个子主题）。可先用 searchNodes 搜一下。`
        }
      }
      cursor = next
    }
    if (!failed && steps.length > 0) {
      const path = topicPathOf(root, cursor.id)
      if (path) return { ok: true, resolved: { topic: cursor, path } }
    }
  }

  // 3) 唯一标题
  const matches: Topic[] = []
  const collect = (topic: Topic): void => {
    if (topic.title === raw) matches.push(topic)
    for (const child of topic.children) collect(child)
  }
  collect(root)

  if (matches.length === 1) {
    const only = matches[0]
    if (only) {
      const path = topicPathOf(root, only.id)
      if (path) return { ok: true, resolved: { topic: only, path } }
    }
  }
  if (matches.length > 1) {
    // 重名必须问清楚：硬选一个就是「自信地改错节点」的源头
    const paths = matches
      .map((topic) => topicPathOf(root, topic.id)?.join('/') ?? '')
      .filter((item) => item.length > 0)
      .slice(0, 5)
    return {
      ok: false,
      error: `标题「${raw}」在文档里出现了 ${matches.length} 次，无法确定是哪一个。请改用路径指定，例如：${paths.join('、')}`
    }
  }

  const hints = suggestTitles(root, raw)
  return {
    ok: false,
    error:
      hints.length > 0
        ? `没有找到标题为「${raw}」的主题。标题里包含「${raw}」的有：${hints.join('、')}——请确认要用哪一个。`
        : `没有找到标题为「${raw}」的主题，可先用 searchNodes 搜索关键词。`
  }
}

/* ------------------------------------------------------------------ */
/* 工具执行（纯逻辑：只吃一棵主题树，方便自检直接跑）                   */
/* ------------------------------------------------------------------ */

export interface ToolContext {
  root: Topic
  /** 当前选中的主题 id（没有则 null） */
  selectedId: string | null
  sheetCount: number
}

export interface ToolResult {
  ok: boolean
  /** 回喂给模型的文本（成败都在这里；失败信息要能让它自我纠正） */
  content: string
  /** 面板上给用户看的一行摘要 */
  summary: string
}

/** 缩进大纲；到底或超行数上限时标注「未展开」 */
function outlineOf(topic: Topic, depth: number, maxLines = 120): { text: string; truncated: boolean } {
  const lines: string[] = []
  let truncated = false
  const visit = (node: Topic, level: number): void => {
    if (lines.length >= maxLines) {
      truncated = true
      return
    }
    const title = node.title.length > 0 ? node.title : '（未命名）'
    const suffix = node.children.length > 0 ? `（${node.children.length} 个子节点）` : ''
    lines.push(`${'  '.repeat(level)}- ${title}${suffix}`)
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
  return { total, branches: root.children.length, maxLevel, notes, codes, formulas }
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : ''
}

function intArg(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
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
    const hits: Array<{ title: string; path: string }> = []
    let scanned = 0
    const visit = (topic: Topic): void => {
      scanned += 1
      if (topic.title.toLowerCase().includes(needle)) {
        const path = topicPathOf(context.root, topic.id)
        hits.push({ title: topic.title, path: path ? path.join(' → ') : topic.title })
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
    const lines = shown.map((hit) => `- ${hit.title}（路径：${hit.path}）`)
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
    return { ok: true, content: `${header}\n${outline.text}${tail}`, summary: `读取子树：${topic.title}` }
  }

  if (name === 'getDocStats') {
    const counts = countsOf(context.root)
    const lines = [
      '当前文档概况：',
      `- 画布数：${context.sheetCount}`,
      `- 节点总数：${counts.total}`,
      `- 一级分支数：${counts.branches}`,
      `- 最大层级：${counts.maxLevel} 层`,
      `- 带备注的节点：${counts.notes}`,
      `- 带代码块的节点：${counts.codes}`,
      `- 带公式的节点：${counts.formulas}`
    ]
    return { ok: true, content: lines.join('\n'), summary: `文档概况：${counts.total} 个节点` }
  }

  return { ok: false, content: `未知工具：${name}`, summary: `未知工具：${name}` }
}

/** 回喂给模型的单条结果长度上限：工具结果再长也不能把上下文撑爆 */
export const AGENT_TOOL_RESULT_MAX = 8000

/** 执行一次只读工具（带结果长度保护） */
export function runReadTool(name: string, argumentsText: string, context: ToolContext): ToolResult {
  const result = executeReadTool(name, argumentsText, context)
  if (result.content.length <= AGENT_TOOL_RESULT_MAX) return result
  return { ...result, content: `${result.content.slice(0, AGENT_TOOL_RESULT_MAX)}\n…（结果过长已截断）` }
}
