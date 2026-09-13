/**
 * 「选中主题后直接打字就进入编辑」那一下敲的字符，先在这里**寄存**一笔。
 *
 * 为什么需要它 —— 中文输入法组词时，拼音的第一个字母会先送来一个"看起来完全正常"的
 * `keydown`（`isComposing` 是 false、`keyCode` 也不是 229），紧跟着才是 `compositionstart`。
 * 我们要是把它当普通字符写进节点，用户就会在空白框里看到凭空多出来的 `w` 之类的怪字符。
 *
 * 所以落字的同时记下「这个字符是我塞的、塞在哪个节点上」；
 * 编辑器一旦发现真正的组词开始，就把这个字符**选中**让输入法的组词直接替换掉它
 *（组词结束还没被替换掉的话，再兜底删掉），节点里就永远不会留下那个多余字母。
 */
let staged: { id: string; ch: string } | null = null

/** 记下刚刚由按键注入的字符 */
export function stageTypedChar(id: string, ch: string): void {
  staged = { id, ch }
}

/**
 * 取走寄存的字符（**取走即清空**）。
 *
 * 只有在同一个节点上才认：中途换了编辑对象时，那一笔已经作废了。
 */
export function takeTypedChar(id: string): string | null {
  const current = staged
  staged = null
  if (!current || current.id !== id) return null
  return current.ch
}

/** 放弃寄存（例如没进编辑态、或已经处理过） */
export function clearTypedChar(): void {
  staged = null
}
