/**
 * Agent 模块（三期）。
 *
 * 这里放的是**纯逻辑**：不依赖 Electron、DOM 与 store，可在自检里直接跑。
 * 目前只有「把文本里提到的节点标题切成可点击片段」——聊天面板用它做
 * 「回复 → 画布」的反向链接；1b 的探查工具与循环状态机也会落在这里。
 */

import { countTopicTree, parseOutline, type OutlineNode } from '../ai'
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

/**
 * 一轮对话里最多几轮「模型 → 工具 → 模型」。
 *
 * 上限是安全阀，不该变成体验问题：撞到上限时渲染层会**去掉工具再问最后一轮**，
 * 让模型把已经看到的东西讲清楚——以前撞上限就直接收尾，用户拿到的是半截话。
 */
export const AGENT_MAX_ROUNDS = 8
/**
 * 一轮对话里最多执行多少次**工具调用**（不是操作数——一次 moveTopics 可以搬很多节点）。
 *
 * 为什么不去掉上限：没有它，模型陷入循环时会无限烧用户的钱和 patience。
 * 为什么够用：大导图的整理靠**批量工具**（moveTopics / insertSubtree），
 * 几次调用就能搬完上百个节点，逐个搬的用法本来就不该有。
 */
export const AGENT_MAX_TOOL_CALLS = 50

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
      '在全部主题标题里按关键词搜索（不区分大小写），返回命中节点的标题、所在路径与**句柄**。' +
      '用户提到一个记不清位置的节点时用它定位；同名节点多时用返回的句柄继续寻址。',
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
      '读取某个主题下面的结构（缩进大纲，含每个节点的子节点数与**句柄**）。' +
      'address 可以是主题 id、**句柄**（`#xxxxxx`）、从中心主题起的标题路径（用 / 分隔），或唯一的标题原文。' +
      '返回的每行形如 `- [#a1b2c3] 标题（3 个子节点）`，方括号里的就是句柄：' +
      '**同名节点、超长标题、标题里带斜杠的情况一律用句柄寻址**（这些东西用标题都定位不了）。' +
      '整理 / 归类大导图时先用它一次读到位。',
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

/**
 * 给模型用的**短句柄**：取节点 id 的最后一段（创建时生成的 6 个随机字符）。
 *
 * 为什么必须有它：大导图里同名节点能出现几十次（「创建 socket.socket()」这类），
 * 按标题寻址必然歧义；标题还可能带斜杠、超长、含奇怪符号。句柄是**唯一**的，
 * 模型从读工具里拿到它，就能一次把上百个节点搬完——这是「一回合整理完」的关键。
 */
export function shortHandleOf(id: string): string {
  const parts = id.split('-')
  const last = parts[parts.length - 1] ?? ''
  return last.length > 0 ? last : id.slice(-6)
}

/** 从中心主题到某节点的标题链；节点不存在返回 null */
export function topicPathOf(root: Topic, id: string): string[] | null {
  const self = findTopic(root, id)
  if (!self) return null
  const titles = ancestorsOf(root, id).map((item) => findTopic(root, item)?.title ?? '')
  return [...titles, self.title]
}

