/**
 * 大纲预览：AI 生成结果的树形展示（按主题生成、按文档生成共用）。
 *
 * 显示节点的**解释行**是关键：用户要的是"详细"，而详细就落在备注里，
 * 预览里看不见的话他无法判断这张图值不值得落地。
 */
import { Sparkles } from 'lucide-react'
import type { ReactElement } from 'react'
import type { OutlineNode } from '@shared/ai'

export function OutlinePreview({
  node,
  depth = 0
}: {
  node: OutlineNode
  depth?: number
}): ReactElement {
  const note = node.notes?.trim() ?? ''
  return (
    <>
      <div className="ai-preview__row" style={{ paddingLeft: 8 + depth * 16 }}>
        {depth === 0 ? <Sparkles size={12} /> : <span className="ai-preview__dot" />}
        {node.title}
      </div>
      {note.length > 0 && (
        <div className="ai-preview__note" style={{ paddingLeft: 8 + depth * 16 + 18 }}>
          {note}
        </div>
      )}
      {node.children.map((child, index) => (
        <OutlinePreview key={`${child.title}-${index}`} node={child} depth={depth + 1} />
      ))}
    </>
  )
}

/** 带解释（备注）的节点数：告诉用户"详细"详在哪，而不是只给一个总节点数 */
export function countNotedNodes(node: OutlineNode | null): number {
  if (!node) return 0
  let total = node.notes && node.notes.trim().length > 0 ? 1 : 0
  for (const child of node.children) total += countNotedNodes(child)
  return total
}
