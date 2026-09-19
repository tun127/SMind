import { ipcMain } from 'electron'
import { isRecord } from '../../shared/guards'
import { IPC, type AiChatResult, type AiConfigPatch, type AiTestResult } from '@shared/ipc'
import {
  normalizeAiConfig,
  toConfigView,
  type AiConfig,
  type AiConfigView,
  type AiMessage
} from '@shared/ai'
import { planAvailableTools } from '@shared/agent'
import { hasWriteToolCall, markTrialTurnSeen } from '@shared/license'
import { consumeTrialTurn, getLicenseView } from '../license'

import {
  WRITE_TOOL_NAMES,
  callAi,
  callAiStream,
  countedTrialTurns,
  readAiConfig,
  streamAborters,
  writeAiConfig
} from '../ai'

/**
 * 这些处理器原来都在 `main/index.ts` 的 `registerIpc()` 里，整块搬来：
 * 函数体、先后顺序、通道名逐字未改（搬迁只做剪切粘贴）。
 */
export function registerAiIpc(): void {
  ipcMain.handle(IPC.aiConfigGet, async (): Promise<AiConfigView> =>
    toConfigView(await readAiConfig())
  )

  ipcMain.handle(IPC.aiConfigSave, async (_e, patch: AiConfigPatch): Promise<AiConfigView> => {
    const current = await readAiConfig()
    const merged: AiConfig = {
      baseUrl:
        typeof patch.baseUrl === 'string' && patch.baseUrl.trim().length > 0
          ? patch.baseUrl.trim()
          : current.baseUrl,
      model:
        typeof patch.model === 'string' && patch.model.trim().length > 0
          ? patch.model.trim()
          : current.model,
      temperature: typeof patch.temperature === 'number' ? patch.temperature : current.temperature,
      // 0 是合规值（表示"不发送 max_tokens"），不能用 `||` 兜底
      maxTokens:
        typeof patch.maxTokens === 'number' && Number.isFinite(patch.maxTokens)
          ? Math.round(patch.maxTokens)
          : current.maxTokens,
      // 质量档位：不传就沿用已保存的（normalizeAiConfig 会挡掉非法值）
      tier: patch.tier ?? current.tier,
      // 空字符串表示「不改动已保存的 Key」，避免用户看不到明文时误清空
      apiKey:
        typeof patch.apiKey === 'string' && patch.apiKey.trim().length > 0
          ? patch.apiKey.trim()
          : current.apiKey
    }
    const { config } = normalizeAiConfig(merged)
    await writeAiConfig(config)
    return toConfigView(config)
  })

  ipcMain.handle(
    IPC.aiChat,
    async (_e, messages: AiMessage[], options?: { timeoutMs?: number }): Promise<AiChatResult> => {
      const config = await readAiConfig()
      return callAi(config, messages, options?.timeoutMs ?? 120000)
    }
  )

  ipcMain.handle(IPC.aiTest, async (): Promise<AiTestResult> => {
    const config = await readAiConfig()
    try {
      const result = await callAi(
        config,
        [{ role: 'user', content: '请只回复两个字：正常' }],
        25000
      )
      return {
        ok: true,
        message: `连接正常（模型 ${result.model}）：${result.content.trim().slice(0, 20)}`
      }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  })

  ipcMain.handle(
    IPC.aiChatStream,
    async (e, requestId: unknown, messages: unknown, options: unknown): Promise<void> => {
      // 这条通道直连网络且带着 Key，渲染层给的一切都不默认可信，逐项校验
      if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) {
        throw new Error('流式请求标识无效')
      }
      // 额度按**真实使用**定，不按想象的边界定。
      //
      // 这套校验是安全网（渲染层给的东西不默认可信），**不是体验闸门**：
      // 以前它会把正常用法挡回去，而且只回一句「对话内容无效」，谁也查不出为什么。
      // 两个真实踩过的坑：
      //   ① 一次批量发**几十个**工具调用（大文档批量删除/改名时很自然）→ 撞上
      //      这里原本 `toolCalls.length > 20` 的上限，整回合直接死掉；
      //   ② 粘贴一整篇长文档 → 撞 6 万字上限。
      // 所以：额度放到「只拦垃圾」的量级，并且报错必须说清**第几条、哪个字段**。
      const MAX_MESSAGES = 400
      const MAX_CONTENT = 1_000_000
      const MAX_TOOL_CALLS_PER_MESSAGE = 200

      if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('对话内容无效：消息列表为空')
      }
      // 收窄之后再定义 blame：闭包里访问到的类型才不会被 TS 当成 unknown
      const list: unknown[] = messages
      const blame = (index: number, why: string): Error => {
        const item = list[index]
        const shape = isRecord(item)
          ? `role=${String(item.role)}、content=${typeof item.content}、toolCalls=${
              Array.isArray(item.toolCalls) ? item.toolCalls.length : '—'
            }`
          : `不是对象（${typeof item}）`
        return new Error(`对话内容无效：第 ${index + 1} 条消息（${shape}）——${why}`)
      }
      if (messages.length > MAX_MESSAGES) {
        throw new Error(
          `对话太长了（${messages.length} 条，上限 ${MAX_MESSAGES} 条）：` +
            '请点聊天面板右上角的「清空对话」后再继续。'
        )
      }
      for (let index = 0; index < messages.length; index += 1) {
        const item = messages[index]
        if (!isRecord(item)) throw blame(index, '不是对象')
        const role = item.role
        const knownRole =
          role === 'system' || role === 'user' || role === 'assistant' || role === 'tool'
        if (!knownRole) throw blame(index, 'role 不是 system/user/assistant/tool')
        if (typeof item.content !== 'string') throw blame(index, 'content 不是字符串')
        if (item.content.length > MAX_CONTENT) {
          throw new Error(
            `这条消息太长了（${item.content.length.toLocaleString()} 字，上限 ` +
              `${MAX_CONTENT.toLocaleString()} 字）：请拆成几条发，或先精简一下。`
          )
        }
        if (item.toolCallId !== undefined && typeof item.toolCallId !== 'string') {
          throw blame(index, 'toolCallId 不是字符串')
        }
        if (item.toolCalls !== undefined) {
          if (!Array.isArray(item.toolCalls)) throw blame(index, 'toolCalls 不是数组')
          if (item.toolCalls.length > MAX_TOOL_CALLS_PER_MESSAGE) {
            throw blame(index, `一次带的工具调用太多（${item.toolCalls.length} 个）`)
          }
          for (const call of item.toolCalls) {
            if (
              !isRecord(call) ||
              typeof call.id !== 'string' ||
              typeof call.name !== 'string' ||
              typeof call.argumentsText !== 'string' ||
              call.argumentsText.length > 60_000
            ) {
              throw blame(index, 'toolCalls 里有一项的 id/name/argumentsText 不合法')
            }
          }
        }
      }

      const config = await readAiConfig()
      if (config.apiKey.length === 0) {
        throw new Error('还没有配置 API Key：请打开「AI 设置」填入后再试')
      }

      // 工具默认开着；模型不支持函数调用时由渲染层显式关掉
      const useTools = !(isRecord(options) && options.useTools === false)

      // **许可闸门**：Pro 或试用没用完，才把写工具下发下去。
      // 放在主进程、放在「下发哪些工具」这一层——模型看不到写工具就物理上调不动它，
      // 比在渲染层判断可靠（渲染层的提示只是礼貌，不是边界）。
      const license = await getLicenseView()
      const tools = useTools ? planAvailableTools(license.canWrite) : []

      const sender = e.sender
      // 窗口销毁时中止：别留悬着的连接，也别再往已销毁的窗口发事件。
      // **用完必须摘掉**：工具循环让一条命令能跑十几二十轮，每轮挂一个 once
      // 会一直攒着（攒到 Node 的监听器上限就会打印并发告警），而且全指向已经结束的请求
      const onSenderDestroyed = (): void => streamAborters.get(requestId)?.abort()
      sender.once('destroyed', onSenderDestroyed)
      const usedTools = await callAiStream(
        config,
        messages as AiMessage[],
        requestId,
        sender,
        tools
      ).finally(() => {
        if (!sender.isDestroyed()) sender.removeListener('destroyed', onSenderDestroyed)
      })

      /**
       * 真的动了画布才算一个试用回合：只读聊天永久免费、不计数。
       *
       * 计数单位是**一次用户命令**，不是「一轮模型请求」——渲染层为每个用户命令
       * 生成一个 turnId，这里按它去重。原来每轮都计数，而一条命令可能跑十几二十轮
       * （生成 100+ 节点的详细图正是这样），会一口气吃掉十几个回合。
       */
      if (hasWriteToolCall(usedTools, WRITE_TOOL_NAMES)) {
        const turnId = isRecord(options) && typeof options.turnId === 'string' ? options.turnId : ''
        if (markTrialTurnSeen(countedTrialTurns, turnId)) await consumeTrialTurn()
      }
    }
  )

  ipcMain.on(IPC.aiChatStreamCancel, (_e, requestId: unknown) => {
    if (typeof requestId === 'string') streamAborters.get(requestId)?.abort()
  })
}
