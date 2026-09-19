/**
 * 工具执行 / 回合收尾（自 `chat/use-chat-loop.ts` 整块搬出，**函数体逐字未改**）。
 *
 * 这一批搬走四段（括号里是原 `use-chat-loop.ts` 的行范围与行数）：
 * - R1 255-285（31）：`pushToolResult` + `compressExecutedCallArgs`；
 * - R2 324-493（170）：`noteAction` + `applyWriteIntent`；
 * - R3 495-601（107）：`setPending` + `skipConfirmFor` + `commitTurn`；
 * - R4 603-796（194）：`processQueue`。
 * 连 R1 上面那三行「工具执行」段头注释也一起带了过来——它描述的就是这批代码，
 * 留在 hook 里会变成一段悬空注释。
 *
 * **为什么是普通工厂函数、而不是一个 hook**：`handleEvent` 的依赖数组是
 * `[update, dumpDiag]`，而订阅流式事件的 effect 依赖数组是 `[handleEvent]`，
 * 那个 effect 的 cleanup 会调 `stopRef.current()` + `commitTurnRef.current()`——
 * **一旦 `handleEvent` 每次渲染都换身份，订阅 effect 就会重跑，cleanup 会把正在跑的
 * AI 回合掐掉**。所以 `update` 与 `dumpDiag` 必须留在 hook 里、仍旧是 `useCallback`，
 * 依赖数组一字不改：`handleEvent` 的身份变化时机才与搬迁前一致。
 *
 * **身份语义为什么等价**：被搬走的这 7 个函数在搬迁前**本来就是每次渲染重建的普通
 * `const`**（不是 `useCallback`）。本工厂不是 hook、不持有任何状态、也不参与 React 的
 * 依赖比较——「每次渲染调用一次工厂、把 7 个新函数拿回来」之后，它们依旧是每次渲染
 * 换新身份，重建时机与搬迁前完全相同。deps 对象每次渲染都是新字面量，但它只作为
 * 一次普通函数调用的实参传递，不会被任何 `useCallback` / `useEffect` 的依赖数组持有。
 *
 * **留在 hook 不搬的**：`update` / `dumpDiag`（见上）、`resolvePending`（用户点头后
 * 从断点继续，是 `useCallback(..., [])` 且要读 `pendingRef` 与 `patchAppSettings`）、
 * `handleEvent` / `runRound` / `send` / `stop` / `clearChat`，以及全部 state / ref 声明。
 */

import type { RefObject } from 'react'
import { claimsAppliedChange, type AiMessage, type ToolCall } from '@shared/ai'
import {
  DESTRUCTIVE_WRITE_LABELS,
  isDestructiveWriteKind,
  isMutatingIntent,
  isReadToolName,
  planWriteTool,
  runReadTool,
  type ToolContext,
  type WriteIntent
} from '@shared/agent'
import { activeRoot, activeSheet, ancestorsOf, findTopic } from '@shared/model/tree'
import { beginCost, keepDiagArmed, reportCosts, setStage } from '../../dev/stage'
import { viewportActions } from '../../render/viewport'
import { useEditor } from '../../store/editor'
import { exportFormatOf } from './format'
import type { ChatDoc, ChatMsg, ChatPlan, PendingWrite } from './types'

