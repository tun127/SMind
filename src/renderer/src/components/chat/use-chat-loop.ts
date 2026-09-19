/**
 * AI 回合的 runtime 状态机（自 ChatPanel.tsx 整块搬出，函数体逐字未改）。
 *
 * 为什么整块搬：`runRoundRef` / `processQueueRef` / `commitTurnRef` / `stopRef` 是
 * 「打破循环引用」的一组 ref（handleEvent ↔ processQueue ↔ runRound ↔ commitTurn 互相调用），
 * 拆散的瞬间就会变成「用到未初始化」。任务表把这条列为 A6 的最高危点——
 * **一组相互引用的 ref 当作一个整体搬进同一个模块，禁止跨文件拆**。
 *
 * 本 hook 拥有：
 * - 会话消息（`messages` + `messagesRef` + `update`）与「按文档恢复 / 落盘」两个 effect；
 * - 全部回合级 ref（wire / 轮数 / 队列 / 待确认 / 写日志 / 改动节点 / 计数器 / 四个环 ref）；
 * - 工具执行的**续跑与调度**（`resolvePending`）、流式事件（`handleEvent`）、回合发起（`runRound`）
 *   以及 `send` / `stop` / `clearChat`；
 * - **工具执行体与回合收尾**（`processQueue` / `applyWriteIntent` / `noteAction` / `commitTurn` /
 *   `setPending` / `pushToolResult` / `compressExecutedCallArgs`）已搬进 `chat/turn-runtime.ts`，
 *   本 hook 只通过一次 `createTurnRuntime(deps)` 调用把它们的当前身份拿回来；
 * - 订阅流式事件的 effect（**卸载时必须收尾这一回合**）与「每次渲染刷新环 ref」的 effect。
 *
 * 视图侧的 state（草稿 / 许可 / 文档 / 提示 / 滚动跟随）仍留在 ChatPanel：
 * 它们的挂载点与面板一致，搬进来只会让「谁拥有它」变模糊。
 * hook 的调用位置刻意放在原来「按文档恢复聊天记录」那个 effect 处，
 * 于是内部几个 effect 的声明顺序与拆分前逐一对应。
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  addUsage,
  buildChatSystemPrompt,
  buildSkeletonDigest,
  compressHistory,
  countTopicTree,
  digestPreamble,
  readableIpcError,
  type AiMessage,
  type AiStreamEvent,
  type QualityTier,
  type ToolCall
} from '@shared/ai'
import {
  canContinueAgentLoop,
  DESTRUCTIVE_WRITE_LABELS,
  isDestructiveWriteKind,
  segmentTitleMentions,
  shortHandleOf,
  topicPathOf,
  type buildTitleIndex,
  type WriteIntent
} from '@shared/agent'
import type { LicenseView } from '@shared/license'
import { createId } from '@shared/model/factory'
import { activeRoot, ancestorsOf, findTopic } from '@shared/model/tree'
import { armDiag, beginCost, setStage } from '../../dev/stage'
import { patchAppSettings, useEditor } from '../../store/editor'
import { createTurnRuntime } from './turn-runtime'
import type { ChatDoc, ChatMsg, ChatPlan, PendingWrite } from './types'

interface LoopInput {
  /** 当前文档路径（null = 尚未保存）：切文档要停回合，并按文档恢复聊天记录 */
  filePath: string | null
  /** 许可状态：提示词要如实说明现在能不能改画布 */
  license: LicenseView | null
  /** 生成质量档位（写进系统提示词） */
  tier: QualityTier
  /** 标题索引：把回复里提到的节点变成可点击引用 */
  titleIndex: ReturnType<typeof buildTitleIndex>
  /** 挂在这个会话上的文档（只读工具 readDocument 用它） */
  docsRef: RefObject<ChatDoc[]>
  /** AI 要动**第一笔**改动之前调用（App 层用它存一份盘上快照） */
  onBeforeAiWrite(): void
  /** 试用次数在主进程里涨的：回合结束后重新读一次 */
  refreshLicense(): void
  /** 自己发的消息一定要看得见：即使刚才在上滑看历史，也拉回底部并恢复跟随 */
  setAtBottom(value: boolean): void
  /** 发出提问后清空输入框（草稿住在视图侧） */
  setDraft(value: string): void
}

