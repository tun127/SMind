/**
 * 富文本 run → 解析后的样式（由 render/measure.ts 按行范围搬出，行为零变化）。
 * 基准样式由入口按层级给出，这里只负责"run 上的显式格式如何覆盖基准"。
 */
import type { RichTextParagraph, RichTextRun } from '@shared/model/types'
import { SCRIPT_FONT_RATIO } from '@shared/richtext'
import { splitInlineMath } from '@shared/formula'
import {
  BULLET_PREFIX,
  FONT_FAMILY,
  inlineFormulaSize,
  type BaseStyle,
  type ResolvedStyle,
  type StyledChar
} from './text-metrics'

export function baseResolved(base: BaseStyle): ResolvedStyle {
  return {
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    fontSize: base.fontSize,
    weight: base.weight,
    fontFamily: FONT_FAMILY
  }
}

export function resolveRun(run: RichTextRun, base: BaseStyle): ResolvedStyle {
  const bold = Boolean(run.bold)
  const raw = run.fontSize && run.fontSize > 0 ? run.fontSize : base.fontSize
  return {
    bold,
    italic: Boolean(run.italic),
    underline: Boolean(run.underline),
    strike: Boolean(run.strike),
    // 上下标按比例缩小字号参与排版：渲染端直接画这个字号，只是再上下偏移
    fontSize: run.script ? Math.max(8, Math.round(raw * SCRIPT_FONT_RATIO)) : raw,
    weight: bold ? Math.max(base.weight, 700) : base.weight,
    fontFamily: run.fontFamily && run.fontFamily.length > 0 ? run.fontFamily : FONT_FAMILY,
    highlight: run.highlight || undefined,
    script: run.script,
    /**
     * 字体颜色必须**带进测量结果**：画布不是画 tiptap 的 DOM，而是按
     * `node.lines[].segments` 自己渲染（`segmentStyle` 直接用 `segment.color`）。
     * 这里以前漏了这一行，于是 `segmentOf` 写出的永远是 `color: undefined`——
     * 表现就是用户报的：「编辑态里颜色是对的，Enter 一提交就恢复黑色」
     * （编辑态是 tiptap 在渲染，只有它认识这个颜色），导出 SVG/PNG 同样丢色。
     * 没显式颜色的 run 保持 undefined，好让 DOM 继承主题的节点文字颜色。
     */
    color: run.color || undefined
  }
}

export function charsOfParagraph(paragraph: RichTextParagraph, base: BaseStyle): StyledChar[] {
  const chars: StyledChar[] = []
  if (paragraph.bullet) {
    const style = baseResolved(base)
    for (const ch of BULLET_PREFIX) chars.push({ ch, style })
  }
  for (const run of paragraph.runs) {
    const style = resolveRun(run, base)
    // 行内公式（`$…$`）拆成独立的「原子块」，宽度按 KaTeX 实测
    for (const segment of splitInlineMath(run.text)) {
      if (segment.formula) {
        const size = inlineFormulaSize(segment.formula, style.fontSize)
        chars.push({
          ch: `$${segment.formula}$`,
          style,
          formula: segment.formula,
          formulaWidth: size.width,
          formulaHeight: size.height
        })
        continue
      }
      for (const ch of segment.text ?? '') chars.push({ ch, style })
    }
  }
  return chars
}
