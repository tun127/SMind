/**
 * 编辑态**宽度提示**（只服务编辑态显示，不进文档、不改测量）。
 *
 * 问题：编辑区里"还没提交进文档"的文本（输入法组词中、以及组词结束但未按 Enter 的草稿）
 * 只存在于 DOM 里 —— ProseMirror 要到提交才把它同步进文档，而编辑框宽度来自布局测量
 * （`use-canvas-layout.ts` 拿 `editingText` 量节点宽）。于是这段时间 `editingText` 没变 →
 * 宽度按旧的（更窄的）文字算 → 拼音折成多行。
 *
 * **两代做法的差别（血泪）**
 * - 第一代（`515aac2` / A3）：只放开 `max-width` → 被 flex-shrink 抵消，真机无效。
 * - 第二代（`cb98bd9`）：组词期加 `flex: 0 0 auto` + 按 `compositionupdate.data` 算加宽，
 *   **但 `compositionend` 一到就把宽度归零** → 未提交的草稿立刻被挤回节点内宽。
 *   用户看到的是"没按 Enter 会扁、按了才正常"（报告 §18，真实输入法 80 条事件的实测）。
 * - **第三代（现在）：宽度由"编辑区当前内容需要多宽"决定**（`draftBoxWidth`），
 *   与组词事件的时序彻底解耦 —— 组词中 / 组词后未提交 / 纯键盘草稿，三种状态一并覆盖。
 *
 * 仍不做的事：把草稿文本接进 `use-canvas-layout` 的测量（那才会让**节点框**也变宽）。
 * 代价是改测量链路，收益只是"框跟着变宽"，属报告 D-07 的第 2 档治本，留待需要时再做。
 */
import { FONT_FAMILY, cssFontOf } from '../render/measure/text-metrics'

/** 组词期的宽度上限对齐测量用的上限（中心主题更宽，由调用方传 TEXT_MAX_ROOT / TEXT_MAX） */
export function compositionBoxWidth(base: number, extra: number, cap: number): number {
  if (!Number.isFinite(extra) || extra <= 0) return base
  return Math.min(cap, Math.ceil(base + extra))
}

/**
 * 编辑框应有的宽度 = max(测得宽度, **当前内容所需宽度**)，并封顶在 `cap`。
 *
 * 两条不变量（自检钉住，见 `scripts/selfcheck/domains/ui.ts`）：
 * 1. **绝不小于测得宽度** —— 否则会与提交后的排版打架（编辑态比提交后更窄，看起来像"跳了一下"）；
 * 2. **绝不小于内容所需** —— 这正是 D-07 的判据：组词结束、内容还在编辑区里时，宽度不得缩回。
 *
 * `contentWidth + 1` 与 `textWidth` 里的 `+1` 是同一种余量（给小数宽度留位，免得最后一个字被挤下去）。
 */
export function draftBoxWidth(textWidth: number, contentWidth: number, cap: number): number {
  const want = Math.max(textWidth, Math.ceil(Math.max(0, contentWidth)) + 1)
  return Math.min(cap, want)
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
