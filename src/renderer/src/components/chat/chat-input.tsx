/**
 * 输入区（自 ChatPanel.tsx 整块搬出，JSX 逐字未改）。
 *
 * 功能按钮在输入框**下方**独立一行：输入区更大，文字不再和按钮挤在一起。
 * 窄面板装不下时右侧按钮组整组换行，不会把「发送」挤出可视区。
 */

import { ClipboardPaste, Paperclip, Send, Square } from 'lucide-react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, RefObject } from 'react'
import { normalizeQualityTier, QUALITY_TIERS, type QualityTier } from '@shared/ai'

interface Props {
  draft: string
  setDraft(value: string): void
  inputRef: RefObject<HTMLTextAreaElement | null>
  streaming: boolean
  tier: QualityTier
  onKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void
  /** 粘进来的是图片时提示一句（textarea 会静默什么都不发生） */
  onImagePaste(): void
  onChangeTier(next: QualityTier): void
  onPickDocument(): void
  onPasteFromClipboard(): void
  onStop(): void
  onSend(): void
}

export default function ChatInput({
  draft,
  setDraft,
  inputRef,
  streaming,
  tier,
  onKeyDown,
  onImagePaste,
  onChangeTier,
  onPickDocument,
  onPasteFromClipboard,
  onStop,
  onSend
}: Props): ReactElement {
  return (
    <div className="chat-panel__input">
      <textarea
        ref={inputRef}
        value={draft}
        rows={4}
        title="Enter 发送 · Shift+Enter 换行"
        placeholder={streaming ? 'AI 正在回答…' : '问点什么，Enter 发送'}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          // 粘进来的是图片（截图）：textarea 会静默什么都不发生，用户只会觉得「粘贴坏了」。
          // 明确说一句，并告诉他图片该粘到哪儿。
          const data = event.clipboardData
          const hasImage = Array.from(data.items).some((item) => item.type.startsWith('image/'))
          if (hasImage && data.getData('text/plain').trim().length === 0) {
            event.preventDefault()
            onImagePaste()
          }
        }}
      />
      {/* 功能按钮移到输入框**下方**独立一行：输入区更大，文字不再和按钮挤在一起 */}
      <div className="chat-panel__input-actions">
        <label
          className="chat-panel__tier"
          title={
            (QUALITY_TIERS.find((item) => item.id === tier)?.hint ?? '') +
            '。档位只改「要求的规模与深度」，不改单次输出上限；下一轮请求立即生效'
          }
        >
          <span>思考强度</span>
          <select
            value={tier}
            disabled={streaming}
            onChange={(event) => onChangeTier(normalizeQualityTier(event.target.value))}
          >
            {QUALITY_TIERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {/* 右侧按钮组：窄面板装不下时整组换行，不会把「发送」挤出可视区 */}
        <div className="chat-panel__input-right">
          <button
            type="button"
            className="btn"
            title="挂一份文档（docx / xlsx / pptx / md / txt / csv …）：挂上后可以直接问它里面的内容。也可以直接把文件拖到这里"
            disabled={streaming}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onPickDocument}
          >
            <Paperclip size={14} />
          </button>
          <button
            type="button"
            className="btn"
            title="粘贴剪贴板文本（保留换行，粘到光标处）"
            disabled={streaming}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onPasteFromClipboard}
          >
            <ClipboardPaste size={14} />
          </button>
          {streaming ? (
            <button type="button" className="btn" title="停止生成" onClick={onStop}>
              <Square size={14} />
              停止
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              title="发送"
              disabled={draft.trim().length === 0}
              onClick={onSend}
            >
              <Send size={14} />
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
