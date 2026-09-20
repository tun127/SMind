import type { ReactElement } from 'react'
import type { LayoutResult } from '@shared/layout/types'
import type { ThemeColors } from '@shared/model/types'
import type { EditorState } from '../../store/editor'
import type { TopicNodeProps } from '../topic/props'
import TopicNode from '../TopicNode'
import type { useCanvasDisplay } from './use-canvas-display'
import type { DragVisual, useNodeDrag } from './use-node-drag'
import type { useRelationshipDrag } from './use-relationship-drag'

/**
 * 节点层：把可见节点铺成 `TopicNode`（自 `Canvas.tsx` 整块搬出，逐字未改）。
 *
 * props 一次都没重新包装：`TopicNode` 有 `memo`，这里传进去的 10 个回调就是画布那 10 个
 * `useCallback`（引用稳定），本层**没有加 `memo`**、也没有内联箭头 → 浅比较面与搬迁前完全一样。
 *
 * `dimmed` / `highlight` / `dragged` 这些判断仍在层内表达式里，按名字读 props。
 */

export function CanvasNodesLayer({
  layout,
  colors,
  selection,
  editingId,
  editingRich,
  visibleNodes,
  handleDrag,
  dragVisual,
  dragSet,
  dragFocus,
  dropTarget,
  searchHits,
  marqueeHits,
  flashIds,
  writingIds,
  pulsingId,
  filterResult,
  handleNodePointerDown,
  handleNodeDoubleClick,
  handleNodeRichChange,
  handleNodeCancelEdit,
  handleNodeCommitEdit,
  handleNodeCommitAndAddChild,
  handleNodeCommitAndAddSibling,
  handleNodeNavigateEdit,
  handleNodeToggleCollapse,
  handleNodeToggleFoldSide
}: {
  layout: LayoutResult
  colors: ThemeColors
  selection: string[]
  editingId: EditorState['editingId']
  editingRich: EditorState['editingRich']
  visibleNodes: LayoutResult['nodes']
  handleDrag: ReturnType<typeof useRelationshipDrag>['handleDrag']
  dragVisual: DragVisual | null
  dragSet: ReadonlySet<string> | null
  dragFocus: ReadonlySet<string> | null
  dropTarget: ReturnType<typeof useNodeDrag>['dropTarget']
  searchHits: ReadonlySet<string> | null
  marqueeHits: ReadonlySet<string> | null
  flashIds: ReadonlySet<string>
  /** AI 执行动效（规格 4.6）：刚写入的节点（入场渐显）与当前执行到的那一个（描边脉冲） */
  writingIds: ReadonlySet<string>
  pulsingId: string | null
  filterResult: ReturnType<typeof useCanvasDisplay>['filterResult']
  handleNodePointerDown: TopicNodeProps['onPointerDown']
  handleNodeDoubleClick: TopicNodeProps['onDoubleClick']
  handleNodeRichChange: TopicNodeProps['onRichChange']
  handleNodeCancelEdit: TopicNodeProps['onCancelEdit']
  handleNodeCommitEdit: TopicNodeProps['onCommitEdit']
  handleNodeCommitAndAddChild: TopicNodeProps['onCommitAndAddChild']
  handleNodeCommitAndAddSibling: TopicNodeProps['onCommitAndAddSibling']
  handleNodeNavigateEdit: TopicNodeProps['onNavigateEdit']
  handleNodeToggleCollapse: TopicNodeProps['onToggleCollapse']
  handleNodeToggleFoldSide: TopicNodeProps['onToggleFoldSide']
}): ReactElement {
  return (
    <>
      {visibleNodes.map((node) => (
        <TopicNode
          key={node.id}
          node={node}
          layout={layout}
          colors={colors}
          selected={selection.includes(node.id)}
          editing={editingId === node.id}
          editingRich={editingId === node.id ? editingRich : null}
          highlight={
            dropTarget && dropTarget.mode === 'child' && dropTarget.id === node.id
              ? 'child'
              : dropTarget && dropTarget.mode !== 'child' && dropTarget.id === node.id
                ? 'sibling'
                : handleDrag?.targetId === node.id
                  ? 'child'
                  : null
          }
          dragged={Boolean(dragSet?.has(node.id))}
          draggable={node.depth > 0}
          searchHit={searchHits ? searchHits.has(node.id) : false}
          marqueeHit={marqueeHits ? marqueeHits.has(node.id) : false}
          flash={flashIds.has(node.id)}
          writing={writingIds.has(node.id)}
          pulsing={pulsingId === node.id}
          dimmed={
            filterResult
              ? !filterResult.keep.has(node.id)
              : dragFocus && !dragFocus.has(node.id)
                ? 'soft'
                : false
          }
          dragOffset={
            dragVisual && dragSet?.has(node.id) ? { dx: dragVisual.dx, dy: dragVisual.dy } : null
          }
          dragPrimary={Boolean(dragVisual && dragVisual.anchorId === node.id)}
          onPointerDown={handleNodePointerDown}
          onDoubleClick={handleNodeDoubleClick}
          onRichChange={handleNodeRichChange}
          onCancelEdit={handleNodeCancelEdit}
          onCommitEdit={handleNodeCommitEdit}
          onCommitAndAddChild={handleNodeCommitAndAddChild}
          onCommitAndAddSibling={handleNodeCommitAndAddSibling}
          onNavigateEdit={handleNodeNavigateEdit}
          onToggleCollapse={handleNodeToggleCollapse}
          onToggleFoldSide={handleNodeToggleFoldSide}
        />
      ))}
    </>
  )
}
