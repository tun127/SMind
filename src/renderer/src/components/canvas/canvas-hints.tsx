import type { ReactElement } from 'react'
import type { useNodeDrag } from './use-node-drag'
import type { Marquee } from './use-marquee-select'
import type { DragVisual } from './use-node-drag'

/**
 * 画布底部的提示层（自 `Canvas.tsx` 整块搬出，逐字未改）：常驻图例、自由摆放提示、
 *
 * 落点被判非法的原因、左键框选的橡皮筋。四块都在 `canvas__world` **之外**（不随画布缩放），
 * 搬迁前后 DOM 顺序一致。
 *
 * 这些提示是「拖拽结果提前讲清楚」的一部分：不写出来，用户只会以为「拖到这里没反应」＝坏了。
 */

export function CanvasHints({
  dragVisual,
  dropTarget,
  freeDrop,
  dropBlocked,
  marquee
}: {
  dragVisual: DragVisual | null
  dropTarget: ReturnType<typeof useNodeDrag>['dropTarget']
  freeDrop: ReturnType<typeof useNodeDrag>['freeDrop']
  dropBlocked: ReturnType<typeof useNodeDrag>['dropBlocked']
  marquee: Marquee | null
}): ReactElement {
  return (
    <>
      {/* 拖到真正的空白处：明确告诉用户"这一下会自由摆放"，
          免得他以为已经吸附进树里了（自由摆放的主题会被自动布局甩在一边，连线横穿整张图） */}
      {/* 常驻图例：拖拽的三种结果提前讲清楚，不用用户去试 */}
      <div className="canvas__drag-legend">
        <span className={dragVisual && dropTarget?.mode === 'child' ? 'is-active' : undefined}>
          拖到主题上＝成为它的子主题
        </span>
        <span className="canvas__drag-legend-sep">·</span>
        <span
          className={
            dragVisual && dropTarget && dropTarget.mode !== 'child' ? 'is-active' : undefined
          }
        >
          拖到同级之间＝插进那一层
        </span>
        <span className="canvas__drag-legend-sep">·</span>
        <span className={dragVisual && freeDrop ? 'is-active' : undefined}>
          按住 Alt＝自由摆放（仍在树里）
        </span>
      </div>

      {freeDrop ? (
        <div className="canvas__free-hint">
          自由摆放（仍在树里；独立主题请用右键「变为独立主题」）
        </div>
      ) : null}

      {/* 落点被判为非法的原因：不写出来，用户只会以为"拖到这里没反应"＝坏了 */}
      {dropBlocked ? <div className="canvas__blocked-hint">{dropBlocked}</div> : null}

      {/* 左键框选的橡皮筋 */}
      {marquee ? (
        <div
          className="canvas__marquee"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0)
          }}
        />
      ) : null}
    </>
  )
}
