/**
 * 回合运行时：**装配点**。把「写意图执行」与「工具队列推进」两块拼起来，
 * 并保留它们共享的三个回合级动作（`setPending` / `skipConfirmFor` / `commitTurn`）。
 *
 * A6-4 把原来的 636 行拆成三个模块（函数体全部**逐字搬移**，只有 deps 的传递方式变了）：
 *   - `write-intent-runtime.ts` 写意图执行（`pushToolResult` / `compressExecutedCallArgs` /
 *     `noteAction` / `applyWriteIntent`）；
 *   - `tool-queue.ts` 队列推进（`processQueue`）；
 *   - 本文件 装配 + `setPending` + `skipConfirmFor` + `commitTurn`。
 *
 * **为什么仍然是普通工厂函数、而不是一个 hook**（继承 A6-3 的理由，一字未改）：
 * `handleEvent` 的依赖数组是 `[update, dumpDiag]`，而订阅流式事件的 effect 依赖数组是
 * `[handleEvent]`，那个 effect 的 cleanup 会调 `stopRef.current()` + `commitTurnRef.current()`——
 * **一旦 `handleEvent` 每次渲染都换身份，订阅 effect 就会重跑，cleanup 会把正在跑的
 * AI 回合掐掉**。所以工厂不是 hook、不持有状态、也不参与 React 的依赖比较：
 * hook 每次渲染调用一次、拿回一批「每渲染重建」的函数，重建时机与搬迁前完全相同。
 * （三个模块里都**没有**任何 `use*` 调用 → 不会改变 hook 的 effect 数量与顺序。）
 *
 * **调用点与返回面不变**：`use-chat-loop.ts` 里仍然只有一次 `createTurnRuntime({...})`，
 * 解构出的 7 个名字与 A6-3 逐字一致 → 本批 `use-chat-loop.ts` **0 行改动**。
 */

import type { RefObject } from 'react'
import { claimsAppliedChange, type AiMessage, type ToolCall } from '@shared/ai'
import { DESTRUCTIVE_WRITE_LABELS, isDestructiveWriteKind, type WriteIntent } from '@shared/agent'
import { keepDiagArmed, reportCosts } from '../../dev/stage'
import { viewportActions } from '../../render/viewport'
import { useEditor } from '../../store/editor'
import type { ChatDoc, ChatMsg, ChatPlan, PendingWrite } from './types'
import { createWriteIntentRuntime } from './write-intent-runtime'
import { createToolQueue } from './tool-queue'

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
   * A6-3 的教训：主 agent 用的区间依赖分析脚本只把「2 空格缩进的 const/let/function」
   * 当成宿主作用域名字，因此漏掉了这三个（它给出的 19 个字段是**不完整的**）；
   * 漏掉的直接后果是 `TS2304 Cannot find name`。
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

  /* ---- 写意图执行：整块在 chat/write-intent-runtime.ts（本文件只装配） ---- */
  const { pushToolResult, compressExecutedCallArgs, noteAction, applyWriteIntent } =
    createWriteIntentRuntime({
      changedIdsRef,
      turnStartedRef,
      wireRef,
      writeLogRef,
      update,
      onBeforeAiWrite
    })

  /* ---- 回合级动作：写意图执行与队列推进都要用（留在装配点上） ---- */

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

  /* ---- 队列推进：整块在 chat/tool-queue.ts（本文件只装配） ---- */
  const { processQueue } = createToolQueue({
    queueRef,
    requestIdRef,
    runRoundRef,
    seenCallsRef,
    writesAppliedRef,
    writesFailedRef,
    docsRef,
    dumpDiag,
    update,
    setActivity,
    setPlan,
    setStreaming,
    pushToolResult,
    compressExecutedCallArgs,
    noteAction,
    applyWriteIntent,
    setPending,
    commitTurn,
    skipConfirmFor
  })

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
