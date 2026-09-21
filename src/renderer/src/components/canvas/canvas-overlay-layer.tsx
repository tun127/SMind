import type { ReactElement } from 'react'
import { OverlayTitleRuns, centeredTitleDy } from './overlay-title-runs'
import type { LayoutResult } from '@shared/layout/types'
import { OVERLAY_TITLE_DEFAULTS } from '@shared/model/overlay-style'
import type { ThemeColors } from '@shared/model/types'
import { branchColorOf } from '../../render/theme'
import type { EditorState } from '../../store/editor'
import { clipText } from './clip-text'
import type { useCanvasDisplay } from './use-canvas-display'
import type { useRelationshipDrag } from './use-relationship-drag'
import type { useTitleEdit } from './use-title-edit'

/**
 * 覆盖层：关系线本体 + 三种落点/对调预览 + 多选徽标 + 端点预览线（自 `Canvas.tsx` 整块搬出，逐字未改）。
 *
 * 画在节点**之上**（避免被节点挡住），与下面那层命中区一上一下是刻意的分工。
 * `dropPreview` / `sideFlipPreview` / `groupBadge` 的类型直接从 `useCanvasDisplay` 的返回值推导，
 * 不手抄判别式联合（§四.3 第 6 条）。
 */

export function CanvasOverlayLayer({
  layout,
  colors,
  selectedOverlay,
  dropPreview,
  sideFlipPreview,
  groupBadge,
  handleDrag,
  handleRelationshipPointerDown,
  pickOverlay,
  setTitleEdit
}: {
  layout: LayoutResult
  colors: ThemeColors
  selectedOverlay: EditorState['selectedOverlay']
  dropPreview: ReturnType<typeof useCanvasDisplay>['dropPreview']
  sideFlipPreview: ReturnType<typeof useCanvasDisplay>['sideFlipPreview']
  groupBadge: ReturnType<typeof useCanvasDisplay>['groupBadge']
  handleDrag: ReturnType<typeof useRelationshipDrag>['handleDrag']
  handleRelationshipPointerDown: ReturnType<
    typeof useRelationshipDrag
  >['handleRelationshipPointerDown']
  pickOverlay: ReturnType<typeof useRelationshipDrag>['pickOverlay']
  setTitleEdit: ReturnType<typeof useTitleEdit>['setTitleEdit']
}): ReactElement {
  return (
    <>
      {/* 关系线画在节点之上，避免被节点挡住 */}
      <svg className="canvas__overlay" width={layout.bounds.width} height={layout.bounds.height}>
        {layout.relationships.map((relationship) => {
          const color = relationship.branchId
            ? branchColorOf(colors, layout, relationship.branchId)
            : colors.deepText
          const angle = ((relationship.arrow.angle * 180) / Math.PI).toFixed(1)
          // 标题那一小块就是这条线的可选中区域（空标题也给一块，否则选不中）
          const size = relationship.labelSize ?? { width: 24, height: 16 }
          const labelBox = {
            x: relationship.label.x - size.width / 2 - 4,
            y: relationship.label.y - size.height / 2 - 4,
            width: size.width + 8,
            height: size.height + 8
          }
          const active =
            selectedOverlay?.kind === 'relationship' && selectedOverlay.id === relationship.id
          return (
            <g key={`relationship-${relationship.id}`}>
              <path
                d={relationship.d}
                fill="none"
                stroke={color}
                strokeWidth={1.8}
                strokeLinecap="round"
              />
              {/* 线身的可拖拽命中区在节点下面那一层，见上方 canvas__overlay 命中层 */}

              <path
                d="M 0 0 L -10 -4 L -10 4 Z"
                transform={`translate(${relationship.arrow.x} ${relationship.arrow.y}) rotate(${angle})`}
                fill={color}
              />

              {/* 标题区的透明命中区：单击选中、双击改文字 */}
              <rect
                className="overlay-hit"
                x={labelBox.x}
                y={labelBox.y}
                width={labelBox.width}
                height={labelBox.height}
                rx={4}
                fill="transparent"
                onPointerDown={(event) => pickOverlay(event, 'relationship', relationship.id)}
                onDoubleClick={() =>
                  setTitleEdit({
                    kind: 'relationship',
                    id: relationship.id,
                    x: relationship.label.x,
                    y: relationship.label.y,
                    anchor: 'middle',
                    value: relationship.title ?? ''
                  })
                }
              />
              {active ? (
                <rect
                  className="overlay-selected"
                  x={labelBox.x}
                  y={labelBox.y}
                  width={labelBox.width}
                  height={labelBox.height}
                  rx={4}
                />
              ) : null}

              {relationship.title ? (
                <text
                  className="overlay-title"
                  x={relationship.label.x}
                  y={relationship.label.y}
                  fontSize={OVERLAY_TITLE_DEFAULTS.relationship.fontSize}
                  fontWeight={600}
                  fill={color}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  stroke={colors.canvas}
                  strokeWidth={4}
                  paintOrder="stroke"
                  strokeLinejoin="round"
                  pointerEvents="none"
                >
                  {/* 关系线标题同样支持手动换行；富文本按 run 分段（部分文字加粗/变色/高亮） */}
                  <OverlayTitleRuns
                    x={relationship.label.x}
                    rich={relationship.titleRich}
                    title={relationship.title}
                    fill={color}
                    fontSize={OVERLAY_TITLE_DEFAULTS.relationship.fontSize}
                    dyOf={centeredTitleDy}
                  />
                </text>
              ) : null}

              {/* 两端各一个手柄：拖到别的主题上即可改接这一端 */}
              {(
                [
                  { end: 'end1Id' as const, point: relationship.start },
                  { end: 'end2Id' as const, point: relationship.arrow }
                ] as const
              ).map((handle) => (
                <circle
                  key={`${relationship.id}-${handle.end}`}
                  className={
                    handleDrag &&
                    handleDrag.relationshipId === relationship.id &&
                    handleDrag.end === handle.end
                      ? 'overlay-handle overlay-handle--active'
                      : 'overlay-handle'
                  }
                  cx={handle.point.x}
                  cy={handle.point.y}
                  r={7}
                  fill={color}
                  onPointerDown={(event) =>
                    handleRelationshipPointerDown(event, relationship.id, handle.end, handle.point)
                  }
                >
                  <title>拖到另一个主题上可改接这一端</title>
                </circle>
              ))}
            </g>
          )
        })}

        {/* 落点预览：要么是"成为子主题"的空位框，要么是"插到同级之间"的插入线 */}
        {dropPreview && dropPreview.kind === 'slot' ? (
          <g>
            <line
              x1={dropPreview.from.x}
              y1={dropPreview.from.y}
              x2={dropPreview.to.x}
              y2={dropPreview.to.y}
              stroke={dropPreview.color}
              strokeWidth={1.8}
              /* 用实线 —— 那就是这个主题将来真正的那条连线，虚线会让人以为"还没连上" */
              strokeLinecap="round"
              opacity={0.9}
            />
            <rect
              x={dropPreview.slot.x}
              y={dropPreview.slot.y}
              width={dropPreview.slot.width}
              height={dropPreview.slot.height}
              rx={10}
              fill={dropPreview.color}
              fillOpacity={0.14}
              stroke={dropPreview.color}
              strokeWidth={2}
            />
            {/* 空位框里写上"是谁要落到这里"，比只显示一个空格子清楚得多 */}
            {dropPreview.title ? (
              <text
                x={dropPreview.slot.x + dropPreview.slot.width / 2}
                y={dropPreview.slot.y + dropPreview.slot.height / 2}
                fontSize={12}
                fontWeight={600}
                fill={dropPreview.color}
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {clipText(dropPreview.title, dropPreview.slot.width)}
              </text>
            ) : null}
            {/* 成为子主题这件事光看几何位置不够直观，直接在空位框下写明 */}
            <text
              x={dropPreview.slot.x + dropPreview.slot.width / 2}
              y={dropPreview.slot.y + dropPreview.slot.height + 14}
              fontSize={11}
              fontWeight={700}
              fill={dropPreview.color}
              textAnchor="middle"
              dominantBaseline="middle"
              stroke={colors.canvas}
              strokeWidth={4}
              paintOrder="stroke"
              strokeLinejoin="round"
            >
              {`将成为「${
                dropPreview.targetTitle.length > 12
                  ? `${dropPreview.targetTitle.slice(0, 12)}…`
                  : dropPreview.targetTitle
              }」的子主题`}
            </text>
          </g>
        ) : null}

        {/*
            同级插入：只画一条夹在目标与相邻兄弟之间的粗插入线（Xmind / 知犀那套"插入位置条"）。
            位置紧贴目标外缘，就在指针附近，不会像过去的空位框那样跑到很远的父级那边去。
          */}
        {dropPreview && dropPreview.kind === 'bar' ? (
          <g>
            <line
              x1={dropPreview.bar.x1}
              y1={dropPreview.bar.y1}
              x2={dropPreview.bar.x2}
              y2={dropPreview.bar.y2}
              stroke={dropPreview.color}
              strokeWidth={5}
              strokeLinecap="round"
            />
            <circle
              cx={(dropPreview.bar.x1 + dropPreview.bar.x2) / 2}
              cy={(dropPreview.bar.y1 + dropPreview.bar.y2) / 2}
              r={4.5}
              fill="#ffffff"
              stroke={dropPreview.color}
              strokeWidth={2.5}
            />
          </g>
        ) : null}

        {/* 左右对调的预览：镜像到中心主题另一侧 */}
        {sideFlipPreview ? (
          <g>
            <rect
              x={sideFlipPreview.x}
              y={sideFlipPreview.y}
              width={sideFlipPreview.width}
              height={sideFlipPreview.height}
              rx={10}
              fill={sideFlipPreview.color}
              fillOpacity={0.08}
              stroke={sideFlipPreview.color}
              strokeWidth={1.5}
              strokeDasharray="6 5"
            />
            {sideFlipPreview.title ? (
              <text
                x={sideFlipPreview.x + sideFlipPreview.width / 2}
                y={sideFlipPreview.y + sideFlipPreview.height / 2}
                fontSize={12}
                fontWeight={600}
                fill={sideFlipPreview.color}
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {clipText(sideFlipPreview.title, sideFlipPreview.width)}
              </text>
            ) : null}
          </g>
        ) : null}

        {/* 多选拖拽：角上挂一个「N 个主题」的徽标 */}
        {groupBadge ? (
          <g>
            <rect
              x={groupBadge.x}
              y={groupBadge.y}
              width={groupBadge.text.length * 11 + 14}
              height={22}
              rx={11}
              fill="#f59e0b"
            />
            <text
              x={groupBadge.x + (groupBadge.text.length * 11 + 14) / 2}
              y={groupBadge.y + 11}
              fontSize={12}
              fontWeight={700}
              fill="#ffffff"
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {groupBadge.text}
            </text>
          </g>
        ) : null}

        {/* 拖拽端点时的预览线 */}
        {handleDrag ? (
          <line
            x1={handleDrag.anchor.x}
            y1={handleDrag.anchor.y}
            x2={handleDrag.pointer.x}
            y2={handleDrag.pointer.y}
            stroke={colors.deepText}
            strokeWidth={1.6}
            strokeDasharray="6 5"
            strokeLinecap="round"
            opacity={0.7}
          />
        ) : null}
      </svg>
    </>
  )
}
