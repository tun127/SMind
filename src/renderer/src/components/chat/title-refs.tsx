/**
 * 助手回复按「节点引用 / 纯文本」渲染（自 ChatPanel.tsx 的 renderAssistantText 搬出）。
 *
 * 只有标题原文才算引用——这正是 system 提示词要求模型的引用方式。
 */

import type { ReactElement } from 'react'
import { buildTitleIndex, segmentTitleMentions } from '@shared/agent'

interface Props {
  content: string
  titleIndex: ReturnType<typeof buildTitleIndex>
  /** 点击引用时在画布上定位（沿用搜索面板的定位方式） */
  onGoToNode(topicId: string): void
}

export default function TitleRefs({ content, titleIndex, onGoToNode }: Props): ReactElement {
  return (
    <>
      {segmentTitleMentions(content, titleIndex).map((segment, index) => {
        const key = `${segment.topicId ?? 'plain'}-${index}`
        if (segment.topicId === null) return <span key={key}>{segment.text}</span>
        const id = segment.topicId
        return (
          <button
            key={key}
            type="button"
            className="chat-msg__link"
            title="在画布中定位这个主题"
            onClick={() => onGoToNode(id)}
          >
            {segment.text}
          </button>
        )
      })}
    </>
  )
}
