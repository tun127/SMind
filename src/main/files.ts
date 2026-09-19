/**
 * 从「打开 / 保存对话框」的结果里取用户选中的第一个路径。
 *
 * 各处原本都写成「先判 `filePaths.length === 0`、再取 `filePaths[0]`」——
 * 逻辑没错，但取下标那一步没有类型保证，于是这段判断在每个调用点都重复了一遍。
 * 收成一个函数：判断只写一次，也不会再出现"忘了判"的新代码。
 */
export function firstPathOf(result: { canceled: boolean; filePaths: string[] }): string | null {
  if (result.canceled) return null
  return result.filePaths[0] ?? null
}

export function ensureXmindExt(p: string): string {
  return p.toLowerCase().endsWith('.xmind') ? p : `${p}.xmind`
}