/** 工厂需要的全部外部依赖（显式传进来，函数体内用解构还原原局部名） */
export interface TurnRuntimeDeps {
  changedIdsRef: RefObject<string[]>
  messagesRef: RefObject<ChatMsg[]>
  pendingRef: RefObject<{ call: ToolCall; intent: WriteIntent; summary: string } | null>
  queueRef: RefObject<{ calls: ToolCall[]; index: number } | null>
  requestIdRef: RefObject<string | null>
  runRoundRef: RefObject<() => void>
  seenCallsRef: RefObject<Set<string>>
  turnStartedRef: RefObject<boolean>
  wireRef: RefObject<AiMessage[]>
  writeLogRef: RefObject<string[]>
  writesAppliedRef: RefObject<number>
  writesFailedRef: RefObject<number>
  dumpDiag(reason: string, force?: boolean): void
  update(updater: (prev: ChatMsg[]) => ChatMsg[]): void
  setActivity(value: string): void
  setPendingWrite(value: PendingWrite | null): void
  setPlan(value: ChatPlan | null): void
  setRememberSkip(value: boolean): void
  setStreaming(value: boolean): void
  /**
   * 下面三个是 `useChatLoop({...}: LoopInput)` 的**解构入参**——它们既不在 hook 的
   * 局部作用域里，也不随代码搬走，必须显式传进来。
   *
   * 主 agent 用的区间依赖分析脚本只把「2 空格缩进的 const/let/function」当成宿主作用域
   * 名字，因此漏掉了这三个（它给出的 19 个字段是**不完整的**）；漏掉的直接后果是
   * `TS2304 Cannot find name`。
   */
  docsRef: RefObject<ChatDoc[]>
  onBeforeAiWrite(): void
  refreshLicense(): void
}

