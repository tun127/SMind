/**
 * 输入法组词期的**宽度提示**（只服务编辑态显示，不进文档、不改测量）。
 *
 * 问题：组词中的文本只存在于 DOM 里 —— ProseMirror 到 `compositionend` 才把它同步进文档，
 * 而编辑框宽度来自布局测量（`use-canvas-layout.ts` 拿 `editingText` 量节点宽）。
 * 于是组词那几百毫秒里 `editingText` 没变 → 宽度冻住 → 拼音折成多行。
 * 纯 ASCII 直接敲键盘**不会**这样（每次按键都会进文档、走一遍测量），这条是组词专属。
 *
 * 处理：组词期按 `compositionupdate` 给的拼音串算一个临时加宽，`compositionend` 立刻还原。
 * 备选方案（让测量也吃 DOM 组词文本）要改测量链路，收益只是"框也跟着变宽"，
 * 代价却是把一条只在编辑态存在的临时状态塞进布局——不值当，故取最小改法。
 */
import { FONT_FAMILY, cssFontOf } from '../render/measure/text-metrics'

/** 组词期的宽度上限对齐测量用的上限（中心主题更宽，由调用方传 TEXT_MAX_ROOT / TEXT_MAX） */
export function compositionBoxWidth(base: number, extra: number, cap: number): number {
  if (!Number.isFinite(extra) || extra <= 0) return base
  return Math.min(cap, Math.ceil(base + extra))
}

let measureCtx: CanvasRenderingContext2D | null = null

/**
 * 量一段组词文本的宽度。
 *
 * 与画布测量共用同一份字体串（`cssFontOf` / `FONT_FAMILY`），免得"提示宽度"与
 * 提交后的真实宽度差太多、看起来像跳了一下。字重用 400：组词期显示的是拼音字母，
 * 与正文的字重差异在这个临时提示里可以忽略。拿不到 canvas 时返回 0（退化成不加宽）。
 */
export function composingTextWidth(text: string, fontSize: number, family = FONT_FAMILY): number {
  if (text.length === 0) return 0
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
  if (!measureCtx) return 0
  measureCtx.font = cssFontOf(fontSize, 400, false, family)
  return measureCtx.measureText(text).width
}
