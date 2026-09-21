/**
 * 「等宽」在代码库里的**唯一表示**。
 *
 * 富文本模型（`RichTextRun`）没有 `mono` 字段，行内代码就是"字体族是等宽字体"：
 * Markdown 导入把 `` `code` `` 写成 `fontFamily`（`import/markdown/inline.ts`），
 * 导出时再用 `isMonoFontFamily` 把它还原成 `` `code` ``（`outline/index.ts`），
 * 编辑器那头的 TipTap 用 `code` mark 表示 —— 两边由 `richtext/index.ts` 对齐。
 *
 * 这个常量原先住在 `import/markdown/inline.ts`，但 richtext 数据层反过来 import 它会形成
 * 「数据层 → 导入器」的反向依赖；所以提到这里：中立模块，谁都能引，它自己不引任何人。
 */

/** 行内代码的等宽字体栈（测量、渲染、编辑器、导出看到的必须是同一个值） */
export const MD_MONO_FONT = 'Consolas, "JetBrains Mono", Menlo, monospace'

/**
 * 判断一个 `fontFamily` 是不是「等宽」。
 *
 * 判据与 Markdown 导出保持一致（`/mono/i`）：只要字体栈里带 `mono` 就算 ——
 * 这样用户从格式栏挑了别的等宽字体（`Fira Code, monospace`）也能被认出来。
 */
export function isMonoFontFamily(value: unknown): boolean {
  return typeof value === 'string' && /mono/i.test(value)
}
