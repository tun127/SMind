/**
 * 流式协议：SSE 切分、增量解析、工具调用聚合、思维链过滤、wire 消息拼装。
 *
 * 单一职责：把「一坨字节」变成结构化事件。网络本身在 main（无 CORS 顾虑），
 * 这里只做**纯解析**，所以自检可以直接喂字节流。
 */
import { isRecord } from '../guards'

/** 模型请求调用某个工具（协议里 arguments 是**字符串**，由流式分片拼出来） */
export interface ToolCall {
  id: string
  name: string
  argumentsText: string
}

/** 流式分片里的一条 tool_call 增量：id/name 通常只在首片给，arguments 逐片追加 */
export interface ToolCallDelta {
  index: number
  id?: string
  name?: string
  argumentsText?: string
}

export interface AiMessage {
  /** assistant 出现在多轮对话里；tool 是工具执行结果回喂（三期） */
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** 助手请求的工具调用：回喂下一轮时**必须带上**，否则协议不成立 */
  toolCalls?: ToolCall[]
  /** role: 'tool' 时，对应哪一次调用 */
  toolCallId?: string
}

/** 主进程 → 渲染进程的流式事件（由 requestId 关联同一次请求） */
export type AiStreamEvent =
  | { requestId: string; kind: 'chunk'; text: string }
  | {
      requestId: string
      kind: 'reasoning'
      text: string
    }
  | {
      requestId: string
      kind: 'done'
      content: string
      model: string
      aborted: boolean
      /** 这一轮模型请求的工具调用（空数组 = 说完了） */
      toolCalls: ToolCall[]
      /**
       * 输出被服务商截断了（`finish_reason: 'length'`）。
       *
       * 以前这个信息被**丢掉**：解析出来了、没人用，于是「被掐断」和「正常说完」
       * 在应用里长得一模一样——用户看到的就是"AI 怎么只写了一点点"。
       * 带上它，界面才能如实说明并引导续写。
       */
      truncated?: boolean
      /**
       * 输出陷入**自我重复**（退化循环），已熔断止损。
       * flash 档模型在超长上下文里的典型失效：同一行连吐几百遍。
       * 界面要如实告知并给下一步（重试 / 换模型）。
       */
      degenerated?: boolean
      /** 思维链全文（有才有；界面用它兜底，保证与流式期间拼出的不一致时以它为准） */
      reasoning?: string
      /** token 消耗（服务商回报；不支持 usage 的服务商没有这个字段，界面就不显示） */
      usage?: TokenUsage
    }
  | { requestId: string; kind: 'error'; message: string }

/**
 * 把网络字节流切成一条条完整的 SSE 数据行。
 *
 * 网络包会在**任意位置**断开——一行 `data: {...}` 很可能分两次到达，
 * 所以必须留缓冲：只吐出确定完整的行，半截的留在缓冲里等下一包。
 * 这是流式解析唯一容易写错的地方。
 *
 * **还必须能收尾**：缓冲里那一截"没有换行结尾的最后一个 data 行"要等 `flush()`
 * 才能吐出。有些服务商的流结尾不带换行，以前没有 flush，最后一段正文就此丢掉
 * （表现是"回答末尾少了一截"，而且极难复现）。
 */
export interface SseLineSplitter {
  (chunk: string): string[]
  /** 流结束时调用：把缓冲里剩下的最后一行也交出来 */
  flush(): string[]
}

export function createSseLineSplitter(): SseLineSplitter {
  let buffer = ''
  const drain = (final: boolean): string[] => {
    const out: string[] = []
    const take = (line: string): void => {
      if (line.startsWith('data:')) out.push(line.slice(5).trim())
    }
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      take(buffer.slice(0, index).replace(/\r$/, ''))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
    if (final && buffer.length > 0) {
      take(buffer.replace(/\r$/, ''))
      buffer = ''
    }
    return out
  }
  const splitter = ((chunk: string): string[] => {
    buffer += chunk
    return drain(false)
  }) as SseLineSplitter
  splitter.flush = (): string[] => drain(true)
  return splitter
}

/** 一次请求的 token 消耗（服务商回报；拿不到就不显示，**不要估**——估了就是编数字） */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** 两段消耗相加：多轮对话把每一轮的消耗并到同一条消息上（工具循环一轮就是一次请求） */
export function addUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  if (!a) return b
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens
  }
}

/** 解析 usage 块；字段不全就返回 null（宁可不显示，也不显示猜出来的数字） */
function readUsage(raw: unknown): TokenUsage | null {
  if (!isRecord(raw)) return null
  const prompt = raw.prompt_tokens
  const completion = raw.completion_tokens
  if (typeof prompt !== 'number' || !Number.isFinite(prompt)) return null
  if (typeof completion !== 'number' || !Number.isFinite(completion)) return null
  const total =
    typeof raw.total_tokens === 'number' && Number.isFinite(raw.total_tokens)
      ? raw.total_tokens
      : prompt + completion
  return {
    promptTokens: Math.max(0, Math.round(prompt)),
    completionTokens: Math.max(0, Math.round(completion)),
    totalTokens: Math.max(0, Math.round(total))
  }
}

