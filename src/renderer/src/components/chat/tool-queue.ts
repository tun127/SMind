/**
 * 工具队列推进：依次执行这一轮的每一个工具调用。
 *
 * A6-4 从 `chat/turn-runtime.ts` **整块搬出**（原文件 L432-L625，194 行，**函数体逐字未改**）：
 * `processQueue`。
 *
 * **为什么拆出来（A6-4 配方①）**：它是"一次只处理一个调用"的调度器——破坏性操作要在
 * 中间停下来问用户、用户点头后再从断点继续。它本身不持有状态，只通过显式入参使用
 * 「写意图执行」的四个函数与 `setPending` / `commitTurn` / `skipConfirmFor`，
 * 与 `handleEvent` 之间没有互引（A6-3 之后已无 ref 环）。
 *
 * **必须原样保留的两条性质**：
 * ① `yieldThen` = `window.setTimeout(step, 0)`：让出一帧再处理下一个调用。同步递归会让
 *    「模型一次批量发几十个调用」把主线程锁死几分钟（真事），这一行是唯一的保障；
 * ② `setStage` / `dumpDiag(..., true)` 的调用点：它们是卡死取证的现场标记，位置不能挪。
 */

import type { RefObject } from 'react'
import type { ToolCall } from '@shared/ai'
import {
  isReadToolName,
  planWriteTool,
  runReadTool,
  type ToolContext,
  type WriteIntent
} from '@shared/agent'
import { activeRoot, activeSheet } from '@shared/model/tree'
import { beginCost, setStage } from '../../dev/stage'
import { useEditor } from '../../store/editor'
import { exportFormatOf } from './format'
import type { ChatDoc, ChatMsg, ChatPlan } from './types'

/** 本模块需要的全部外部依赖（显式传进来，函数体内用解构还原原局部名） */
export interface ToolQueueDeps {
  queueRef: RefObject<{ calls: ToolCall[]; index: number } | null>
  requestIdRef: RefObject<string | null>
  runRoundRef: RefObject<() => void>
  seenCallsRef: RefObject<Set<string>>
  writesAppliedRef: RefObject<number>
  writesFailedRef: RefObject<number>
  /** 挂在这个会话上的文档：readDocument 工具靠它把文档变成可问答的上下文 */
  docsRef: RefObject<ChatDoc[]>
  dumpDiag(reason: string, force?: boolean): void
  update(updater: (prev: ChatMsg[]) => ChatMsg[]): void
  setActivity(value: string): void
  setPlan(value: ChatPlan | null): void
  setStreaming(value: boolean): void
  /** 「写意图执行」模块的四个函数（原样透传；身份每渲染重建，与搬迁前一致） */
  pushToolResult(call: ToolCall, content: string): void
  compressExecutedCallArgs(callId: string): void
  noteAction(summary: string, counts: boolean): void
  applyWriteIntent(intent: WriteIntent): { ok: boolean; note: string }
  /** 回合内的两个动作与一个判定（仍在 `turn-runtime.ts`） */
  setPending(value: { call: ToolCall; intent: WriteIntent; summary: string } | null): void
  commitTurn(): void
  skipConfirmFor(kind: WriteIntent['kind']): boolean
}

export function createToolQueue(deps: ToolQueueDeps): { processQueue(): void } {
  const {
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
  } = deps

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

  return { processQueue }
}
