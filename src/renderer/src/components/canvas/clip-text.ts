/**
 * 空位框里显示的标题：按可用宽度粗略截断，避免文字溢出虚线框。
 * 中日韩字符按整宽算，其余按半宽算。
 *
 * （自 `Canvas.tsx` 整块搬出，函数体逐字未改；它本来就是纯函数，只被 JSX 调用。）
 */
export function clipText(text: string, width: number, fontSize = 12): string {
  const plain = text.replace(/\s+/g, ' ').trim()
  const limit = Math.max(0, width - 12)
  let used = 0
  let out = ''
  for (const ch of plain) {
    const charWidth = /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? fontSize : fontSize * 0.55
    if (used + charWidth > limit) return `${out}…`
    used += charWidth
    out += ch
  }
  return out
}
