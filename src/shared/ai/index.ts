/**
 * AI 功能的纯逻辑（不依赖 Electron 与 DOM，可在自检里跑）。
 *
 * 设计要点：
 * 1. 走 **OpenAI 兼容协议**（`/v1/chat/completions`），填 BaseURL / Key / 模型名即可对接
 *    OpenAI、DeepSeek、通义、智谱、Kimi 等任何兼容实现；
 * 2. 让模型输出**缩进大纲**而不是 JSON——大纲用文本表达更稳，模型不容易写坏引号导致整段作废；
 * 3. 网络请求放在主进程（避开渲染进程的 CORS 限制），这里只做「拼请求、解析结果、翻译错误」。
 */

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

import { createTopic } from '../model/factory'
import type { Topic } from '../model/types'

export interface AiConfig {
  /** 形如 https://api.deepseek.com/v1 或 https://api.openai.com/v1 */
  baseUrl: string
  /** 只存在主进程的配置文件里，不写进 .xmind */
  apiKey: string
  model: string
  /** 采样温度（0.2 稳定，0.9 发散） */
  temperature: number
}

/** 界面上要用的配置视图：**不包含完整 Key**，只给掩码 */
export interface AiConfigView {
  baseUrl: string
  model: string
  temperature: number
  hasKey: boolean
  /** 例如 sk-…3f9c；没有 Key 时为 null */
  keyPreview: string | null
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.6
}

/** 常见服务商的预设，方便一键填 BaseURL */
export const AI_PRESETS: Array<{ label: string; baseUrl: string; model: string }> = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: '通义千问（兼容模式）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { label: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { label: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' }
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验并补全配置；非法字段退回默认值并给出提示 */
export function normalizeAiConfig(raw: unknown): { config: AiConfig; warnings: string[] } {
  const warnings: string[] = []
  const source = isRecord(raw) ? raw : {}

  let baseUrl = typeof source.baseUrl === 'string' ? source.baseUrl.trim() : ''
  if (baseUrl.length === 0) {
    baseUrl = DEFAULT_AI_CONFIG.baseUrl
  } else if (!/^https?:\/\//i.test(baseUrl)) {
    warnings.push('BaseURL 必须以 http:// 或 https:// 开头，已回退为默认值')
    baseUrl = DEFAULT_AI_CONFIG.baseUrl
  }

  const model = typeof source.model === 'string' && source.model.trim().length > 0 ? source.model.trim() : DEFAULT_AI_CONFIG.model
  const apiKey = typeof source.apiKey === 'string' ? source.apiKey.trim() : ''

  let temperature = typeof source.temperature === 'number' && Number.isFinite(source.temperature) ? source.temperature : DEFAULT_AI_CONFIG.temperature
  if (temperature < 0) temperature = 0
  if (temperature > 2) temperature = 2

  return { config: { baseUrl, model, apiKey, temperature }, warnings }
}

/** 把配置转成界面上要展示的形态（Key 只给掩码） */
export function toConfigView(config: AiConfig): AiConfigView {
  const key = config.apiKey
  const preview = key.length === 0 ? null : key.length <= 8 ? '****' : `${key.slice(0, 3)}…${key.slice(-4)}`
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    temperature: config.temperature,
    hasKey: key.length > 0,
    keyPreview: preview
  }
}

/**
 * 拼出 chat/completions 的完整地址。
 * 用户可能填 `https://api.x.com`、`https://api.x.com/v1`、`https://api.x.com/v1/` 或完整地址，
 * 这几种都要能用。
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) return ''
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  if (/\/v\d+(\.\d+)?$/i.test(trimmed)) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

/* ------------------------------------------------------------------ */
/* 提示词                                                              */
/* ------------------------------------------------------------------ */

export interface AiMessage {
  role: 'system' | 'user'
  content: string
}

const OUTLINE_SYSTEM =
  '你是思维导图助手。输出必须是**缩进大纲**：每行一个节点，以「- 」开头，' +
  '子节点比父节点多缩进两个空格。只输出大纲本身，不要解释、不要客套、不要用代码块包裹。'

/** 一键生成导图的提示词 */
export function buildGenerateMessages(input: {
  topic: string
  /** 期望的层级深度 */
  depth?: number
  /** 额外要求（用户自由填写） */
  extra?: string
}): AiMessage[] {
  const depth = input.depth && input.depth > 0 ? input.depth : 3
  const lines = [
    `主题：${input.topic}`,
    `要求：最多 ${depth} 层，第一行是中心主题，下面按层级展开；用简体中文；每个节点尽量简短（不超过 12 字）。`
  ]
  if (input.extra && input.extra.trim().length > 0) lines.push(`补充要求：${input.extra.trim()}`)
  return [
    { role: 'system', content: OUTLINE_SYSTEM },
    { role: 'user', content: lines.join('\n') }
  ]
}

