/**
 * Markdown 行内记号的转义——**导入器与导出器共用同一张表**。
 *
 * 为什么要独立成文件：这张表必须两边一致，否则往返一趟文字就变了——
 * 导出时少转义一个字符，再导入回来它就被当成格式标记；
 * 导出时多转义一个字符，导入回来就多出一个反斜杠。
 * 放在中间的叶子模块里，谁也不用依赖谁（`import/markdown.ts` 与 `outline/index.ts` 都引它）。
 */

/**
 * 这些字符在 Markdown 行内有特殊含义，写在正文里时要加反斜杠：
 * `\` `` ` `` `*` `_` `{` `}` `[` `]` `(` `)` `#` `+` `-` `.` `!` `~` `^` `=` `<` `>` `|`
 *
 * 与 CommonMark 的转义集合基本一致，另外把本项目的扩展记号
 * （`==高亮==`、`^上标^`、`~下标~`）也算了进去。
 */
export const MARKDOWN_ESCAPABLE = '\\`*_{}[]()#+-.!~^=<>|'

/** 正文 → 可安全写进 Markdown 的文本（给每个记号加反斜杠） */
export function escapeMarkdownText(text: string): string {
  let out = ''
  for (const ch of text) {
    out += MARKDOWN_ESCAPABLE.includes(ch) ? `\\${ch}` : ch
  }
  return out
}
