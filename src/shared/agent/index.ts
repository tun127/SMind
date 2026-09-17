/**
 * Agent 模块（三期）。
 *
 * 这里放的是**纯逻辑**：不依赖 Electron、DOM 与 store，可在自检里直接跑。
 * 目前只有「把文本里提到的节点标题切成可点击片段」——聊天面板用它做
 * 「回复 → 画布」的反向链接；1b 的探查工具与循环状态机也会落在这里。
 */

import { countTopicTree, parseOutline, type OutlineNode } from '../ai'
import { isRecord } from '../guards'
import { parseRange } from '../layout'
import { ancestorsOf, findTopic, isSelfOrDescendant, walk } from '../model/tree'
import type { Sheet, Topic, TopicCode } from '../model/types'
import { DEFAULT_STRUCTURE, MARKER_LABELS, STRUCTURES } from '../xmind/constants'

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
export function segmentTitleMentions(
  text: string,
  index: Map<string, TitleIndexEntry[]>
): TextSegment[] {
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
 *
 * 16 轮 → 40 轮（用户要求"一句命令就生成 100+ 个节点的完整图"之后放的）：
 * 一次完整的详细生成通常是「读骨架 → 按分支逐个 insertSubtree（一个分支一次，
 * 免得单次输出被上限截断）→ 补解释 → 收尾」，分 5~8 个分支就是十几轮，
 * 16 轮会让它写到一半被截断——而截断的表现正是"只写了粗分"。
 */
export const AGENT_MAX_ROUNDS = 40
/**
 * 一轮对话里最多执行多少次**工具调用**（不是操作数——一次 moveTopics 可以搬很多节点）。
 *
 * 为什么不去掉上限：没有它，模型陷入循环时会无限烧用户的钱和 patience。
 * 60 → 200：100+ 节点的详细图（每个节点可能还要单独补备注/代码/公式）在
 * 只读探查 + 分批写入之下会用到几十上百次调用；60 会在写到一半时停住。
 */
export const AGENT_MAX_TOOL_CALLS = 200

/**
 * 还能不能继续下一轮。
 *
 * 返回 reason 是为了**告诉用户为什么停了**——静默停下会让人以为 AI 坏了。
 */
export function canContinueAgentLoop(
  round: number,
  toolCallsUsed: number
): { ok: boolean; reason: string } {
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
function schema(
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return { type: 'object', properties, required }
}

/** 三期 1b 只注册**只读**工具：模型物理上做不了改画布的事 */
export const AGENT_TOOLS: AgentToolDef[] = [
  {
    name: 'listAttachments',
    description:
      '列出画布上的**元素**：关系线（含两端主题与元素 id）、边界、概要，以及可用的标记 id 清单。' +
      '要给某个分支加边界/概要、要连关系线、或要改/删已有的这些元素时，先用它拿到 id——' +
      '这些元素**没有标题可寻址**，改它们必须用返回的 id。',
    parameters: schema({
      address: { type: 'string', description: '只列与这个主题相关的元素（可省略；省略则列全部）' }
    })
  },
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
  },
  {
    name: 'updatePlan',
    description:
      '写下**执行计划**，并在每完成一步后更新进度（**不改画布**）。' +
      '动手前先调用它：steps 给 2~6 步的清单，一步一件事、每步能对应到具体操作；' +
      '之后**每完成一步再调用一次**，steps 传同一份清单、done 传已完成的数量（1、2、3…）。' +
      '用户会在聊天里看到这份清单与进度。大任务（新建整张图、批量补内容、重构结构）先写计划，' +
      '比直接开干更容易做全，也更容易被发现有遗漏。小改动（改个标题、搬一个节点）不需要计划。',
    parameters: schema(
      {
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: '计划步骤（2~6 条，按执行顺序）'
        },
        done: { type: 'integer', description: '已完成几步（0 = 刚开始；做到第 k 步就传 k）' }
      },
      ['steps']
    )
  },
  {
    name: 'readDocument',
    description:
      '读取**用户挂在这个会话上的文档**（聊天面板里拖进来的 / 点 📎 选的）。' +
      '用户的要求与某份文档有关、或你需要原文依据时用它，**不要凭空作答**。' +
      '用法：不填 name 时只有一份文档就直接读；填 name 选指定文档（先不填 query 调一次可看到' +
      '可用文档清单与本段范围）；填 query 就返回包含该关键词的片段（带行号，最适合问答）；' +
      '不填 query 则按 offset/limit 返回一段（默认从头 6000 字）。',
    parameters: schema(
      {
        name: { type: 'string', description: '文档名（可只写一部分），不填 = 唯一的那份' },
        query: { type: 'string', description: '要查找的关键词（推荐：比整篇读更省更快）' },
        offset: { type: 'integer', description: '从第几个字符开始（默认 0）' },
        limit: { type: 'integer', description: '最多返回多少字符（默认 6000，最多 12000）' }
      },
      []
    )
  },
  {
    name: 'exportOutline',
    description:
      '把当前画布导出成大纲文件：txt（纯文本）/ md（Markdown）/ opml（可导入其它导图软件）。' +
      '会弹出系统的「保存到…」对话框，用户自己选位置——**不要在用户没要求时主动导出**。' +
      '用户说"导出大纲 / 存成 Markdown / 给我 OPML"时用它。',
    parameters: schema(
      {
        format: { type: 'string', description: 'txt / md / opml，默认 md' }
      },
      []
    )
  },
  {
    name: 'findIncompleteNodes',
    description:
      '按「完整性」筛查节点，用来**自检有没有漏**：哪些节点缺备注（解释）、缺子节点（叶子）、缺代码块。' +
      '写完一大片内容后调用它核对覆盖度，再针对性补齐——比凭印象说"都写好了"可靠得多。' +
      'missing 选一种：notes（缺备注，默认）/ children（叶子节点）/ code（缺代码块）；' +
      'scope 可限定某一支（标题路径或句柄），不填就是整篇。返回带**句柄**，可以直接拿去继续写。',
    parameters: schema(
      {
        missing: { type: 'string', description: 'notes / children / code，默认 notes' },
        scope: { type: 'string', description: '限定在哪一支下面查，不填 = 整篇' },
        limit: { type: 'integer', description: '最多列出几个（默认 20，最多 50）' }
      },
      []
    )
  },
  {
    name: 'findDuplicates',
    description:
      '按「同名」查重：找出**规范化后标题相同**的节点（忽略空白、标点、全角半角、尾部编号与' +
      '「（补充）/ 副本」后缀），并给出每组的句柄与路径；另外列出「疑似近义」（一个标题是另一个的一部分）。' +
      'AI 分批写入后最容易留下重复，整理收尾时用它先看清楚，再决定要不要调 mergeDuplicates 合并。',
    parameters: schema(
      { scope: { type: 'string', description: '限定在哪一支下面查，不填 = 整篇' } },
      []
    )
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
    if (topic.title.length > 0 && topic.title !== query && topic.title.includes(query))
      out.push(topic.title)
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
function duplicateGroups(scope: Topic): Array<{ title: string; ids: string[] }> {
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

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : ''
}

function intArg(
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
      '可用标记 id（给 setMarkers 用，格式 markerId=含义）：' +
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
    const pathOf = (id: string): string =>
      ancestorsOf(context.root, id)
        .map((ancestor) => findTopic(context.root, ancestor)?.title ?? '')
        .filter((title) => title.length > 0)
        .join(' → ')
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

    const titleOf = (id: string): string => findTopic(context.root, id)?.title ?? ''
    /** 祖先路径（含中心主题，不含自己） */
    const pathOf = (id: string): string[] =>
      ancestorsOf(context.root, id)
        .map(titleOf)
        .filter((title) => title.length > 0)

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
export const AGENT_TOOL_RESULT_MAX = 8000

/** 执行一次只读工具（带结果长度保护） */
export function runReadTool(name: string, argumentsText: string, context: ToolContext): ToolResult {
  const result = executeReadTool(name, argumentsText, context)
  if (result.content.length <= AGENT_TOOL_RESULT_MAX) return result
  return {
    ...result,
    content: `${result.content.slice(0, AGENT_TOOL_RESULT_MAX)}\n…（结果过长已截断）`
  }
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
  | {
      kind: 'moveMany'
      moves: Array<{ id: string; targetId: string; index: number | null }>
      requested: number
    }
  | { kind: 'collapse'; id: string; collapsed: boolean }
  /** 切换结构（思维导图 / 鱼骨 / 时间轴 …）：整张图或某一支 */
  | { kind: 'structure'; id: string; structureClass: string }
  /** 同级排序（+ 可选自动编号）：orderedIds 是排好的子主题顺序 */
  | { kind: 'sortChildren'; id: string; orderedIds: string[]; renumber: boolean }
  /** 合并同名主题：每组保留 keepId，把 mergeIds 的内容并进去后删掉它们 */
  | { kind: 'dedupe'; groups: Array<{ keepId: string; mergeIds: string[] }> }
  | { kind: 'notes'; id: string; text: string }
  | { kind: 'code'; id: string; code: TopicCode | null }
  | { kind: 'formula'; id: string; formula: string }
  | { kind: 'ask'; question: string; options: string[] }
  /* ---- 第二批：画布元素（关系线 / 边界 / 概要）+ 标记 / 标签 ---- */
  | { kind: 'relationship'; ends: [string, string]; label: string; title: string | null }
  | { kind: 'boundary'; topicIds: string[]; label: string; title: string | null }
  | { kind: 'summary'; topicIds: string[]; label: string; title: string | null }
  | { kind: 'attachmentTitle'; target: AttachmentKind; id: string; title: string }
  | { kind: 'attachmentRemove'; target: AttachmentKind; id: string; label: string }
  | { kind: 'markers'; id: string; markerIds: string[] }
  | { kind: 'label'; id: string; label: string; add: boolean }

/** 画布上的三种元素（第二批工具的共通目标） */
export type AttachmentKind = 'relationship' | 'boundary' | 'summary'

/** 中文名：摘要与报错里用它，避免用户看到 relationship 这种词 */
const ATTACHMENT_LABEL: Record<AttachmentKind, string> = {
  relationship: '关系线',
  boundary: '边界',
  summary: '概要'
}

function readAttachmentKind(raw: unknown): AttachmentKind | null {
  return raw === 'relationship' || raw === 'boundary' || raw === 'summary' ? raw : null
}

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
      'outline 里只放要新增的主题文字，不要把解释说明或开场白写进去。' +
      '每个节点的文字要**自带信息量**（具体事实、数字、条件、例子），不要写「XX 的概述」这类空标题；' +
      '解释与细节**直接写成子节点**（「要点：…」「例：…」），不要用 `> ` 备注行——备注在画布上不显眼。' +
      '**它只用于真正的新内容**：把画布上已有的节点「重写一遍」等于复制一份（整理 / 归类已有内容请用 moveTopics 移动）。',
    parameters: schema(
      {
        address: { type: 'string', description: '挂在哪个主题下面' },
        outline: { type: 'string', description: '缩进大纲文本' },
        allowDuplicate: {
          type: 'boolean',
          description: 'outline 的标题在文档里大多已存在时会被拦下；确实要新增同名内容才传 true'
        }
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
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '可选的候选答案（最多 5 个）'
        }
      },
      ['question']
    )
  },
  {
    name: 'addRelationship',
    description:
      '在两个主题之间连一条关系线（可选标注文字）。两端用 address 指定（id / 句柄 / 标题路径 / 唯一标题）。' +
      '已经连过就复用原来那条，不会重复连。',
    parameters: schema(
      {
        from: { type: 'string', description: '起点主题' },
        to: { type: 'string', description: '终点主题' },
        label: { type: 'string', description: '线上的标注文字（可省略）' }
      },
      ['from', 'to']
    )
  },
  {
    name: 'addBoundary',
    description:
      '给一组**同级**主题加边界（圈出一个范围），可带标题。addresses 传多个时表示「第一个到最后一个」的连续区间，' +
      '所以这些主题必须是同一级且相邻。范围已经存在就复用。',
    parameters: schema(
      {
        addresses: {
          type: 'array',
          items: { type: 'string' },
          description: '要圈进去的主题（1 个或连续几个）'
        },
        title: { type: 'string', description: '边界的标题（可省略）' }
      },
      ['addresses']
    )
  },
  {
    name: 'addSummary',
    description:
      '给一组**同级**主题加概要（标在右侧的概括框），可带标题。要求与 addBoundary 相同。',
    parameters: schema(
      {
        addresses: {
          type: 'array',
          items: { type: 'string' },
          description: '要概括的主题（1 个或连续几个）'
        },
        title: { type: 'string', description: '概要文字（可省略，默认「概要」）' }
      },
      ['addresses']
    )
  },
  {
    name: 'setAttachmentTitle',
    description:
      '改画布元素上的文字：关系线的标注 / 边界的标题 / 概要的文字。' +
      'id 必须先用 listAttachments 拿到（这些元素没有标题可寻址）。',
    parameters: schema(
      {
        target: {
          type: 'string',
          enum: ['relationship', 'boundary', 'summary'],
          description: '元素种类'
        },
        id: { type: 'string', description: '元素 id（来自 listAttachments）' },
        title: { type: 'string', description: '新的文字（空串表示清空）' }
      },
      ['target', 'id', 'title']
    )
  },
  {
    name: 'removeAttachment',
    description:
      '删除一个画布元素（关系线 / 边界 / 概要）。id 来自 listAttachments。' +
      '这是破坏性操作，用户会被问一次——只有用户确实要删时才用它。',
    parameters: schema(
      {
        target: {
          type: 'string',
          enum: ['relationship', 'boundary', 'summary'],
          description: '元素种类'
        },
        id: { type: 'string', description: '元素 id（来自 listAttachments）' }
      },
      ['target', 'id']
    )
  },
  {
    name: 'setMarkers',
    description:
      '设置主题的标记图标（**整体替换**，不是追加；传空数组就是清空）。' +
      'markerId 必须来自 listAttachments 返回的清单，**不要自己编**（编出来的 id 会被拒绝）。',
    parameters: schema(
      {
        address: { type: 'string', description: '目标主题' },
        markers: {
          type: 'array',
          items: { type: 'string' },
          description: '标记 id 列表（整体替换）'
        }
      },
      ['address', 'markers']
    )
  },
  {
    name: 'addLabel',
    description: '给主题加一个标签（短词，例如「重点」「待办」「疑问」）。已经有的标签不会重复加。',
    parameters: schema(
      {
        address: { type: 'string', description: '目标主题' },
        label: { type: 'string', description: '标签文字（短）' }
      },
      ['address', 'label']
    )
  },
  {
    name: 'removeLabel',
    description: '去掉主题上的一个标签。',
    parameters: schema(
      {
        address: { type: 'string', description: '目标主题' },
        label: { type: 'string', description: '要移除的标签文字' }
      },
      ['address', 'label']
    )
  },
  {
    name: 'setStructure',
    description:
      '切换结构类型：把整张图（或某一支）从逻辑图改成思维导图 / 鱼骨图 / 时间轴 / 括号图 / 矩阵图等。' +
      `可选结构：${STRUCTURES.filter((s) => s.supported)
        .map((s) => (s.class === DEFAULT_STRUCTURE ? `${s.class}（默认）` : s.class))
        .join('、')}。` +
      '改整张图不填 address（用的是中心主题）；只改某支用 address 指定。' +
      '用户说"换成鱼骨图 / 改成时间轴 / 排成矩阵"时就调它——**不要**手动搬节点去模拟结构。',
    parameters: schema(
      {
        address: { type: 'string', description: '要改哪个主题，不填 = 中心主题（整张图）' },
        structure: {
          type: 'string',
          description:
            '结构 id（如 org.xmind.ui.fishbone.leftHeaded），也可以直接用中文名（如 鱼骨图）'
        }
      },
      ['structure']
    )
  },
  {
    name: 'sortSiblings',
    description:
      '给某个主题的**同级子主题排序**（默认按标题），可选**自动编号**（1. 2. 3. …，会先去掉旧编号）。' +
      '整理类任务的收尾常用：把并列的分支按顺序排好、或给步骤类内容编号。' +
      'by 可选 title（默认，按标题）/ length（按标题长度）；order 可选 asc（默认）/ desc。' +
      '注意：编号会重写子主题标题，**该标题上的局部格式（加粗/颜色）会跟着被清掉**（与手工改名一致）。',
    parameters: schema(
      {
        address: { type: 'string', description: '排谁的子主题，不填 = 中心主题' },
        by: { type: 'string', description: 'title（默认）/ length' },
        order: { type: 'string', description: 'asc（默认）/ desc' },
        renumber: { type: 'boolean', description: 'true = 顺带加「1. 2. 」编号' }
      },
      []
    )
  },
  {
    name: 'mergeDuplicates',
    description:
      '合并**同名重复**的主题（同名判定同 findDuplicates：忽略空白/标点/全角半角/尾部编号与"（补充）"后缀）。' +
      '保留内容最完整的那个，把其余的**子主题搬过来、缺的备注/代码/公式/标签补上**，再删掉多余节点。' +
      '**这是删节点的操作**，界面上会先请用户确认。要精确控制就先 findDuplicates 看清有哪些组，' +
      '用 titles 只合并指定的那几组，否则合并范围内全部同名组。',
    parameters: schema(
      {
        scope: { type: 'string', description: '限定在哪一支里合并，不填 = 整篇' },
        titles: {
          type: 'array',
          items: { type: 'string' },
          description: '只合并这些标题（原文照抄），不填则合并全部同名组'
        }
      },
      []
    )
  }
]

/** 一次对话可用的全部工具（读 + 写） */
export const AGENT_ALL_TOOLS: AgentToolDef[] = [...AGENT_TOOLS, ...AGENT_WRITE_TOOLS]

/**
 * 真正会**改动画布**的写工具名（**不含 askUser**）。
 *
 * 用途：试用计数只认「这次对话真的动了画布吗」——askUser 只是提问、什么都没改，
 * 把它算进去等于"只问一句就消耗一个试用回合"。
 */
export const AGENT_CANVAS_TOOL_NAMES: string[] = AGENT_WRITE_TOOLS.filter(
  (tool) => tool.name !== 'askUser'
).map((tool) => tool.name)

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
    // 空操作要如实说：否则一次「改了名」的报告背后什么都没变，用户以为 AI 在糊弄他
    if (target.topic.title === title) {
      return fail(`「${title}」的标题本来就是它，这次没有任何改动。`)
    }
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

    // 防「照抄已有内容」：整理 / 归类时模型很容易用新增来"重写一遍"，结果是把内容**复制**一份
    // （真出过事故：一次整理之后画布上出现了好几套相同的分类与节点）。
    // 硬判定：outline 里的标题有多大比例**文档里已经存在**——过半数且数量不少就拦下来。
    if (args.allowDuplicate !== true) {
      const existing = new Set<string>()
      const collect = (topic: Topic): void => {
        if (topic.title.length > 0) existing.add(topic.title)
        for (const child of topic.children) collect(child)
      }
      collect(root)
      let totalNodes = 0
      let alreadyExists = 0
      const walk = (node: OutlineNode): void => {
        totalNodes += 1
        if (existing.has(node.title)) alreadyExists += 1
        for (const child of node.children) walk(child)
      }
      for (const node of nodes) walk(node)
      if (alreadyExists >= 5 && alreadyExists * 2 >= totalNodes) {
        return fail(
          `outline 里有 ${alreadyExists}/${totalNodes} 个标题在文档中**已经存在**——这看着像是把已有内容重写一遍，` +
            '执行后画布上会多出一份重复内容。归置已有主题请改用 moveTopics（按句柄或标题寻址移动）。' +
            '确实要新增这些同名内容，带上 allowDuplicate: true 再调用一次。'
        )
      }
    }

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
    // 空操作：本来就在这个父级下、又没指定位置——如实说，不要报成「已移动」。
    // 判定与 store 的 moveNode **完全一致**（同父级 + 无 index 就是原地不动），
    // 否则会出现「计划说执行了、实际被忽略」的错位。要重排就显式给 index。
    const chain = ancestorsOf(root, source.topic.id)
    if (chain[chain.length - 1] === destination.topic.id && args.index === undefined) {
      return fail(
        `「${source.topic.title}」本来就在「${destination.topic.title}」下面，这次没有改动。`
      )
    }
    const rawIndex = args.index
    const index =
      typeof rawIndex === 'number' && Number.isFinite(rawIndex)
        ? Math.max(0, Math.round(rawIndex))
        : null
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
        typeof rawIndex === 'number' && Number.isFinite(rawIndex)
          ? Math.max(0, Math.round(rawIndex))
          : null
      moves.push({
        id: source.resolved.topic.id,
        targetId: destination.resolved.topic.id,
        index: slot
      })
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
      intent: {
        kind: 'code',
        id: target.topic.id,
        code: { language: language.length > 0 ? language : 'text', text }
      },
      summary: `给「${target.topic.title}」写代码块（${language.length > 0 ? language : 'text'}）`,
      destructive: false
    }
  }

  if (name === 'setFormula') {
    const target = resolve('address')
    if ('problem' in target) return target.problem
    if (typeof args.formula !== 'string') return fail('formula 必须是字符串。')
    // 模型常常好心地把公式包在 $…$ 里，这里替它剥掉（与公式输入框的处理一致）
    const formula = args.formula
      .trim()
      .replace(/^\$\$?/, '')
      .replace(/\$\$?$/, '')
      .trim()
    return {
      ok: true,
      intent: { kind: 'formula', id: target.topic.id, formula },
      summary:
        formula.length === 0
          ? `移除「${target.topic.title}」的公式`
          : `给「${target.topic.title}」写公式`,
      destructive: false
    }
  }

  if (name === 'askUser') {
    const question = stringArg(args, 'question')
    if (question.length === 0) return fail('question 不能为空。')
    const rawOptions = args.options
    const options = Array.isArray(rawOptions)
      ? rawOptions
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .slice(0, 5)
      : []
    return {
      ok: true,
      intent: { kind: 'ask', question, options },
      summary: `提问：${question.length > 24 ? `${question.slice(0, 24)}…` : question}`,
      destructive: false
    }
  }

  if (name === 'addRelationship') {
    const from = typeof args.from === 'string' ? args.from : ''
    const to = typeof args.to === 'string' ? args.to : ''
    const source = resolveTopicAddress(root, from)
    if (!source.ok) return fail(source.error)
    const target = resolveTopicAddress(root, to)
    if (!target.ok) return fail(target.error)
    if (source.resolved.topic.id === target.resolved.topic.id) {
      return fail('关系线两端不能是同一个主题。')
    }
    const label = typeof args.label === 'string' ? args.label.trim() : ''
    const fromTitle = source.resolved.topic.title
    const toTitle = target.resolved.topic.title
    return {
      ok: true,
      intent: {
        kind: 'relationship',
        ends: [source.resolved.topic.id, target.resolved.topic.id],
        label: `${fromTitle} → ${toTitle}`,
        title: label.length > 0 ? label : null
      },
      summary: `连关系线：${fromTitle} → ${toTitle}`,
      destructive: false
    }
  }

  if (name === 'addBoundary' || name === 'addSummary') {
    const rawList = args.addresses
    const list = Array.isArray(rawList)
      ? rawList.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : []
    if (list.length === 0) return fail('addresses 至少要给一个主题。')
    const topicIds: string[] = []
    const titles: string[] = []
    for (const item of list) {
      const resolved = resolveTopicAddress(root, item)
      if (!resolved.ok) return fail(resolved.error)
      topicIds.push(resolved.resolved.topic.id)
      titles.push(resolved.resolved.topic.title)
    }
    const title =
      typeof args.title === 'string' && args.title.trim().length > 0 ? args.title.trim() : null
    const shown = titles.join('、')
    const isBoundary = name === 'addBoundary'
    return {
      ok: true,
      intent: { kind: isBoundary ? 'boundary' : 'summary', topicIds, label: shown, title },
      summary: `${isBoundary ? '加边界' : '加概要'}：${shown}`,
      destructive: false
    }
  }

  if (name === 'setAttachmentTitle') {
    const target = readAttachmentKind(args.target)
    if (!target) return fail('target 只能是 relationship / boundary / summary。')
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (id.length === 0) return fail('缺少 id：请先用 listAttachments 拿到元素 id。')
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    return {
      ok: true,
      intent: { kind: 'attachmentTitle', target, id, title },
      summary: `改${ATTACHMENT_LABEL[target]}文字：${title.length > 0 ? title : '（清空）'}`,
      destructive: false
    }
  }

  if (name === 'removeAttachment') {
    const target = readAttachmentKind(args.target)
    if (!target) return fail('target 只能是 relationship / boundary / summary。')
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (id.length === 0) return fail('缺少 id：请先用 listAttachments 拿到元素 id。')
    return {
      ok: true,
      intent: { kind: 'attachmentRemove', target, id, label: ATTACHMENT_LABEL[target] },
      summary: `删除${ATTACHMENT_LABEL[target]}（id=${id}）`,
      // 破坏性：交给渲染层先问一次用户
      destructive: true
    }
  }

  if (name === 'setMarkers') {
    const address = typeof args.address === 'string' ? args.address : ''
    const resolved = resolveTopicAddress(root, address)
    if (!resolved.ok) return fail(resolved.error)
    const rawList = args.markers
    const list = Array.isArray(rawList)
      ? rawList
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map((item) => item.trim())
      : []
    const unknown = list.filter((markerId) => !(markerId in MARKER_LABELS))
    if (unknown.length > 0) {
      return fail(
        `不认识的标记 id：${unknown.join('、')}。可用 id 见 listAttachments 返回的清单，不要自己编。`
      )
    }
    const title = resolved.resolved.topic.title
    return {
      ok: true,
      intent: { kind: 'markers', id: resolved.resolved.topic.id, markerIds: list },
      summary: `设置标记（${title}）：${list.length > 0 ? list.join('、') : '清空'}`,
      destructive: false
    }
  }

  if (name === 'addLabel' || name === 'removeLabel') {
    const address = typeof args.address === 'string' ? args.address : ''
    const resolved = resolveTopicAddress(root, address)
    if (!resolved.ok) return fail(resolved.error)
    const label = typeof args.label === 'string' ? args.label.trim() : ''
    if (label.length === 0) return fail('label 不能为空。')
    const add = name === 'addLabel'
    return {
      ok: true,
      intent: { kind: 'label', id: resolved.resolved.topic.id, label, add },
      summary: `${add ? '加' : '去'}标签（${resolved.resolved.topic.title}）：${label}`,
      destructive: false
    }
  }

  if (name === 'setStructure') {
    const raw = stringArg(args, 'structure')
    const structureClass = resolveStructureId(raw)
    if (structureClass === null) {
      return fail(
        `不认识的结构「${raw}」。可选：${STRUCTURES.filter((s) => s.supported)
          .map((s) => `${s.label}（${s.class}）`)
          .join('、')}`
      )
    }
    // 不填 address = 整张图（改中心主题的结构），与界面上点「结构」下拉的效果一致
    const address = stringArg(args, 'address')
    let target = root
    if (address.length > 0) {
      const resolved = resolveTopicAddress(root, address)
      if (!resolved.ok) return fail(resolved.error)
      target = resolved.resolved.topic
    }
    const label = STRUCTURES.find((s) => s.class === structureClass)?.label ?? structureClass
    return {
      ok: true,
      intent: { kind: 'structure', id: target.id, structureClass },
      summary: `把「${target.title}」的结构改成${label}`,
      destructive: false
    }
  }

  if (name === 'sortSiblings') {
    const address = stringArg(args, 'address')
    let parent = root
    if (address.length > 0) {
      const resolved = resolveTopicAddress(root, address)
      if (!resolved.ok) return fail(resolved.error)
      parent = resolved.resolved.topic
    }
    if (parent.children.length < 2) {
      return fail(`「${parent.title}」下面只有 ${parent.children.length} 个子主题，不需要排序。`)
    }
    const by = stringArg(args, 'by') === 'length' ? 'length' : 'title'
    const desc = stringArg(args, 'order') === 'desc'
    const ordered = [...parent.children].sort((left, right) => {
      const base =
        by === 'length'
          ? left.title.length - right.title.length
          : left.title.localeCompare(right.title, 'zh-Hans-CN', {
              numeric: true,
              sensitivity: 'base'
            })
      // 同键时按 id 兜底：顺序稳定，用户重复调用不会每次都变
      return (desc ? -base : base) || left.id.localeCompare(right.id)
    })
    return {
      ok: true,
      intent: {
        kind: 'sortChildren',
        id: parent.id,
        orderedIds: ordered.map((topic) => topic.id),
        renumber: args.renumber === true
      },
      summary:
        `按${by === 'length' ? '标题长度' : '标题'}${desc ? '倒序' : '正序'}排列「${parent.title}」的 ` +
        `${ordered.length} 个子主题${args.renumber === true ? '，并重新编号' : ''}`,
      destructive: false
    }
  }

  if (name === 'mergeDuplicates') {
    const scopeArg = stringArg(args, 'scope')
    let base = root
    if (scopeArg.length > 0) {
      const resolved = resolveTopicAddress(root, scopeArg)
      if (!resolved.ok) return fail(resolved.error)
      base = resolved.resolved.topic
    }
    const rawTitles = Array.isArray(args.titles) ? args.titles : []
    const wanted = rawTitles
      .filter((title): title is string => typeof title === 'string' && title.trim().length > 0)
      .map((title) => normalizeTopicTitle(title))

    const groups = duplicateGroups(base).filter(
      (group) => wanted.length === 0 || wanted.includes(normalizeTopicTitle(group.title))
    )
    if (groups.length === 0) {
      return fail('没有找到可合并的同名主题（可以先调 findDuplicates 看看）。')
    }

    const planned: Array<{ keepId: string; mergeIds: string[] }> = []
    let nested = 0
    for (const group of groups) {
      const topics = group.ids
        .map((id) => findTopic(root, id))
        .filter((topic): topic is Topic => topic !== null)
      // 组内存在祖先/后代关系时合并会搬出一个环：跳过并如实说明
      const hasNesting = topics.some((left) =>
        topics.some((right) => left.id !== right.id && isSelfOrDescendant(root, left.id, right.id))
      )
      if (hasNesting) {
        nested += 1
        continue
      }
      // 保留"内容最全"的那个；同分时保留层级更浅的（信息更容易被找到）
      const ranked = [...topics].sort(
        (left, right) =>
          contentScore(right) - contentScore(left) ||
          ancestorsOf(root, left.id).length - ancestorsOf(root, right.id).length
      )
      const keeper = ranked[0]
      if (!keeper) continue
      planned.push({ keepId: keeper.id, mergeIds: ranked.slice(1).map((topic) => topic.id) })
    }
    if (planned.length === 0) {
      return fail(
        `${groups.length} 组同名主题之间都存在父子包含关系（比如「成本」下面还有「成本」），` +
          '合并会把子节点搬进自己的祖先里——请先手动调整结构再用它。'
      )
    }
    const removed = planned.reduce((sum, item) => sum + item.mergeIds.length, 0)
    return {
      ok: true,
      intent: { kind: 'dedupe', groups: planned },
      summary:
        `合并 ${planned.length} 组同名主题：保留内容最全的那个，删掉多余 ${removed} 个` +
        (nested > 0 ? `（另有 ${nested} 组因存在父子包含关系被跳过）` : ''),
      destructive: true
    }
  }

  return fail('不是可用的写工具。')
}

