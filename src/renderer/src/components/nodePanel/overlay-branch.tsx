/**
 * 节点属性面板的「选到画布元素」分支（概要 / 边界 / 关系线）。
 *
 * 与「选到节点」分支互斥：`selectOverlay` 会把 `selection` 清空，
 * 所以两条分支不会同时成立；搬出来只是把原来同文件里的两块 JSX 分开。
 * JSX 逐字未改，store 订阅随块一起搬进本模块。
 */

import { Bold, Eraser, Italic, X } from 'lucide-react'
import type { ReactElement } from 'react'
import { activeSheet } from '@shared/model/tree'
import {
  OVERLAY_TITLE_DEFAULTS,
  readOverlayTextStyle,
  type OverlayKind
} from '@shared/model/overlay-style'
import { useEditor } from '../../store/editor'
import { PanelHeader } from './panel-parts'

/** 画布元素标题的字体控制（与主题的格式栏同一套观感） */
const OVERLAY_FONT_SIZES = [12, 13, 14, 16, 18, 22, 28]
const OVERLAY_COLORS = ['#1f2328', '#EB5757', '#F2994A', '#27AE60', '#2D9CDB', '#2F6BFF', '#9B51E0']

type Sheet = ReturnType<typeof activeSheet>
/** 三类画布级元素在数据里长得一样（都有 id / title / style），面板用同一套控件渲染 */
type OverlayItem =
  Sheet['summaries'][number] | Sheet['boundaries'][number] | Sheet['relationships'][number]

interface Props {
  selectedOverlay: { kind: OverlayKind; id: string }
  overlayItem: OverlayItem
  onClose(): void
}

/**
 * 画布级元素的属性：文字 + 字体（字号/加粗/斜体/颜色）+ 删除。
 *
 * 概要此前「文字删空就只剩一个框、点不到也改不了」——现在它和主题一样可选中、可改样式，
 * 文字清空后依然保留点击区（画布上有占位提示）。
 */
export default function OverlayBranch({
  selectedOverlay,
  overlayItem,
  onClose
}: Props): ReactElement {
  const setOverlayStyle = useEditor((s) => s.setOverlayStyle)
  const setRelationshipTitle = useEditor((s) => s.setRelationshipTitle)
  const setBoundaryTitle = useEditor((s) => s.setBoundaryTitle)
  const setSummaryTitle = useEditor((s) => s.setSummaryTitle)
  const removeRelationship = useEditor((s) => s.removeRelationship)
  const removeBoundary = useEditor((s) => s.removeBoundary)
  const removeSummary = useEditor((s) => s.removeSummary)

  const kind: OverlayKind = selectedOverlay.kind
  const label = kind === 'summary' ? '概要' : kind === 'boundary' ? '边界' : '关系线'
  const styleText = readOverlayTextStyle(overlayItem.style, OVERLAY_TITLE_DEFAULTS[kind])
  const setTitle =
    kind === 'summary'
      ? setSummaryTitle
      : kind === 'boundary'
        ? setBoundaryTitle
        : setRelationshipTitle
  const remove =
    kind === 'summary' ? removeSummary : kind === 'boundary' ? removeBoundary : removeRelationship

  return (
    <div className="side-panel">
      <PanelHeader onClose={onClose} />
      <div className="side-panel__body">
        <div className="side-panel__empty">
          已选中画布上的「{label}」：文字与字体都能改，和主题一样支持撤销。
        </div>

        <div className="side-panel__title">{label}文字</div>
        <textarea
          key={`${overlayItem.id}-${overlayItem.title ?? ''}`}
          className="input input--area overlay-row__multi"
          rows={3}
          defaultValue={overlayItem.title ?? ''}
          placeholder="输入文字（Enter 换行；清空后画布上仍留有可点击的占位）"
          onBlur={(event) => setTitle(overlayItem.id, event.currentTarget.value)}
        />

        <div className="side-panel__title">字体</div>
        <div className="side-panel__row">
          <select
            className="select"
            value={styleText.fontSize}
            onChange={(event) =>
              setOverlayStyle(kind, overlayItem.id, { fontSize: Number(event.target.value) })
            }
          >
            {OVERLAY_FONT_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={styleText.bold ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
            title="加粗"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOverlayStyle(kind, overlayItem.id, { bold: !styleText.bold })}
          >
            <Bold size={15} />
          </button>
          <button
            type="button"
            className={styleText.italic ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
            title="斜体"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOverlayStyle(kind, overlayItem.id, { italic: !styleText.italic })}
          >
            <Italic size={15} />
          </button>
          <button
            type="button"
            className="fmt-btn"
            title="恢复默认字体"
            onMouseDown={(e) => e.preventDefault()}
            /* 传 0 / false / 空串＝把对应属性删掉，恢复元素本身的默认外观 */
            onClick={() =>
              setOverlayStyle(kind, overlayItem.id, {
                fontSize: 0,
                bold: false,
                italic: false,
                color: ''
              })
            }
          >
            <Eraser size={14} />
          </button>
        </div>
        <div className="side-panel__row">
          <span className="side-panel__hint">颜色</span>
          {OVERLAY_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={styleText.color === color ? 'color-dot color-dot--active' : 'color-dot'}
              style={{ background: color }}
              title={color}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setOverlayStyle(kind, overlayItem.id, { color })}
            />
          ))}
        </div>

        <div className="side-panel__hint">
          双击画布上的文字也能直接编辑；选中后按 Delete 删除这个{label}。
        </div>
        <div className="side-panel__row">
          <button
            type="button"
            className="btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              remove(overlayItem.id)
              useEditor.getState().clearOverlaySelection()
            }}
          >
            <X size={14} /> 删除{label}
          </button>
        </div>
      </div>
    </div>
  )
}
