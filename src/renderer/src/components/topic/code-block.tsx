/**
 * 从 `TopicNode.tsx` 抽出的「节点内代码块（语言切换 + 高亮行）」（A3-2）：只搬 JSX，逐字未改。
 * 外面包一层 Fragment（不产生 DOM 节点），条件判断仍在内部，渲染结果与搬前一致。
 */
import type { ReactElement } from 'react'
import { BLOCK_GAP } from '@shared/layout/accessory'
import { CODE_LANGUAGES } from '@shared/code-language'
import { useEditor } from '../../store/editor'
import type { TopicNodeProps } from './props'

export function TopicCodeBlock({
  node,
  code,
  codeMetrics,
  codeBox,
  codeLines
}: {
  node: TopicNodeProps['node']
  code: TopicNodeProps['node']['topic']['code']
  codeMetrics: NonNullable<TopicNodeProps['node']['codeMetrics']> | null | undefined
  codeBox: { width: number; height: number } | null
  codeLines: ReactElement[]
}): ReactElement {
  return (
    <>
      {/* 代码块：等宽排版，尺寸与字号都来自测量（节点被拉伸时一起等比缩放）；语言小标可直接切换 */}
      {code && codeMetrics && codeBox && (
        <div
          className="topic__code"
          style={{ width: codeBox.width, height: codeBox.height, marginTop: BLOCK_GAP }}
        >
          <select
            className="topic__code-lang"
            value={code.language || 'text'}
            title="切换代码语言"
            style={{
              fontSize: Math.max(8, Math.round(9 * codeMetrics.scale)),
              lineHeight: `${codeMetrics.header}px`
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onChange={(event) =>
              useEditor
                .getState()
                .setCode(node.id, { language: event.target.value, text: code.text })
            }
          >
            {CODE_LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>
                {lang === 'text' ? 'text' : lang}
              </option>
            ))}
          </select>
          <pre
            className="topic__code-pre"
            style={{
              fontSize: codeMetrics.fontSize,
              lineHeight: `${codeMetrics.lineHeight}px`,
              padding: `${codeMetrics.header}px ${codeMetrics.paddingX}px ${codeMetrics.paddingY}px`
            }}
          >
            {codeLines}
          </pre>
        </div>
      )}
    </>
  )
}
