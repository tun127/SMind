import { app, safeStorage } from 'electron'
import { isRecord } from '../shared/guards'
import { writeJsonAtomic } from './atomic-write'
import { logMain } from './log'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { IPC, type AiChatResult } from '@shared/ipc'
import {
  DEFAULT_AI_CONFIG,
  accumulateToolCalls,
  chatCompletionsUrl,
  createRepetitionGuard,
  createSseLineSplitter,
  createThinkingFilter,
  describeAiError,
  extractContent,
  extractStreamDelta,
  finalizeToolCalls,
  isTruncatedFinish,
  normalizeAiConfig,
  toWireMessages,
  type AiConfig,
  type AiMessage,
  type AiStreamEvent,
  type TokenUsage,
  type ToolCall
} from '@shared/ai'
import { AGENT_CANVAS_TOOL_NAMES, toWireTools, type AgentToolDef } from '@shared/agent'

/* ------------------------------------------------------------------ */
/* AI 配置与请求代理（P8）                                             */
/* ------------------------------------------------------------------ */

/** 应用级默认设置（默认视角锁定 / 默认主题 / 默认对齐） */
export const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')

const aiConfigFile = (): string => join(app.getPath('userData'), 'ai-config.json')

/**
 * API Key 的存放：优先用 Electron 的安全存储（Windows 走 DPAPI，密钥绑定当前用户账户）。
 *
 * 为什么必须做：Key 是用户真金白银买来的东西，明文躺在 `ai-config.json` 里，
 * 任何读得到这个文件的东西（云同步盘、备份、别的程序）都拿得到。
 *
 * 两条底线：**读的时候兼容老明文**（升级不能把用户的 Key 弄丢），
 * **写的时候不再落明文**（有安全存储就只写密文）。Linux 没有 keyring 时会退回明文——
 * 能用比"安全但不能用"重要。
 */
function packApiKey(apiKey: string): { apiKey?: string; apiKeyEnc?: string } {
  if (apiKey.length === 0) return {}
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { apiKeyEnc: safeStorage.encryptString(apiKey).toString('base64') }
    }
  } catch {
    /* 落到明文 */
  }
  return { apiKey }
}

function unpackApiKey(raw: Record<string, unknown>): string {
  const encrypted = typeof raw.apiKeyEnc === 'string' ? raw.apiKeyEnc : ''
  if (encrypted.length > 0) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
      }
    } catch {
      /* 换了机器 / 换了账户就解不开：当作没有，让用户重填，而不是抛错把面板打挂 */
    }
    return ''
  }
  return typeof raw.apiKey === 'string' ? raw.apiKey : ''
}

export async function readAiConfig(): Promise<AiConfig> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(aiConfigFile(), 'utf8'))
    const record = isRecord(raw) ? raw : {}
    // 先按普通字段规整，再用（可能解出来的）Key 覆盖：JSON 里可能只有密文
    return { ...normalizeAiConfig(raw).config, apiKey: unpackApiKey(record) }
  } catch {
    return { ...DEFAULT_AI_CONFIG }
  }
}

export async function writeAiConfig(config: AiConfig): Promise<void> {
  const { apiKey, ...rest } = config
  // 注意 apiKey 被摘出去了：有安全存储时文件里**不会**再出现明文 Key
  const stored = { version: 1, ...rest, ...packApiKey(apiKey) }
  // 原子写：AI 配置被写坏，用户看到的是"Key 和模型全丢了"
  await writeJsonAtomic(aiConfigFile(), stored)
}

/**
 * 启动时把老的明文 Key 迁移到安全存储（幂等，只对**存在明文**的文件动手）。
 *
 * 不做这一步的话，升级后就一直是明文——除非用户碰巧又保存了一次 AI 设置。
 */
export async function migrateAiConfigKey(): Promise<void> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(aiConfigFile(), 'utf8'))
    if (!isRecord(raw)) return
    const plain = typeof raw.apiKey === 'string' ? raw.apiKey : ''
    if (plain.length === 0 || !safeStorage.isEncryptionAvailable()) return
    await writeAiConfig(await readAiConfig())
    logMain('ai-config-migrated', 'API Key 已迁移到系统安全存储（不再以明文留在配置文件里）')
  } catch {
    /* 迁移失败不影响使用：读取时两种格式都认 */
  }
}