/** 某节点下的子主题清单（最多 8 个）：把候选回给模型，它下一步就能自己纠正 */
function describeChildren(topic: Topic, limit = 8): string {
  const titles = topic.children.map((child) => child.title).filter((title) => title.length > 0)
  if (titles.length === 0) return `（「${topic.title}」下面没有子主题）`
  const shown = titles.slice(0, limit)
  const more = titles.length > shown.length ? ` 等 ${titles.length} 个` : ''
  return `（在「${topic.title}」下有：${shown.join('、')}${more}）`
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

  // 1b) 短句柄（读工具每行都会打出的 `#xxxxxx`）：重名 / 超长 / 带斜杠的标题全靠它寻址
  const bare = raw.startsWith('#') ? raw.slice(1) : raw
  if (/^[0-9a-z]{4,10}$/.test(bare)) {
    const matched: Topic[] = []
    const scan = (topic: Topic): void => {
      if (shortHandleOf(topic.id) === bare) matched.push(topic)
      for (const child of topic.children) scan(child)
    }
    scan(root)
    const only = matched[0]
    if (matched.length === 1 && only) {
      const path = topicPathOf(root, only.id)
      if (path) return { ok: true, resolved: { topic: only, path } }
    }
    if (matched.length > 1) {
      return {
        ok: false,
        error: `句柄「${raw}」在文档里出现了 ${matched.length} 次（极罕见）。请改用完整的主题 id 或标题路径。`
      }
    }
  }

  // 2) 标题路径：中心主题/成本/人力。
  //    模型很爱把**文档名**或中心主题也写进开头（「体检报告/分支/子」），
  //    所以允许从开头跳掉一到两段再试；只要能走到底就算命中。
  const parts = raw
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  /** 路径解析的失败原因：先留着，等「整串标题精确匹配」也失败才报——见第 3 步的注释 */
  let pathError = ''
  if (parts.length > 1) {
    let bestDepth = -1
    let bestError = ''
    for (let skip = 0; skip <= Math.min(2, parts.length - 1); skip += 1) {
      const steps = parts.slice(skip)
      let cursor: Topic = root
      let depth = 0
      let failed = false
      for (const step of steps) {
        const next = cursor.children.find((child) => child.title === step)
        if (!next) {
          // 记下「走得最深」的那次失败：它离答案最近，对模型最有指导性
          if (depth >= bestDepth) {
            bestDepth = depth
            bestError = `路径「${raw}」中找不到「${step}」${describeChildren(cursor)}`
          }
          failed = true
          break
        }
        cursor = next
        depth += 1
      }
      if (!failed) {
        const path = topicPathOf(root, cursor.id)
        if (path) return { ok: true, resolved: { topic: cursor, path } }
      }
    }
    if (bestError.length > 0) {
      // 不在这里直接报错：标题里**本身带斜杠**的节点（「class A: /A ()」这类，
      // 编程笔记里一抓一把）路径一定走不通，但整串标题精确匹配能救回来——
      // 先让第 3 步试，第 3 步也失败才把路径错误报出去
      pathError = `${bestError}。也可以直接用 searchNodes 按标题搜索。`
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

  // 标题精确匹配也没救回来，路径错误才是真正要报的
  if (matches.length === 0 && pathError.length > 0) {
    return { ok: false, error: pathError }
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

/* ------------------------------------------------------------------ */
/* 写工具（三期二期）：能真正改画布的那一批                             */
/* ------------------------------------------------------------------ */

/**
 * 写工具**不在这里直接改 store**。
 *
 * `planWriteTool` 只把模型给的参数解析成一条「操作意图」，由渲染层执行。这样：
 * ① 这一层保持纯逻辑（自检能直接跑，不用起 React）；
 * ② 解析/寻址失败时能把可读原因原样回喂给模型，让它自己纠正；
 * ③ 破坏性操作有地方插「确认」这一步（执行前拦一道）。
 */
export type WriteIntent =
  | { kind: 'rename'; id: string; title: string }
  /** nodes = 要挂上去的若干**同级**新主题（并列多行时会有多个） */
  | { kind: 'insert'; id: string; nodes: OutlineNode[]; count: number }
  | { kind: 'delete'; id: string; title: string; size: number }
  | { kind: 'move'; id: string; targetId: string; index: number | null }
  /**
   * 批量移动：整理大导图的正路。一次工具调用搬很多节点，
   * 否则「把 84 个平铺节点归类」这种任务在任何调用上限下都做不完。
   */
  | { kind: 'moveMany'; moves: Array<{ id: string; targetId: string; index: number | null }>; requested: number }
  | { kind: 'collapse'; id: string; collapsed: boolean }
  | { kind: 'notes'; id: string; text: string }
  | { kind: 'code'; id: string; code: { language: string; text: string } | null }
  | { kind: 'formula'; id: string; formula: string }
  | { kind: 'ask'; question: string; options: string[] }

export type WritePlan =
  | { ok: true; intent: WriteIntent; summary: string; destructive: boolean }
  | { ok: false; error: string; summary: string }

export const AGENT_WRITE_TOOLS: AgentToolDef[] = [
  {
    name: 'renameTopic',
    description:
      '修改一个主题的标题。address 可以是主题 id、标题路径（如 中心主题/成本/人力），或唯一的标题原文。' +
      '改名前先确认目标是谁（用 getSelection 或 searchNodes 看过的 id），不要用近似标题硬猜。' +
      '注意：改名会清掉该标题上的局部格式（加粗/颜色），与手工改名行为一致。',
    parameters: schema(
      {
        address: { type: 'string', description: '主题 id、标题路径或唯一标题' },
        title: { type: 'string', description: '新的标题文字（不要带引号）' }
      },
      ['address', 'title']
    )
  },
  {
    name: 'insertSubtree',
    description:
      '在指定主题下面**新增**内容。outline 用缩进大纲写、每行以「- 」开头：' +
      '并列的多行会成为多个**同级**新主题，缩进两格表示更深一级。' +
      'outline 里只放要新增的主题文字，不要把解释说明或开场白写进去。',
    parameters: schema(
      {
        address: { type: 'string', description: '挂在哪个主题下面' },
        outline: { type: 'string', description: '缩进大纲文本' }
      },
      ['address', 'outline']
    )
  },
  {
    name: 'deleteTopic',
    description:
      '删除一个主题**连同它的整棵子树**。这是破坏性操作，界面上会先请你（用户）确认。' +
      '删除前务必确认目标正确——宁可先用 searchNodes 查清楚。',
    parameters: schema({ address: { type: 'string', description: '要删除的主题' } }, ['address'])
  },
  {
    name: 'moveTopic',
    description:
      '把**一个**主题（连同子树）移动到另一个主题下面。index 是插到第几个子节点（从 0 开始；省略表示放到最后）。' +
      '不能移动到自己的子孙下面。' +
      '要移动**很多**主题时（整理、归类）请改用 moveTopics——一次调用批量移动，别一个个搬。' +
      '注意：用户**手动摆过位置**的主题默认不能移动——那会打乱他自己排好的版面；' +
      '确实必要（例如用户明确要求重新排列）时，再带上 allowMoved: true 重新调用。',
    parameters: schema(
      {
        address: { type: 'string', description: '要移动的主题' },
        toAddress: { type: 'string', description: '新的父主题' },
        index: { type: 'integer', description: '插到第几个位置（可省略）' },
        allowMoved: {
          type: 'boolean',
          description: '目标主题是用户手动摆过位置时，必须显式传 true 才允许移动'
        }
      },
      ['address', 'toAddress']
    )
  },
  {
    name: 'moveTopics',
    description:
      '**批量**移动多个主题——整理 / 归类大导图时务必用它：一次调用可以移动很多节点，' +
      '比逐个 moveTopic 省得多（调用次数上限按「调用」算，不按节点算）。' +
      'moves 里每一项的语义与 moveTopic 完全相同（address / toAddress / index?）；' +
      '**address 优先填句柄**（读工具给的 `#xxxxxx`）——同名节点、超长标题、带斜杠标题都靠它。' +
      '个别条目解析失败会被**跳过**（摘要里说明是哪几条），其余照常执行；全都不行才整体报错。' +
      '列表里有用户手动摆过位置的主题时，同样需要 allowMoved: true。',
    parameters: schema(
      {
        moves: {
          type: 'array',
          description: '要执行的移动列表（一次最多 200 项；更多请分批）',
          items: {
            type: 'object',
            properties: {
              address: { type: 'string', description: '要移动的主题' },
              toAddress: { type: 'string', description: '新的父主题' },
              index: { type: 'integer', description: '插到第几个位置（可省略，省略放到最后）' }
            },
            required: ['address', 'toAddress']
          }
        },
        allowMoved: {
          type: 'boolean',
          description: '列表里有用户手动摆过位置的主题时，必须显式传 true 才允许整批移动'
        }
      },
      ['moves']
    )
  },
  {
    name: 'setCollapsed',
    description: '折叠或展开一个主题（只影响显示，不改内容）。',
    parameters: schema(
      {
        address: { type: 'string', description: '目标主题' },
        collapsed: { type: 'boolean', description: 'true = 折叠，false = 展开' }
      },
      ['address', 'collapsed']
    )
  },
  {
    name: 'setNotes',
    description: '写主题的备注（多行纯文本）。传空字符串即清空备注。',
    parameters: schema(
      {
        address: { type: 'string', description: '目标主题' },
        text: { type: 'string', description: '备注正文' }
      },
      ['address', 'text']
    )
  },
  {
    name: 'setCode',
    description:
      '写主题的代码块（会按语言语法高亮）。text 传空字符串即移除代码块。' +
      'language 用常见名：js / ts / python / java / c / cpp / csharp / go / rust / sql / json / yaml / bash / html / css / text。',
    parameters: schema(
      {
        address: { type: 'string', description: '目标主题' },
        language: { type: 'string', description: '语言（可省略，默认 text）' },
        text: { type: 'string', description: '代码正文' }
      },
      ['address', 'text']
    )
  },
  {
    name: 'setFormula',
    description:
      '写主题的 LaTeX 公式。formula 只填正文（如 \\frac{a}{b}），**不要**带 $ 或 $$ 包裹。传空字符串即移除公式。',
    parameters: schema(
      {
        address: { type: 'string', description: '目标主题' },
        formula: { type: 'string', description: 'LaTeX 正文' }
      },
      ['address', 'formula']
    )
  },
  {
    name: 'askUser',
    description:
      '当指令指向不明、有多个候选、或你不确定用户想改哪一支（哪张分支）时，用这个工具提问，' +
      '**不要猜着改**。一次只问一个问题，问题要短；能给出候选就放到 options 里。',
    parameters: schema(
      {
        question: { type: 'string', description: '要问用户的问题' },
        options: { type: 'array', items: { type: 'string' }, description: '可选的候选答案（最多 5 个）' }
      },
      ['question']
    )
  }
]

/** 一次对话可用的全部工具（读 + 写） */
export const AGENT_ALL_TOOLS: AgentToolDef[] = [...AGENT_TOOLS, ...AGENT_WRITE_TOOLS]

/**
 * 这次对话**允许模型看到的工具**。
 *
 * 闸门放在「下发哪些工具定义」这一层，而不是"调用时再拦"——模型看不到写工具，
 * 就物理上调不动它，与「工具即权限边界」是同一条原则（也是提示词注入的最终防线）。
 * `canWrite` 由主进程按许可状态算出（Pro，或试用还没用完）。
 */
export function planAvailableTools(canWrite: boolean): AgentToolDef[] {
  return canWrite ? AGENT_ALL_TOOLS : AGENT_TOOLS
}

/** 目标节点自己或它的某个子孙是不是 `id` */
function subtreeContains(node: Topic, id: string): boolean {
  if (node.id === id) return true
  return node.children.some((child) => subtreeContains(child, id))
}

/**
 * 把写工具的调用解析成一条「操作意图」。
 *
 * 失败也返回文本（`error`）而不是抛错：这段文字会原样回喂给模型，
 * 它看到「标题「成本」出现 2 次，请改用路径」才知道下一步怎么改。
 */
export function planWriteTool(name: string, argumentsText: string, root: Topic): WritePlan {
  const fail = (error: string): WritePlan => ({
    ok: false,
    error: `调用 ${name} 失败：${error}`,
    summary: `${name}：${error.length > 30 ? `${error.slice(0, 30)}…` : error}`
  })

  let args: Record<string, unknown> = {}
  const trimmed = argumentsText.trim()
  if (trimmed.length > 0) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      return fail(`参数不是合法 JSON（${(error as Error).message}）。请重新调用并传入合法参数。`)
    }
    if (!isRecord(parsed)) return fail('参数必须是 JSON 对象。')
    args = parsed
  }

  /** 解析 address 并给出「找到的那个节点」 */
  const resolve = (key: string): { topic: Topic } | { problem: WritePlan } => {
    const address = stringArg(args, key)
    if (address.length === 0) return { problem: fail(`${key} 不能为空。`) }
    const resolved = resolveTopicAddress(root, address)
    if (!resolved.ok) return { problem: fail(resolved.error) }
    return { topic: resolved.resolved.topic }
  }

  if (name === 'renameTopic') {
    const target = resolve('address')
    if ('problem' in target) return target.problem
    if (typeof args.title !== 'string') return fail('title 必须是字符串。')
    const title = args.title.trim()
    return {
      ok: true,
      intent: { kind: 'rename', id: target.topic.id, title },
      summary:
        title.length === 0
          ? `清空「${target.topic.title}」的标题`
          : `改名「${target.topic.title}」→「${title}」`,
      destructive: false
    }
  }

  if (name === 'insertSubtree') {
    const target = resolve('address')
    if ('problem' in target) return target.problem
    const outline = stringArg(args, 'outline')
    if (outline.length === 0) return fail('outline 不能为空。')
    const parsed = parseOutline(outline, '新主题')
    if (!parsed.root) return fail(parsed.warnings.join('；') || 'outline 里解析不出任何主题。')

    // 并列多行会被解析器套一个壳节点：这里**把壳剥掉**，让那些行成为并列的新主题。
    // 直接把壳落进画布会凭空多出一个叫「新主题」的垃圾节点——模型没错，是我们的锅。
    const nodes = parsed.wrapped ? parsed.root.children : [parsed.root]
    if (nodes.length === 0) return fail('outline 里没有可插入的主题。')

    const host = target.topic.title
    const shown = nodes
      .slice(0, 3)
      .map((node) => node.title)
      .join('、')
    return {
      ok: true,
      intent: { kind: 'insert', id: target.topic.id, nodes, count: parsed.count },
      summary:
        nodes.length === 1
          ? `在「${host}」下新增「${nodes[0]?.title ?? ''}」（共 ${parsed.count} 个节点）`
          : `在「${host}」下新增 ${nodes.length} 个主题（${shown}${nodes.length > 3 ? ' 等' : ''}；共 ${parsed.count} 个节点）`,
      destructive: false
    }
  }

  if (name === 'deleteTopic') {
    const target = resolve('address')
    if ('problem' in target) return target.problem
    const size = countTopicTree(target.topic)
    return {
      ok: true,
      intent: { kind: 'delete', id: target.topic.id, title: target.topic.title, size },
      summary: `删除「${target.topic.title}」（含 ${size} 个节点）`,
      destructive: true
    }
  }

  if (name === 'moveTopic') {
    const source = resolve('address')
    if ('problem' in source) return source.problem
    const destination = resolve('toAddress')
    if ('problem' in destination) return destination.problem
    if (source.topic.id === destination.topic.id) return fail('不能把一个主题移到它自己下面。')
    if (subtreeContains(source.topic, destination.topic.id)) {
      return fail('不能把一个主题移到它自己的子孙下面。')
    }
    // 自由摆放的地盘：用户手动摆过位置的主题默认不动（改动别人的版面比改内容更招人烦，
    // 而且撤得回来也撤不掉火气）。要走这条路必须是模型**显式**说清楚。
    if (source.topic.position && args.allowMoved !== true) {
      return fail(
        `「${source.topic.title}」是用户手动摆过位置的主题，移动它会打乱他自己排的版面。` +
          '如果这一步确实必要（例如用户明确要求重新排列），请再调用一次并带上 allowMoved: true。'
      )
    }
    const rawIndex = args.index
    const index = typeof rawIndex === 'number' && Number.isFinite(rawIndex) ? Math.max(0, Math.round(rawIndex)) : null
    return {
      ok: true,
      intent: { kind: 'move', id: source.topic.id, targetId: destination.topic.id, index },
      summary: `移动「${source.topic.title}」到「${destination.topic.title}」下`,
      destructive: false
    }
  }

  if (name === 'moveTopics') {
    // 批量移动：整理大导图的正路。
    // 100 条里错 1 条就整批退回 = 烧掉整整一轮（模型重写 100 条 JSON），
    // 所以这里是**跳过容错**：能执行的执行，解析失败的精确列出来让模型补一次即可。
    const raw = args.moves
    if (!Array.isArray(raw) || raw.length === 0) return fail('moves 必须是非空的数组。')
    if (raw.length > 200) return fail('一次最多移动 200 个主题，更多请分批调用。')

    const moves: Array<{ id: string; targetId: string; index: number | null }> = []
    const skipped: string[] = []
    for (let position = 0; position < raw.length; position += 1) {
      const item = raw[position]
      if (!isRecord(item)) {
        skipped.push(`moves[${position}]（不是对象）`)
        continue
      }
      const sourceAddress = typeof item.address === 'string' ? item.address.trim() : ''
      if (sourceAddress.length === 0) {
        skipped.push(`moves[${position}]（缺 address）`)
        continue
      }
      const source = resolveTopicAddress(root, sourceAddress)
      if (!source.ok) {
        skipped.push(`moves[${position}]「${sourceAddress}」`)
        continue
      }
      const targetAddress = typeof item.toAddress === 'string' ? item.toAddress.trim() : ''
      if (targetAddress.length === 0) {
        skipped.push(`moves[${position}]（缺 toAddress）`)
        continue
      }
      const destination = resolveTopicAddress(root, targetAddress)
      if (!destination.ok) {
        skipped.push(`moves[${position}] 的目标「${targetAddress}」`)
        continue
      }
      if (source.resolved.topic.id === destination.resolved.topic.id) {
        skipped.push(`moves[${position}]（目标是它自己）`)
        continue
      }
      if (subtreeContains(source.resolved.topic, destination.resolved.topic.id)) {
        skipped.push(`moves[${position}]（目标是它自己的子孙）`)
        continue
      }
      if (source.resolved.topic.position && args.allowMoved !== true) {
        skipped.push(`moves[${position}]「${source.resolved.topic.title}」（用户手动摆过位置）`)
        continue
      }
      const rawIndex = item.index
      const slot =
        typeof rawIndex === 'number' && Number.isFinite(rawIndex) ? Math.max(0, Math.round(rawIndex)) : null
      moves.push({ id: source.resolved.topic.id, targetId: destination.resolved.topic.id, index: slot })
    }

    if (moves.length === 0) {
      return fail(
        `没有一条能执行。${skipped.length > 0 ? `原因：${skipped.slice(0, 6).join('；')}。` : ''}` +
          '可以用 searchNodes 搜到正确的标题后再补一次调用。'
      )
    }
    const skippedNote =
      skipped.length > 0
        ? `（跳过 ${skipped.length} 条没执行：${skipped.slice(0, 4).join('；')}${skipped.length > 4 ? '…' : ''}）`
        : ''
    return {
      ok: true,
      intent: { kind: 'moveMany', moves, requested: raw.length },
      summary: `批量移动 ${moves.length} 个主题${skippedNote}`,
      destructive: false
    }
  }

  if (name === 'setCollapsed') {
    const target = resolve('address')
    if ('problem' in target) return target.problem
    if (typeof args.collapsed !== 'boolean') return fail('collapsed 必须是 true 或 false。')
    return {
      ok: true,
      intent: { kind: 'collapse', id: target.topic.id, collapsed: args.collapsed },
      summary: `${args.collapsed ? '折叠' : '展开'}「${target.topic.title}」`,
      destructive: false
    }
  }

  if (name === 'setNotes') {
    const target = resolve('address')
    if ('problem' in target) return target.problem
    if (typeof args.text !== 'string') return fail('text 必须是字符串。')
    const text = args.text
    return {
      ok: true,
      intent: { kind: 'notes', id: target.topic.id, text },
      summary:
        text.trim().length === 0
          ? `清空「${target.topic.title}」的备注`
          : `给「${target.topic.title}」写备注（${text.trim().length} 字）`,
      destructive: false
    }
  }

  if (name === 'setCode') {
    const target = resolve('address')
    if ('problem' in target) return target.problem
    if (typeof args.text !== 'string') return fail('text 必须是字符串。')
    const text = args.text
    if (text.trim().length === 0) {
      return {
        ok: true,
        intent: { kind: 'code', id: target.topic.id, code: null },
        summary: `移除「${target.topic.title}」的代码块`,
        destructive: false
      }
    }
    const language = stringArg(args, 'language')
    return {
      ok: true,
      intent: { kind: 'code', id: target.topic.id, code: { language: language.length > 0 ? language : 'text', text } },
      summary: `给「${target.topic.title}」写代码块（${language.length > 0 ? language : 'text'}）`,
      destructive: false
    }
  }

  if (name === 'setFormula') {
    const target = resolve('address')
    if ('problem' in target) return target.problem
    if (typeof args.formula !== 'string') return fail('formula 必须是字符串。')
    // 模型常常好心地把公式包在 $…$ 里，这里替它剥掉（与公式输入框的处理一致）
    const formula = args.formula.trim().replace(/^\$\$?/, '').replace(/\$\$?$/, '').trim()
    return {
      ok: true,
      intent: { kind: 'formula', id: target.topic.id, formula },
      summary:
        formula.length === 0 ? `移除「${target.topic.title}」的公式` : `给「${target.topic.title}」写公式`,
      destructive: false
    }
  }

  if (name === 'askUser') {
    const question = stringArg(args, 'question')
    if (question.length === 0) return fail('question 不能为空。')
    const rawOptions = args.options
    const options = Array.isArray(rawOptions)
      ? rawOptions.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 5)
      : []
    return {
      ok: true,
      intent: { kind: 'ask', question, options },
      summary: `提问：${question.length > 24 ? `${question.slice(0, 24)}…` : question}`,
      destructive: false
    }
  }

  return fail('不是可用的写工具。')
}

/** 写意图是不是「会改动画布」的那种（askUser 只提问，不改任何东西） */
export function isMutatingIntent(intent: WriteIntent): boolean {
  return intent.kind !== 'ask'
}

/** 这个名字是不是只读工具（渲染层据此决定「直接执行」还是「走写工具流程」） */
export function isReadToolName(name: string): boolean {
  return AGENT_TOOLS.some((tool) => tool.name === name)
}
