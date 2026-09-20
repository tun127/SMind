/**
 * 自定义协议（`mind-resource`）背后的**纯查表逻辑**：URL → 包内路径 → 字节。
 *
 * 抽出来的理由只有一个：**不依赖 Electron 才能被自检覆盖**（先例：`shared/update-policy.ts`、
 * `main/doc-resources.ts`、`main/license/state.ts`）。协议注册本身仍留在
 * `resource-protocol.ts`——那里要用 `protocol.handle`。
 *
 * 安全性说明：资源**不会被拼进任何文件系统调用**，只按 key 查内存表，
 * 所以 `../../` 之类的 key 只会查不到（这条已写进已知安全问题核对表，现在有断言守着）。
 */

/** 把请求 URL 还原成包内资源路径；解不出来返回 null（调用方回 400） */
export function resourcePathFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    return decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  } catch {
    return null
  }
}

/**
 * 在各窗口各文档的资源表里找一份资源（协议请求认不出窗口，而资源路径全局唯一，所以逐表查；
 * **隔离发生在保存时**——每份文档只打自己那一份）。
 */
export function findResourceBytes(
  tables: Iterable<Record<string, Uint8Array>>,
  path: string
): Uint8Array | undefined {
  for (const table of tables) {
    const bytes = table[path]
    if (bytes) return bytes
  }
  return undefined
}
