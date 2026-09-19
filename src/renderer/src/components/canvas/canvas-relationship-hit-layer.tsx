import type { ReactElement } from 'react'
import type { LayoutResult } from '@shared/layout/types'
import { useEditor } from '../../store/editor'
import type { useRelationshipDrag } from './use-relationship-drag'

/**
 * 关系线线身的命中层（自 `Canvas.tsx` 整块搬出，逐字未改）。
 *
 * 这一层特意画在节点**下面**：那 18px 的透明命中区如果压在上层，会把经过线下方节点的拖拽
 * 操作抢走（表现为「某些节点怎么都拖不动」）。
 *
 * `useEditor.getState()` 仍在层内直接调用——与搬迁前同源（它不读渲染值，只取当前 store）。
 */

export function CanvasRelationshipHitLayer({
  layout,
  handleCurvePointerDown
}: {
  layout: LayoutResult
  handleCurvePointerDown: ReturnType<typeof useRelationshipDrag>['handleCurvePointerDown']
}): ReactElement {
  return (
    <>
      {/* 关系线线身的命中层：特意画在节点**下面**。
            否则那 18px 的透明命中区会压在上层，把经过线下方节点的拖拽操作抢走，
            表现为「某些节点怎么都拖不动」。 */}
      <svg className="canvas__overlay" width={layout.bounds.width} height={layout.bounds.height}>
        {layout.relationships.map((relationship) => (
          <path
            key={`hit-${relationship.id}`}
            className="overlay-curve"
            d={relationship.d}
            fill="none"
            stroke="transparent"
            strokeWidth={18}
            strokeLinecap="round"
            onPointerDown={(event) => handleCurvePointerDown(event, relationship.id)}
            onDoubleClick={(event) => {
              event.stopPropagation()
              useEditor.getState().resetRelationshipCurve(relationship.id)
            }}
          >
            <title>拖动可移动这条线；双击恢复自动弯度</title>
          </path>
        ))}
      </svg>
    </>
  )
}
