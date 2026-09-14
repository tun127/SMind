/**
 * 渲染层的「默认值」：由「设置」驱动，作用于**没有显式对齐**的所有段落。
 *
 * 为什么放在这里而不是写进每个节点：对齐本来是段落级的（RichText 的 align），
 * 纯文本节点根本没有段落级样式——默认值必须由测量/渲染的兜底逻辑提供。
 * 改默认值时调用方要顺带 `bumpMeasureEpoch()`，否则测量缓存里还是旧对齐。
 */
export type TextAlign = 'left' | 'center' | 'right'

let defaultTextAlign: TextAlign = 'center'

export function setDefaultTextAlign(align: TextAlign): void {
  defaultTextAlign = align
}

export function defaultTextAlignOf(): TextAlign {
  return defaultTextAlign
}
