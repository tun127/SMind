/**
 * 从 `TopicNode.tsx` 抽出的「文本行（含行内公式）」（A3-2）：只搬 JSX，逐字未改。
 * 外面包一层 Fragment（不产生 DOM 节点），条件判断仍在内部，渲染结果与搬前一致。
 */
import type { ReactElement } from 'react'
import { formulaHtml } from '../../render/formula'
import type { TopicNodeProps } from './props'
import { segmentStyle } from './segment-style'

export function TopicTextLines({ node }: { node: TopicNodeProps['node'] }): ReactElement {
  return (
    <>
      {node.lines.map((line, lineIndex) => (
        <div
          key={lineIndex}
          className="topic__line"
          style={{
            height: line.height,
            lineHeight: `${line.height}px`,
            textAlign: line.align
          }}
        >
          {line.segments.length === 0
            ? '\u00A0'
            : line.segments.map((segment, segmentIndex) =>
                segment.formula ? (
                  // 行内公式（标题里的 $…$）：交给 KaTeX，垂直居中对齐文字
                  <span
                    key={segmentIndex}
                    className="topic__inline-formula"
                    // KaTeX 的输出由渲染器生成，不是用户 HTML
                    dangerouslySetInnerHTML={{ __html: formulaHtml(segment.formula) }}
                  />
                ) : (
                  <span key={segmentIndex} style={segmentStyle(segment)}>
                    {segment.text}
                  </span>
                )
              )}
        </div>
      ))}
    </>
  )
}