export interface StreamDelta {
  text: string
  /** 推理模型的思维链增量（`reasoning_content`；多数实现 / 分片没有，为空串） */
  reasoning: string
  /** 服务端实际使用的模型名（每个分片都带，取到一次即可） */
  model: string | null
  /** 本片里的工具调用增量（没有则为空数组） */
  toolCalls: ToolCallDelta[]
  /** 结束原因：`tool_calls` = 这轮要调工具，`stop` = 说完了 */
  finishReason: string | null
  /** token 消耗（开了 include_usage 时，最后一个分片会带；多数分片没有） */
  usage: TokenUsage | null
}

/**
 * 服务商的结束原因是否表示「输出被上限截断」。
 *
 * 只认 OpenAI 兼容的 `length`，**不猜**别家的写法：误判成截断会多发一次
 * （要付费的）续写请求，漏判只是少提示一句——宁可漏判。
 *
 * 抽成纯函数是为了能被自检钉住。这条判断决定「被掐断」与「正常说完」是否
 * 还长得一模一样：以前 `finish_reason` 解析出来了却没人用，用户看到的就是
 * 「AI 怎么只写了一点点」，无从判断是模型懒还是被截断。
 */
export function isTruncatedFinish(finishReason: string | null | undefined): boolean {
  return (finishReason ?? '').trim().toLowerCase() === 'length'
}

/** 退化熔断的触发门槛：同一行**逐字相同**且连续出现这么多次 */
export const DEGENERATION_MAX_REPEAT = 10

/**
 * 退化循环熔断：模型把同一行**原样**反复输出（真事：flash 档模型在超长上下文里
 * 连续吐了几百行「（我来执行）。」——那不是思考，是退化，只会白烧用户的钱和时间）。
 *
 * 判据刻意保守：**完整成行**、**去掉首尾空白后逐字相同**、连续 ≥ `DEGENERATION_MAX_REPEAT` 次。
 * 正常内容里连续多行完全相同几乎不存在（列表也有编号、标点、缩进差异）；
 * 宁可晚几行熔断，也不要误杀合法内容。
 *
 * 返回 true 表示已触发（触发后持续返回 true，调用方应当停止读取并收尾）。
 */
export function createRepetitionGuard(
  maxRepeat: number = DEGENERATION_MAX_REPEAT
): (delta: string) => boolean {
  let pending = ''
  let lastLine: string | null = null
  let repeats = 0
  let tripped = false
  return (delta: string): boolean => {
    if (tripped) return true
    pending += delta
    const parts = pending.split('\n')
    pending = parts.pop() ?? '' // 最后一段可能是半行，留到下一片再判
    for (const line of parts) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      if (trimmed === lastLine) {
        repeats += 1
        if (repeats >= maxRepeat) {
          tripped = true
          return true
        }
      } else {
        lastLine = trimmed
        repeats = 1
      }
    }
    return false
  }
}

/**
 * 从一条流式数据里取增量内容。
 * `[DONE]`、空行、解析不了的（有些实现会混入心跳）都返回 null。
 *
 * 注意 usage 分片很特殊：开了 `stream_options.include_usage` 后，最后会来一个
 * **`choices` 为空数组、只有 usage** 的分片——不能因为 choices 空就把它扔掉。
 */
export function extractStreamDelta(dataLine: string): StreamDelta | null {
  const text = dataLine.trim()
  if (text.length === 0 || text === '[DONE]') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const model = typeof parsed.model === 'string' ? parsed.model : null
  const usage = readUsage(parsed.usage)
  /** 思维链增量：DeepSeek 推理模型 / 通义 Qwen3 等把它放在 `reasoning_content` */
  const reasoningOf = (source: unknown): string =>
    isRecord(source) && typeof source.reasoning_content === 'string' ? source.reasoning_content : ''
  const choices = parsed.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    // usage 专属分片（choices 为空）：有 usage 就收下，没有才丢
    return usage
      ? { text: '', reasoning: '', model, toolCalls: [], finishReason: null, usage }
      : null
  }
  const first = choices[0]
  if (!isRecord(first))
    return usage
      ? { text: '', reasoning: '', model, toolCalls: [], finishReason: null, usage }
      : null
  const finishReason = typeof first.finish_reason === 'string' ? first.finish_reason : null
  const delta = first.delta
  const toolCalls = isRecord(delta) ? readToolCallDeltas(delta.tool_calls) : []

  // 绝大多数实现是 delta.content；少数把整段塞在 message.content
  if (isRecord(delta) && typeof delta.content === 'string') {
    return {
      text: delta.content,
      reasoning: reasoningOf(delta),
      model,
      toolCalls,
      finishReason,
      usage
    }
  }
  const message = first.message
  if (isRecord(message) && typeof message.content === 'string') {
    return {
      text: message.content,
      reasoning: reasoningOf(message),
      model,
      toolCalls,
      finishReason,
      usage
    }
  }
  return { text: '', reasoning: reasoningOf(delta), model, toolCalls, finishReason, usage }
}

