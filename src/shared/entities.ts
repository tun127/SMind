/**
 * 数字字符引用（`&#65;` / `&#x41;`）的统一解码——**只有这一份**。
 *
 * 为什么单独收出来：原先三处各写一遍（`xmind/xml.ts`、`document/index.ts`、
 * `import/markdown.ts`），而且互不一致，其中两处是真会崩的：
 *
 * - 只判断 `Number.isFinite(code)` 或 `code > 0` 的版本，会把 `&#x110000;`
 *   直接交给 `String.fromCodePoint` —— 它**抛 RangeError**，导入一个含该引用的
 *   文件当场中断（不是"少解析一个字符"，是整段流程失败）；
 * - `document/index.ts` 的正则写成 `#x?[0-9a-fA-F]+`，`x` 是可选的，
 *   于是 `&#12ab;` 也匹配，随后按十进制 `parseInt('12ab')` 解出 **U+000C**，
 *   凭空往文本里塞一个控制字符。
 *
 * 各处的**名字表**仍然留在原文件里：那些差异是有意的
 * （`&nbsp;` 在 XML 里是 U+00A0，在「XML → 纯文本」的提取里当普通空格更合适，
 *  Markdown 那边还需要完整 HTML 名集），但**数字引用的处理没有任何理由不一致**。
 */

/**
 * 码点 → 字符；越界或非法返回 `''`（**不抛异常**，调用方据此保留原文）。
 *
 * HTML/XML 的数字引用合法区间与 Unicode 一致：`0x1`–`0x10FFFF`（0 被排除，
 * 因为 `&#0;` 在任何文档标准里都不该产出 NUL 字符）。
 */
export function charOfCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/**
 * 数字引用体 → 字符。`body` 形如 `#65` / `#x41`（不含 `&` 与 `;`）。
 *
 * 十六进制前缀**只认小写 `x`**：调用方（XML 读取、XML→文本、Markdown 行内）
 * 的正则都只匹配小写，XML 1.0 的 CharRef 也规定只写小写 `x`
 * （HTML 允许 `&#X41;`，但这三条路径都不处理 HTML 的宽松写法，这里就不做无用的放宽）。
 *
 * 不是合法的数字引用、或码点越界时返回 `null`，调用方应把 `&…;` 原样保留
 * （宁可显示成源码，也不要静默丢字符或抛异常）。
 */
export function decodeNumericEntity(body: string): string | null {
  const hex = /^#x[0-9a-fA-F]+$/.test(body)
  const dec = /^#[0-9]+$/.test(body)
  if (!hex && !dec) return null
  const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
  const char = charOfCodePoint(code)
  return char === '' ? null : char
}
