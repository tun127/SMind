import type { PointerEvent as ReactPointerEvent, ReactElement, RefObject } from 'react'
import { OVERLAY_TITLE_LINE_HEIGHT, overlayTitleLines } from '@shared/layout/overlays'
import type { LayoutResult } from '@shared/layout/types'
import { OVERLAY_TITLE_DEFAULTS, readOverlayTextStyle } from '@shared/model/overlay-style'
import type { ThemeColors } from '@shared/model/types'
import { branchColorOf } from '../../render/theme'
import type { EditorState } from '../../store/editor'
import type { useRelationshipDrag } from './use-relationship-drag'
import type { useTitleEdit } from './use-title-edit'
import type { DragVisual } from './use-node-drag'

/**
 * 画布最底下的那层 svg：结构装饰线 / 边界 / 概要 / 树上连线（自 `Canvas.tsx` 整块搬出，逐字未改）。
 *
 * JSX 一个字没动，外面只包了一层 Fragment（不产生 DOM 节点）——`canvas__world` 里仍然是
 * 「一个 `svg.canvas__edges`」，DOM 结构与搬迁前完全一致。
 *
 * `renderEdge` 随层一起搬进来：它只被这一层用（静态连线层与拖拽层共用同一条路径函数），
 * 原来读的是画布作用域的 `layout` / `colors`，现在同名从 props 进来，函数体一字未改。
 *
 * **没有 `memo`**：父组件传进来的都是它自己的值，本层不做浅比较优化，`TopicNode` 的浅比较面
 * 因此一点没变（§四.3 第 4 条）。
 */

type Edges = LayoutResult['edges']

