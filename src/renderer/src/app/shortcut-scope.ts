/**
 * 「这次按键该不该由全局快捷键接管」的判据。
 *
 * 抽成纯函数的理由：这条判据以前是内联在 `use-keyboard-shortcuts.ts` 里的一大段 if，
 * 一改动就没法验证 —— 而它恰好管着"编辑标题时 Ctrl+S 到底有没有反应"，
 * 值得被自检钉住（传进来的 target 只要有个 `tagName` / `isContentEditable` 就够，不需要 DOM）。
 *
 * 2026-09-21 修的缺陷：原来只要焦点在 INPUT / TEXTAREA / SELECT / contenteditable 上，
 * 整个 `onKeyDown` 直接 return —— 于是**在标题编辑器里按 Ctrl+S 保存没反应**，
 * 用户必须先点一下画布空白处才能保存。现在的分档是：
 *   · 单键（含 Alt 组合）→ 一律不接管（那是用户正在输入，抢走会变成删节点 / 加主题）；
 *   · 编辑类组合键（复制 / 粘贴 / 剪切 / 全选 / 撤销 / 重做）→ 交还给控件/编辑器本身
 *     （标题编辑器里 Ctrl+V 必须粘贴文字，不能被 store.paste() 抢走）；
 *   · 其余 Ctrl/⌘ 组合（保存、另存、打开、搜索、新建…）→ **照旧归应用层**。
 */

export interface ShortcutTargetLike {
  tagName?: string
  isContentEditable?: boolean
}

export interface ShortcutKeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
}

/** 焦点是否落在"用户正在输入"的地方（输入框 / 文本域 / 下拉 / 富文本编辑器） */
export function isEditableTarget(target: ShortcutTargetLike | null | undefined): boolean {
  if (!target) return false
  const tag = (target.tagName ?? '').toUpperCase()
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true
  )
}

/**
 * 输入处**必须交还**给控件自己的组合键：复制 / 粘贴 / 剪切 / 全选 / 撤销 / 重做。
 * 这几个键在任何输入场景下都只有一个含义 —— 操作文字本身。
 */
const EDITING_COMBOS = ['c', 'v', 'x', 'a', 'z', 'y']

/** 这次按键该不该走全局快捷键（false = 让给输入控件 / 富文本编辑器） */
export function shouldHandleGlobalShortcut(
  target: ShortcutTargetLike | null | undefined,
  key: ShortcutKeyLike
): boolean {
  if (!isEditableTarget(target)) return true
  const combo = key.ctrlKey || key.metaKey
  if (!combo) return false
  return !EDITING_COMBOS.includes(key.key.toLowerCase())
}
