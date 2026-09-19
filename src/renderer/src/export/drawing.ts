/**
 * 导出用的「绘图操作」构建器。
 *
 * 思路：把布局结果（node 坐标/尺寸/断行/分段样式/图片框/公式框 + 连线/边界/概要）
 * 翻译成一串与具体输出格式无关的绘制指令，然后由两个后端分别消费：
 *   - svg.ts：生成矢量 SVG
 *   - raster.ts：用 Canvas 2D 画成位图（供 PNG 用，以及 PDF 的回落路径）
 * SVG 还有第二个去处：主进程用它转**矢量 PDF**（`svgToPdf`），所以 PDF 默认是矢量的。
 * 这样「画布上看到的」与「导出的」用的是同一份布局数据，不会出现两套排版。
 *
 * 本文件是纯函数（不碰 DOM），可以在自检里直接断言生成的指令。
 */

import { OVERLAY_TITLE_LINE_HEIGHT, overlayTitleLines } from '@shared/layout/overlays'
import { readOverlayTextStyle } from '@shared/model/overlay-style'
import { branchColorOf } from '../render/theme'

/* ---- A2 拆分：类型与节点绘制搬进子模块；入口保留同名再导出，调用点零改动 ---- */
import { arrowPath, nodeOps, textAnchorOf } from './node'
import type { BuildDrawingInput, DrawOp, Drawing } from './ops'
export * from './ops'

/* ------------------------------------------------------------------ */
/* 构建                                                                */
/* ------------------------------------------------------------------ */

export function buildDrawing(input: BuildDrawingInput): Drawing {
  const { layout, colors } = input
  const ops: DrawOp[] = []

  // 1. 连线（在节点下面）
  for (const edge of layout.edges) {
    const target = layout.nodeMap.get(edge.toId)
    const firstLevel = Boolean(target && target.depth === 1)
    ops.push({
      kind: 'path',
      d: edge.d,
      stroke: branchColorOf(colors, layout, edge.toId),
      strokeWidth: firstLevel ? colors.edgeWidth * 1.5 : colors.edgeWidth,
      opacity: colors.edgeOpacity
    })
  }

  if (input.includeOverlays !== false) {
    // 2. 结构装饰线（时间轴主轴、鱼骨主脊、括号）
    for (const decoration of layout.decorations) {
      ops.push({
        kind: 'path',
        d: decoration.d,
        stroke: decoration.branchId
          ? branchColorOf(colors, layout, decoration.branchId)
          : colors.deepText,
        strokeWidth: colors.edgeWidth * (decoration.widthScale ?? 1),
        opacity: decoration.dashed ? 0.5 : colors.edgeOpacity,
        dash: decoration.dashed ? '6 5' : undefined
      })
    }

    // 3. 边界：填充 + 描边
    for (const boundary of layout.boundaries) {
      const color = boundary.branchId
        ? branchColorOf(colors, layout, boundary.branchId)
        : colors.deepText
      ops.push({
        kind: 'path',
        d: boundary.d,
        fill: color,
        fillOpacity: 0.08,
        stroke: color,
        strokeWidth: 1.5,
        strokeOpacity: 0.6
      })
      if (boundary.title) {
        const boundaryStyle = readOverlayTextStyle(boundary.style, { fontSize: 12, bold: true })
        ops.push({
          kind: 'text',
          x: boundary.label.x,
          y: boundary.label.y,
          text: boundary.title,
          fontSize: boundaryStyle.fontSize,
          fontWeight: boundaryStyle.bold ? 700 : 400,
          italic: boundaryStyle.italic || undefined,
          fill: boundaryStyle.color ?? color,
          anchor: 'start',
          baseline: 'middle'
        })
      }
    }

    // 4. 概要：大括号 + 文字（文字描一圈画布底色，压到别的内容上也读得清）
    for (const summary of layout.summaries) {
      const color = summary.branchId
        ? branchColorOf(colors, layout, summary.branchId)
        : colors.deepText
      ops.push({
        kind: 'path',
        d: summary.d,
        stroke: color,
        strokeWidth: 1.6,
        strokeOpacity: 0.75
      })
      if (summary.title) {
        // 多行标题逐行画，整体以 label.y 为中线居中（与画布上的 tspan 排法一致）
        const lines = overlayTitleLines(summary.title)
        const textStyle = readOverlayTextStyle(summary.style, { fontSize: 13, bold: true })
        const startY = summary.label.y - ((lines.length - 1) * OVERLAY_TITLE_LINE_HEIGHT) / 2
        lines.forEach((line, index) => {
          if (line.length === 0) return
          ops.push({
            kind: 'text',
            x: summary.label.x,
            y: startY + index * OVERLAY_TITLE_LINE_HEIGHT,
            text: line,
            fontSize: textStyle.fontSize,
            fontWeight: textStyle.bold ? 700 : 400,
            italic: textStyle.italic || undefined,
            fill: textStyle.color ?? color,
            anchor: textAnchorOf(
              summary.anchor === 'middle' ? 'center' : summary.anchor === 'end' ? 'right' : 'left'
            ),
            baseline: 'middle',
            stroke: input.background ?? '#ffffff',
            strokeWidth: 4
          })
        })
      }
    }
  }

  // 5. 节点
  for (const node of layout.nodes) nodeOps(node, layout, colors, input, ops)

  if (input.includeOverlays !== false) {
    // 6. 关系线画在节点之上
    for (const relationship of layout.relationships) {
      const color = relationship.branchId
        ? branchColorOf(colors, layout, relationship.branchId)
        : colors.deepText
      ops.push({ kind: 'path', d: relationship.d, stroke: color, strokeWidth: 1.8 })
      ops.push({
        kind: 'path',
        d: arrowPath(relationship.arrow.x, relationship.arrow.y, relationship.arrow.angle),
        fill: color
      })
      if (relationship.title) {
        ops.push({
          kind: 'text',
          x: relationship.label.x,
          y: relationship.label.y,
          text: relationship.title,
          fontSize: 12,
          fontWeight: 600,
          fill: color,
          anchor: 'middle',
          baseline: 'middle',
          stroke: input.background ?? '#ffffff',
          strokeWidth: 4
        })
      }
    }
  }

  return {
    width: layout.bounds.width,
    height: layout.bounds.height,
    background: input.background,
    ops
  }
}
