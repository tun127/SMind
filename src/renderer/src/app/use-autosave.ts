import { useEffect } from 'react'
import { defaultDocumentName, fileNameOf } from '@shared/model/naming'
import { snapshotForSave, useEditor } from '../store/editor'
import { beginCost } from '../dev/stage'
import { activeDocId } from '../store/tabs'

/**
 * 自动保存（30s）与自动版本快照（10min）（自 App.tsx 整块搬出，两个 effect 体逐字未改）。
 *
 * 自动保存用**快照**而不是直接落库：把正在输入但还没提交的文本也写进去，
 * 同时不打断用户的输入。失败必须让用户知道——最坏的不是"存不上"，
 * 而是用户以为存上了、其实没有。
 */

interface Deps {
  showToast(message: string): void
}

export function useAutosave({ showToast }: Deps): void {
  /* ------------------------------------------------------------------ */
  /* 自动保存                                                            */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    const timer = window.setInterval(() => {
      const store = useEditor.getState()
      if (!store.dirty) return
      // 用快照而不是直接落库：把正在输入但还没提交的文本也写进去，
      // 同时不打断用户的输入（不会退出编辑态）
      // 取证：这一跳每 30 秒一次，正好落在「冻结发生在回合之后」的时间窗里，必须计时
      const endSave = beginCost('自动存档快照')
      void window.api
        .autosave(
          activeDocId(),
          snapshotForSave(store),
          store.filePath,
          fileNameOf(store.filePath) ?? '未命名导图'
        )
        .catch((error: unknown) => {
          // 自动保存失败必须让用户知道：最坏的情况不是"存不上"，
          // 而是用户以为存上了、其实没有
          const detail = error instanceof Error ? error.message : String(error)
          showToast(`自动保存失败：${detail}（请尽快手动保存一次）`)
        })
      endSave()
    }, 30000)
    return () => window.clearInterval(timer)
  }, [showToast])

  /* ------------------------------------------------------------------ */
  /* 自动版本快照                                                        */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    // 每 10 分钟留一个版本；内容与上一份相同（或距上次太近）时
    // 主进程会按内容指纹直接忽略，不会白写盘。
    // 只对「已保存过的文档」记录：还没有路径的文档由自动保存与崩溃恢复兜底。
    const timer = window.setInterval(() => {
      const store = useEditor.getState()
      if (!store.filePath) return
      void window.api
        .snapshotCreate(activeDocId(), {
          workbook: snapshotForSave(store),
          path: store.filePath,
          title: defaultDocumentName(store.workbook),
          reason: 'auto'
        })
        .catch(() => undefined)
    }, 600000)
    return () => window.clearInterval(timer)
  }, [])
}
