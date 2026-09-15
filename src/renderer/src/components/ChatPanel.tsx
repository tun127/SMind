import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from 'react'
import { Bot, Eraser, Send, Settings2, Sparkles, Square, TriangleAlert, X } from 'lucide-react'
import {
  buildChatSystemPrompt,
  buildSkeletonDigest,
  countTopicTree,
  type AiMessage,
  type AiStreamEvent,
  type ToolCall
} from '@shared/ai'
import {
  buildTitleIndex,
  canContinueAgentLoop,
  isReadToolName,
  planWriteTool,
  runReadTool,
  segmentTitleMentions,
  type ToolContext,
  type WriteIntent
} from '@shared/agent'
import { createId } from '@shared/model/factory'
import { activeRoot, ancestorsOf, findTopic } from '@shared/model/tree'
import { viewportActions } from '../render/viewport'
import { useEditor } from '../store/editor'
import type { AiTask } from './AiDialog'

interface Props {
  onClose(): void
  /** 面板自己不做配置界面，只负责把用户送去「AI 设置」 */
  onOpenSettings(): void
  /**
   * 打开会**写入画布**的 AI 流程（润色 / 扩写 / 生成）。
   *
   * 这些仍走原来的对话框（先预览、确认后才写入）——它们与聊天里的写工具互补：
   * 对话框适合「我就想让 AI 生成一批内容」，聊天适合「你看着办」。
   */
  onOpenTask(task: AiTask): void
  /**
   * AI 要动**第一笔**改动之前调用。
   * App 层用它存一份盘上快照——撤销栈在内存里，崩溃就没了，这是第二层保险。
   */
  onBeforeAiWrite(): void
}

interface ChatMsg {
  /** 用作 React key：列表只会追加，但用下标做 key 在插入场景会错位 */
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 这条回答被用户手动停止——标注出来，别让人以为说完了 */
  aborted?: boolean
  /** 这一轮里 AI 做过什么（工具调用摘要），让用户看得见它干的事 */
  toolNotes?: string[]
}

/**
 * 发给模型的历史条数上限。
 * 防长对话把上下文撑爆（8k 的模型几轮就满）；真正的「压缩」在后续迭代做。
 */
const MAX_HISTORY = 16

/** 快捷提问：只跟 AI 聊，不动画布 */
const QUICK_PROMPTS = ['总结这页导图的主要内容', '指出这个导图结构上薄弱的地方']

/**
 * 快捷任务：这些会**真的改画布**（走原对话框：先预览、确认后才写入）。
 * 与上面的提问分开一排，免得用户分不清哪个会改文件。
 */
const QUICK_TASKS: Array<{ label: string; task: AiTask }> = [
  { label: '润色选中标题', task: 'polish' },
  { label: '扩写选中主题', task: 'expand' },
  { label: '生成新导图', task: 'generate' }
]

/**
 * AI 聊天面板（三期）。
 *
 * 循环：用户提问 → 模型（可能要求调工具）→ 本地执行 → 结果回喂 → 模型继续，直到不再要求调工具。
 *
 * 工具的两种命运：
 * - **只读**（看结构）：立刻执行，没有副作用；
 * - **写**（改画布）：解析成「操作意图」再落到 store，**破坏性操作会停下来先问用户**。
 *
 * 安全网：整个回合的改动并成**一步撤销**（`beginAiTurn`/`commitAiTurn`），
 * 回合中锁住用户的撤销键，开动前请 App 存一份盘上快照。
 */
