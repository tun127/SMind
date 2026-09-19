/**
 * 面板「选到节点」分支里的「标记图标」段。
 *
 * 整块 JSX 原样搬出（外面包 Fragment，不产生 DOM 节点），props 原样传，
 * store 订阅随块一起搬进本模块。
 */

import { X } from 'lucide-react'
import type { ReactElement } from 'react'
import { MARKER_GROUPS } from '@shared/xmind/constants'
import type { Topic } from '@shared/model/types'
import { markerVisualOf } from '../../render/markers'
import { useEditor } from '../../store/editor'
import MarkerIcon from '../MarkerIcon'

interface Props {
  topic: Topic
  topicId: string
}

export default function MarkerSection({ topic, topicId }: Props): ReactElement {
  const toggleMarker = useEditor((s) => s.toggleMarker)

  return (
    <>
      <div className="side-panel__title">标记图标</div>

      {/* 已添加的标记（包含文件里带来、本软件不认识的标记，这里可以移除） */}
      {topic.markers.length > 0 ? (
        <div className="chip-row">
          {topic.markers.map((marker) => (
            <span key={`on-${marker.markerId}`} className="chip">
              <MarkerIcon markerId={marker.markerId} size={14} />
              <span className="chip__text">{markerVisualOf(marker.markerId).label}</span>
              <button
                type="button"
                className="chip__del"
                title="移除此标记"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggleMarker(topicId, marker.markerId)}
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="side-panel__hint">还没有标记。点击下面的图标即可添加。</div>
      )}

      {MARKER_GROUPS.map((group) => (
        <div key={group.title} className="marker-row">
          <span className="marker-row__label">{group.title}</span>
          <div className="marker-picker">
            {group.markers.map((markerId) => {
              const active = topic.markers.some((marker) => marker.markerId === markerId)
              return (
                <button
                  key={markerId}
                  type="button"
                  className={active ? 'marker-btn marker-btn--active' : 'marker-btn'}
                  title={markerVisualOf(markerId).label}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => toggleMarker(topicId, markerId)}
                >
                  <MarkerIcon markerId={markerId} />
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </>
  )
}
