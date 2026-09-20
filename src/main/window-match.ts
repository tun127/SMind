/**
 * 「从外面打开一个文档」时的**窗口归属判定**（纯函数，不依赖 Electron → 可被自检覆盖）。
 *
 * 规则（与浏览器的标签一致）：已经开着这个文件的窗口 → 聚焦它、把路径推给它的渲染进程去切标签；
 * 没开过 → 交给当前聚焦的窗口开新标签；一个窗口都没有才新建窗口（后两步在 `windows.ts` 里）。
 *
 * 两个易错点，所以值得单独抽出来钉住：
 * 1. 一个窗口可以开着**多个**文档，要逐个比（不能只看窗口"当前那个"）；
 * 2. **界面进程已经没了的窗口不算**——它开着这个文件也聚焦不了（原来这层判断写在循环里，
 *    很容易在改写时丢掉）。
 */
export interface WindowOwnership {
  destroyed: boolean
  /** 该窗口打开着的所有文档路径（未保存过的新文档是 null） */
  docPaths: readonly (string | null)[]
}

/** 找出已经开着 `path` 的那个窗口；没有就返回 undefined */
export function windowOwningPath<T extends WindowOwnership>(
  windows: readonly T[],
  path: string,
  samePath: (a: string, b: string) => boolean
): T | undefined {
  return windows.find(
    (win) => !win.destroyed && win.docPaths.some((doc) => doc !== null && samePath(doc, path))
  )
}
