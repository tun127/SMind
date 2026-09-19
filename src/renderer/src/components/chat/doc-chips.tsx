/**
 * 已挂上的文档条目（自 ChatPanel.tsx 整块搬出，JSX 逐字未改）。
 */

import { Paperclip, X } from 'lucide-react'
import type { ReactElement } from 'react'
import type { ChatDoc } from './types'

interface Props {
  docs: ChatDoc[]
  onRemove(name: string): void
}

export default function DocChips({ docs, onRemove }: Props): ReactElement {
  return (
    <div className="chat-panel__docs">
      {docs.map((doc) => (
        <span
          key={doc.name}
          className="chat-panel__doc"
          title={`${doc.text.length.toLocaleString()} 字 · 只在本次会话有效`}
        >
          <Paperclip size={11} />
          {doc.name}
          <button
            type="button"
            className="chat-panel__doc-remove"
            title="移除这份文档"
            onClick={() => onRemove(doc.name)}
          >
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  )
}