/**
 * 写工具的名字：主进程据此判断「这次对话真的动了画布吗」（试用计数只认它）。
 *
 * 用 AGENT_CANVAS_TOOL_NAMES 而不是全部写工具：askUser 只是提问、什么都不改，
 * 算进去就变成"只问一句也消耗一个试用回合"。
 */
export const WRITE_TOOL_NAMES = AGENT_CANVAS_TOOL_NAMES

/** 进行中的流式请求（requestId → 控制器）：「停止生成」与窗口关闭时中止用 */
export const streamAborters = new Map<string, AbortController>()

/** 已经计过数的用户命令（turnId）：一条命令跑多少轮都只算一个写回合 */
export const countedTrialTurns = new Set<string>()

/**
 * 带「输出上限」逐级降档的发送。
 *
 * 为什么需要：各服务商对单次输出上限的容忍度差别很大（2k / 4k / 8k / 32k 都有），
 * 而我们默认给到 16384——那是「一句命令生成 100+ 节点的详细图」所需。
 * 一旦这个值超过服务商自己的上限，请求会直接 400。**降档而不是放弃**：
 * 能写多少是多少（写不完还有截断检测与续写兜底），总比整个请求失败强。
 *
 * 只有错误体**点名了输出上限相关字段**才降档；其它错误（Key 无效、模型不存在）
 * 原样返回给调用方翻译——否则会把真正的错误信息藏起来。
 */
async function sendWithMaxTokensFallback(
  send: (maxTokens: number) => Promise<Response>,
  requested: number
): Promise<{ response: Response; errorBody: string }> {
  const ladder = requested > 0 ? [requested, 8192, 4096, 2048, 0] : [0]
  const steps = [...new Set(ladder)].filter((value) => value <= requested || value === 0)
  let lastResponse: Response | null = null
  let lastBody = ''
  for (const limit of steps) {
    const response = await send(limit)
    if (response.ok) {
      if (limit !== requested) {
        logMain(
          'ai-max-tokens-downgraded',
          `服务商不接受 max_tokens=${requested}，已降档到 ${limit > 0 ? limit : '不发送该字段'}`
        )
      }
      return { response, errorBody: '' }
    }
    lastBody = await response.text()
    lastResponse = response
    if (limit === 0 || !/max_?(tokens|length|output|new_tokens)/i.test(lastBody)) break
  }
  if (!lastResponse) throw new Error('AI 请求没有发出')
  return { response: lastResponse, errorBody: lastBody }
}

/**
 * 流式对话（三期 AI 聊天面板 1a）。
 *
 * 与 callAi 的区别：`stream: true`，服务端按 SSE 逐块回，这里边收边通过
 * `aiStreamEvent` 推给渲染进程——聊天框要的是打字机效果，等全文到齐就死了。
 * 结果**不走返回值**：本函数只把事件发完，内容与错误都在事件里。
 */
