/**
 * 编辑态**宽度提示**（只服务编辑态显示，不进文档、不改测量）。
 *
 * 问题：编辑区里"还没提交进文档"的文本（输入法组词中、以及组词结束但未按 Enter 的草稿）
 * 只存在于 DOM 里 —— ProseMirror 要到提交才把它同步进文档，而编辑框宽度来自布局测量
 * （`use-canvas-layout.ts` 拿 `editingText` 量节点宽）。于是这段时间 `editingText` 没变 →
 * 宽度按旧的（更窄的）文字算 → 拼音折成多行。
 *
 * **三代做法的差别（血泪，报告 D-07 / §18）**
 * - 第一代（`515aac2` / A3）：只放开 `max-width` → 被 flex-shrink 抵消，真机无效。
 * - 第二代（`cb98bd9`）：组词期加 `flex: 0 0 auto` + 按 `compositionupdate.data` 算加宽，
 *   **但 `compositionend` 一到就把宽度归零** → 未提交的草稿立刻被挤回节点内宽。
 *   用户看到的是"没按 Enter 会扁、按了才正常"。
 * - **第三代（现在）：宽度由"编辑区当前内容需要多宽"决定**（`draftBoxWidth` + `measureContentWidth`），
 *   与组词事件的时序彻底解耦 —— 组词中 / 组词后未提交 / 纯键盘草稿，三种状态一并覆盖。
 *
 * **量宽为什么必须用 DOM 探针而不是 canvas**：canvas 只认得 `font` 简写，**拿不到字距等继承样式**。
 * 实测（2026-09-21）：18 个字符 canvas 量出 223px、真实渲染需要 ~227px → 写进 224px 后仍折成 2 行；
 * 而"差几个像素"在这个场景里就是"一行"与"两行"的区别。探针 span 插在编辑区里、样式全部继承，
 * 量出来的就是真实渲染宽度。
 *
 * 仍不做的事：把草稿文本接进 `use-canvas-layout` 的测量（那才会让**节点框**也变宽）。
 * 代价是改测量链路，收益只是"框跟着变宽"，属报告 D-07 的第 2 档治本，留待需要时再做。
 */

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

/**
 * 量一段文本在**这个编辑区里**渲染出来需要多宽。
 *
 * 探针 span 插进 `host`（编辑区）里，因此字体族 / 字号 / 字重 / 字距 / 变体全部继承，
 * 量的就是真实渲染宽度 —— 这是 canvas 估宽做不到的（见文件头）。
 * `white-space: pre` 保证不被探针自己的换行影响；`visibility: hidden` + 移出视口，不闪不挡。
 */
export function measureContentWidth(host: HTMLElement, text: string): number {
  if (text.length === 0) return 0
  const probe = document.createElement('span')
  probe.textContent = text
  probe.style.cssText =
    'position:absolute;left:-99999px;top:0;visibility:hidden;white-space:pre;padding:0;margin:0;border:0'
  host.appendChild(probe)
  const width = probe.getBoundingClientRect().width
  probe.remove()
  return width
}
