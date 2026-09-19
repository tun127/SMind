/**
 * 从 `TopicNode.tsx` 抽出的「节点内 KaTeX 公式块」（A3-2）：只搬 JSX，逐字未改。
 * 外面包一层 Fragment（不产生 DOM 节点），条件判断仍在内部，渲染结果与搬前一致。
 */
import type { ReactElement } from 'react'
import { BLOCK_GAP } from '@shared/layout/accessory'
import { formulaHtml } from '../../render/formula'
import type { TopicNodeProps } from './props'

export function TopicFormulaBlock({
  node,
  formula,
  formulaBox
}: {
  node: TopicNodeProps['node']
  formula: TopicNodeProps['node']['topic']['formula']
  formulaBox: { width: number; height: number } | null | undefined
}): ReactElement {
  return (
    <>
      {/* LaTeX 公式：KaTeX 渲染成 HTML，直接内嵌在节点里 */}
      {formula && formulaBox && (
        <div
          className="topic__formula"
          style={{
            width: formulaBox.width,
            height: formulaBox.height,
            marginTop: BLOCK_GAP,
            fontSize: node.fontSize
          }}
          // KaTeX 的输出是我们自己生成的 HTML，不来自用户输入的原样注入
          dangerouslySetInnerHTML={{ __html: formulaHtml(formula) }}
        />
      )}
    </>
  )
}