export async function callAiStream(
  config: AiConfig,
  messages: AiMessage[],
  requestId: string,
  sender: { isDestroyed(): boolean; send(channel: string, payload: unknown): void },
  /**
   * 这次允许下发给模型的工具定义（可能只有只读的，也可能一个都没有——
   * 模型不支持函数调用时）。**许可闸门就在这一层**。
   */
  tools: AgentToolDef[]
): Promise<string[]> {
  /** 本次流里模型调用过的工具名（主进程据此判定这是不是一个「写回合」） */
  let toolNames: string[] = []
  const push = (event: AiStreamEvent): void => {
    if (!sender.isDestroyed()) sender.send(IPC.aiStreamEvent, event)
  }

  const url = chatCompletionsUrl(config.baseUrl)
  if (url.length === 0) {
    push({ requestId, kind: 'error', message: 'BaseURL 没有配置' })
    return []
  }

  const controller = new AbortController()
  streamAborters.set(requestId, controller)

  let full = ''
  /** 思维链（推理模型才有；只用于界面直播，不进正文、不进历史） */
  let reasoning = ''
  /** 退化循环熔断：同一行被复读到门槛就止损（真事：flash 模型在超长上下文里复读几百行） */
  const repetition = createRepetitionGuard()
  let degenerated = false
  let model: string | null = null
  /** 结束原因：`stop` = 说完了、`tool_calls` = 要调工具、`length` = **被输出上限截断** */
  let finishReason: string | null = null
  /** 本轮模型请求的工具调用（分片累积；空数组 = 说完了） */
  let toolCalls: ToolCall[] = []
  /** token 消耗（开了 include_usage 后随最后一个分片到来；服务商不支持就没有） */
  let usage: TokenUsage | null = null
  try {
    const buildBody = (maxTokens: number): string =>
      JSON.stringify({
        model: config.model,
        messages: toWireMessages(messages),
        temperature: config.temperature,
        stream: true,
        /**
         * **显式给出输出上限**。不给的话用服务商默认值——很多默认只有 1.5k~2k token，
         * 而「完整详细的大纲」（考点 + 解释 + 例子）动辄 8k~14k，
         * 写到一半就被服务端掐断，用户看到的就是"AI 只写了粗分"。
         */
        ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
        // 让服务商在流末尾回报 token 消耗（面板要显示「这次花了多少」）。
        // OpenAI 兼容实现基本都支持；不认这个字段的会忽略它，无害
        stream_options: { include_usage: true },
        // 只下发这次允许的工具：模型看不到写工具，就物理上调不动它
        ...(tools.length > 0
          ? {
              tools: toWireTools(tools),
              // 明确允许并行工具调用：否则有些模型（qwen 系）一次回复只肯发一个调用，
              // 搬几十个节点就要几十轮，用户感受是「走一步推一步」
              parallel_tool_calls: true
            }
          : {})
      })

    const send = (maxTokens: number): Promise<Response> =>
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`
        },
        body: buildBody(maxTokens),
        signal: controller.signal
      })

    const { response, errorBody } = await sendWithMaxTokensFallback(send, config.maxTokens)
    if (!response.ok) {
      // 错误响应不是流：errorBody 里就是整段文本，交给统一的错误翻译
      throw new Error(describeAiError(response.status, errorBody))
    }
    if (!response.body) throw new Error('AI 服务没有返回流式内容')

    const splitter = createSseLineSplitter()
    const decoder = new TextDecoder()
    // 思维链不再只能扔掉：reasoning_content / <think> 里的内容**转发给界面直播**
    // （用户盯着一屏工具条目时，看得见它"在想什么"比一个转圈强得多）；
    // 但它不进正文（full），也不会存进历史——只是过程展示。
    const emitReasoning = (text: string): void => {
      if (text.length === 0) return
      reasoning += text
      push({ requestId, kind: 'reasoning', text })
    }
    const think = createThinkingFilter(emitReasoning)
    const emit = (text: string): void => {
      if (text.length === 0) return
      full += text
      if (repetition(text)) degenerated = true
      push({ requestId, kind: 'chunk', text })
    }
    const handleLine = (line: string): void => {
      const delta = extractStreamDelta(line)
      if (!delta) return
      if (delta.model) model = delta.model
      if (delta.usage) usage = delta.usage
      // 结束原因要留住：`length` 意味着这次输出被服务商的输出上限掐断了
      if (delta.finishReason) finishReason = delta.finishReason
      // 工具调用的参数是**逐片追加**的字符串，必须按 index 累积（见 accumulateToolCalls）
      if (delta.toolCalls.length > 0) toolCalls = accumulateToolCalls(toolCalls, delta.toolCalls)
      if (delta.reasoning.length > 0) emitReasoning(delta.reasoning)
      emit(think.push(delta.text))
    }
    const feed = (piece: string): void => {
      for (const line of splitter(piece)) handleLine(line)
    }

    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (controller.signal.aborted) break
      feed(decoder.decode(value, { stream: true }))
      // 退化熔断：不再读下去——多读一行就是多烧一笔钱
      if (degenerated) break
    }
    // 收尾：解码器里可能还压着没有换行的最后一行
    feed(decoder.decode())
    /**
     * 还要冲**分割器**的缓冲：有些服务商的流结尾不带换行，
     * 最后那个 `data:` 行会一直躺在缓冲里——以前没有这一步，
     * 用户看到的就是"回答末尾少了一截"（正文最后一段整段丢失）。
     */
    for (const line of splitter.flush()) handleLine(line)
    // 过滤器里可能留着「像标签前缀其实是正文」的尾巴
    emit(think.flush())

    if (degenerated) {
      // 复读的尾巴裁掉：它不该进正文，更不该跟着上下文进下一轮（会把下一轮也拖进退化）
      const lines = full.split('\n')
      const last = (lines[lines.length - 1] ?? '').trim()
      let end = lines.length
      if (last.length > 0) while (end > 1 && (lines[end - 1] ?? '').trim() === last) end -= 1
      const kept = lines.slice(0, end).join('\n')
      full = last.length > 0 ? `${kept}\n${last}` : kept
      logMain('ai-degeneration-guard', '模型输出陷入自我重复，已熔断并裁掉复读尾巴')
    }

    const finalCalls = finalizeToolCalls(toolCalls)
    toolNames = finalCalls.map((call) => call.name)

    push({
      requestId,
      kind: 'done',
      content: full,
      model: model ?? config.model,
      aborted: controller.signal.aborted,
      toolCalls: finalCalls,
      // 如实上报"被截断"：以前这个信息被丢掉，用户只看到"AI 怎么只写了一点"
      ...(isTruncatedFinish(finishReason) ? { truncated: true } : {}),
      ...(degenerated ? { degenerated: true } : {}),
      ...(reasoning.length > 0 ? { reasoning } : {}),
      ...(usage ? { usage } : {})
    })
  } catch (error) {
    if (controller.signal.aborted) {
      // 用户主动停止：不算错误，把已经收到的部分完完整整交回去
      push({
        requestId,
        kind: 'done',
        content: full,
        model: model ?? config.model,
        aborted: true,
        // 被停止时工具调用多半是残缺的：带回去但渲染层不会执行（见 ChatPanel）
        toolCalls: finalizeToolCalls(toolCalls)
      })
    } else if (error instanceof TypeError) {
      // fetch 的网络层错误（DNS / 连接被拒 / 证书）
      push({
        requestId,
        kind: 'error',
        message: `连不上 AI 服务：请检查 BaseURL 是否正确、网络是否可用（${error.message}）`
      })
    } else {
      push({ requestId, kind: 'error', message: (error as Error).message })
    }
  } finally {
    streamAborters.delete(requestId)
  }
  return toolNames
}

/**
 * 调一次 OpenAI 兼容的 chat/completions。
 *
 * 放在主进程做：① 绕开渲染进程的 CORS 限制；② 超时与错误翻译集中在一处；
 * ③ API Key 只留在主进程的配置文件里，不经过渲染进程。
 */
export async function callAi(
  config: AiConfig,
  messages: AiMessage[],
  timeoutMs: number
): Promise<AiChatResult> {
  if (config.apiKey.length === 0) {
    throw new Error('还没有配置 API Key：请打开「AI 设置」填入后再试')
  }
  const url = chatCompletionsUrl(config.baseUrl)
  if (url.length === 0) throw new Error('BaseURL 没有配置')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const buildBody = (maxTokens: number): string =>
      JSON.stringify({
        model: config.model,
        messages,
        temperature: config.temperature,
        // 与流式请求同理：不显式给上限，服务商默认值会把长输出掐断
        ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
        stream: false
      })

    const send = (maxTokens: number): Promise<Response> =>
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`
        },
        body: buildBody(maxTokens),
        signal: controller.signal
      })

    // 与流式路径同一套降档策略（见 sendWithMaxTokensFallback）
    const { response, errorBody } = await sendWithMaxTokensFallback(send, config.maxTokens)
    if (!response.ok) throw new Error(describeAiError(response.status, errorBody))
    const text = await response.text()

    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error('AI 返回的不是合法 JSON：可能 BaseURL 指向的不是兼容接口')
    }

    const content = extractContent(payload)
    const usage = isRecord(payload) && isRecord(payload.usage) ? payload.usage : null
    const totalTokens = usage && typeof usage.total_tokens === 'number' ? usage.total_tokens : null
    const model =
      isRecord(payload) && typeof payload.model === 'string' ? payload.model : config.model
    // 结束原因：`length` = 被输出上限截断（界面要如实提示，别让用户以为模型只肯写这么多）
    const choices = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices : []
    const firstChoice: unknown = choices[0]
    const finishReason =
      isRecord(firstChoice) && typeof firstChoice.finish_reason === 'string'
        ? firstChoice.finish_reason
        : null
    return { content, model, totalTokens, finishReason }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(
        `请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒）：网络慢或模型响应太慢，可以稍后再试`,
        { cause: error }
      )
    }
    if (error instanceof TypeError) {
      // fetch 的网络层错误（DNS/连接被拒/证书）
      throw new Error(`连不上 AI 服务：请检查 BaseURL 是否正确、网络是否可用（${error.message}）`, {
        cause: error
      })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
