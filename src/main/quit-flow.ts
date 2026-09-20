/**
 * 退出流程的**纯判定**（不依赖 Electron → 可被自检覆盖）：退出前还有哪些窗口要问一遍
 * 「要不要保存」。
 *
 * 为什么值得单独一处并钉住：这里**曾经只问一个窗口**，多窗口下「退出」会**静默丢掉**
 * 其他窗口的未保存修改（真出过）。规则只有两条，但都很致命：
 * 已经批准关闭的（`allowClose`）不再问；界面进程已经没了的（`destroyed`）问了也没人答。
 */
export interface QuitCandidate {
  allowClose: boolean
  destroyed: boolean
}

/** 需要发 `closeRequest` 去问一遍的窗口（保持传入顺序） */
export function windowsToAsk<T extends QuitCandidate>(candidates: readonly T[]): T[] {
  return candidates.filter((candidate) => !candidate.allowClose && !candidate.destroyed)
}
