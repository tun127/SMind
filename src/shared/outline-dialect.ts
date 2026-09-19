/**
 * 大纲方言的**共享原语**。
 *
 * 为什么单独一份：AI 返回的大纲（`ai/outline.ts`）与 Markdown 导入（`import/markdown.ts`）
 * 解析的是**同一套缩进大纲语法**，但两处各写了一遍规则，只靠注释里的约定保证一致
 * （`ai/outline.ts` 的注释就是这么写的："与 Markdown 导入共用一种语法"——可没人强制它）。
 * 一旦某处改了制表符宽度或缩进级别，两边的层级就会悄悄错开：同一份文本从 AI 直接生成
 * 与从 Markdown 导入会长出不同的树。
 *
 * 这里只放**两边都必须一致**的东西（制表符宽度、缩进→层级、项目符号词汇表）。
 * 各自特有的策略仍留在各自文件里（比如导入器要处理 `- [x]` 任务列表、公式整行、
 * 内联语法，AI 大纲要处理 `**加粗**` 与分隔行）——共用原语不等于合并解析器。
 */

/** 制表符宽度（格）：缩进大纲里 tab 一律当两个空格 */
export const TAB_WIDTH = 2

/** 制表符展开成空格（展开后再数缩进，才能和"用空格缩进"的文本走同一套规则） */
export function expandTabs(line: string): string {
  return line.replace(/\t/g, ' '.repeat(TAB_WIDTH))
}

/** 行首缩进宽度（要求**已展开制表符**） */
export function indentWidthOf(expanded: string): number {
  return expanded.length - expanded.trimStart().length
}

/** 缩进宽度 → 层级：两格一级 */
export function depthOfIndent(width: number): number {
  return Math.floor(width / TAB_WIDTH)
}

/* ------------------------------------------------------------------ */
/* 项目符号词汇表（两处解析器共用，避免一边认 `•` 另一边不认）          */
/* ------------------------------------------------------------------ */

/** 无序项目符号：`- * + •`，后面必须跟空白 */
export const BULLET_MARKER = /^[-*+•]\s+/
/** 有序项目符号：`1.` `1)` `1、`，后面的空白可有可无（模型常漏） */
export const ORDERED_MARKER = /^\d+[.)、]\s*/
/** ATX 标题：`#` 到 `######`，后面必须跟空白 */
export const HEADING_MARKER = /^#{1,6}\s+/

/** 是不是"带标记的大纲行"（用于判断这一行像主题还是像解释文字） */
export function hasOutlineMarker(body: string): boolean {
  return BULLET_MARKER.test(body) || ORDERED_MARKER.test(body) || HEADING_MARKER.test(body)
}
