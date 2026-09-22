/**
 * 聊天上下文：骨架摘要、任务意图分类、聊天历史的归一与压缩。
 *
 * 单一职责：决定「这轮对话给模型看什么」。长对话压缩后仍要能正确引用现状，
 * 所以摘要口径（digestPreamble）与保留条数都集中在这里。
 */
import { isRecord } from '../guards'
import { countHiddenNodes, visibleChildren } from '../model/tree'
import type { Topic } from '../model/types'
import type { AiMessage } from './stream'

/** 统计一棵主题树的节点总数（含根） */
/**
 * 子树节点总数（含自己）。
 *
 * 注意与 `@shared/model/tree` 的 `countTopics` **不等价**：后者走 `walk`，
 * 会把 `detachedChildren`（自由摆放的主题）也数进去，这里只跟 `children`。
 * 别把两者合并——有浮动节点的文档会静默多算。这一处用于给模型报「这个分支多大」，
 * 与画布上的实体层级保持一致。
 */
export function countTopicTree(root: Topic): number {
  let total = 1
  for (const child of root.children) total += countTopicTree(child)
  return total
}

/**
 * 骨架摘要：中心主题 + 一级分支 + 各自子树节点数。
 *
 * 作用是**让模型先知道该问什么**——只给标题它不知道哪里内容多、
 * 哪里值得深挖；全量注入又装不下大文档（万级节点）。
 * 骨架是两者的平衡点：万级文档也只有十几行、几百 token。
 */
