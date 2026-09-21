/**
 * 「节点属性」面板里代码块草稿 → 该写进 store 的值。
 *
 * 为什么单拎出来当纯函数：面板里**有两个**入口都会写代码块（语言下拉的 onChange、
 * 代码输入框的 onBlur），而「什么都没输入」与「选了个语言」必须分得开 —— 判据写错一次，
 * 就会在用户什么都没输入的情况下凭空插入一个空代码块。抽成纯函数才钉得住（自检直接覆盖）。
 *
 * 返回三态：
 * - `undefined` → 什么都不做（草稿还没成为内容）
 * - `null` → 移除代码块
 * - `{ language, text }` → 写入
 */
import type { TopicCode } from '@shared/model/types'

export type CodeDraftPatch = undefined | null | TopicCode

export function codeDraftPatch(
  current: TopicCode | undefined,
  draftText: string,
  draftLanguage: string
): CodeDraftPatch {
  const text = draftText.replace(/\s+$/, '')
  const currentText = current?.text ?? ''
  const currentLanguage = current?.language ?? 'text'
  if (currentText === text && currentLanguage === draftLanguage) return undefined

  /**
   * 没有既有代码块、也没有任何文字 → 不新建。
   *
   * 这一条是 2026-09-21 的缺陷修复（用户报「点公式插入却凭空出现 python 代码块」）：
   * 语言下拉的初始值来自「默认样式」设置（常见是 python），而点「公式」会把焦点从
   * 代码输入框拿走 → 触发它的 onBlur 提交；空文本 + 非 text 语言恰好满足
   * `setCode` 的"有语言就算有代码块"，于是凭空长出一个空代码块、节点跟着变高。
   * 现在判据只看**有没有内容**：想先选语言再写代码也行，写完失焦时一样带上所选语言。
   */
  if (text.length === 0 && !current) return undefined

  if (text.length === 0 && draftLanguage === 'text') return null
  return { language: draftLanguage, text }
}
