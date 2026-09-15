import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from 'react'
import { Bot, Eraser, Send, Settings2, Sparkles, Square, X } from 'lucide-react'
import {
  buildChatSystemPrompt,
  buildSkeletonDigest,
  countTopicTree,
  type AiMessage,
  type AiStreamEvent
} from '@shared/ai'
import {
  buildTitleIndex,
  canContinueAgentLoop,
  runReadTool,
  segmentTitleMentions,
  type ToolContext
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
   * 这些仍走原来的对话框（先预览、确认后才写入）——本期面板是只读的，
   * 把它们收成面板里的入口，而不是让用户去别处找。
   */
  onOpenTask(task: AiTask): void
}

interface ChatMsg {
  /** 用作 React key：列表只会追加，但用下标做 key 在插入场景会错位 */
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 这条回答被用户手动停止——标注出来，别让人以为说完了 */
  aborted?: boolean
  /** 这一轮里 AI 翻看过什么（工具调用摘要），让用户看得见它做过的事 */
  toolNotes?: string[]
}

/**
 * 发给模型的历史条数上限。
 * 防长对话把上下文撑爆（8k 的模型几轮就满）；真正的「压缩」在二期做。
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
 * AI 聊天面板（三期 1a 聊天 + 1b 只读探查工具）。
 *
 * 循环：用户提问 → 模型（可能要求调工具）→ 本地执行只读工具 → 结果回喂 → 模型继续，
 * 直到模型不再要求调工具为止。**工具全部只读**，所以这一版仍然不动画布。
 *
 * 上下文每次提问时**重新取**（不是挂载时取一次）——用户可能刚改了导图。
 */
export default function ChatPanel({ onClose, onOpenSettings, onOpenTask }: Props): ReactElement {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [draft, setDraft] = useState('')
  /** null = 还没查完；false = 没配 Key（显示引导）；true = 可用 */
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [streaming, setStreaming] = useState(false)
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
  /** runRound 与 handleEvent 互相需要，用 ref 打破循环引用 */
  const runRoundRef = useRef<() => void>(() => {})

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

  const handleEvent = useCallback(
    (event: AiStreamEvent): void => {
      if (event.requestId !== requestIdRef.current) return

      /** 结束本轮：清空进行中的请求，解锁输入 */
      const finishTurn = (): void => {
        requestIdRef.current = null
        setStreaming(false)
      }

      /**
       * 往最后一条助手消息上补字段（工具痕迹 / 收尾文案）。
       *
       * **只覆盖真正给了值的键**：`{ ...last, content: undefined }` 会把 content
       * 清成 undefined，下一次渲染读它的 length 就直接崩（这个坑真踩过，
       * 表现为点「停止生成」后整块界面报错）。
       */
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
        finishTurn()
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
        finishTurn()
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
        finishTurn()
        return
      }

      // 有工具调用：把助手这一轮记进消息线（协议要求带上 tool_calls），再执行工具
      wireRef.current = [...wireRef.current, { role: 'assistant', content: event.content, toolCalls: calls }]
      roundRef.current += 1

      const gate = canContinueAgentLoop(roundRef.current, toolCallsUsedRef.current + calls.length)
      if (!gate.ok) {
        toolCallsUsedRef.current += calls.length
        update((prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          return [
            ...prev.slice(0, -1),
            { ...last, content: `${last.content}\n\n（${gate.reason}，先基于已看到的内容作答）` }
          ]
        })
        finishTurn()
        return
      }

      toolCallsUsedRef.current += calls.length

      const state = useEditor.getState()
      const context: ToolContext = {
        root: activeRoot(state.workbook),
        selectedId: state.selection[0] ?? null,
        sheetCount: state.workbook.sheets.length
      }

      const notes: string[] = []
      const toolMessages: AiMessage[] = []
      for (const call of calls) {
        // 工具失败也会返回可读文本（见 runReadTool）：让模型自己纠正，而不是整轮中断
        const result = runReadTool(call.name, call.argumentsText, context)
        notes.push(result.summary)
        toolMessages.push({ role: 'tool', toolCallId: call.id, content: result.content })
      }
      wireRef.current = [...wireRef.current, ...toolMessages]

      patchLast({ toolNotes: [...(messagesRef.current[messagesRef.current.length - 1]?.toolNotes ?? []), ...notes] })

      // 继续下一轮：模型拿到结果后再决定是继续调工具还是作答
      runRoundRef.current()
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
  }, [runRound])

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
                  用自然语言聊聊这页导图。
                  <br />
                  它会自己翻看结构（搜索主题、读分支），但<strong>不会改</strong>你的画布；
                  要它动图请用下面的「润色 / 扩写 / 生成」——那几个会先给你预览。
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
