/**
 * 渲染层的「默认值」：由「设置」驱动，作用于**没有显式对齐**的所有段落。
 *
 * 为什么放在这里而不是写进每个节点：对齐本来是段落级的（RichText 的 align），
 * 纯文本节点根本没有段落级样式——默认值必须由测量/渲染的兜底逻辑提供。
 * 改默认值时调用方要顺带 `bumpMeasureEpoch()`，否则测量缓存里还是旧对齐。
 *
 * 初值**从设置项的默认值派生**（`DEFAULT_APP_SETTINGS.defaultAlign`）：设置读回来之前
 * 的那一小段时间用的是它，两边各写一个 `'center'` 就是一处会漂移的重复实现。
 */
import { DEFAULT_APP_SETTINGS } from '@shared/ipc'

export type TextAlign = 'left' | 'center' | 'right'

let defaultTextAlign: TextAlign = DEFAULT_APP_SETTINGS.defaultAlign

export function setDefaultTextAlign(align: TextAlign): void {
  defaultTextAlign = align
}

export function defaultTextAlignOf(): TextAlign {
  return defaultTextAlign
}
