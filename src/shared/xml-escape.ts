/**
 * XML 文本 / 属性转义。
 *
 * 与 `richtext` 里的 HTML 转义是两回事：HTML 那份用于拼给编辑器与备注，
 * 这份用于 OPML 与 SVG 导出——它们的实体语法虽然相似，但**不该互相借用**，
 * 否则哪天为了迁就 HTML（比如不转单引号）会悄悄破坏 XML 的合法性。
 *
 * 抽成一处是因为之前有两份几乎一样的实现（outline 与 svg 导出），
 * 改一处忘另一处的风险是实打实的。
 */

/** 文本节点：只处理会破坏结构的三个字符 */
export function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 属性值：在文本转义基础上补上两种引号（属性可能是单引号或双引号包裹的） */
export function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