export function buildSkeletonDigest(root: Topic, maxBranches = 20): string {
  const lines: string[] = [`中心主题：${root.title.length > 0 ? root.title : '（未命名）'}`]
  const children = root.children
  if (children.length === 0) {
    lines.push('（暂无一级分支）')
    return lines.join('\n')
  }

  /**
   * 被折叠收起的分支要**标出来**：骨架是模型判断「图里有什么」的第一手材料，
   * 不标它就会以为那些分支不存在（或反过来，以为它们正显示在画布上）。
   */
  const visible = new Set(visibleChildren(root).map((topic) => topic.id))
  const shown = children.slice(0, maxBranches)
  for (const child of shown) {
    const title = child.title.length > 0 ? child.title : '（未命名）'
    const folded = visible.has(child.id) ? '' : '，已收起'
    lines.push(`- ${title}（${countTopicTree(child)} 个节点${folded}）`)
  }
  if (children.length > shown.length) {
    lines.push(`- …另有 ${children.length - shown.length} 个一级分支未列出`)
  }
  const hidden = countHiddenNodes(root)
  if (hidden > 0) {
    lines.push(`（提示：画布上共有 ${hidden} 个节点已收起、当前不显示）`)
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 任务类型识别（决定注入哪个场景模块）                                  */
/* ------------------------------------------------------------------ */

/**
 * 从用户这一轮的话里**粗略**判断任务类型。
 *
 * 为什么需要它：以前不管问什么，都把「100+ 节点生成规格」整份塞进提示词——
 * 小任务被大规格污染（改个标题也洋洋洒洒），还白烧 token。现在按任务注入对应模块。
 *
 * 判据刻意**宽松**（命中一个词就算）：漏判的代价是"少给规格"（质量掉档），
 * 误判的代价只是多几百 token——宁滥勿缺。
 * 两类都没命中时**不注入模块**，让模型自己先判断该做什么（判断不出来就问，见底线 3）。
 */
export interface TaskIntent {
  /** 可能要大范围生成内容 */
  generation: boolean
  /** 可能要改动已有内容 */
  editing: boolean
}

const GENERATION_HINTS = [
  '生成',
  '写一份',
  '写个',
  '做一份',
  '做个',
  '整理成',
  '整理出',
  '大纲',
  '导图',
  '知识体系',
  '体系',
  '框架',
  '补全',
  '扩充',
  '扩写',
  '罗列',
  '列一份',
  '详细',
  '详解',
  '复习',
  '备考',
  '梳理'
]

const EDITING_HINTS = [
  '改',
  '修改',
  '重命名',
  '改名',
  '删',
  '移',
  '搬',
  '合并',
  '去重',
  '查重',
  '排序',
  '编号',
  '折叠',
  '收起',
  '展开',
  '加个',
  '加上',
  '调整',
  '润色',
  '替换',
  '归类',
  '精简'
]

export function classifyTaskIntent(text: string | null | undefined): TaskIntent {
  const content = (text ?? '').trim()
  return {
    generation: GENERATION_HINTS.some((hint) => content.includes(hint)),
    editing: EDITING_HINTS.some((hint) => content.includes(hint))
  }
}

/** 落盘的聊天记录条目（只存必要字段；**不进 .xmind**） */
export interface ChatHistoryEntry {
  role: 'user' | 'assistant'
  content: string
  aborted?: boolean
}

/** 单条记录长度上限与整体条数上限：防坏文件与超长内容把面板撑爆 */
const CHAT_ENTRY_MAX_LENGTH = 20000
const CHAT_HISTORY_MAX = 200

/**
 * 校验并裁剪落盘的聊天记录。
 *
 * 磁盘上的文件可能是旧版本写的、也可能被手工改坏；
 * 坏条目一律丢弃、超长截断，**绝不让它把渲染层带崩**。
 */
export function normalizeChatHistory(raw: unknown): ChatHistoryEntry[] {
  if (!isRecord(raw)) return []
  const list = raw.messages
  if (!Array.isArray(list)) return []

  const out: ChatHistoryEntry[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const role = item.role
    if (role !== 'user' && role !== 'assistant') continue
    if (typeof item.content !== 'string' || item.content.trim().length === 0) continue
    const content =
      item.content.length > CHAT_ENTRY_MAX_LENGTH
        ? item.content.slice(0, CHAT_ENTRY_MAX_LENGTH)
        : item.content
    out.push({ role, content, aborted: item.aborted === true ? true : undefined })
  }
  // 只留最近的一批：长对话的下文比上文有用
  return out.slice(-CHAT_HISTORY_MAX)
}

/**
 * 压缩器的输入：比 `AiMessage` 多一条「这一轮干了什么」（面板上的工具条目）。
 *
 * 不能直接吃 AiMessage：工具条目只存在于面板的消息里，而它们恰恰是
 * 「我做过什么」最可靠的来源（结论可能被模型说错，工具条目是执行记录）。
 */
export interface CompressibleMessage {
  role: 'user' | 'assistant'
  content: string
  /** 这一轮 AI 执行过的工具调用摘要 */
  toolNotes?: string[]
}

export interface CompressedHistory {
  /** 折叠出来的「此前做过什么」；空串表示没折叠任何东西 */
  digest: string
  /** 保留原文的消息（最早的在前） */
  recent: CompressibleMessage[]
  /** 被折叠了几条 */
  collapsed: number
}

/** 保留最近几条原文：够模型接着聊，又不至于把上下文撑爆 */
export const HISTORY_KEEP_RECENT = 6
/** 摘要的长度上限（超出就从**最早**的条目开始丢：越近的越重要） */
export const HISTORY_DIGEST_MAX = 1200

function firstLineOf(text: string): string {
  const line =
    text
      .split('\n')
      .map((item) => item.trim())
      .find((item) => item.length > 0) ?? ''
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

/**
 * 折叠更早的轮次，压成一段「此前做过什么」。
 *
 * 为什么不是直接截断：`slice(-16)` 会让模型忘掉之前干过什么，用户说「继续」时
 * 它就从零重新读一遍导图——在大导图上就是把同一种折腾重复一遍（真被投诉过）。
 * 而本项目的底层判断是「**文档本身是 agent 的持久记忆**」：对话可以激进压缩，
 * 因为任何细节它都能用只读工具重新探查回来；但「我做过什么」必须留着。
 *
 * 不做模型调用：**纯函数、零成本、可自检**。摘要内容是确定性的——
 * 每条旧消息取「用户让我…」+「我做了…」（没有工具条目时才退回「我说过…」）。
 */
export function compressHistory(
  messages: readonly CompressibleMessage[],
  options: { keepRecent?: number; maxDigest?: number } = {}
): CompressedHistory {
  const keep = Math.max(2, options.keepRecent ?? HISTORY_KEEP_RECENT)
  const maxDigest = Math.max(0, options.maxDigest ?? HISTORY_DIGEST_MAX)
  const cut = Math.max(0, messages.length - keep)
  const older = messages.slice(0, cut)
  const recent = messages.slice(cut)
  if (older.length === 0) return { digest: '', recent: [...messages], collapsed: 0 }

  const lines: string[] = []
  for (const message of older) {
    const text = firstLineOf(message.content)
    if (message.role === 'user') {
      if (text.length > 0) lines.push(`- 用户让我：${text}`)
      continue
    }
    const notes = (message.toolNotes ?? []).filter((note) => note.trim().length > 0)
    if (notes.length > 0) lines.push(`- 我做了：${notes.slice(0, 6).join('、')}`)
    else if (text.length > 0) lines.push(`- 我说过：${text}`)
  }

  // 太长就从最早丢：越近的越重要
  let digest = lines.join('\n')
  while (digest.length > maxDigest && lines.length > 1) {
    lines.shift()
    digest = lines.join('\n')
  }
  if (digest.length > maxDigest) digest = `${digest.slice(0, maxDigest)}…`
  return { digest, recent, collapsed: older.length }
}

/** 最近窗口里 assistant 的工具附注最长保留多少字符（D-05：不丢，但也不撑爆上下文）。 */
export const WIRE_TOOL_NOTES_MAX = 240

/**
 * 把 `recent` 窗口转成真正的 wire 消息。
 *
 * D-05 第一步：`older` 进 digest，`recent` 原样保留 toolNotes；拼 wire 时以前只取
 * role/content，于是第 2、3 轮 AI 干过什么都看不到。这里把 assistant 的 toolNotes
 * 追加成一行附注。
 *
 * D-05 第二步（本批）：最后一条 assistant 已经由 system prompt 的 `previousTurnNotes`
 * 注入；若它同时也是最后一条消息，wire 就跳过它的附注，避免同一信息出现两次。
 * 若最后一条是 user（此时 system 没注入任何 notes），仍保留前一条 assistant 的附注。
 */
export function toWireRecentMessages(
  recent: readonly CompressibleMessage[],
  options: { maxNoteChars?: number; skipLastAssistantNotes?: boolean } = {}
): AiMessage[] {
  const maxNoteChars = options.maxNoteChars ?? WIRE_TOOL_NOTES_MAX
  const skipLastAssistantNotes = options.skipLastAssistantNotes ?? true
  const out: AiMessage[] = []
  for (const [index, message] of recent.entries()) {
    if (message.content.trim().length === 0) continue
    if (message.role !== 'assistant') {
      out.push({ role: message.role, content: message.content })
      continue
    }
    if (skipLastAssistantNotes && index === recent.length - 1) {
      out.push({ role: 'assistant', content: message.content })
      continue
    }
    const notes = (message.toolNotes ?? [])
      .map((note) => note.trim())
      .filter((note) => note.length > 0)
    if (notes.length === 0) {
      out.push({ role: 'assistant', content: message.content })
      continue
    }
    const body = notes.join('；')
    const clipped = body.length > maxNoteChars ? `${body.slice(0, maxNoteChars)}…` : body
    out.push({ role: 'assistant', content: `${message.content}\n（本轮执行：${clipped}）` })
  }
  return out
}
/** 把摘要包装成一条可以塞进消息线的内容（带一句"别凭记忆改"的提醒） */
export function digestPreamble(digest: string): string {
  return (
    '（以下是更早对话的折叠摘要，供你了解上下文。它是**概括**，细节请直接重新读取导图或搜索，' +
    '不要凭这份摘要里的印象去改节点。）\n' +
    digest
  )
}