/** 挑「保留哪一个」用的内容量：子树越大越全；同规模时看有没有备注/代码/公式 */
function contentScore(topic: Topic): number {
  return (
    countTopicTree(topic) * 100 +
    (topic.notes && topic.notes.trim().length > 0 ? 10 : 0) +
    (topic.code ? 5 : 0) +
    (topic.formula ? 3 : 0)
  )
}

/** 结构 id 的宽松解析：完整 class、中文名、或点号后缀都能认 */
function resolveStructureId(input: string): string | null {
  const value = input.trim()
  if (value.length === 0) return null
  const supported = STRUCTURES.filter((structure) => structure.supported)
  const lower = value.toLowerCase()
  const hit =
    supported.find((structure) => structure.class === value) ??
    supported.find((structure) => structure.label === value) ??
    supported.find((structure) => structure.class.toLowerCase().endsWith(`.${lower}`))
  return hit ? hit.class : null
}

/** 写意图是不是「会改动画布」的那种（askUser 只提问，不改任何东西） */
export function isMutatingIntent(intent: WriteIntent): boolean {
  return intent.kind !== 'ask'
}

/** 这个名字是不是只读工具（渲染层据此决定「直接执行」还是「走写工具流程」） */
export function isReadToolName(name: string): boolean {
  return AGENT_TOOLS.some((tool) => tool.name === name)
}
