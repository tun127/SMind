/**
 * 从 `TopicNode.tsx` 抽出的「标记条」（A3-2）：只搬 JSX，逐字未改。
 * 外面包一层 Fragment（不产生 DOM 节点），条件判断仍在内部，渲染结果与搬前一致。
 */
import type { ReactElement } from 'react'
import { MARKER_STRIP_GAP } from '@shared/layout/accessory'
import MarkerIcon from '../MarkerIcon'

export function TopicMarkersStrip({
  markerColumns,
  markerSide,
  markerStripWidth
}: {
  markerColumns: string[][]
  markerSide: 'left' | 'right'
  markerStripWidth: number
}): ReactElement {
  return (
    <>
      {/* 标记条：挂在节点**外侧**竖排（默认左侧，左向分支放右侧） */}
      {markerColumns.length > 0 && (
        <div
          className="topic__markers"
          style={
            markerSide === 'left'
              ? { left: -(markerStripWidth + MARKER_STRIP_GAP) }
              : { right: -(markerStripWidth + MARKER_STRIP_GAP) }
          }
        >
          {markerColumns.map((column, columnIndex) => (
            <div key={columnIndex} className="topic__marker-col">
              {column.map((markerId, index) => (
                <MarkerIcon key={`mk-${columnIndex}-${index}-${markerId}`} markerId={markerId} />
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
