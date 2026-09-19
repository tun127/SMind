/**
 * 一条助手消息里的工具条目（自 ChatPanel.tsx 原样搬出）。
 */

import type { ReactElement } from 'react'

export default function ToolNotes({ notes }: { notes: string[] }): ReactElement {
  return (
    <div className="chat-msg__tools">
      {notes.map((note, index) => (
        <span
          key={`${note}-${index}`}
          className={
            note.startsWith('💬') ? 'chat-msg__tool chat-msg__tool--note' : 'chat-msg__tool'
          }
        >
          {note}
        </span>
      ))}
    </div>
  )
}