/** 节点扩写（给选中节点补子主题）的提示词 */
export function buildExpandMessages(input: {
  title: string
  /** 已有的子主题，避免重复 */
  existing?: string[]
  count?: number
  /** 该节点的备注，作为上下文 */
  notes?: string
  /** 从根到父节点的路径，帮助模型理解上下文 */
  path?: string[]
}): AiMessage[] {
  const count = input.count && input.count > 0 ? input.count : 5
  const lines = [`当前主题：${input.title}`]
  if (input.path && input.path.length > 1) lines.push(`所在分支：${input.path.join(' → ')}`)
  if (input.notes && input.notes.trim().length > 0) lines.push(`备注信息：${input.notes.trim()}`)
  if (input.existing && input.existing.length > 0) {
    lines.push(`已有的子主题（不要重复）：${input.existing.join('、')}`)
  }
  lines.push(`任务：为「${input.title}」补 ${count} 个新的子主题。`)
  lines.push('要求：每个子主题一行，以「- 」开头且**不要缩进**，简体中文，每个不超过 12 字，只输出这些行。')

  return [
    { role: 'system', content: OUTLINE_SYSTEM },
    { role: 'user', content: lines.join('\n') }
  ]
}

/** 文案润色（只改这一句标题）的提示词 */
export function buildPolishMessages(input: { title: string; style?: string }): AiMessage[] {
  const style = input.style && input.style.trim().length > 0 ? input.style.trim() : '简洁、专业、通顺'
  return [
    {
      role: 'system',
      content:
        '你是中文文案编辑。只返回改写后的那一句文本本身：不要引号、不要编号、不要解释、不要换行。' +
        '如果原文已经是好的，就返回原文。'
    },
    {
      role: 'user',
      content: `请把下面这条思维导图节点文字改得${style}，保持原意与长度相当：\n${input.title}`
    }
  ]
}

/* ------------------------------------------------------------------ */
/* 解析模型输出                                                        */
/* ------------------------------------------------------------------ */

export interface OutlineNode {
  title: string
  children: OutlineNode[]
}

export interface ParsedOutline {
  /** 解析出的根节点；解析不出内容时为 null */
  root: OutlineNode | null
  /** 一共解析出多少个节点（含根） */
  count: number
  warnings: string[]
}

/** 去掉 ```lang ... ``` 包裹；模型经常多此一举地包一层 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  const lines = trimmed.split(/\r?\n/)
  const first = lines.shift() ?? ''
  void first
  if (lines.length > 0 && lines[lines.length - 1].trim().startsWith('```')) lines.pop()
  return lines.join('\n')
}

/** 一行的解析结果：层级深度 + 文字 + 是否有列表标记；不是大纲行则返回 null */
export function parseOutlineLine(line: string): { depth: number; text: string; marked: boolean } | null {
  if (line.trim().length === 0) return null

  // 制表符按两个空格算，缩进按两格一级
  const expanded = line.replace(/\t/g, '  ')
  const indent = expanded.length - expanded.trimStart().length
  let body = expanded.trim()

  const marked = /^([-*+•]\s+|\d+[.)、]\s*|#{1,6}\s+)/.test(body)

  // 去掉列表符号：- * + • 、1. 1)、# 标题
  body = body.replace(/^[-*+•]\s+/, '')
  body = body.replace(/^\d+[.)、]\s*/, '')
  body = body.replace(/^#{1,6}\s+/, '')
  body = body.replace(/^\*\*(.+)\*\*$/, '$1').trim()

  if (body.length === 0) return null
  // 纯分隔线/装饰行直接跳过
  if (/^[-=_*]{3,}$/.test(body)) return null

  return { depth: Math.floor(indent / 2), text: body, marked }
}

/** 短句才可能是主题；带句号的长句通常是模型的解释文字 */
export function looksLikeTopic(text: string): boolean {
  if (/[。！？!?]$/.test(text.trim())) return false
  if (/[，,；;].*[，,；;]/.test(text) && [...text].length > 20) return false
  return [...text.trim()].length <= 24
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
  for (const line of lines) {
    const item = parseOutlineLine(line)
    if (item) all.push(item)
  }

  let parsed = all.filter((item) => item.marked || item.depth > 0)

  if (parsed.length === 0) {
    const terse = all.filter((item) => looksLikeTopic(item.text))
    if (terse.length === 0) {
      return {
        root: null,
        count: 0,
        warnings: ['模型没有返回可解析的大纲（只看到说明文字），请重试或换个模型']
      }
    }
    parsed = terse
    warnings.push('模型没有用缩进大纲的格式，已按「一行一个主题」解析')
  }

  // 归一化深度：第一行深度当作 0，避免模型整体缩进导致层级错位
  const baseDepth = parsed[0].depth
  for (const item of parsed) item.depth = Math.max(0, item.depth - baseDepth)

  const roots: OutlineNode[] = []
  const stack: Array<{ depth: number; node: OutlineNode }> = []

  for (const item of parsed) {
    const node: OutlineNode = { title: item.text, children: [] }
    while (stack.length > 0 && stack[stack.length - 1].depth >= item.depth) stack.pop()

    const parent = stack[stack.length - 1]
    if (parent) parent.node.children.push(node)
    else roots.push(node)

    stack.push({ depth: item.depth, node })
  }

  let root: OutlineNode
  if (roots.length === 1) {
    root = roots[0]
  } else {
    // 模型给了并列的多个顶层节点：套一个根节点，别让它们散着
    root = { title: fallbackRootTitle, children: roots }
    warnings.push(`模型返回了 ${roots.length} 个并列的顶层节点，已统一挂到「${fallbackRootTitle}」下`)
  }

  const count = countOutlineNodes(root)
  return { root, count, warnings }
}

