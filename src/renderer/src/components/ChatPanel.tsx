import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from 'react'
import { Bot, ClipboardPaste, Eraser, Send, Settings2, Sparkles, Square, TriangleAlert, X } from 'lucide-react'
import {
  addUsage,
  buildChatSystemPrompt,
  buildSkeletonDigest,
  claimsAppliedChange,
  countTopicTree,
  readableIpcError,
  formatTokenCount,
  type AiMessage,
  type AiStreamEvent,
  type TokenUsage,
  type ToolCall
} from '@shared/ai'
import {
  buildTitleIndex,
  canContinueAgentLoop,
  isMutatingIntent,
  isReadToolName,
  planWriteTool,
  runReadTool,
  segmentTitleMentions,
  shortHandleOf,
  topicPathOf,
  type ToolContext,
  type WriteIntent
} from '@shared/agent'
import type { LicenseView } from '@shared/license'
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
  /** 这条回答花了多少 token（多轮工具调用会累计；服务商没回报就没有） */
  usage?: TokenUsage
  /** 诚实标注：模型说改了、实际零改动（或写操作没落实）时显示 */
  warning?: string
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
  /**
   * 许可状态（Pro / 试用剩余）。
   *
   * **闸门不在这一层**——由主进程决定下发哪些工具；这里只负责让用户看得见
   * （还差几次、以及去哪输入许可码），以及让提示词如实说明现在能不能改。
   */
  const [license, setLicense] = useState<LicenseView | null>(null)
  const [activateOpen, setActivateOpen] = useState(false)
  const [licenseKey, setLicenseKey] = useState('')
  const [licenseMessage, setLicenseMessage] = useState<string | null>(null)
  /** 本次会话累计的 token 消耗（按服务商回报累计；换会话/清空时归零） */
  const [sessionTokens, setSessionTokens] = useState(0)
  /** 输入区上方的一句临时提示（粘贴失败之类），几秒后自己消失 */
  const [hint, setHint] = useState<string | null>(null)
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
  /** 输入框：便捷粘贴要把内容插到光标处 */
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
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

  useEffect(() => {
    void window.api
      .aiConfigGet()
      .then((view) => setHasKey(view.hasKey))
      .catch(() => setHasKey(false))
  }, [])

  /** 读许可状态；读不到就当"未知"（面板少显示一个徽标，绝不拦住用户用软件） */
  const refreshLicense = useCallback((): void => {
    void window.api
      .licenseGet()
      .then(setLicense)
      .catch(() => undefined)
  }, [])

  useEffect(() => refreshLicense(), [refreshLicense])

  /** 临时提示几秒后自己消失：不占地方、也不用用户去关 */
  useEffect(() => {
    if (hint === null) return
    const timer = window.setTimeout(() => setHint(null), 8000)
    return () => window.clearTimeout(timer)
  }, [hint])

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

    // AI 动手前，先把用户**正在输入**的标题按正常流程提交掉：不提交的话，
    // 输入框里的字会被这次写入冲掉——那是数据丢失，不是体验问题。
    // 提交在 AI 事务**之外**，于是 Ctrl+Z 先撤 AI 的改动、再撤这次提交，顺序对得上。
    if (store.editingId !== null && isMutatingIntent(intent)) store.commitEdit()

    /** 记下这次动过的节点：回合结束时闪一下（「看得见」是放手让 AI 干的前提） */
    const touched = (ids: Array<string | null | undefined>): void => {
      for (const id of ids) if (typeof id === 'string' && id.length > 0) changedIdsRef.current.push(id)
    }

    switch (intent.kind) {
      case 'rename':
        store.setTitle(intent.id, intent.title)
        touched([intent.id])
        return { ok: true, note: '' }
      case 'insert': {
        // 可能是多个并列的新主题（解析器套的壳已经在规划阶段剥掉了）
        const before = new Set(
          findTopic(activeRoot(store.workbook), intent.id)?.children.map((child) => child.id) ?? []
        )
        let added = 0
        for (const node of intent.nodes) added += store.applyOutlineTree(intent.id, node)
        if (added === 0) return { ok: false, note: '目标主题已不存在，插入没有生效。' }
        // 新增完比原来多出来的那批就是新节点，顺手也闪它们本人
        const after = findTopic(activeRoot(store.workbook), intent.id)
        touched([intent.id, ...(after?.children ?? []).filter((child) => !before.has(child.id)).map((c) => c.id)])
        return { ok: true, note: '' }
      }
      case 'delete': {
        // 被删的节点已经没了、闪不了，就闪它的父级——用户至少知道「这一片被动过」
        const chain = ancestorsOf(activeRoot(store.workbook), intent.id)
        const parentId = chain[chain.length - 1]
        const removed = store.deleteTopic(intent.id)
        if (removed) touched([parentId])
        return removed ? { ok: true, note: '' } : { ok: false, note: '目标主题已不存在，删除没有生效。' }
      }
      case 'move': {
        const moved = store.moveNode(intent.id, intent.targetId, intent.index ?? undefined)
        if (moved) touched([intent.id, intent.targetId])
        return moved ? { ok: true, note: '' } : { ok: false, note: '移动没有生效：目标位置不合法。' }
      }
      case 'moveMany': {
        // 批量移动：逐条落（每条都是一次 store.moveNode，都在同一步撤销里）。
        // 个别条目可能因为前面条目改变了结构而落空——如实把比例回喂给模型
        let movedCount = 0
        for (const move of intent.moves) {
          const moved = store.moveNode(move.id, move.targetId, move.index ?? undefined)
          if (moved) {
            movedCount += 1
            touched([move.id, move.targetId])
          }
        }
        if (movedCount === 0) return { ok: false, note: '一个都没有移动成功：目标位置可能不合法。' }
        return {
          ok: true,
          note: movedCount < intent.requested ? `成功 ${movedCount}/${intent.requested}，其余目标位置不合法` : ''
        }
      }
      case 'collapse':
        store.setCollapsed(intent.id, intent.collapsed)
        touched([intent.id])
        return { ok: true, note: '' }
      case 'notes':
        store.setNotes(intent.id, intent.text)
        touched([intent.id])
        return { ok: true, note: '' }
      case 'code':
        store.setCode(intent.id, intent.code)
        touched([intent.id])
        return { ok: true, note: '' }
      case 'formula':
        store.setFormula(intent.id, intent.formula)
        touched([intent.id])
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

    // 试用次数在主进程里涨的：回合结束后重新读一次，面板上的数字才不会落后
    refreshLicense()

    // 兜住「说改了、其实没落地」：本轮**零写操作**、但话里带着结果声明 → 如实标注。
    // 这类事故用户最难判断（画布没变，话却说得很确定），必须在气泡上戳破。
    const lastMsg = messagesRef.current[messagesRef.current.length - 1]
    if (
      writesAppliedRef.current === 0 &&
      lastMsg !== undefined &&
      lastMsg.role === 'assistant' &&
      claimsAppliedChange(lastMsg.content)
    ) {
      update((prev) => {
        const last = prev[prev.length - 1]
        if (!last || last.role !== 'assistant') return prev
        return [
          ...prev.slice(0, -1),
          {
            ...last,
            warning:
              writesFailedRef.current > 0
                ? `本轮没有任何改动落到画布上：${writesFailedRef.current} 个写操作都没成功（见上方「未执行」条目）。`
                : '本轮没有任何改动落到画布上——上面说的只是计划或说明，不是已经执行的改动。'
          }
        ]
      })
    }

    // 改完**看得见**：闪一下动过的节点，并把视口带到第一处改动。
    // 直接操作省掉了「预览确认」，信任全靠这一眼——没这一下，画布静悄悄地变了。
    const changed = [...new Set(changedIdsRef.current)]
    if (changed.length > 0) {
      viewportActions.flash(changed)
      // 等下一帧：布局要等这次写入渲染完才更新，立刻滚会滚到旧位置
      window.requestAnimationFrame(() => {
        const first = changed[0]
        if (first) viewportActions.ensureVisible(first)
      })
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

      // 同一回合里重复问同一件事：不重复执行（白烧配额，模型还会原地打转），
      // 直接把「问过了」告诉它，逼它换个策略
      const callKey = `${call.name}|${call.argumentsText}`
      if (seenCallsRef.current.has(callKey)) {
        pushToolResult(
          call,
          `（这个调用本回合已经执行过，结果见上面那条 ${call.name} 的返回。请换个关键词或换个分支再试，不要重复同一个调用。）`
        )
        noteAction(`跳过重复调用：${call.name}`, false)
        queue.index += 1
        step()
        return
      }
      seenCallsRef.current.add(callKey)

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
      if (applied.ok) writesAppliedRef.current += 1
      else writesFailedRef.current += 1
      const written = applied.ok ? `已执行：${plan.summary}${applied.note ? `（${applied.note}）` : ''}` : applied.note
      // 失败也要在面板上留一行痕迹：否则用户只在气泡里看到它"说要改"，
      // 却没有任何地方告诉他这一步**没执行**
      if (!applied.ok) noteAction(`未执行：${plan.summary}`, false)
      // 有些模型（qwen-plus 这类）一次回复只发**一个**工具调用：搬几十个节点要几十轮，
      // 用户感受就是「走一步推一步」。在工具结果里**就地**提醒它改用批量——
      // 比在系统提示词里讲一遍更贴近它当下的决策点
      const nudge =
        queue.calls.length === 1 && (call.name === 'moveTopic' || call.name === 'renameTopic')
          ? '（提示：剩下的同类操作请用 moveTopics 一次批量发出来——一次回复里可以包含多个工具调用，' +
            '也可以用一条 moveTopics 带很多项；不要一次只搬一个。）'
          : ''
      pushToolResult(call, written + nudge)
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
      if (applied.ok) writesAppliedRef.current += 1
      else writesFailedRef.current += 1
      pushToolResult(pending.call, applied.ok ? `已执行：${pending.summary}${applied.note ? `（${applied.note}）` : ''}` : applied.note)
      if (applied.ok) noteAction(pending.summary, true)
      else noteAction(`未执行：${pending.summary}`, false)
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
          toolNotes: [...(messagesRef.current[messagesRef.current.length - 1]?.toolNotes ?? []), gate.reason]
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

      // 有工具调用：把助手这一轮记进消息线（协议要求带上 tool_calls），然后逐个处理
      wireRef.current = [...wireRef.current, { role: 'assistant', content: event.content, toolCalls: calls }]
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
      .aiChatStream(requestId, wireRef.current, {
        useTools: useToolsRef.current && !forceNoToolsRef.current
      })
      .catch((error: unknown) => {
        // invoke 被拒（参数无效 / 没配 Key）：同样以事件形式收尾，只有一条代码路径。
        // 顺手剥掉 Electron 那层「Error invoking remote method …」包装，只留人话
        handleEvent({ requestId, kind: 'error', message: readableIpcError((error as Error).message) })
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

      // 用户这句话里提到的节点：应用先按标题匹配好（带句柄）——
      // 这样模型可以直接动手，不用反过来要求用户「先去画布上选中」
      const mentioned = new Map<string, { title: string; handle: string; path: string }>()
      for (const segment of segmentTitleMentions(text, titleIndex)) {
        const id = segment.topicId
        if (id === null) continue
        const topic = findTopic(root, id)
        const path = topicPathOf(root, id)
        if (topic && path) {
          mentioned.set(id, { title: topic.title, handle: shortHandleOf(id), path: path.join(' → ') })
        }
      }

      const system = buildChatSystemPrompt({
        skeleton: buildSkeletonDigest(root),
        selectedTitles,
        totalNodes: countTopicTree(root),
        sheetCount: state.workbook.sheets.length,
        // 能不能改，以主进程的许可判定为准：写工具没下发时，提示词也必须如实说
        canWrite: license?.canWrite ?? true,
        writeHint: license?.writeHint ?? null,
        // 上一轮实际做过的改动：不注入的话，用户说「继续」时模型会从零开始
        // 重新读取、重新规划——大导图上就是把同一种折腾重复一遍
        previousTurnNotes: messagesRef.current[messagesRef.current.length - 1]?.toolNotes ?? [],
        mentionedNodes: [...mentioned.values()].slice(0, 5)
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
      runRound()
    },
    [runRound, update, license, titleIndex]
  )

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    // isComposing：中文输入法回车选词时不能当作发送
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      send(draft)
    }
  }

  /**
   * 便捷粘贴：走主进程读剪贴板（比渲染层的 clipboard API 稳——无焦点/权限时会抛），
   * 插到光标处。Ctrl+V 本来就能用；这个按钮给的是「不想碰键盘」和「Ctrl+V 被别的
   * 程序占住」时的第二条路，多行文本照贴。
   */
  const pasteFromClipboard = (): void => {
    void window.api
      .readClipboardText()
      .then((text) => {
        const clip = text
          .replace(/\r\n?/g, '\n')
          .replace(/[ \t]+$/gm, '')
          .trim()
        if (clip.length === 0) {
          // 剪贴板里没有文字（多半是图片）——静悄悄没反应最容易被当成「功能坏了」
          setHint('剪贴板里没有文字。如果复制的是图片：聊天目前只能发文字，可以把图里的文字打出来，或直接问我。')
          return
        }
        const el = inputRef.current
        const start = el && el.selectionStart !== null ? el.selectionStart : draft.length
        const end = el && el.selectionEnd !== null ? el.selectionEnd : draft.length
        const next = draft.slice(0, start) + clip + draft.slice(end)
        setDraft(next)
        window.requestAnimationFrame(() => {
          if (el) {
            el.focus()
            el.setSelectionRange(start + clip.length, start + clip.length)
          }
        })
      })
      .catch(() => undefined)
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
        {license && (
          <span
            className={license.pro ? 'chat-panel__badge chat-panel__badge--pro' : 'chat-panel__badge'}
            title={
              license.pro
                ? `Pro${license.holder ? `（${license.holder}）` : ''}：AI 可以直接改画布`
                : `免费试用：还能让 AI 改 ${license.remaining} 次（只读聊天不限次）`
            }
          >
            {license.pro ? 'Pro' : `试用剩 ${license.remaining} 次`}
          </span>
        )}
        {sessionTokens > 0 && (
          <span className="chat-panel__badge" title="本次会话累计的 token 消耗（按服务商回报累计；清空对话时归零）">
            {formatTokenCount(sessionTokens)} tok
          </span>
        )}
        <div className="chat-panel__actions">
          <button
            type="button"
            className="tool-btn"
            title="清空对话"
            disabled={streaming || messages.length === 0}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              update(() => [])
              setSessionTokens(0)
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
                  {msg.role === 'user' ? (
                    msg.content
                  ) : (
                    <>
                      {/* 过程在上、结论在下：先看见它干了什么，AI 的回答压轴——
                          以前回答在最上面、被工具条目和上限提示压在下面，用户根本找不到「回复」在哪儿 */}
                      {msg.toolNotes && msg.toolNotes.length > 0 && (
                        <div className="chat-msg__tools">
                          {msg.toolNotes.map((note, index) => (
                            <span key={`${note}-${index}`} className="chat-msg__tool">
                              {note}
                            </span>
                          ))}
                        </div>
                      )}
                      {renderAssistantText(msg.content)}
                      {msg.warning && <div className="chat-msg__warning">{msg.warning}</div>}
                      {msg.usage && (
                        <div className="chat-msg__usage" title="按服务商回报统计（问 + 答），多轮工具调用已累计">
                          tokens {formatTokenCount(msg.usage.totalTokens)}（问{' '}
                          {msg.usage.promptTokens.toLocaleString()} · 答{' '}
                          {msg.usage.completionTokens.toLocaleString()}）
                        </div>
                      )}
                    </>
                  )}
                  {msg.aborted && <span className="chat-msg__stop">（已停止）</span>}
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

          {license && !license.canWrite && (
            <div className="chat-panel__limits">
              <div className="chat-panel__limits-text">
                <TriangleAlert size={14} />
                <span>{license.writeHint}</span>
              </div>
              {activateOpen ? (
                <div className="chat-panel__activate">
                  <textarea
                    value={licenseKey}
                    rows={3}
                    placeholder="把购买时拿到的许可码整串粘进来（可以带换行）"
                    onChange={(event) => setLicenseKey(event.target.value)}
                  />
                  {licenseMessage && <div className="chat-panel__activate-msg">{licenseMessage}</div>}
                  <div className="chat-panel__activate-actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setActivateOpen(false)
                        setLicenseMessage(null)
                      }}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={licenseKey.trim().length === 0}
                      onClick={() => {
                        void window.api.licenseActivate(licenseKey).then((result) => {
                          setLicense(result.view)
                          setLicenseMessage(result.message)
                          if (result.ok) {
                            setActivateOpen(false)
                            setLicenseKey('')
                          }
                        })
                      }}
                    >
                      激活
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="btn" onClick={() => setActivateOpen(true)}>
                  输入许可码
                </button>
              )}
            </div>
          )}

          {hint && <div className="chat-panel__activate-msg chat-panel__hint">{hint}</div>}

          <div className="chat-panel__input">
            <textarea
              ref={inputRef}
              value={draft}
              rows={2}
              placeholder={streaming ? 'AI 正在回答…' : '问点什么，Enter 发送（Shift+Enter 换行）'}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
            />
            <button
              type="button"
              className="btn"
              title="粘贴剪贴板文本（保留换行，粘到光标处）"
              disabled={streaming}
              onMouseDown={(e) => e.preventDefault()}
              onClick={pasteFromClipboard}
            >
              <ClipboardPaste size={14} />
            </button>
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