export function createTurnRuntime(deps: TurnRuntimeDeps): {
  pushToolResult(call: ToolCall, content: string): void
  compressExecutedCallArgs(callId: string): void
  noteAction(summary: string, counts: boolean): void
  applyWriteIntent(intent: WriteIntent): { ok: boolean; note: string }
  setPending(value: { call: ToolCall; intent: WriteIntent; summary: string } | null): void
  commitTurn(): void
  processQueue(): void
} {
  const {
    changedIdsRef,
    messagesRef,
    pendingRef,
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
    setPendingWrite,
    setPlan,
    setRememberSkip,
    setStreaming,
    docsRef,
    onBeforeAiWrite,
    refreshLicense
  } = deps

  /* ------------------------------------------------------------------ */
  /* 工具执行                                                            */
  /* ------------------------------------------------------------------ */

  /** 往消息线里塞一条工具结果（模型下一轮就看得到） */
  const pushToolResult = (call: ToolCall, content: string): void => {
    wireRef.current = [...wireRef.current, { role: 'tool', toolCallId: call.id, content }]
  }

  /**
   * 已成功执行的调用：把消息线里它的完整参数压成短摘要。
   *
   * 轮内每执行完一个调用就把**整条消息线**原样重发给模型——setCode 的整段代码、
   * insertSubtree 的整段大纲全都原样带着。几十个调用就能把单轮提示词撑到
   * 60k+ token，光让服务端读一遍就要一两分钟：UI 没死，但像死了（实测单轮往返 125s）。
   * 执行结果已经在对应的 tool 消息里，参数本体对后续轮次没有用处；
   * 保留开头一段是为万一模型想引用自己刚才写的内容时还有个抓手。
   */
  const compressExecutedCallArgs = (callId: string): void => {
    const HEAD = 200
    wireRef.current = wireRef.current.map((msg) => {
      if (msg.role !== 'assistant' || !msg.toolCalls?.some((c) => c.id === callId)) return msg
      return {
        ...msg,
        toolCalls: msg.toolCalls.map((c) =>
          c.id === callId && c.argumentsText.length > HEAD
            ? {
                ...c,
                argumentsText: `${c.argumentsText.slice(0, HEAD)}…（此调用已成功执行，参数其余部分省略；执行结果见下方对应的工具消息）`
              }
            : c
        )
      }
    })
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
      for (const id of ids)
        if (typeof id === 'string' && id.length > 0) changedIdsRef.current.push(id)
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
        touched([
          intent.id,
          ...(after?.children ?? []).filter((child) => !before.has(child.id)).map((c) => c.id)
        ])
        return { ok: true, note: '' }
      }
      case 'delete': {
        // 被删的节点已经没了、闪不了，就闪它的父级——用户至少知道「这一片被动过」
        const chain = ancestorsOf(activeRoot(store.workbook), intent.id)
        const parentId = chain[chain.length - 1]
        const removed = store.deleteTopic(intent.id)
        if (removed) touched([parentId])
        return removed
          ? { ok: true, note: '' }
          : { ok: false, note: '目标主题已不存在，删除没有生效。' }
      }
      case 'move': {
        const moved = store.moveNode(intent.id, intent.targetId, intent.index ?? undefined)
        if (moved) touched([intent.id, intent.targetId])
        return moved
          ? { ok: true, note: '' }
          : { ok: false, note: '移动没有生效：目标位置不合法。' }
      }
      case 'moveMany': {
        // 批量移动：一次写入落完（都在同一步撤销里）。逐条调 moveNode 时，
        // 每条都要扫一遍全树清失效的边界/概要——一次最多 200 条就是 200 遍全树，
        // 终态一样但成本差一个数量级。
        // 个别条目可能因为前面条目改变了结构而落空——如实把比例回喂给模型
        const appliedMoves = store.moveNodes(intent.moves)
        for (const move of appliedMoves) touched([move.id, move.targetId])
        const movedCount = appliedMoves.length
        if (movedCount === 0) return { ok: false, note: '一个都没有移动成功：目标位置可能不合法。' }
        return {
          ok: true,
          note:
            movedCount < intent.requested
              ? `成功 ${movedCount}/${intent.requested}，其余目标位置不合法`
              : ''
        }
      }
      case 'collapse':
        // 带 side = 平衡图中心主题的「按侧收起」（幂等设置值，重试不会来回翻）
        if (intent.side) store.setFoldSide(intent.id, intent.side, intent.collapsed)
        else store.setCollapsed(intent.id, intent.collapsed)
        touched([intent.id])
        return { ok: true, note: '' }
      case 'structure':
        // 结构是整张画布的属性：只改中心主题（intent.id 由规划层保证就是根节点）
        store.setStructure(intent.structureClass)
        touched([intent.id])
        return { ok: true, note: '' }
      case 'sortChildren': {
        store.sortChildren(intent.id, intent.orderedIds, intent.renumber)
        touched([intent.id, ...intent.orderedIds])
        return { ok: true, note: intent.renumber ? '顺序与编号都已更新' : '顺序已更新' }
      }
      case 'dedupe': {
        const merged = store.mergeTopics(intent.groups)
        if (merged === 0) return { ok: false, note: '没有可合并的（组内可能存在父子包含关系）。' }
        touched(intent.groups.map((group) => group.keepId))
        return { ok: true, note: `共删除 ${merged} 个重复节点` }
      }
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
      /* ---- 第二批：画布元素（关系线 / 边界 / 概要）与标记、标签 ---- */
      case 'relationship': {
        const created = store.connectTopics(intent.ends[0], intent.ends[1])
        if (!created) return { ok: false, note: '连关系线没有生效：两端主题可能已不存在。' }
        if (intent.title !== null) store.setRelationshipTitle(created, intent.title)
        touched([intent.ends[0], intent.ends[1]])
        return { ok: true, note: '' }
      }
      case 'boundary': {
        const created = store.addBoundaryFor(intent.topicIds, intent.title ?? undefined)
        if (!created) return { ok: false, note: '这些主题不是同级相邻，圈不成一个范围。' }
        touched(intent.topicIds)
        return { ok: true, note: '' }
      }
      case 'summary': {
        const created = store.addSummaryFor(intent.topicIds, intent.title ?? undefined)
        if (!created) return { ok: false, note: '这些主题不是同级相邻，加不了概要。' }
        touched(intent.topicIds)
        return { ok: true, note: '' }
      }
      case 'attachmentTitle':
        if (intent.target === 'relationship') store.setRelationshipTitle(intent.id, intent.title)
        else if (intent.target === 'boundary') store.setBoundaryTitle(intent.id, intent.title)
        else store.setSummaryTitle(intent.id, intent.title)
        return { ok: true, note: '' }
      case 'attachmentRemove':
        if (intent.target === 'relationship') store.removeRelationship(intent.id)
        else if (intent.target === 'boundary') store.removeBoundary(intent.id)
        else store.removeSummary(intent.id)
        return { ok: true, note: '' }
      case 'markers':
        store.setMarkers(intent.id, intent.markerIds)
        touched([intent.id])
        return { ok: true, note: '' }
      case 'label':
        if (intent.add) store.addLabel(intent.id, intent.label)
        else store.removeLabel(intent.id, intent.label)
        touched([intent.id])
        return { ok: true, note: '' }
      case 'ask':
        return { ok: true, note: '' }
      default:
        return { ok: false, note: '未知操作。' }
    }
  }

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

  /**
   * 这次破坏性操作是否已被用户「不再询问」？
   *
   * 从 store **现读**，不用组件里的值：一个回合里的写操作是在同一次回调里连续跑完的，
   * 用闭包里的旧值会让「刚勾过不再询问」在本回合内不生效。
   */
  const skipConfirmFor = (kind: WriteIntent['kind']): boolean =>
    useEditor.getState().appSettings.aiConfirmSkip.includes(kind)

  /** 结束本轮：把 AI 的改动并成一步撤销，并把「改了什么」留在气泡里 */
  const commitTurn = (): void => {
    /**
     * 回合收尾先落一行**耗时归属**——这一行直接回答「刚才这十几秒花在哪了」。
     * 例如：`AI 回合结束：画布布局×12 共 3400ms(最慢 900) · 应用写意图×12 共 210ms(最慢 30)
     * · 代码块渲染×288 · 代码块 span 共 45 万`。
     */
    reportCosts('AI 回合结束')
    // 不关：实测冻结发生在**回合结束后用户开始滚动画布**那一段（写入侧只用了几毫秒），
    // 关掉就等于把唯一能取证的两分钟丢掉了
    keepDiagArmed(120_000)
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
      const text = log.length > 6 ? `${log.slice(0, 6).join('；')}…` : log.join('；')
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
          {
            ...last,
            content: `${last.content}\n\n——\n已改动：${text}（共 ${log.length} 处）\n${undoLine}`
          }
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
    /**
     * 让出一帧再处理下一个调用。
     *
     * 以前这里是**同步递归**（`queue.index += 1; step()`）：模型一次批量发几十个调用时，
     * 全部画布写入 + 重排会在一次调用栈里跑完，渲染进程的主线程几分钟不回——
     * 表现就是「卡死了，点击任何键都没反应、关也关不掉」（真事）。
     * 让出一帧后，界面能持续重绘、Esc 与「停止」也能真正生效。
     */
    const yieldThen = (): void => {
      window.setTimeout(step, 0)
    }
    function step(): void {
      const queue = queueRef.current
      if (!queue) return
      const call = queue.calls[queue.index]
      if (!call) {
        queueRef.current = null
        runRoundRef.current()
        return
      }
      setStage(`执行工具 ${call.name}`)

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
        yieldThen()
        return
      }
      seenCallsRef.current.add(callKey)

      if (isReadToolName(call.name)) {
        const state = useEditor.getState()
        const context: ToolContext = {
          root: activeRoot(state.workbook),
          selectedId: state.selection[0] ?? null,
          sheetCount: state.workbook.sheets.length,
          // 第二批工具（关系线/边界/概要）挂在画布上，不在主题树里
          sheet: activeSheet(state.workbook),
          // 挂在这个会话上的文档：readDocument 工具靠它把文档变成可问答的上下文
          documents: docsRef.current
        }
        setActivity(`正在翻看导图…（${queue.index + 1}/${queue.calls.length}）`)
        /**
         * 导出大纲：要弹系统的「保存到…」对话框，属于**宿主动作**（纯逻辑层做不了），
         * 所以在这里执行；结果如实回喂——用户可能在对话框里点了取消。
         * 队列在这里暂停（`index` 在 finally 里才前进）：对话没选完就继续跑别的事会很怪。
         */
        if (call.name === 'exportOutline') {
          const format = exportFormatOf(call.argumentsText)
          setActivity('等待你选择保存位置…')
          void window.api
            .exportOutline(useEditor.getState().workbook, format)
            .then((path) => {
              pushToolResult(
                call,
                path ? `已导出到：${path}` : '用户在保存对话框里取消了，没有导出。'
              )
              noteAction(path ? `已导出大纲（${format}）` : '导出被取消', Boolean(path))
            })
            .catch((error: unknown) => {
              pushToolResult(call, `导出失败：${(error as Error).message}`)
              noteAction('导出大纲失败', false)
            })
            .finally(() => {
              queue.index += 1
              yieldThen()
            })
          return
        }
        /**
         * 计划工具：把它的产物**显示出来**。
         * 解析参数（steps / done）而不是去猜回显文字——参数才是模型的原始意图。
         */
        if (call.name === 'updatePlan') {
          try {
            const parsed = JSON.parse(call.argumentsText) as { steps?: unknown; done?: unknown }
            const steps = Array.isArray(parsed.steps)
              ? parsed.steps.filter(
                  (step): step is string => typeof step === 'string' && step.trim().length > 0
                )
              : []
            if (steps.length > 0) {
              const rawDone =
                typeof parsed.done === 'number' && Number.isFinite(parsed.done) ? parsed.done : 0
              setPlan({
                steps,
                done: Math.max(0, Math.min(steps.length, Math.round(rawDone)))
              })
            }
          } catch {
            /* 参数不是合法 JSON：工具会把错误回喂给模型，这里不额外处理 */
          }
        }
        const result = runReadTool(call.name, call.argumentsText, context)
        pushToolResult(call, result.content)
        noteAction(result.summary, false)
        queue.index += 1
        yieldThen()
        return
      }

      const plan = planWriteTool(
        call.name,
        call.argumentsText,
        activeRoot(useEditor.getState().workbook)
      )
      if (!plan.ok) {
        // 规划失败：把原因回喂给模型让它自己纠正，不打断整轮
        pushToolResult(call, plan.error)
        noteAction(plan.summary, false)
        queue.index += 1
        yieldThen()
        return
      }

      if (plan.intent.kind === 'ask') {
        // 模型主动提问：呈现问题、本轮到此为止（等用户回答）
        queueRef.current = null
        update((prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          const options =
            plan.intent.kind === 'ask' && plan.intent.options.length > 0
              ? `\n可选：${plan.intent.options.join(' / ')}`
              : ''
          return [
            ...prev.slice(0, -1),
            {
              ...last,
              content: `${last.content}\n\n${plan.intent.kind === 'ask' ? plan.intent.question : ''}${options}`
            }
          ]
        })
        requestIdRef.current = null
        setStreaming(false)
        commitTurn()
        return
      }

      if (plan.destructive && !skipConfirmFor(plan.intent.kind)) {
        // 破坏性操作：停下来等用户点头（这一步就是「确认分级」）
        // 用户勾过「不再询问这类操作」时直接执行——但**第一次一定要问**
        setPending({ call, intent: plan.intent, summary: plan.summary })
        return
      }

      setActivity(`正在改画布…（${queue.index + 1}/${queue.calls.length}）`)
      // 进这一阶段先落一行：真卡死时它就是日志里最后一条（案发现场）
      const endWrite = beginCost('应用写意图', plan.intent.kind)
      const applied = applyWriteIntent(plan.intent)
      endWrite()
      // 强制转储：冻结就发生在某次应用之后的渲染里，这份就是「案发前的最后现场」
      dumpDiag(`已应用 ${plan.intent.kind}（${queue.index + 1}/${queue.calls.length}）`, true)
      if (applied.ok) writesAppliedRef.current += 1
      else writesFailedRef.current += 1
      const written = applied.ok
        ? `已执行：${plan.summary}${applied.note ? `（${applied.note}）` : ''}`
        : applied.note
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
      if (applied.ok) {
        noteAction(plan.summary, true)
        compressExecutedCallArgs(call.id)
      }
      queue.index += 1
      yieldThen()
    }

    step()
  }

  return {
    pushToolResult,
    compressExecutedCallArgs,
    noteAction,
    applyWriteIntent,
    setPending,
    commitTurn,
    processQueue
  }
}
