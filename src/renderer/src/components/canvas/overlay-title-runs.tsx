import type { ReactElement } from 'react'
import { OVERLAY_TITLE_LINE_HEIGHT, overlayRunLines } from '@shared/layout/overlays'
import type { RichText } from '@shared/model/types'

/**
 * 画布级元素标题的「行 → tspan」渲染（关系线 / 边界 / 概要共用）。
 *
 * 为什么单独一个组件：三处原来是各写一段 `overlayTitleLines(...).map(...)`，
 * 富文本要按 run 再切一层（`overlayRunLines`），三份各写一遍必然走形。
 *
 * 高亮在 SVG 里**没有背景色**，这里用「同色描边加粗一圈」近似荧光笔 ——
 * 真画背景矩形得先把每段量宽，而测量要 DOM（布局层没有），
 * 为一块底色把测量链路引进来不划算；近似方案在画布与导出里观感一致。
 */
export function OverlayTitleRuns({
  x,
  rich,
  title,
  fill,
  fontSize,
  dyOf
}: {
  x: number
  /** 富文本（部分文字加粗 / 变色 / 高亮）；缺省时按纯文本渲染 */
  rich: RichText | undefined
  title: string | undefined
  /** 整段文字的默认颜色（run 自带颜色优先） */
  fill: string
  /** 整段文字的默认字号（run 自带字号优先） */
  fontSize: number
  /** 第 index 行相对基线／中线的偏移 */
  dyOf(index: number, total: number): number
}): ReactElement {
  const lines = overlayRunLines(rich, title)
  return (
    <>
      {lines.map((runs, index) => (
        <tspan key={index} x={x} dy={dyOf(index, lines.length)}>
          {runs.length === 0
            ? '\u00A0'
            : runs.map((run, runIndex) => (
                <tspan
                  key={runIndex}
                  fontWeight={run.bold ? 700 : undefined}
                  fontStyle={run.italic ? 'italic' : undefined}
                  fill={run.color ?? fill}
                  fontSize={run.fontSize ?? fontSize}
                  {...(run.highlight
                    ? {
                        stroke: 'rgba(255, 214, 0, 0.85)',
                        strokeWidth: (run.fontSize ?? fontSize) * 0.5,
                        paintOrder: 'stroke' as const,
                        strokeLinejoin: 'round' as const
                      }
                    : {})}
                >
                  {run.text}
                </tspan>
              ))}
        </tspan>
      ))}
    </>
  )
}

/** 三种元素共用的行偏移规则：整块垂直居中（关系线 / 概要） */
export function centeredTitleDy(index: number, total: number): number {
  return index === 0 ? -((total - 1) * OVERLAY_TITLE_LINE_HEIGHT) / 2 : OVERLAY_TITLE_LINE_HEIGHT
}

/** 边界标题：自上而下排（基线在第一行） */
export function stackedTitleDy(index: number): number {
  return index === 0 ? 0 : OVERLAY_TITLE_LINE_HEIGHT
}