export function CanvasEdgesLayer({
  layout,
  colors,
  boundaryGroups,
  selectedOverlay,
  pickOverlay,
  setTitleEdit,
  staticEdges,
  dragEdges,
  dragSet,
  dragVisual,
  dragFocus,
  dragEdgesRef
}: {
  layout: LayoutResult
  colors: ThemeColors
  /** 同色的多个边界拼成一条 path（画布那个 memo 的结果，本层只读 `color` / `d`） */
  boundaryGroups: ReadonlyArray<{ color: string; d: string }>
  selectedOverlay: EditorState['selectedOverlay']
  pickOverlay: ReturnType<typeof useRelationshipDrag>['pickOverlay']
  setTitleEdit: ReturnType<typeof useTitleEdit>['setTitleEdit']
  staticEdges: Edges
  dragEdges: Edges
  dragSet: ReadonlySet<string> | null
  dragVisual: DragVisual | null
  dragFocus: ReadonlySet<string> | null
  dragEdgesRef: RefObject<SVGGElement | null>
}): ReactElement {
  /** 画一条树上的连线。静态层与拖拽层共用，避免样式写两遍。 */
  const renderEdge = (edge: (typeof layout.edges)[number], dim = false): ReactElement => {
    const target = layout.nodeMap.get(edge.toId)
    const isFirstLevel = Boolean(target && target.depth === 1)
    return (
      <path
        key={`${edge.fromId}->${edge.toId}`}
        d={edge.d}
        fill="none"
        stroke={branchColorOf(colors, layout, edge.toId)}
        strokeWidth={isFirstLevel ? colors.edgeWidth * 1.5 : colors.edgeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={colors.edgeOpacity * (dim ? 0.3 : 1)}
      />
    )
  }

  return (
    <>
      <svg className="canvas__edges" width={layout.bounds.width} height={layout.bounds.height}>
        {/* 结构专属的装饰线（时间轴主轴、鱼骨图主脊、括号图的括号） */}
        {layout.decorations.map((decoration, index) => (
          <path
            key={`deco-${index}`}
            d={decoration.d}
            fill="none"
            stroke={
              decoration.branchId
                ? branchColorOf(colors, layout, decoration.branchId)
                : colors.deepText
            }
            strokeWidth={colors.edgeWidth * (decoration.widthScale ?? 1)}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={decoration.dashed ? 0.5 : colors.edgeOpacity}
            strokeDasharray={decoration.dashed ? '6 5' : undefined}
          />
        ))}

        {/* 边界：同色的多个边界拼成一条 path 一次性填充，
              所以重叠区域不会被半透明叠加成更深的颜色 */}
        {boundaryGroups.map((group) => (
          <path
            key={`boundary-fill-${group.color}`}
            d={group.d}
            fill={group.color}
            fillOpacity={0.08}
            fillRule="nonzero"
            stroke={group.color}
            strokeWidth={1.5}
            strokeOpacity={0.6}
          />
        ))}

        {/* 每个边界一个透明命中区：双击即可改标题。
              单独画是为了能分辨出点中的是哪一个（填充是按颜色合并的） */}
        {layout.boundaries.map((boundary) => (
          <path
            key={`boundary-hit-${boundary.id}`}
            className="overlay-boundary-hit"
            d={boundary.d}
            fill="transparent"
            onPointerDown={(event) => pickOverlay(event, 'boundary', boundary.id)}
            onDoubleClick={() =>
              setTitleEdit({
                kind: 'boundary',
                id: boundary.id,
                x: boundary.label.x,
                y: boundary.label.y,
                anchor: 'start',
                value: boundary.title ?? ''
              })
            }
          />
        ))}

        {/* 选中边界的虚线框（与概要一致：选中就能在面板里改文字与字体） */}
        {layout.boundaries.map((boundary) =>
          selectedOverlay?.kind === 'boundary' &&
          selectedOverlay.id === boundary.id &&
          boundary.bounds ? (
            <rect
              key={`boundary-selected-${boundary.id}`}
              className="overlay-selected"
              x={boundary.bounds.x - 5}
              y={boundary.bounds.y - 5}
              width={boundary.bounds.width + 10}
              height={boundary.bounds.height + 10}
              rx={6}
            />
          ) : null
        )}

        {/* 边界标题单独画，保证文字在填充之上 */}
        {layout.boundaries.map((boundary) => {
          const boundaryText = readOverlayTextStyle(boundary.style, OVERLAY_TITLE_DEFAULTS.boundary)
          return boundary.title ? (
            <text
              key={`boundary-title-${boundary.id}`}
              className="overlay-title"
              x={boundary.label.x}
              y={boundary.label.y}
              fontSize={boundaryText.fontSize}
              fontWeight={boundaryText.bold ? 700 : 400}
              fontStyle={boundaryText.italic ? 'italic' : undefined}
              fill={
                boundaryText.color ??
                (boundary.branchId
                  ? branchColorOf(colors, layout, boundary.branchId)
                  : colors.deepText)
              }
              dominantBaseline="middle"
              onPointerDown={(event) => pickOverlay(event, 'boundary', boundary.id)}
              onDoubleClick={() =>
                setTitleEdit({
                  kind: 'boundary',
                  id: boundary.id,
                  x: boundary.label.x,
                  y: boundary.label.y,
                  anchor: 'start',
                  value: boundary.title ?? ''
                })
              }
            >
              {/* 边界标题同样支持换行（自上而下排） */}
              {overlayTitleLines(boundary.title).map((line, index) => (
                <tspan
                  key={index}
                  x={boundary.label.x}
                  dy={index === 0 ? 0 : OVERLAY_TITLE_LINE_HEIGHT}
                >
                  {line.length > 0 ? line : '\u00A0'}
                </tspan>
              ))}
            </text>
          ) : null
        })}

        {/* 概要：覆盖一组同级主题的大括号 + 概要文字。
              文字为空时也画占位文字与命中区——否则「把文字删空」之后就再也点不到它了 */}
        {layout.summaries.map((summary) => {
          const color = summary.branchId
            ? branchColorOf(colors, layout, summary.branchId)
            : colors.deepText
          const text = readOverlayTextStyle(summary.style, OVERLAY_TITLE_DEFAULTS.summary)
          const selected = selectedOverlay?.kind === 'summary' && selectedOverlay.id === summary.id
          const labelSize = summary.labelSize ?? { width: 48, height: OVERLAY_TITLE_LINE_HEIGHT }
          const labelLeft =
            summary.anchor === 'start'
              ? summary.label.x
              : summary.anchor === 'end'
                ? summary.label.x - labelSize.width
                : summary.label.x - labelSize.width / 2
          const openEditor = (): void =>
            setTitleEdit({
              kind: 'summary',
              id: summary.id,
              x: summary.label.x,
              y: summary.label.y,
              anchor: summary.anchor,
              value: summary.title ?? ''
            })
          const pick = (event: ReactPointerEvent<SVGElement>): void =>
            pickOverlay(event, 'summary', summary.id)
          return (
            <g key={`summary-${summary.id}`}>
              <path
                d={summary.d}
                fill="none"
                stroke={color}
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeOpacity={0.75}
              />
              {/* 命中区：括号线（按描边命中）+ 文字块矩形（空文字时也能点到） */}
              <path
                d={summary.d}
                fill="none"
                stroke="transparent"
                strokeWidth={12}
                className="overlay-hit"
                onPointerDown={pick}
                onDoubleClick={openEditor}
              />
              <rect
                x={labelLeft - 3}
                y={summary.label.y - labelSize.height / 2 - 3}
                width={labelSize.width + 6}
                height={labelSize.height + 6}
                fill="transparent"
                className="overlay-hit"
                onPointerDown={pick}
                onDoubleClick={openEditor}
              />
              <text
                className="overlay-title"
                x={summary.label.x}
                y={summary.label.y}
                fontSize={text.fontSize}
                fontWeight={text.bold ? 700 : 400}
                fontStyle={text.italic ? 'italic' : undefined}
                fill={text.color ?? color}
                textAnchor={summary.anchor}
                dominantBaseline="middle"
                /* 用画布色给文字描一圈边，即使压到别的内容上也读得清 */
                stroke={colors.canvas}
                strokeWidth={4}
                paintOrder="stroke"
                strokeLinejoin="round"
                /* 空文字时用半透明占位，提示「双击可以输入」 */
                opacity={summary.title ? 1 : 0.45}
                pointerEvents="none"
              >
                {summary.title
                  ? overlayTitleLines(summary.title).map((line, index, all) => (
                      <tspan
                        key={index}
                        x={summary.label.x}
                        dy={
                          index === 0
                            ? -(all.length - 1) * (OVERLAY_TITLE_LINE_HEIGHT / 2)
                            : OVERLAY_TITLE_LINE_HEIGHT
                        }
                      >
                        {line.length > 0 ? line : '\u00A0'}
                      </tspan>
                    ))
                  : '概要（双击输入）'}
              </text>
              {selected && summary.bounds ? (
                <rect
                  className="overlay-selected"
                  x={summary.bounds.x - 5}
                  y={summary.bounds.y - 5}
                  width={summary.bounds.width + 10}
                  height={summary.bounds.height + 10}
                  rx={4}
                />
              ) : null}
            </g>
          )
        })}

        {staticEdges.map((edge) =>
          renderEdge(edge, dragFocus !== null && !dragFocus.has(edge.toId))
        )}

        {/*
            子树内部的连线：跟着被拖的节点一起平移重画。
            位移由 `applyGhostTransform` **命令式**写（React 不管这个 transform——
            否则它每帧会用上一帧的状态盖回来，节点反而抖）。
          */}
        {dragSet && dragVisual ? (
          <g ref={dragEdgesRef} opacity={0.9}>
            {dragEdges.map((edge) => renderEdge(edge))}
          </g>
        ) : null}
      </svg>
    </>
  )
}
