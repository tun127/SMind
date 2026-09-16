/**
 * 标签文字过长时的「截断 + 省略号」。
 *
 * 为什么必须在这里截断、而不是靠 CSS 的 `overflow: hidden`：
 * 渲染层只是把测量结果里的文字画出来，CSS 裁掉的是**像素**——
 * 用户看到的是**半个字被切掉**（"标签被截断"的观感就是这么来的）。
 * 在这里按真实字宽逐字试，画出来的一定是完整字形，宽度与测量也严格一致。
 *
 * 字宽由调用方注入（渲染层用 Canvas 的 measureText，测试里用固定表），
 * 所以这个模块是纯函数、不依赖 DOM。
 */

export const LABEL_ELLIPSIS = '…'

export interface FittedLabel {
  /** 实际画出来的文字（截断时带省略号） */
  text: string
  /** 对应宽度（各字宽之和） */
  width: number
  /** 是否发生了截断 */
  truncated: boolean
}

/**
 * 把 `text` 塞进 `maxTextWidth`：放不下就截到能放下为止并补省略号。
 *
 * 省略号本身也占位，所以判断的是「前缀宽 + 省略号宽 <= 上限」；
 * 极端情况（一个字都放不下）只留省略号，避免出现宽度为 0 的空标签。
 */
export function fitLabelText(
  text: string,
  charWidth: (ch: string) => number,
  maxTextWidth: number
): FittedLabel {
  const chars = [...text]

  let fullWidth = 0
  for (const ch of chars) fullWidth += charWidth(ch)
  if (fullWidth <= maxTextWidth) return { text, width: fullWidth, truncated: false }

  const ellipsisWidth = charWidth(LABEL_ELLIPSIS)
  let kept = ''
  let width = 0
  for (const ch of chars) {
    const next = width + charWidth(ch)
    if (next + ellipsisWidth > maxTextWidth) break
    kept += ch
    width = next
  }
  return { text: `${kept}${LABEL_ELLIPSIS}`, width: width + ellipsisWidth, truncated: true }
}
