/**
 * 对话框结果与扩展名的小助手（主进程，**不依赖 Electron**）。
 *
 * 为什么单独一个文件：它们原来住在 `files.ts` 里，而那个文件 import 了 `./history`
 * （`history.ts` 又 import `electron`）——自检是纯 Node，一 import 就会把 Electron 拖进来，
 * 于是这两个判断永远进不了回归网。**把判断与 IO 分开**是这一批「让主进程也能被自检覆盖」的通用做法
 * （先例：`shared/update-policy.ts`、`main/doc-resources.ts`）。
 */

/**
 * 从「打开 / 保存对话框」的结果里取用户选中的第一个路径。
 *
 * 各处原本都写成「先判 `filePaths.length === 0`、再取 `filePaths[0]`」——
 * 逻辑没错，但取下标那一步没有类型保证，于是这段判断在每个调用点都重复了一遍。
 * 收成一个函数：判断只写一次，也不会再出现"忘了判"的新代码。取消 / 没选都返回 null。
 */
export function firstPathOf(result: { canceled: boolean; filePaths: string[] }): string | null {
  if (result.canceled) return null
  return result.filePaths[0] ?? null
}

/** 补上 `.xmind` 扩展名（已经有了就不动，大小写不敏感） */
export function ensureXmindExt(p: string): string {
  return p.toLowerCase().endsWith('.xmind') ? p : `${p}.xmind`
}
