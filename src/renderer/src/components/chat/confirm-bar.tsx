/**
 * 破坏性操作的确认条（自 ChatPanel.tsx 整块搬出，JSX 逐字未改）。
 */

import { TriangleAlert } from 'lucide-react'
import type { ReactElement } from 'react'
import type { PendingWrite } from './types'

interface Props {
  pendingWrite: PendingWrite
  /** 确认框里的「以后不再询问这类操作」 */
  rememberSkip: boolean
  onRememberSkipChange(value: boolean): void
  /** 用户表态：approve＝执行；remember＝勾了「不再询问」 */
  onResolve(approve: boolean, remember?: boolean): void
}

export default function ConfirmBar({
  pendingWrite,
  rememberSkip,
  onRememberSkipChange,
  onResolve
}: Props): ReactElement {
  return (
    <div className="chat-panel__confirm">
      <div className="chat-panel__confirm-text">
        <TriangleAlert size={14} />
        <span>{pendingWrite.summary}</span>
      </div>
      <label className="chat-panel__confirm-remember">
        <input
          type="checkbox"
          checked={rememberSkip}
          onChange={(event) => onRememberSkipChange(event.target.checked)}
        />
        <span>以后「{pendingWrite.label}」不再询问（可在 AI 设置里恢复）</span>
      </label>
      <div className="chat-panel__confirm-actions">
        <button type="button" className="btn" onClick={() => onResolve(false)}>
          跳过
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => onResolve(true, rememberSkip)}
        >
          执行
        </button>
      </div>
    </div>
  )
}
