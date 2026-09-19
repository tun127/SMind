/**
 * AI 聊天面板的消息列表（自 ChatPanel.tsx 整块搬出，JSX 逐字未改）。
 *
 * 只有两处按 §3.2 配方换成了子组件：助手正文的节点引用 → `TitleRefs`，
 * 工具条目 → `ToolNotes`（两者都只是在原地多一层 Fragment，DOM 不变）。
 */

import { Sparkles } from 'lucide-react'
import type { ReactElement, RefObject } from 'react'
import { formatTokenCount } from '@shared/ai'
import type { buildTitleIndex } from '@shared/agent'
import TitleRefs from './title-refs'
import ToolNotes from './tool-notes'
import type { ChatMsg, ChatPlan } from './types'

interface Props {
  messages: ChatMsg[]
  plan: ChatPlan | null
  streaming: boolean
  activity: string
  listRef: RefObject<HTMLDivElement | null>
  titleIndex: ReturnType<typeof buildTitleIndex>
  /** 点击回复里的节点引用时在画布上定位 */
  onGoToNode(topicId: string): void
}

export default function MessageList({
  messages,
  plan,
  streaming,
  activity,
  listRef,
  titleIndex,
  onGoToNode
}: Props): ReactElement {
  return (
    <div className="chat-panel__list" ref={listRef}>
      {messages.length === 0 && (
        <div className="chat-panel__hint">
          <Sparkles size={16} />
          <p>
            用自然语言聊这页导图，也可以直接让它改图。
            <br />
            它会自己翻看结构；删分支这类操作会<strong>先问你</strong>， 改完按一次{' '}
            <strong>Ctrl+Z</strong> 可以整体撤销。
          </p>
        </div>
      )}
      {messages.map((msg, index) => (
        <div key={msg.id} className={msg.role === 'user' ? 'chat-msg chat-msg--user' : 'chat-msg'}>
          <div className="chat-msg__bubble">
            {msg.role === 'user' ? (
              msg.content
            ) : (
              <>
                {/* 执行计划：挂在最后一条助手消息上（一个回合一份，回合结束仍留着可回看） */}
                {plan && index === messages.length - 1 && (
                  <div className="chat-plan">
                    <div className="chat-plan__head">
                      执行计划（{plan.done}/{plan.steps.length}）
                    </div>
                    <ol className="chat-plan__list">
                      {plan.steps.map((step, stepIndex) => (
                        <li
                          key={`${stepIndex}-${step}`}
                          className={
                            stepIndex < plan.done
                              ? 'chat-plan__item chat-plan__item--done'
                              : stepIndex === plan.done
                                ? 'chat-plan__item chat-plan__item--current'
                                : 'chat-plan__item'
                          }
                        >
                          {stepIndex < plan.done ? '✓' : stepIndex === plan.done ? '▶' : '·'} {step}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                {/* 过程在上、结论在下：先看见它干了什么，AI 的回答压轴——
                    以前回答在最上面、被工具条目和上限提示压在下面，用户根本找不到「回复」在哪儿 */}
                {msg.toolNotes && msg.toolNotes.length > 0 && <ToolNotes notes={msg.toolNotes} />}
                {msg.thinking && msg.thinking.trim().length > 0 && (
                  /**
                   * 思维链展示（对齐 DeepSeek 网页的体验）：
                   * 思考中 → 展开直播；正文一开始 → 自动收起成一行，可点开回看。
                   */
                  <details
                    className="chat-think"
                    open={
                      streaming &&
                      msg.id === messages[messages.length - 1]?.id &&
                      msg.content.trim().length === 0
                    }
                  >
                    <summary className="chat-think__summary">
                      {streaming &&
                      msg.id === messages[messages.length - 1]?.id &&
                      msg.content.trim().length === 0
                        ? '思考中…（展开看过程）'
                        : '已深度思考（点击展开）'}
                    </summary>
                    <div className="chat-think__body">{msg.thinking}</div>
                  </details>
                )}
                <TitleRefs content={msg.content} titleIndex={titleIndex} onGoToNode={onGoToNode} />
                {msg.warning && <div className="chat-msg__warning">{msg.warning}</div>}
                {msg.usage && (
                  <div
                    className="chat-msg__usage"
                    title="按服务商回报统计（问 + 答），多轮工具调用已累计"
                  >
                    tokens {formatTokenCount(msg.usage.totalTokens)}（问{' '}
                    {msg.usage.promptTokens.toLocaleString()} · 答{' '}
                    {msg.usage.completionTokens.toLocaleString()}）
                  </div>
                )}
              </>
            )}
            {/* 还在写：末尾一个闪烁光标，一眼看出「这条还没完」 */}
            {streaming &&
              msg.role === 'assistant' &&
              msg.id === messages[messages.length - 1]?.id && (
                <span className="chat-msg__caret" aria-hidden="true" />
              )}
            {msg.aborted && <span className="chat-msg__stop">（已停止）</span>}
          </div>
        </div>
      ))}

      {/* 正在工作：转圈 + 一行说明。
          没有它的时候，用户盯着一屏工具条目分不清「它还在想」和「已经答完了」 */}
      {streaming && (
        <div className="chat-thinking" role="status" aria-live="polite">
          <span className="chat-thinking__spinner" aria-hidden="true" />
          <span>{activity || '正在思考…'}</span>
        </div>
      )}
    </div>
  )
}