/** 解析 delta.tool_calls：各实现字段略有出入，能取多少取多少 */
function readToolCallDeltas(raw: unknown): ToolCallDelta[] {
  if (!Array.isArray(raw)) return []
  const out: ToolCallDelta[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const index = typeof item.index === 'number' && Number.isFinite(item.index) ? item.index : 0
    const fn = isRecord(item.function) ? item.function : null
    out.push({
      index,
      id: typeof item.id === 'string' ? item.id : undefined,
      name: fn && typeof fn.name === 'string' ? fn.name : undefined,
      argumentsText: fn && typeof fn.arguments === 'string' ? fn.arguments : undefined
    })
  }
  return out
}

/**
 * 把流式分片累积成完整的工具调用。
 *
 * 关键点：**arguments 是逐片追加的字符串**——一次覆盖式赋值只会拿到
 * 半截 JSON（`{"que`），所以这里按 index 归位后**追加**。
 */
export function accumulateToolCalls(previous: ToolCall[], deltas: ToolCallDelta[]): ToolCall[] {
  const next = [...previous]
  for (const delta of deltas) {
    const index = delta.index >= 0 ? delta.index : 0
    const current = next[index]
    next[index] = {
      id: delta.id ?? current?.id ?? `call_${index}`,
      name: delta.name ?? current?.name ?? '',
      argumentsText: (current?.argumentsText ?? '') + (delta.argumentsText ?? '')
    }
  }
  return next
}

/** 收尾：丢掉没拿到名字的空槽（分片可能跳号，槽位会留洞） */
export function finalizeToolCalls(calls: ToolCall[]): ToolCall[] {
  return calls.filter((call) => call.name.length > 0)
}

/* ------------------------------------------------------------------ */
/* 思维链过滤                                                          */
/* ------------------------------------------------------------------ */

const THINK_OPEN = ['<', 'think', '>'].join('')
const THINK_CLOSE = ['<', '/', 'think', '>'].join('')

export interface ThinkingFilter {
  /** 送进一段原始增量，返回**可以显示给用户**的部分 */
  push(chunk: string): string
  /** 流结束：把「看着像标签前缀、其实是普通文字」的尾巴还回来 */
  flush(): string
}

/** 结尾这一段有多长可能是（被切开的）标签前缀 */
function tagTailLength(text: string): number {
  const max = Math.max(THINK_OPEN.length, THINK_CLOSE.length) - 1
  for (let length = Math.min(text.length, max); length > 0; length -= 1) {
    const tail = text.slice(text.length - length)
    if (THINK_OPEN.startsWith(tail) || THINK_CLOSE.startsWith(tail)) return length
  }
  return 0
}

/**
 * 滤掉思维链。
 *
 * 两种真实情况都要处理：① 推理模型把 ` thinking…` 一起塞进 content；
 * ② 服务商把开头那段放进了 `reasoning_content`，content 里**只剩一个** `</think>`
 * ——气泡里孤零零挂个标签，就是它（真事）。
 * 增量是分片到达的，标签可能被切成两半，所以尾巴要留住等下一片。
 */
export function createThinkingFilter(onThink?: (piece: string) => void): ThinkingFilter {
  let inThink = false
  let pending = ''
  return {
    push(chunk: string): string {
      pending += chunk
      let out = ''
      for (;;) {
        if (inThink) {
          const close = pending.indexOf(THINK_CLOSE)
          if (close < 0) {
            // 整段都在思维链里：只留可能是标签前缀的尾巴，其余交给 onThink（直播用）
            const keep = tagTailLength(pending)
            if (onThink && pending.length > keep) onThink(pending.slice(0, pending.length - keep))
            pending = pending.slice(pending.length - keep)
            return out
          }
          if (onThink && close > 0) onThink(pending.slice(0, close))
          pending = pending.slice(close + THINK_CLOSE.length)
          inThink = false
          continue
        }
        const open = pending.indexOf(THINK_OPEN)
        const close = pending.indexOf(THINK_CLOSE)
        if (close >= 0 && (open < 0 || close < open)) {
          // 只有闭合标签：丢掉标签本身，它前面的是正常内容
          out += pending.slice(0, close)
          pending = pending.slice(close + THINK_CLOSE.length)
          continue
        }
        if (open >= 0) {
          out += pending.slice(0, open)
          pending = pending.slice(open + THINK_OPEN.length)
          inThink = true
          continue
        }
        const keep = tagTailLength(pending)
        out += pending.slice(0, pending.length - keep)
        pending = pending.slice(pending.length - keep)
        return out
      }
    },
    flush(): string {
      const rest = inThink ? '' : pending
      if (inThink && onThink && pending.length > 0) onThink(pending)
      pending = ''
      inThink = false
      return rest
    }
  }
}

/**
 * 转成 OpenAI 兼容的请求体形态。
 *
 * 协议细节：助手消息带工具调用时要用 `tool_calls` 数组、参数是**字符串**；
 * 工具结果用 `role: 'tool'` + `tool_call_id` 关联。少了哪一样服务端都会报 400。
 */
export function toWireMessages(messages: AiMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.content }
    }
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.argumentsText }
        }))
      }
    }
    return { role: message.role, content: message.content }
  })
}
