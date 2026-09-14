/**
 * 多窗口相关的**纯逻辑**。
 *
 * 放在 shared 里是为了能直接被自检断言——主进程的窗口行为很难自动化，
 * 但「同一个文件该聚焦已有窗口还是开新窗口」这类判断是纯函数，值得钉住。
 */

/**
 * 路径归一：Windows 上 `C:\A\b.xmind` 与 `c:/a/B.XMIND` 是同一个文件。
 * 统一成正斜杠 + 小写，避免同一份文档被开出两个窗口。
 */
export function normalizeDocPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase()
}

export function sameDocPath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return normalizeDocPath(a) === normalizeDocPath(b)
}

/**
 * 双击 / 命令行传来一个文档时怎么处理：
 * 已经在某个窗口里打开（且没有未保存改动会被糟蹋）就聚焦它，否则开新窗口。
 *
 * `openPaths` 按窗口顺序给出各自当前打开的文档路径（新文档为 null）。
 * 返回命中的窗口下标，没命中返回 -1。
 */
export function findWindowForPath(openPaths: Array<string | null>, target: string): number {
  const key = normalizeDocPath(target)
  for (let i = 0; i < openPaths.length; i += 1) {
    const path = openPaths[i]
    if (path && normalizeDocPath(path) === key) return i
  }
  return -1
}

/** 自动存档槽位名（多窗口各存各的；重启后按窗口创建顺序认领） */
export function autosaveSlotName(index: number): string {
  return `slot-${Math.max(1, Math.floor(index))}`
}
