import { protocol } from 'electron'
import type { MainContext } from './context'

import { mimeOfPath } from '@shared/model/resources'
import { findResourceBytes, resourcePathFromUrl } from './resource-table'

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 跨窗口、跨标签找一份资源。
 *
 * 协议请求本身认不出是哪个窗口/标签发的，而资源路径是全局唯一的，
 * 所以这里扫描各窗口各文档的资源表；**隔离发生在保存时**（每份文档只打自己那一份）。
 * 查表本身在 `./resource-table`（不依赖 Electron，因此有断言覆盖）。
 */
export function resourceBytesOf(ctx: MainContext, path: string): Uint8Array | undefined {
  const tables = (function* eachResourceTable() {
    for (const state of ctx.windows.values()) {
      for (const doc of state.docs.values()) yield doc.resources
    }
  })()
  return findResourceBytes(tables, path)
}

/** 把包内资源（resources/…）通过自定义协议暴露给画布上的 <img> */
export function registerResourceProtocol(ctx: MainContext): void {
  protocol.handle(RESOURCE_SCHEME, async (request) => {
    const path = resourcePathFromUrl(request.url)
    if (path === null) return new Response('', { status: 400 })
    const bytes = resourceBytesOf(ctx, path)
    if (!bytes) return new Response('', { status: 404 })
    return new Response(bytes as unknown as BodyInit, {
      headers: {
        'content-type': mimeOfPath(path),
        // 图片可能在同一次会话里被替换，不做缓存最省心
        'cache-control': 'no-store'
      }
    })
  })
}

/**
 * 图片/附件通过自定义协议喂给渲染进程，而不是把二进制塞进 IPC 或 data URL。
 * 必须在 app ready 之前登记，否则 scheme 不会被当作「标准且安全」的来源。
 */
export const RESOURCE_SCHEME = 'mind-resource'
