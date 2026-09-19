/**
 * 工具栏「视图与缩放」组：缩小 / 实际大小 / 放大 / 适应画布 / 视角锁定。
 *
 * JSX 自 Toolbar.tsx 整块搬出、逐字未改；`quick`、`zoom`、`viewLock` 由入口原样传入
 *（入口本就从 store 订阅 zoom 与 viewLock，传值可保持渲染时机与拆分前一致）。
 */

import { Crosshair, Maximize, ZoomIn, ZoomOut } from 'lucide-react'
import type { ReactElement } from 'react'
import { viewportActions } from '../../render/viewport'
import { useEditor } from '../../store/editor'
import type { QuickRender } from './quick-items'

interface Props {
  quick: QuickRender
  zoom: number
  viewLock: boolean
}

export default function ViewControls({ quick, zoom, viewLock }: Props): ReactElement {
  const store = useEditor.getState

  return (
    <div className="toolbar__group">
      {quick(
        'zoom-out',
        <button
          type="button"
          className="tool-btn"
          title="缩小 (Ctrl+-)"
          onClick={() => viewportActions.zoomTo(zoom / 1.2)}
        >
          <ZoomOut size={17} />
        </button>
      )}
      <button
        type="button"
        className="tool-btn tool-btn--text"
        title="实际大小 (Ctrl+0)"
        onClick={() => viewportActions.zoomTo(1)}
      >
        {Math.round(zoom * 100)}%
      </button>
      {quick(
        'zoom-in',
        <button
          type="button"
          className="tool-btn"
          title="放大 (Ctrl+=)"
          onClick={() => viewportActions.zoomTo(zoom * 1.2)}
        >
          <ZoomIn size={17} />
        </button>
      )}
      {quick(
        'fit',
        <button
          type="button"
          className="tool-btn"
          title="适应画布 (Ctrl+1)"
          onClick={() => viewportActions.fit()}
        >
          <Maximize size={17} />
        </button>
      )}
      {quick(
        'view-lock',
        <button
          type="button"
          className={viewLock ? 'tool-btn tool-btn--active' : 'tool-btn'}
          title={
            viewLock
              ? '视角锁定：视角正跟住选中的主题（再点一次取消，Ctrl+Shift+L）'
              : '视角锁定：让视角始终跟住选中的主题（Ctrl+Shift+L）'
          }
          onClick={() => store().toggleViewLock()}
        >
          <Crosshair size={17} />
        </button>
      )}
    </div>
  )
}
