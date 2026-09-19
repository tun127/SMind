/**
 * 从 `TopicNode.tsx` 抽出的「底部标签行」（A3-2）：只搬 JSX，逐字未改。
 * 外面包一层 Fragment（不产生 DOM 节点），条件判断仍在内部，渲染结果与搬前一致。
 */
import type { ReactElement } from 'react'
import type { TopicNodeProps } from './props'

export function TopicLabelRow({ node }: { node: TopicNodeProps['node'] }): ReactElement {
  return (
    <>
      {/* 底部标签行 */}
      {node.labelRow.items.length > 0 && (
        <div className="topic__labels" style={{ height: node.labelRow.height }}>
          {node.labelRow.items.map((label, index) => (
            <span
              key={`l-${index}-${label.text}`}
              className="topic__label"
              style={{ width: label.width }}
              // 过长时标签画的是截断后的文字，hover 用完整原文提示
              title={label.full ?? label.text}
            >
              {label.text}
            </span>
          ))}
        </div>
      )}
    </>
  )
}