export interface ChatLoopApi {
  messages: ChatMsg[]
  activity: string
  streaming: boolean
  plan: ChatPlan | null
  pendingWrite: PendingWrite | null
  rememberSkip: boolean
  sessionTokens: number
  send(raw: string): void
  stop(): void
  resolvePending(approve: boolean, remember?: boolean): void
  setRememberSkip(value: boolean): void
  clearChat(): void
}

export function useChatLoop({
  filePath,
  license,
  tier,
  titleIndex,
  docsRef,
  onBeforeAiWrite,
  refreshLicense,
  setAtBottom,
  setDraft
}: LoopInput): ChatLoopApi {
  const [messages, setMessages] = useState<ChatMsg[]>([])

  /** 本次会话累计的 token 消耗（按服务商回报累计；换会话/清空时归零） */
  const [sessionTokens, setSessionTokens] = useState(0)

  /**
   * 正在干什么（「正在思考…」「正在翻看导图…」）。
   *
   * 没有它的时候，用户盯着一屏工具条目分不清「它还在想」和「已经答完了」——
   * 真被投诉过（「我都不知道它干完没有」）。转圈 + 一行字是最便宜、最有效的补偿。
   */
  const [activity, setActivity] = useState('')
  const [streaming, setStreaming] = useState(false)
  /** 需要用户点头的破坏性操作（删分支等） */
  const [pendingWrite, setPendingWrite] = useState<PendingWrite | null>(null)
  /** 确认框里的「以后不再询问这类操作」 */
  const [rememberSkip, setRememberSkip] = useState(false)

  /**
   * 这次「用户命令」的标识：一条命令内的每一轮请求都带同一个 id。
   * 主进程用它做试用计数去重——一条命令跑十几二十轮也只算一个写回合。
   */
  const turnIdRef = useRef('')
  /**
   * 当前的执行计划（模型用 updatePlan 工具写的）。
   *
   * 摆在界面上而不是藏在工具痕迹里：长任务（生成上百节点的详细图）最需要的就是
   * "现在走到第几步、还剩什么"——这是用户能一眼看出"它有没有跑偏"的唯一地方。
   */
  const [plan, setPlan] = useState<ChatPlan | null>(null)

  const messagesRef = useRef<ChatMsg[]>([])
  const requestIdRef = useRef<string | null>(null)

  /** 发给模型的完整消息线（含本轮的 assistant.toolCalls 与 tool 结果） */
  const wireRef = useRef<AiMessage[]>([])
  /** 本轮已进行的模型轮数 / 已执行的工具调用次数 */
  const roundRef = useRef(0)
  const toolCallsUsedRef = useRef(0)
  /** 模型不支持函数调用时置 false，此后不再带工具定义 */
  const useToolsRef = useRef(true)
  /** 撞到调用上限后的「最后一轮」：只让它作答，不再给工具 */
  const forceNoToolsRef = useRef(false)
  /** 本回合已执行过的调用（同名同参数）：重复的不再执行，免得白烧配额 */
  const seenCallsRef = useRef<Set<string>>(new Set())
  /** runRound / processQueue 与 handleEvent 互相需要，用 ref 打破循环引用 */
  const runRoundRef = useRef<() => void>(() => {})
  const processQueueRef = useRef<() => void>(() => {})
  const commitTurnRef = useRef<() => void>(() => {})
  /** 卸载收尾时要用 stop()，但它定义在下面（同一个「打破循环引用」的理由） */
  const stopRef = useRef<() => void>(() => {})
  /** 待处理的工具调用（一次处理一个：破坏性操作要在中间停下来问用户） */
  const queueRef = useRef<{ calls: ToolCall[]; index: number } | null>(null)
  /** 待确认的写操作（state 只用于渲染，判定走 ref） */
  const pendingRef = useRef<{ call: ToolCall; intent: WriteIntent; summary: string } | null>(null)
  /** 本轮 AI 改了哪些东西（并成撤销标签 + 事后摘要） */
  const writeLogRef = useRef<string[]>([])
  /** 本轮 AI 改到/新增了哪些节点：回合结束时闪一下它们 */
  const changedIdsRef = useRef<string[]>([])
  /** 本轮**成功落到画布**的写操作数 / 失败数：用来兜住「说改了、其实没落地」 */
  const writesAppliedRef = useRef(0)
  const writesFailedRef = useRef(0)
  /** 本轮是否已经开过事务（只在真有写操作时开） */
  const turnStartedRef = useRef(false)

  /** state 与 ref 一起更新：发请求要读最新历史，state 是给渲染的 */
  const update = useCallback((updater: (prev: ChatMsg[]) => ChatMsg[]) => {
    setMessages((prev) => {
      const next = updater(prev)
      messagesRef.current = next
      return next
    })
  }, [])

  /**
   * 按文档恢复聊天记录。
   *
   * key 用**文档路径**；未保存的文档不落盘（只在内存里，关掉即弃）——
   * 免得应用数据目录里堆一堆「未命名文档」的会话。
   * 切到别的文档时必须清空，否则会把上一份文档的对话串过去。
   */
  useEffect(() => {
    /**
     * 文档切换（含第一次保存、恢复、另存为）时，**进行中的回合必须立刻停**。
     *
     * 踩过的坑：回合状态（轮数 / 消息线 / 待执行队列）都在本组件的 ref 里，不随文档走——
     * `filePath` 一变，下面的逻辑会清空/重载消息（新路径的历史往往是空的），
     * 而回合还在继续跑：界面上就是「对话消失了、但还在第 14 轮」；
     * 更糟的是写工具作用于**当前激活文档**——继续跑等于可能把改动落到另一份文档上。
     */
    if (requestIdRef.current !== null) {
      window.api.aiChatStreamCancel(requestIdRef.current)
      requestIdRef.current = null
      queueRef.current = null
      setStreaming(false)
      setActivity('')
      setPending(null)
      setPendingWrite(null)
      if (turnStartedRef.current) {
        turnStartedRef.current = false
        useEditor.getState().commitAiTurn('AI · 回合因切换文档中止')
      }
      // console.warn 会被主进程转发进应用日志（渲染层没有独立的日志通道）
      console.warn('[chat] 进行中的回合因切换文档而中止')
    }
    if (!filePath) {
      update(() => [])
      return
    }
    let cancelled = false
    void window.api
      .chatHistoryLoad(filePath)
      .then((entries) => {
        if (cancelled) return
        update(() =>
          entries.map((entry) => ({
            id: createId(),
            role: entry.role,
            content: entry.content,
            aborted: entry.aborted
          }))
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // setPending 是**本 hook 里的函数字面量**（A6-4 配方② 之后），lint 不再要求列进依赖数组；
    // 即便列进来也不该列：补了本 effect 就会每渲染重跑，把正在跑的回合取消、聊天记录反复重载。
    // 它只写 pendingRef 与两个稳定 setter，用哪一份都等价。
  }, [filePath, update])

  /** 落盘：防抖 800ms；流式过程中不写（逐字保存等于每个字都写一次盘） */
  useEffect(() => {
    if (!filePath || streaming || messages.length === 0) return
    const timer = window.setTimeout(() => {
      void window.api
        .chatHistorySave(
          filePath,
          messages.map((msg) => ({ role: msg.role, content: msg.content, aborted: msg.aborted }))
        )
        .catch(() => undefined)
    }, 800)
    return () => window.clearTimeout(timer)
  }, [filePath, messages, streaming])

  /* ---- 卡死取证转储：AI 回合期间把现场节流落盘 ----
   * 曾经的 freeze 全部发生在「写意图落盘后」的渲染阶段，而未命名文档没有自动存档、
   * 聊天历史也不落盘——强杀进程会把毒内容一起带走，下一轮只能从零猜。
   * 有了这份转储，任何一次冻结之后 `%APPDATA%/smind/diag/last-state.json` 里
   * 都有完整的 wire（含全部工具参数）与 workbook，可用 scripts/run-diag-freeze.mjs
   * 对真实内容逐块复现定位。 */
  const lastDumpAtRef = useRef(0)
  /** 上一次转储的序列化耗时：决定「强制转储」还要不要每次都跑 */
  const dumpCostRef = useRef(0)
  const dumpDiag = useCallback((reason: string, force = false): void => {
    const now = performance.now()
    // 节流 2 秒。强制转储（每个写调用一次）本来是取证必需的——冻结就发生在
    // 某次写入之后，晚一步的转储可能永远跑不到。但**大文档**下它每次都要
    // 同步序列化整份 workbook，会变成新的负担；所以实测超过 25ms 就退回节流模式，
    // 牺牲一点现场新度、换掉这条新的卡顿来源。
    const heavy = dumpCostRef.current > 25
    if ((!force || heavy) && now - lastDumpAtRef.current < 2000) return
    lastDumpAtRef.current = now
    try {
      const startedAt = performance.now()
      const payload = JSON.stringify({
        at: new Date().toISOString(),
        reason,
        round: roundRef.current,
        wire: wireRef.current,
        messages: messagesRef.current,
        workbook: useEditor.getState().workbook
      })
      dumpCostRef.current = performance.now() - startedAt
      // 必须 catch：invoke 的失败是**异步**的，外层 try/catch 抓不到，
      // 否则会在控制台刷「Uncaught (in promise)」并污染错误边界
      void window.api.diagDump(payload).catch(() => undefined)
    } catch {
      /* 取证绝不能把正常流程弄崩 */
    }
  }, [])

  /* ---- 工具执行 / 回合收尾：整块搬进 chat/turn-runtime.ts（显式 deps 对象，函数体逐字未改） ---- */

  /**
   * 待确认的写操作：state 只用于渲染，判定走 `pendingRef`。
   *
   * **A6-4 配方② 把它搬回 hook**（A6-3 时它住在 runtime 工厂里）：
   * 它只是 `pendingRef` + 两个 React setter 的写入，定义留在这里、以 deps 传进工厂之后，
   * `handleEvent` 那处订阅 effect 与 `send` 都不必再挂 `eslint-disable`——
   * 既没有改变它的重建时机（本来就是普通函数字面量、每渲染重建），
   * 也不必为"让 lint 变绿"去动高频路径的 ref 用法（§五 的纪律）。
   */
  const setPending = (
    value: { call: ToolCall; intent: WriteIntent; summary: string } | null
  ): void => {
    pendingRef.current = value
    setPendingWrite(
      value
        ? {
            summary: value.summary,
            kind: value.intent.kind,
            label: isDestructiveWriteKind(value.intent.kind)
              ? DESTRUCTIVE_WRITE_LABELS[value.intent.kind]
              : '这类操作'
          }
        : null
    )
    // 每次新确认框都从「不记住」开始：上次勾过不该顺延到下一次
    setRememberSkip(false)
  }

  const {
    pushToolResult,
    compressExecutedCallArgs,
    noteAction,
    applyWriteIntent,
    commitTurn,
    processQueue
  } = createTurnRuntime({
    changedIdsRef,
    messagesRef,
    queueRef,
    requestIdRef,
    runRoundRef,
    seenCallsRef,
    turnStartedRef,
    wireRef,
    writeLogRef,
    writesAppliedRef,
    writesFailedRef,
    dumpDiag,
    update,
    setActivity,
    setPlan,
    setStreaming,
    // 这三个是 useChatLoop 的解构入参：不随代码搬走，必须显式传进来
    docsRef,
    onBeforeAiWrite,
    refreshLicense,
    // A6-4 配方②：定义在本 hook 里，以 deps 传进工厂（见上面 setPending 的说明）
    setPending
  })

  /** 用户对破坏性操作表态后继续（从断点接着处理剩下的调用） */
  const resolvePending = useCallback((approve: boolean, remember = false): void => {
    const pending = pendingRef.current
    setPending(null)
    if (!pending) return

    if (approve && remember) {
      /**
       * 记住「这类操作以后不再询问」。
       *
       * 落进 settings.json（`patchAppSettings` 同时更新内存与磁盘）——
       * 只记在组件 state 里的话，下次开窗口又会问一遍，用户会以为"勾了没用"。
       * 写入失败不影响这次执行：确认框已经点过了。
       */
      void patchAppSettings({
        aiConfirmSkip: Array.from(
          new Set([...useEditor.getState().appSettings.aiConfirmSkip, pending.intent.kind])
        )
      })
    }

    if (approve) {
      const endWrite = beginCost('应用写意图', pending.intent.kind)
      const applied = applyWriteIntent(pending.intent)
      endWrite()
      if (applied.ok) writesAppliedRef.current += 1
      else writesFailedRef.current += 1
      pushToolResult(
        pending.call,
        applied.ok
          ? `已执行：${pending.summary}${applied.note ? `（${applied.note}）` : ''}`
          : applied.note
      )
      if (applied.ok) {
        noteAction(pending.summary, true)
        compressExecutedCallArgs(pending.call.id)
      } else noteAction(`未执行：${pending.summary}`, false)
    } else {
      // 拒绝也要如实回喂：否则模型以为删掉了，后面的判断全错
      pushToolResult(
        pending.call,
        '用户拒绝了这次操作，没有执行。请不要重试同一个操作，改为向用户说明你原本打算做什么。'
      )
      noteAction(`已跳过：${pending.summary}`, false)
    }

    const queue = queueRef.current
    if (queue) {
      queue.index += 1
      processQueueRef.current()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ------------------------------------------------------------------ */
  /* 流式事件                                                            */
  /* ------------------------------------------------------------------ */

  const handleEvent = useCallback(
    (event: AiStreamEvent): void => {
      if (event.requestId !== requestIdRef.current) return

      /** 往最后一条助手消息上补字段（工具痕迹 / 收尾文案） */
      const patchLast = (patch: Partial<ChatMsg>): void => {
        update((prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          const merged: ChatMsg = { ...last }
          if (patch.content !== undefined) merged.content = patch.content
          if (patch.thinking !== undefined) merged.thinking = patch.thinking
          if (patch.aborted !== undefined) merged.aborted = patch.aborted
          if (patch.toolNotes !== undefined) merged.toolNotes = patch.toolNotes
          return [...prev.slice(0, -1), merged]
        })
      }

      if (event.kind === 'chunk') {
        update((prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          return [...prev.slice(0, -1), { ...last, content: last.content + event.text }]
        })
        return
      }

      if (event.kind === 'reasoning') {
        // 思维链直播：边想边显示，正文一开始就自动收起（界面在渲染层做）
        update((prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          return [...prev.slice(0, -1), { ...last, thinking: (last.thinking ?? '') + event.text }]
        })
        return
      }

      if (event.kind === 'error') {
        // 模型不支持函数调用（各家报错文案不一）→ 关掉工具重试一次，别把错误丢给用户
        if (useToolsRef.current && /tool|function/i.test(event.message)) {
          useToolsRef.current = false
          requestIdRef.current = null
          update((prev) => {
            const last = prev[prev.length - 1]
            if (!last || last.role !== 'assistant') return prev
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                toolNotes: [...(last.toolNotes ?? []), '当前模型不支持工具调用，已切换为纯对话模式']
              }
            ]
          })
          runRoundRef.current()
          return
        }
        patchLast({ content: `出错了：${event.message}` })
        requestIdRef.current = null
        setStreaming(false)
        commitTurnRef.current()
        return
      }

      // token 消耗按服务商回报记账：每一轮请求都有一次（工具循环一轮 = 一次请求），
      // 既累计到会话总数，也并到这条回答上（所以多轮的回答显示的是**总和**）
      const usage = event.usage
      if (usage) {
        setSessionTokens((prev) => prev + usage.totalTokens)
        update((prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          return [...prev.slice(0, -1), { ...last, usage: addUsage(last.usage, usage) }]
        })
      }

      if (event.aborted) {
        // 用户主动停止：已生成的部分保留；工具调用多半残缺，一律不执行。
        // 内容为空时**不要**再往里塞「（已停止）」——气泡上本来就会渲染这个标记，
        // 两处都写会出现「（已停止）（已停止）」
        update((prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          return [...prev.slice(0, -1), { ...last, aborted: true }]
        })
        requestIdRef.current = null
        setStreaming(false)
        queueRef.current = null
        commitTurnRef.current()
        return
      }

      /**
       * 输出被服务商的**输出上限**截断（`finish_reason = length`）。
       *
       * 以前这个信息被丢掉：解析出来了、没人用，于是「被服务商掐断」和「正常说完」
       * 在应用里长得一模一样——用户看到的是"AI 怎么只写了一点点"，
       * 既不知道是模型懒、还是被截断，也无从下手。
       * 现在如实说明并给出下一步（这是"只写粗分"最常见的原因）。
       */
      if (event.truncated) {
        patchLast({
          warning:
            '本回合的输出被服务商的**输出上限**截断了（剩余内容没有发出），所以看起来"只写了一半"。' +
            '回复「继续」可以接着写完；想一次写更多，去「AI 设置」把「单次输出上限」调大。'
        })
      }

      // 思维链全文兜底：流式期间已逐片拼过，这里以完整版为准（防丢片）
      if (event.kind === 'done' && event.reasoning && event.reasoning.length > 0) {
        patchLast({ thinking: event.reasoning })
      }

      // 退化熔断：如实告知并给下一步（这是模型退化，不是用户做错了什么）
      if (event.kind === 'done' && event.degenerated) {
        patchLast({
          warning:
            '模型输出陷入**自我重复**（退化循环），已自动熔断止损、裁掉复读部分。' +
            '重试通常可恢复；反复出现请换更强的模型（如 deepseek-chat），或新开一个会话减小上下文。'
        })
      }

      const calls = event.toolCalls
      if (calls.length === 0) {
        update((prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          const content =
            last.content.trim().length > 0
              ? last.content
              : '（模型没有返回内容，换个说法或换个模型再试）'
          return [...prev.slice(0, -1), { ...last, content }]
        })
        requestIdRef.current = null
        setStreaming(false)
        commitTurnRef.current()
        return
      }

      roundRef.current += 1

      // 先算还有没有预算：不够就**不要**把这轮的 tool_calls 记进消息线——
      // 助手消息带 tool_calls 却没有对应的工具结果，服务端会直接报 400。
      const gate = canContinueAgentLoop(roundRef.current, toolCallsUsedRef.current + calls.length)
      if (!gate.ok) {
        toolCallsUsedRef.current += calls.length

        // 已经是「不带工具的决胜轮」了，模型居然还在要工具：必须**硬停**。
        // 以前这里会再问一次、模型再要一次……于是「已达上限」的小标签叠了三层，
        // 用户最后什么都没等到。
        if (forceNoToolsRef.current) {
          update((prev) => {
            const last = prev[prev.length - 1]
            if (!last || last.role !== 'assistant') return prev
            const content =
              last.content.trim().length > 0
                ? last.content
                : `（${gate.reason}，模型仍在尝试调用工具，本次已停止。可以换个说法再问一次。）`
            return [...prev.slice(0, -1), { ...last, content }]
          })
          requestIdRef.current = null
          setStreaming(false)
          queueRef.current = null
          commitTurnRef.current()
          return
        }

        // 撞上限 ≠ 不回答：去掉工具再问**一次**，让它把已经看到的东西讲清楚
        patchLast({
          toolNotes: [
            ...(messagesRef.current[messagesRef.current.length - 1]?.toolNotes ?? []),
            gate.reason
          ]
        })
        forceNoToolsRef.current = true
        wireRef.current = [
          ...wireRef.current,
          {
            role: 'user',
            content:
              '（工具调用次数已达本次上限。请立刻停止调用工具，向用户**总结**：你已经完成了哪些改动、' +
              '哪些还没来得及做、建议用户接下来怎么办——比如让他再发一句「继续」。）'
          }
        ]
        runRoundRef.current()
        return
      }

      /**
       * 把这一轮的解说（计划 / 每步反馈）**移进步骤时间线**：正文只保留最后一轮的
       * （= 最终自检与总结）。阅读顺序因此是用户要的样子：
       * **计划 → 工具步骤 → 每步反馈 → … → 最终自检**，
       * 而不是"一堆工具痕迹在上、一段不知道属于哪一步的正文在下"。
       * （wire 不受影响：协议里的 assistant.content 照旧，这里只动界面展示。）
       */
      update((prev) => {
        const last = prev[prev.length - 1]
        if (!last || last.role !== 'assistant') return prev
        const narration = last.content.trim()
        if (narration.length === 0) return prev
        return [
          ...prev.slice(0, -1),
          { ...last, content: '', toolNotes: [...(last.toolNotes ?? []), `💬 ${narration}`] }
        ]
      })

      // 有工具调用：把助手这一轮记进消息线（协议要求带上 tool_calls），然后逐个处理
      wireRef.current = [
        ...wireRef.current,
        { role: 'assistant', content: event.content, toolCalls: calls }
      ]
      // 工具调用即将开跑：打开取证输出。卡死正好都发生在这条路径上，
      // 所以只有这里开——用户自己的日常编辑不会产生任何诊断日志
      armDiag(`AI 回合：${calls.length} 个工具调用`)
      dumpDiag(`收到 ${calls.length} 个工具调用`)
      toolCallsUsedRef.current += calls.length
      queueRef.current = { calls, index: 0 }
      processQueueRef.current()
    },
    [update, dumpDiag]
  )

  const runRound = useCallback((): void => {
    const requestId = createId()
    requestIdRef.current = requestId
    setStreaming(true)
    dumpDiag(`发起第 ${roundRef.current + 1} 轮模型请求`, true)
    setActivity(
      roundRef.current === 0
        ? '正在思考…'
        : `正在思考…（第 ${roundRef.current + 1} 轮，还在翻资料）`
    )
    setStage(`AI 第 ${roundRef.current + 1} 轮`)
    // 上下文体积观测：退化循环与「越聊越贵」都和它有关——先有数据，再谈压缩
    console.warn(
      `[chat] 本轮上下文：${wireRef.current.length} 条消息 / ${
        JSON.stringify(wireRef.current).length
      } 字符`
    )
    void window.api
      .aiChatStream(requestId, wireRef.current, {
        useTools: useToolsRef.current && !forceNoToolsRef.current,
        turnId: turnIdRef.current
      })
      .catch((error: unknown) => {
        // invoke 被拒（参数无效 / 没配 Key）：同样以事件形式收尾，只有一条代码路径。
        // 顺手剥掉 Electron 那层「Error invoking remote method …」包装，只留人话
        handleEvent({
          requestId,
          kind: 'error',
          message: readableIpcError((error as Error).message)
        })
      })
  }, [handleEvent, dumpDiag])

  useEffect(() => {
    runRoundRef.current = runRound
    processQueueRef.current = processQueue
    commitTurnRef.current = commitTurn
    stopRef.current = stop
  })

  /**
   * 订阅流式事件。
   *
   * **卸载时必须收尾这一回合**——以前只做了「取消订阅」，
   * 而面板是 `{sidePanel === 'chat' && <ChatPanel/>}` 挂载的（切到别的抽屉就整个卸载）：
   * 正在跑的回合没人收尾，store 里的 `aiTurn` 永远留着，于是
   * `undo` / `redo` 被**静默**挡住（Ctrl+Z 彻底失灵，用户看不出原因），
   * 画布还会因为 `aiTurnActive` 一直为真而持续节流（连自己打字都慢半拍）。
   */
  useEffect(() => {
    const off = window.api.onAiStreamEvent(handleEvent)
    return () => {
      off()
      stopRef.current()
      // 队列是自己"接着跑"的，不会有模型事件来收尾，这里同样要自己收干净
      commitTurnRef.current()
    }
  }, [handleEvent])

  const send = useCallback(
    (raw: string): void => {
      const text = raw.trim()
      if (text.length === 0 || requestIdRef.current !== null) return

      const state = useEditor.getState()
      const root = activeRoot(state.workbook)
      const selectedId = state.selection[0] ?? null
      // 选区路径（根 → 当前节点）是模型最需要的「用户指着哪」
      const selectedTitles = selectedId
        ? [...ancestorsOf(root, selectedId), selectedId]
            .map((id) => findTopic(root, id)?.title ?? '')
            .filter((title) => title.length > 0)
        : []

      // 用户这句话里提到的节点：应用先按标题匹配好（带句柄）——
      // 这样模型可以直接动手，不用反过来要求用户「先去画布上选中」
      const mentioned = new Map<string, { title: string; handle: string; path: string }>()
      for (const segment of segmentTitleMentions(text, titleIndex)) {
        const id = segment.topicId
        if (id === null) continue
        const topic = findTopic(root, id)
        const path = topicPathOf(root, id)
        if (topic && path) {
          mentioned.set(id, {
            title: topic.title,
            handle: shortHandleOf(id),
            path: path.join(' → ')
          })
        }
      }

      const system = buildChatSystemPrompt({
        skeleton: buildSkeletonDigest(root),
        selectedTitles,
        totalNodes: countTopicTree(root),
        sheetCount: state.workbook.sheets.length,
        // 生成规格按用户的档位走（min 省 token / mid 80 分 / max 90 分）
        tier,
        // 用户这一轮的原话：用来粗判任务类型，决定注入「生成规格 / 编辑模块 / 未判定兜底」
        latestRequest: text,
        // 能不能改，以主进程的许可判定为准：写工具没下发时，提示词也必须如实说
        canWrite: license?.canWrite ?? true,
        writeHint: license?.writeHint ?? null,
        // 上一轮实际做过的改动：不注入的话，用户说「继续」时模型会从零开始
        // 重新读取、重新规划——大导图上就是把同一种折腾重复一遍
        previousTurnNotes: messagesRef.current[messagesRef.current.length - 1]?.toolNotes ?? [],
        mentionedNodes: [...mentioned.values()].slice(0, 5)
      })

      // 上下文压缩（三期）：最近几轮原文 + 更早轮次折叠成「此前做过什么」。
      // 工具条目（toolNotes）参与摘要——它是"我做过什么"最可靠的来源
      // （模型可能把结论说错，执行记录不会）。
      const compressed = compressHistory(
        messagesRef.current.map((msg) => ({
          role: msg.role,
          content: msg.content,
          toolNotes: msg.toolNotes
        }))
      )
      const history: AiMessage[] = [
        ...(compressed.digest.length > 0
          ? [{ role: 'user' as const, content: digestPreamble(compressed.digest) }]
          : []),
        ...compressed.recent
          .filter((msg) => msg.content.trim().length > 0)
          .map((msg): AiMessage => ({ role: msg.role, content: msg.content })),
        { role: 'user', content: text }
      ]

      // 每轮提问重建消息线：上一轮的 tool 结果不能跨轮复用（导图可能已经变了）
      wireRef.current = [{ role: 'system', content: system }, ...history]
      // 新的一次用户命令 = 新的 turnId：主进程靠它做试用计数去重
      // （一条命令跑多少轮都只算一个写回合，见 markTrialTurnSeen）
      turnIdRef.current = createId()
      setPlan(null)
      roundRef.current = 0
      toolCallsUsedRef.current = 0
      writeLogRef.current = []
      changedIdsRef.current = []
      writesAppliedRef.current = 0
      writesFailedRef.current = 0
      turnStartedRef.current = false
      queueRef.current = null
      forceNoToolsRef.current = false
      seenCallsRef.current = new Set()
      setPending(null)
      setPendingWrite(null)

      update((prev) => [
        ...prev,
        { id: createId(), role: 'user', content: text },
        { id: createId(), role: 'assistant', content: '' }
      ])
      setDraft('')
      // 自己发的消息一定要看得见：即使刚才在上滑看历史，也拉回底部并恢复跟随
      setAtBottom(true)
      runRound()
    },
    // setDraft / setAtBottom 是 React 的稳定 setter（拆分前在组件作用域里、lint 视为稳定，
    // 如今作为入参传入，规则要求显式列出）——补进来不改变 send 的身份变化时机。
    // setPending 是**本 hook 里的函数字面量**（A6-4 配方② 之后），lint 同样不再要求列进来；
    // 它只写 pendingRef 与两个稳定 setter，不补是安全的。
    [runRound, update, license, titleIndex, tier, setAtBottom, setDraft]
  )

  const stop = (): void => {
    const id = requestIdRef.current
    if (id) window.api.aiChatStreamCancel(id)
    // 工具队列也要停：以前只取消了网络请求，已经排好队的调用还会继续改画布——
    // 用户按了「停止」而画布还在变，比不给停更让人生气。
    if (queueRef.current) {
      queueRef.current = null
      // 队列是自己「接着跑」的，不会有模型事件来收尾，所以这里得自己把回合收干净
      setStreaming(false)
      setActivity('')
      commitTurnRef.current()
    }
  }

  /** 清空对话：内存与落盘那份都要清（否则下次打开这份文档对话又"复活"了） */
  const clearChat = (): void => {
    update(() => [])
    setSessionTokens(0)
    if (filePath) void window.api.chatHistoryClear(filePath).catch(() => undefined)
  }
  return {
    messages,
    activity,
    streaming,
    plan,
    pendingWrite,
    rememberSkip,
    sessionTokens,
    send,
    stop,
    resolvePending,
    setRememberSkip,
    clearChat
  }
}
