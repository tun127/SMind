/**
 * 从 `TopicNode.tsx` 抽出的「折叠徽标（双向展开的两根 + 单徽标）」（A3-2）：只搬 JSX，逐字未改。
 * 外面包一层 Fragment（不产生 DOM 节点），条件判断仍在内部，渲染结果与搬前一致。
 */
import type { ReactElement } from 'react'
import { collapseBadgeSide } from '@shared/layout/core'
import { FOLD_SIDE_LABELS } from '@shared/model/fold-labels'
import { countDescendants, hiddenCountOfSide, splitFoldSidesOf } from '@shared/model/tree'
import type { TopicNodeProps } from './props'

export function TopicCollapseBadges({
  node,
  splitSides,
  foldedSides,
  color,
  canCollapse,
  collapseSide,
  onToggleFoldSide,
  onToggleCollapse
}: {
  node: TopicNodeProps['node']
  splitSides: ReturnType<typeof splitFoldSidesOf>
  foldedSides: Set<ReturnType<typeof splitFoldSidesOf>[number]>
  color: string
  canCollapse: boolean | undefined
  collapseSide: ReturnType<typeof collapseBadgeSide>
  onToggleFoldSide: TopicNodeProps['onToggleFoldSide']
  onToggleCollapse: TopicNodeProps['onToggleCollapse']
}): ReactElement {
  return (
    <>
      {/* 双向展开的结构：每个方向一根徽标，分别收起（各贴自己那一侧的边） */}
      {splitSides.map((side) => (
        <button
          key={side}
          type="button"
          className={`topic__collapse topic__collapse--${side}`}
          title={
            foldedSides.has(side)
              ? `已收起${FOLD_SIDE_LABELS[side]}侧 ${hiddenCountOfSide(node.topic, side)} 个子主题，点击展开`
              : `收起${FOLD_SIDE_LABELS[side]}侧分支`
          }
          style={{ background: color }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation()
            onToggleFoldSide(node.id, side)
          }}
        >
          {/* 收起时显示这一侧藏了多少个节点，展开时是 −（与整体折叠的徽标同一套样式） */}
          {foldedSides.has(side) ? hiddenCountOfSide(node.topic, side) : '−'}
        </button>
      ))}

      {splitSides.length === 0 && canCollapse && (
        <button
          type="button"
          className={`topic__collapse topic__collapse--${collapseSide}`}
          title={
            node.topic.collapsed
              ? `折叠了 ${countDescendants(node.topic)} 个子主题，点击展开`
              : '折叠子主题'
          }
          // 平面样式：只有分支配色的底，不再描白圈/投影（那圈白边看着像高光，用户反馈去掉）
          style={{ background: color }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation()
            onToggleCollapse(node.id)
          }}
        >
          {/* 折叠时显示折叠的后代数量，展开时是 −（XMind 式圆形简约徽标） */}
          {node.topic.collapsed ? countDescendants(node.topic) : '−'}
        </button>
      )}
    </>
  )
}
