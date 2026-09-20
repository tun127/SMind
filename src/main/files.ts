import { promises as fs } from 'node:fs'
import { basename, dirname } from 'node:path'
import { parseXmind } from '@shared/xmind/parse'
import { serializeXmind } from '@shared/xmind/serialize'
import { defaultDocumentName } from '@shared/model/naming'
import type { OpenResult, SaveResult } from '@shared/ipc'
import type { Workbook } from '@shared/model/types'
import { writeFileAtomic } from './atomic-write'
import { recordVisit, rememberSaveDir } from './history'
import { docOf, pruneForSave } from './doc-resources'
import type { DocWindow } from './context'

/**
 * 这两个小助手搬进了 `./file-args`（**不依赖 Electron**，因此能被自检覆盖）。
 * 在这里原样再导出：调用点（多个 IPC 域）一行都不用改。
 */
export { ensureXmindExt, firstPathOf } from './file-args'

/* ------------------------------------------------------------------ */
/* 文件读写                                                            */
/* ------------------------------------------------------------------ */

export async function readDocumentInto(
  state: DocWindow | null,
  docId: string,
  path: string
): Promise<OpenResult> {
  const buf = await fs.readFile(path)
  // 传文件名进去：亿图脑图的专有 .emmx 没有自带文档名，只能拿文件名当中心主题
  const parsed = await parseXmind(new Uint8Array(buf), { fileName: basename(path) })
  // 副本（临时文件）：算"未保存的新文档"——不记路径、不进历史、保存走另存为
  const isCopy = Boolean(state && state.copySource && state.copySource === path)
  if (state && typeof docId === 'string') {
    // 资源记在**这个文档**名下：别的标签保存时不会把它们打进去
    const doc = docOf(state, docId)
    doc.resources = parsed.resources
    doc.inserted.clear()
    doc.docPath = isCopy ? null : path
  }
  // 记一笔打开历史（用中心主题名，方便在历史界面里认出是哪张图）；副本不进历史
  if (!isCopy) await recordVisit(path, defaultDocumentName(parsed.workbook)).catch(() => undefined)
  return {
    path: isCopy ? '' : path,
    workbook: parsed.workbook,
    warnings: parsed.warnings,
    resourceCount: Object.keys(parsed.resources).length,
    copy: isCopy || undefined
  }
}

export async function writeDocument(
  state: DocWindow | null,
  docId: string,
  path: string,
  workbook: Workbook
): Promise<SaveResult> {
  const doc = state && typeof docId === 'string' ? docOf(state, docId) : null
  if (doc) pruneForSave(doc, workbook)
  const bytes = await serializeXmind({ workbook, resources: doc?.resources ?? {} })
  await writeFileAtomic(path, bytes)
  if (doc) doc.docPath = path
  // 保存成功也记一笔，并记住这次用的目录（下次「另存为」默认落在这里）
  await rememberSaveDir(dirname(path)).catch(() => undefined)
  await recordVisit(path, defaultDocumentName(workbook)).catch(() => undefined)
  return { path }
}
