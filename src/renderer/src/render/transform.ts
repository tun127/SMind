/**
 * 位移字符串的**两套语法**（都在这一个文件里，免得又混用）。
 *
 * 同一个 `translate(...)`，写进 CSS 与写进 SVG 属性是**两种语法**：
 *
 * - CSS 的 `transform` 样式**必须带单位**：`translate(-2.66px, -124px)`；
 * - SVG 的 `transform` 属性**不能带单位**：`translate(-2.66, -124)`。
 *
 * 踩过的坑：命令式拖拽把 CSS 那套写进了 SVG 的 `<g transform>`，结果属性解析失败
 * （控制台每帧一条 `<g> attribute transform: Expected ')'`），拖拽连线层根本不动，
 * 而且每帧报错 + 转发日志把帧预算也烧掉了——表现就是"拖拽还是不同步"。
 * 抽成具名函数之后，自检能把"谁带单位、谁不带"钉住。
 */

/** CSS 的 transform 样式值（带单位） */
export function cssTranslate(dx: number, dy: number): string {
  return `translate(${dx}px, ${dy}px)`
}

/** SVG 的 transform 属性值（不带单位） */
export function attrTranslate(dx: number, dy: number): string {
  return `translate(${dx}, ${dy})`
}