export function countOutlineNodes(node: OutlineNode | null): number {
  if (!node) return 0
  let total = 1
  for (const child of node.children) total += countOutlineNodes(child)
  return total
}

/** 把解析出来的大纲转成模型里的主题树（AI 结果落盘用） */
export function outlineToTopic(node: OutlineNode, structureClass?: string): Topic {
  const topic = createTopic(node.title, structureClass)
  topic.children = node.children.map((child) => outlineToTopic(child))
  return topic
}

/** 解析「一行一个」的列表（扩写结果那种） */
export function parseFlatList(text: string): string[] {
  const body = stripCodeFence(text ?? '')
  const out: string[] = []
  for (const line of body.split(/\r?\n/)) {
    const item = parseOutlineLine(line)
    if (!item) continue
    // 扩写可能出现缩进、或者写成多级；这里只要文字
    if (item.text.length > 0) out.push(item.text)
  }
  return out
}

/**
 * 润色结果清洗：模型常常不听话地加上引号、编号或换行。
 * 只保留第一行，去掉包裹的引号与「1. 」这类前缀。
 */
export function cleanPolishedTitle(raw: string): string {
  const firstLine = (raw ?? '').split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  let text = firstLine
  text = text.replace(/^\d+[.)、]\s*/, '')
  text = text.replace(/^[-*+•]\s+/, '')
  if (text.length >= 2) {
    const pairs: Array<[string, string]> = [
      ['"', '"'],
      ['「', '」'],
      ['“', '”'],
      ["'", "'"],
      ['《', '》']
    ]
    for (const [open, close] of pairs) {
      if (text.startsWith(open) && text.endsWith(close) && text.length > open.length + close.length) {
        text = text.slice(open.length, text.length - close.length)
        break
      }
    }
  }
  return text.trim()
}

/* ------------------------------------------------------------------ */
/* 网络结果的解析与错误翻译                                            */
/* ------------------------------------------------------------------ */

/** 从 OpenAI 兼容响应里取正文；取不到时抛出可读错误 */
export function extractContent(payload: unknown): string {
  if (!isRecord(payload)) throw new Error('AI 返回的内容不是合法的 JSON 对象')
  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    // 有些实现把错误塞在 body 里
    const message = isRecord(payload.error) && typeof payload.error.message === 'string' ? payload.error.message : null
    throw new Error(message ? `AI 返回错误：${message}` : 'AI 没有返回任何结果（choices 为空）')
  }

  const first = choices[0]
  if (!isRecord(first)) throw new Error('AI 返回结构不正确（choices[0] 不是对象）')
  const message = first.message
  if (isRecord(message) && typeof message.content === 'string') return message.content
  if (typeof first.text === 'string') return first.text
  throw new Error('AI 返回结构不正确（缺少 message.content）')
}

/** 把 HTTP 状态码与响应体翻译成用户能看懂的中文提示 */
export function describeAiError(status: number, bodyText: string): string {
  let detail = bodyText.trim()
  try {
    const parsed: unknown = JSON.parse(bodyText)
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string') {
      detail = parsed.error.message
    }
  } catch {
    /* 不是 JSON 就用原文 */
  }
  const short = detail.length > 200 ? `${detail.slice(0, 200)}…` : detail

  if (status === 401 || status === 403) {
    return `鉴权失败（${status}）：API Key 不对或没有权限。请到「AI 设置」里检查 Key。${short ? ` 服务端信息：${short}` : ''}`
  }
  if (status === 404) {
    return `接口不存在（404）：多半是 BaseURL 或模型名填错了，BaseURL 一般要带 /v1。${short ? ` 服务端信息：${short}` : ''}`
  }
  if (status === 429) {
    return `请求太频繁或被限流（429）：稍后再试，或换一个模型/额度。${short ? ` 服务端信息：${short}` : ''}`
  }
  if (status === 400) {
    return `请求被拒绝（400）：可能是模型名不对或提示词过长。${short ? ` 服务端信息：${short}` : ''}`
  }
  if (status >= 500) {
    return `AI 服务端错误（${status}）：不是你的问题，稍后再试。${short ? ` 服务端信息：${short}` : ''}`
  }
  return `AI 请求失败（${status}）${short ? `：${short}` : ''}`
}
