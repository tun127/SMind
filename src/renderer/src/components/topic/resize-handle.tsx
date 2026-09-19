/**
 * 从 `TopicNode.tsx` 抽出的「手动拉伸手柄（右下角改尺寸 / 双击恢复）」（A3-2）：只搬 JSX，逐字未改。
 * 外面包一层 Fragment（不产生 DOM 节点），条件判断仍在内部，渲染结果与搬前一致。
 */
import type { ReactElement } from 'react'
import { useEditor } from '../../store/editor'
import type { TopicNodeProps } from './props'

export function TopicResizeHandle({
  node,
  selected,
  editing,
  minNodeWidth,
  minNodeHeight
}: {
  node: TopicNodeProps['node']
  selected: boolean
  editing: boolean
  minNodeWidth: number
  minNodeHeight: number
}): ReactElement {
  return (
    <>
      {/* 手动拉伸手柄：选中且不在编辑态时出现，拖右下角改尺寸，双击恢复自动尺寸 */}
      {selected && !editing && (
        <span
          className="topic__resize"
          title="拖动调整节点大小；双击恢复自动尺寸"
          onPointerDown={(event) => {
            event.stopPropagation()
            event.preventDefault()
            const startX = event.clientX
            const startY = event.clientY
            const startWidth = node.width
            const startHeight = node.height
            const zoom = useEditor.getState().zoom || 1
            // 框不能小于内容：代码块缩到缩放下限、公式块整块原子——取两者更大的下限
            const minWidth = Math.max(60, minNodeWidth)
            const minHeight = Math.max(28, minNodeHeight)
            const move = (moveEvent: PointerEvent): void => {
              useEditor.getState().setSizeOverride(node.id, {
                width: Math.max(minWidth, startWidth + (moveEvent.clientX - startX) / zoom),
                height: Math.max(minHeight, startHeight + (moveEvent.clientY - startY) / zoom)
              })
            }
            const up = (): void => {
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', up)
            }
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', up)
          }}
          onDoubleClick={(event) => {
            event.stopPropagation()
            useEditor.getState().setSizeOverride(node.id, null)
          }}
        />
      )}
    </>
  )
}