export default function ChatPanel({
  onClose,
  onOpenSettings,
  onOpenTask,
  onBeforeAiWrite
}: Props): ReactElement {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [draft, setDraft] = useState('')
  /** null = 还没查完；false = 没配 Key（显示引导）；true = 可用 */
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [streaming, setStreaming] = useState(false)
  /** 需要用户点头的破坏性操作（删分支等） */
  const [pendingWrite, setPendingWrite] = useState<{ summary: string } | null>(null)
  const filePath = useEditor((s) => s.filePath)
  const workbook = useEditor((s) => s.workbook)
  /** 标题索引：把回复里提到的节点变成可点击引用（按首字分桶，大文档也不卡） */
  const titleIndex = useMemo(() => buildTitleIndex(activeRoot(workbook)), [workbook])

  const messagesRef = useRef<ChatMsg[]>([])
  const requestIdRef = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  /** 发给模型的完整消息线（含本轮的 assistant.toolCalls 与 tool 结果） */
  const wireRef = useRef<AiMessage[]>([])
  /** 本轮已进行的模型轮数 / 已执行的工具调用次数 */
  const roundRef = useRef(0)
  const toolCallsUsedRef = useRef(0)
  /** 模型不支持函数调用时置 false，此后不再带工具定义 */
  const useToolsRef = useRef(true)
  /** runRound / processQueue 与 handleEvent 互相需要，用 ref 打破循环引用 */
  const runRoundRef = useRef<() => void>(() => {})
  const processQueueRef = useRef<() => void>(() => {})
  const commitTurnRef = useRef<() => void>(() => {})
  /** 待处理的工具调用（一次处理一个：破坏性操作要在中间停下来问用户） */
  const queueRef = useRef<{ calls: ToolCall[]; index: number } | null>(null)
  /** 待确认的写操作（state 只用于渲染，判定走 ref） */
  const pendingRef = useRef<{ call: ToolCall; intent: WriteIntent; summary: string } | null>(null)
  /** 本轮 AI 改了哪些东西（并成撤销标签 + 事后摘要） */
  const writeLogRef = useRef<string[]>([])
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

  useEffect(() => {
    void window.api
      .aiConfigGet()
      .then((view) => setHasKey(view.hasKey))
      .catch(() => setHasKey(false))
  }, [])

  /**
   * 按文档恢复聊天记录。
   *
   * key 用**文档路径**；未保存的文档不落盘（只在内存里，关掉即弃）——
   * 免得应用数据目录里堆一堆「未命名文档」的会话。
   * 切到别的文档时必须清空，否则会把上一份文档的对话串过去。
   */
  useEffect(() => {
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

  /* ------------------------------------------------------------------ */
  /* 工具执行                                                            */
  /* ------------------------------------------------------------------ */

  /** 往消息线里塞一条工具结果（模型下一轮就看得到） */
  const pushToolResult = (call: ToolCall, content: string): void => {
    wireRef.current = [...wireRef.current, { role: 'tool', toolCallId: call.id, content }]
  }

  /** 把「AI 干了什么」记到界面与日志上 */
  const noteAction = (summary: string, counts: boolean): void => {
    if (counts) writeLogRef.current = [...writeLogRef.current, summary]
    update((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== 'assistant') return prev
      return [...prev.slice(0, -1), { ...last, toolNotes: [...(last.toolNotes ?? []), summary] }]
    })
  }

  /**
   * 把一条写意图落到 store 上。
   *
   * 这里是**唯一**执行写操作的地方：撤销事务、快照、摘要都在这一处收口，
   * 免得以后新增工具时漏掉某一步安全网。
   */
  const applyWriteIntent = (intent: WriteIntent): { ok: boolean; note: string } => {
    const store = useEditor.getState()

    if (!turnStartedRef.current) {
      turnStartedRef.current = true
      store.beginAiTurn()
      onBeforeAiWrite()
    }

    switch (intent.kind) {
      case 'rename':
        store.setTitle(intent.id, intent.title)
        return { ok: true, note: '' }
      case 'insert': {
        const added = store.applyOutlineTree(intent.id, intent.node)
        return added > 0 ? { ok: true, note: '' } : { ok: false, note: '目标主题已不存在，插入没有生效。' }
      }
      case 'delete':
        return store.deleteTopic(intent.id)
          ? { ok: true, note: '' }
          : { ok: false, note: '目标主题已不存在，删除没有生效。' }
      case 'move': {
        const moved = store.moveNode(intent.id, intent.targetId, intent.index ?? undefined)
        return moved ? { ok: true, note: '' } : { ok: false, note: '移动没有生效：目标位置不合法。' }
      }
      case 'collapse':
        store.setCollapsed(intent.id, intent.collapsed)
        return { ok: true, note: '' }
      case 'notes':
        store.setNotes(intent.id, intent.text)
        return { ok: true, note: '' }
      case 'code':
        store.setCode(intent.id, intent.code)
        return { ok: true, note: '' }
      case 'formula':
        store.setFormula(intent.id, intent.formula)
        return { ok: true, note: '' }
      case 'ask':
        return { ok: true, note: '' }
      default:
        return { ok: false, note: '未知操作。' }
    }
  }

  const setPending = (value: { call: ToolCall; intent: WriteIntent; summary: string } | null): void => {
    pendingRef.current = value
    setPendingWrite(value ? { summary: value.summary } : null)
  }

  /** 结束本轮：把 AI 的改动并成一步撤销，并把「改了什么」留在气泡里 */
  const commitTurn = (): void => {
    const log = writeLogRef.current
    if (turnStartedRef.current) {
      const label = log.length > 0 ? `AI · ${log.slice(0, 2).join('、')}` : 'AI · 修改导图'
      useEditor.getState().commitAiTurn(label)
    }
    if (log.length > 0) {
      const text =
        log.length > 6 ? `${log.slice(0, 6).join('；')}…` : log.join('；')
      // 已保存的文档在动手前存过版本快照；把它写出来，用户才知道「重启之后怎么回去」
      const hasSnapshot = useEditor.getState().filePath !== null
      update((prev) => {
        const last = prev[prev.length - 1]
        if (!last || last.role !== 'assistant') return prev
        const undoLine = hasSnapshot
          ? '撤销：按一次 Ctrl+Z 全部回退；动手前的状态已存进「版本快照」（Ctrl+H），应用重启过也能回到那里。'
          : '撤销：按一次 Ctrl+Z 全部回退（未保存的文档没有版本快照，应用重启后无从回退）。'
        return [
          ...prev.slice(0, -1),
          { ...last, content: `${last.content}\n\n——\n已改动：${text}（共 ${log.length} 处）\n${undoLine}` }
        ]
      })
    }
    writeLogRef.current = []
    turnStartedRef.current = false
    setPending(null)
  }

  /**
   * 依次处理这一轮的工具调用。
   *
   * **一次只处理一个**：破坏性操作要在中间停下来问用户，不能一口气执行完
   * （用户点完「执行」再从断点继续）。读工具没有副作用，直接跑。
   */
  const processQueue = (): void => {
    const step = (): void => {
      const queue = queueRef.current
      if (!queue) return
      const call = queue.calls[queue.index]
      if (!call) {
        queueRef.current = null
        runRoundRef.current()
        return
      }

      if (isReadToolName(call.name)) {
        const state = useEditor.getState()
        const context: ToolContext = {
          root: activeRoot(state.workbook),
          selectedId: state.selection[0] ?? null,
          sheetCount: state.workbook.sheets.length
        }
        const result = runReadTool(call.name, call.argumentsText, context)
        pushToolResult(call, result.content)
        noteAction(result.summary, false)
        queue.index += 1
        step()
        return
      }

      const plan = planWriteTool(call.name, call.argumentsText, activeRoot(useEditor.getState().workbook))
      if (!plan.ok) {
        // 规划失败：把原因回喂给模型让它自己纠正，不打断整轮
        pushToolResult(call, plan.error)
        noteAction(plan.summary, false)
        queue.index += 1
        step()
        return
      }

      if (plan.intent.kind === 'ask') {
        // 模型主动提问：呈现问题、本轮到此为止（等用户回答）
        queueRef.current = null
        update((prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          const options = plan.intent.kind === 'ask' && plan.intent.options.length > 0 ? `\n可选：${plan.intent.options.join(' / ')}` : ''
          return [
            ...prev.slice(0, -1),
            { ...last, content: `${last.content}\n\n${plan.intent.kind === 'ask' ? plan.intent.question : ''}${options}` }
          ]
        })
        requestIdRef.current = null
        setStreaming(false)
        commitTurn()
        return
      }

      if (plan.destructive) {
        // 破坏性操作：停下来等用户点头（这一步就是「确认分级」）
        setPending({ call, intent: plan.intent, summary: plan.summary })
        return
      }

      const applied = applyWriteIntent(plan.intent)
      pushToolResult(call, applied.ok ? `已执行：${plan.summary}` : applied.note)
      if (applied.ok) noteAction(plan.summary, true)
      queue.index += 1
      step()
    }

    step()
  }

  /** 用户对破坏性操作表态后继续（从断点接着处理剩下的调用） */
  const resolvePending = useCallback((approve: boolean): void => {
    const pending = pendingRef.current
    setPending(null)
    if (!pending) return

    if (approve) {
      const applied = applyWriteIntent(pending.intent)
      pushToolResult(pending.call, applied.ok ? `已执行：${pending.summary}` : applied.note)
      if (applied.ok) noteAction(pending.summary, true)
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

      if (event.aborted) {
        // 用户主动停止：已生成的部分保留；工具调用多半残缺，一律不执行
        update((prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          const content = last.content.trim().length > 0 ? last.content : '（已停止）'
          return [...prev.slice(0, -1), { ...last, content, aborted: true }]
        })
        requestIdRef.current = null
        setStreaming(false)
        queueRef.current = null
        commitTurnRef.current()
        return
      }

      const calls = event.toolCalls
      if (calls.length === 0) {
        update((prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          const content = last.content.trim().length > 0 ? last.content : '（模型没有返回内容，换个说法或换个模型再试）'
          return [...prev.slice(0, -1), { ...last, content }]
        })
        requestIdRef.current = null
        setStreaming(false)
        commitTurnRef.current()
        return
      }

      // 有工具调用：把助手这一轮记进消息线（协议要求带上 tool_calls），然后逐个处理
      wireRef.current = [...wireRef.current, { role: 'assistant', content: event.content, toolCalls: calls }]
      roundRef.current += 1

      const gate = canContinueAgentLoop(roundRef.current, toolCallsUsedRef.current + calls.length)
      if (!gate.ok) {
        toolCallsUsedRef.current += calls.length
        patchLast({ content: `${messagesRef.current[messagesRef.current.length - 1]?.content ?? ''}\n\n（${gate.reason}，先基于已看到的内容作答）` })
        requestIdRef.current = null
        setStreaming(false)
        commitTurnRef.current()
        return
      }

      toolCallsUsedRef.current += calls.length
      queueRef.current = { calls, index: 0 }
      processQueueRef.current()
    },
    [update]
  )

  const runRound = useCallback((): void => {
    const requestId = createId()
    requestIdRef.current = requestId
    setStreaming(true)
    void window.api
      .aiChatStream(requestId, wireRef.current, { useTools: useToolsRef.current })
      .catch((error: unknown) => {
        // invoke 被拒（参数无效 / 没配 Key）：同样以事件形式收尾，只有一条代码路径
        handleEvent({ requestId, kind: 'error', message: (error as Error).message })
      })
  }, [handleEvent])

  useEffect(() => {
    runRoundRef.current = runRound
    processQueueRef.current = processQueue
    commitTurnRef.current = commitTurn
  })

  useEffect(() => window.api.onAiStreamEvent(handleEvent), [handleEvent])

  // 新内容到达就滚到底：聊天面板的默认预期
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

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

      const system = buildChatSystemPrompt({
        skeleton: buildSkeletonDigest(root),
        selectedTitles,
        totalNodes: countTopicTree(root),
        sheetCount: state.workbook.sheets.length
      })

      const history: AiMessage[] = [
        ...messagesRef.current
          .slice(-MAX_HISTORY)
          .filter((msg) => msg.content.trim().length > 0)
          .map((msg): AiMessage => ({ role: msg.role, content: msg.content })),
        { role: 'user', content: text }
      ]

      // 每轮提问重建消息线：上一轮的 tool 结果不能跨轮复用（导图可能已经变了）
      wireRef.current = [{ role: 'system', content: system }, ...history]
      roundRef.current = 0
      toolCallsUsedRef.current = 0
      writeLogRef.current = []
      turnStartedRef.current = false
      queueRef.current = null
      setPending(null)
      setPendingWrite(null)

      update((prev) => [
        ...prev,
        { id: createId(), role: 'user', content: text },
        { id: createId(), role: 'assistant', content: '' }
      ])
      setDraft('')
      runRound()
    },
    [runRound, update]
  )

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    // isComposing：中文输入法回车选词时不能当作发送
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      send(draft)
    }
  }

  const stop = (): void => {
    const id = requestIdRef.current
    if (id) window.api.aiChatStreamCancel(id)
  }

  /** 回复 → 画布的反向链接：选中并居中（沿用搜索面板的定位方式） */
  const goToNode = (topicId: string): void => {
    useEditor.getState().select(topicId)
    window.requestAnimationFrame(() => viewportActions.centerOn(topicId))
  }

  /**
   * 助手回复按「节点引用 / 纯文本」渲染。
   * 只有标题原文才算引用——这正是 system 提示词要求模型的引用方式。
   */
  const renderAssistantText = (content: string): ReactElement[] =>
    segmentTitleMentions(content, titleIndex).map((segment, index) => {
      const key = `${segment.topicId ?? 'plain'}-${index}`
      if (segment.topicId === null) return <span key={key}>{segment.text}</span>
      const id = segment.topicId
      return (
        <button
          key={key}
          type="button"
          className="chat-msg__link"
          title="在画布中定位这个主题"
          onClick={() => goToNode(id)}
        >
          {segment.text}
        </button>
      )
    })

  return (
    <div className="side-panel chat-panel">
      <div className="side-panel__header">
        <span className="chat-panel__title">
          <Bot size={15} />
          AI 助手
        </span>
        <div className="chat-panel__actions">
          <button
            type="button"
            className="tool-btn"
            title="清空对话"
            disabled={streaming || messages.length === 0}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              update(() => [])
              // 落盘的那份也要清：否则下次打开这份文档对话又"复活"了
              if (filePath) void window.api.chatHistoryClear(filePath).catch(() => undefined)
            }}
          >
            <Eraser size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            title="AI 设置（BaseURL / Key / 模型）"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onOpenSettings}
          >
            <Settings2 size={15} />
          </button>
          <button
            type="button"
            className="tool-btn"
            title="关闭"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {hasKey === false ? (
        <div className="side-panel__body">
          <div className="side-panel__empty">
            还没有配置 AI 服务。填入 BaseURL 与 API Key 后（支持 DeepSeek / OpenAI / 通义 / 智谱 /
            Kimi / 本地 Ollama），就能直接用自然语言聊这页导图。
          </div>
          <button type="button" className="btn btn--primary" onClick={onOpenSettings}>
            <Settings2 size={14} />
            打开 AI 设置
          </button>
        </div>
      ) : (
        <>
          <div className="chat-panel__list" ref={listRef}>
            {messages.length === 0 && (
              <div className="chat-panel__hint">
                <Sparkles size={16} />
                <p>
                  用自然语言聊这页导图，也可以直接让它改图。
                  <br />
                  它会自己翻看结构；删分支这类操作会<strong>先问你</strong>，
                  改完按一次 <strong>Ctrl+Z</strong> 可以整体撤销。
                </p>
              </div>
            )}
            {messages.map((msg) => (
              <div key={msg.id} className={msg.role === 'user' ? 'chat-msg chat-msg--user' : 'chat-msg'}>
                <div className="chat-msg__bubble">
                  {msg.role === 'user' ? msg.content : renderAssistantText(msg.content)}
                  {msg.aborted && <span className="chat-msg__stop">（已停止）</span>}
                  {msg.toolNotes && msg.toolNotes.length > 0 && (
                    <div className="chat-msg__tools">
                      {msg.toolNotes.map((note, index) => (
                        <span key={`${note}-${index}`} className="chat-msg__tool">
                          {note}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="chat-panel__quick">
            {QUICK_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="chat-panel__chip"
                disabled={streaming}
                onClick={() => send(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>

          {/* 会改画布的三个入口：视觉上与「只聊」的区分开 */}
          <div className="chat-panel__quick">
            {QUICK_TASKS.map((item) => (
              <button
                key={item.task}
                type="button"
                className="chat-panel__chip chat-panel__chip--task"
                disabled={streaming}
                title="会先预览、确认后才写入画布"
                onClick={() => onOpenTask(item.task)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {pendingWrite && (
            <div className="chat-panel__confirm">
              <div className="chat-panel__confirm-text">
                <TriangleAlert size={14} />
                <span>{pendingWrite.summary}</span>
              </div>
              <div className="chat-panel__confirm-actions">
                <button type="button" className="btn" onClick={() => resolvePending(false)}>
                  跳过
                </button>
                <button type="button" className="btn btn--primary" onClick={() => resolvePending(true)}>
                  执行
                </button>
              </div>
            </div>
          )}

          <div className="chat-panel__input">
            <textarea
              value={draft}
              rows={2}
              placeholder={streaming ? 'AI 正在回答…' : '问点什么，Enter 发送（Shift+Enter 换行）'}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
            />
            {streaming ? (
              <button type="button" className="btn" title="停止生成" onClick={stop}>
                <Square size={14} />
                停止
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                title="发送"
                disabled={draft.trim().length === 0}
                onClick={() => send(draft)}
              >
                <Send size={14} />
                发送
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
