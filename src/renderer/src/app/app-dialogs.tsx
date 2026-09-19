import { type Dispatch, type ReactElement, type SetStateAction, type useState } from 'react'
import type { ExtractedDocument } from '@shared/document'
import AiSettingsDialog from '../components/AiSettingsDialog'
import DocumentToMapDialog from '../components/DocumentToMapDialog'
import { RecoveryDialog, ShortcutsDialog, UnsavedDialog } from '../components/Dialogs'
import ExportDialog from '../components/ExportDialog'
import HistoryDialog from '../components/HistoryDialog'
import type { useDocumentActions } from './use-document-actions'
import type { useRecovery } from './use-recovery'
import type { useWindowClose } from './use-window-close'

/**
 * 全部对话框 + toast（自 App.tsx 整块搬出，JSX 块体逐字未改）。
 *
 * 关窗链路的三处回调**逐字保留**（人肉验收清单里的重点）：
 * - 取消：先 setPending(null)，再 window.api.closeCancel() 回执主进程（不回执会导致窗口关不掉）；
 * - 不保存：先做自己的收尾（action.discard），没有收尾才直接 action.run()；
 * - 保存：saveDocument(false) 成功（ok）才 action.run()，失败不继续关窗流程。
 *
 * props 原样传、外层 Fragment 不产生 DOM 节点、不加 memo、不重新包装回调。
 */

type DocActions = ReturnType<typeof useDocumentActions>
type WindowClose = ReturnType<typeof useWindowClose>
type Recovery = ReturnType<typeof useRecovery>
/**
 * 拖进来的文档：类型推导自 App 里那份同名 state（`useState<ExtractedDocument | null>`）。
 * `typeof useState<...>` 的类型查询会命中最先声明的那个重载（值多一个 undefined），
 * 所以用 `Exclude` 去掉它——App 那份 state 的初值就是 `null`。
 */
type DocToMap = Exclude<ReturnType<typeof useState<ExtractedDocument | null>>[0], undefined>

interface Props {
  recovery: Recovery['recovery']
  handleRestore: Recovery['handleRestore']
  handleDiscardRecovery: Recovery['handleDiscardRecovery']
  pending: WindowClose['pending']
  setPending: WindowClose['setPending']
  displayName: string
  saveDocument: DocActions['saveDocument']
  showShortcuts: boolean
  setShowShortcuts: Dispatch<SetStateAction<boolean>>
  showExport: boolean
  setShowExport: Dispatch<SetStateAction<boolean>>
  showToast(message: string): void
  docToMap: DocToMap
  setDocToMap: Dispatch<SetStateAction<DocToMap>>
  openGeneratedInNewWindow: DocActions['openGeneratedInNewWindow']
  showAiSettings: boolean
  setShowAiSettings: Dispatch<SetStateAction<boolean>>
  showHistory: boolean
  setShowHistory: Dispatch<SetStateAction<boolean>>
  openPath: DocActions['openPath']
  guard: WindowClose['guard']
  restoreSnapshot: DocActions['restoreSnapshot']
  toast: string | null
}

export function AppDialogs({
  recovery,
  handleRestore,
  handleDiscardRecovery,
  pending,
  setPending,
  displayName,
  saveDocument,
  showShortcuts,
  setShowShortcuts,
  showExport,
  setShowExport,
  showToast,
  docToMap,
  setDocToMap,
  openGeneratedInNewWindow,
  showAiSettings,
  setShowAiSettings,
  showHistory,
  setShowHistory,
  openPath,
  guard,
  restoreSnapshot,
  toast
}: Props): ReactElement {
  return (
    <>
      {recovery && (
        <RecoveryDialog
          info={recovery}
          onRestore={() => void handleRestore()}
          onDiscard={handleDiscardRecovery}
        />
      )}

      {pending && (
        <UnsavedDialog
          fileName={pending.fileName || displayName}
          onCancel={() => {
            const action = pending
            setPending(null)
            // 关窗/退出流程里点「取消」：必须回执主进程。
            // 不回执的话主进程一直以为「退出流程还在进行」，之后每次关窗都走退出分支，
            // 那个分支看到"还有窗口没确认"就直接 return —— 窗口关不掉（点了放弃修改没反应）
            if (action.windowClose) window.api.closeCancel()
          }}
          onDiscard={() => {
            const action = pending
            setPending(null)
            // 关标签/退出的「不保存」：先做自己的收尾（标记强制关闭等），再继续流程
            if (action.discard) action.discard()
            else action.run()
          }}
          onSave={() => {
            const action = pending
            setPending(null)
            void saveDocument(false).then((ok) => {
              if (ok) action.run()
            })
          }}
        />
      )}

      {showShortcuts && <ShortcutsDialog onClose={() => setShowShortcuts(false)} />}

      {showExport && <ExportDialog onClose={() => setShowExport(false)} onNotify={showToast} />}

      {docToMap && (
        <DocumentToMapDialog
          document={docToMap}
          onClose={() => setDocToMap(null)}
          onNotify={showToast}
          onGenerateInNewWindow={openGeneratedInNewWindow}
        />
      )}

      {showAiSettings && (
        <AiSettingsDialog onClose={() => setShowAiSettings(false)} onNotify={showToast} />
      )}

      {showHistory && (
        <HistoryDialog
          onClose={() => setShowHistory(false)}
          onNotify={showToast}
          onOpenFile={(path) => void openPath(path)}
          onRestore={(snapshotId) => guard(() => void restoreSnapshot(snapshotId))}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </>
  )
}
