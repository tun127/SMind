/**
 * AI 聊天面板头部（自 ChatPanel.tsx 整块搬出，JSX 逐字未改）。
 *
 * 许可徽标本身就是**激活入口**：点它直接跳到 AI 设置的许可区。
 * 以前输入框只在试用用完后才出现，想提前激活的人找不到地方。
 */

import { Bot, Eraser, Settings2, X } from 'lucide-react'
import type { ReactElement } from 'react'
import { formatTokenCount } from '@shared/ai'
import type { LicenseView } from '@shared/license'

interface Props {
  license: LicenseView | null
  /** 本次会话累计的 token 消耗（0 = 不显示徽标） */
  sessionTokens: number
  streaming: boolean
  /** 消息条数（0 = 「清空对话」不可点） */
  messagesLength: number
  onOpenSettings(): void
  onClose(): void
  onClear(): void
}

export default function ChatHeader({
  license,
  sessionTokens,
  streaming,
  messagesLength,
  onOpenSettings,
  onClose,
  onClear
}: Props): ReactElement {
  return (
    <div className="side-panel__header">
      <span className="chat-panel__title">
        <Bot size={15} />
        AI 助手
      </span>
      {license && (
        <button
          type="button"
          className={license.pro ? 'chat-panel__badge chat-panel__badge--pro' : 'chat-panel__badge'}
          title={
            license.pro
              ? `Pro${license.holder ? `（${license.holder}）` : ''}：AI 可以直接改画布（点击查看 / 取消激活）`
              : `免费试用：还能让 AI 改 ${license.remaining} 次（只读聊天不限次）。点击可查看许可、提前激活`
          }
          onMouseDown={(event) => event.preventDefault()}
          onClick={onOpenSettings}
        >
          {license.pro ? 'Pro' : `试用剩 ${license.remaining} 次`}
        </button>
      )}
      {sessionTokens > 0 && (
        <span
          className="chat-panel__badge"
          title="本次会话累计的 token 消耗（按服务商回报累计；清空对话时归零）"
        >
          {formatTokenCount(sessionTokens)} tok
        </span>
      )}
      <div className="chat-panel__actions">
        <button
          type="button"
          className="tool-btn"
          title="清空对话"
          disabled={streaming || messagesLength === 0}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClear}
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
  )
}
