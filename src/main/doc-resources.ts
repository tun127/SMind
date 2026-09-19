import type { Workbook } from '@shared/model/types'
import { pruneSessionResources } from '@shared/model/resources'

/**
 * 一个窗口可以开着**多个文档标签**（浏览器式多文件），
 * 所以资源与文档归属再往下分一层——按 docId（标签）隔离。
 *
 * 不分的话：A 标签保存时会把 B 标签的图片打进包里，A 删掉图片会把 B 的资源一起清掉。
 * 自动存档槽位与未保存确认仍然按窗口（一次只存/问激活的那个标签）。
 */
export interface DocResources {
  /** 这份文档携带的图片/附件资源；保存时只打自己这一份 */
  resources: Record<string, Uint8Array>
  /**
   * 本次会话新插入的资源路径。
   * 保存时只清理「新插入过、后来又被删掉」的资源，
   * 文件里原本带着的资源一律不动（可能有本软件尚未建模的引用）。
   */
  inserted: Set<string>
  /** 这份文档当前打开的文件路径（新文档＝null） */
  docPath: string | null
}

/**
 * 这两个只在窗口状态里那层「文档资源表」上操作，不碰任何跨窗口共享状态，
 * 所以不进 `MainContext`——任何模块都可以直接 import（域文件尤其需要：
 * 保存、快照、媒体几个域都要按 docId 取资源）。
 */

/** 取（或建）某个文档的资源记录：渲染进程开新标签后第一次用到时才真正建起来 */
export function docOf(state: { docs: Map<string, DocResources> }, docId: string): DocResources {
  let doc = state.docs.get(docId)
  if (!doc) {
    doc = { resources: {}, inserted: new Set(), docPath: null }
    state.docs.set(docId, doc)
  }
  return doc
}

export function pruneForSave(doc: DocResources, workbook: Workbook): void {
  const { resources, removed } = pruneSessionResources(doc.resources, doc.inserted, workbook)
  if (removed.length === 0) return
  doc.resources = resources
  for (const path of removed) doc.inserted.delete(path)
}
