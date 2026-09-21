import { useCallback, useEffect, useState, type RefObject } from 'react'
import type { RecoveryInfo } from '@shared/ipc'
import { setStage } from '../dev/stage'
import { activeDocId, useTabs } from '../store/tabs'

/**
 * 崩溃恢复：启动时查一次存档、恢复或丢弃（自 App.tsx 整块搬出，代码逐字未改）。
 *
 * `recoveryPendingRef` 仍由 App 拥有并传入：退出前的关窗链路要读它
 *（「还停在未保存内容这一步没做决定」时不能直接关）。
 */

interface Deps {
  /** 是否还停在「发现未保存内容」这一步没做决定（关窗链路也要读） */
  recoveryPendingRef: RefObject<boolean>
  showToast(message: string): void
}

interface Api {
  recovery: RecoveryInfo | null
  handleRestore(): Promise<void>
  handleDiscardRecovery(): void
}

export function useRecovery({ recoveryPendingRef, showToast }: Deps): Api {
  const [recovery, setRecovery] = useState<RecoveryInfo | null>(null)
  /* ------------------------------------------------------------------ */
  /* 崩溃恢复                                                            */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    void (async () => {
      try {
        // 逐份恢复的 UI 另开一批；本批先按"最近一份"提示（列表按 savedAt 倒序）
        const list = await window.api.recoveryCheck()
        const info = list.items[0] ?? null
        if (info) {
          recoveryPendingRef.current = true
          setRecovery(info)
        }
      } catch {
        /* 忽略 */
      }
    })()
  }, [recoveryPendingRef])

  const handleRestore = useCallback(async (): Promise<void> => {
    // 记住要恢复的是**哪一份**存档（setRecovery(null) 之后就问不到了）
    const savedDocId = recovery?.docId
    setRecovery(null)
    try {
      // 分步打点：「点恢复就卡死」这类问题必须能看出卡在哪一步
      // （否则只能看到"卡住了"，连是读存档还是画布渲染都不知道）
      setStage('恢复：读取存档')
      const result = await window.api.recoveryLoad(activeDocId(), savedDocId)
      if (result) {
        setStage('恢复：载入工作簿')
        useTabs.getState().openWorkbook(result.workbook, result.path || null)
        setStage('恢复：完成')
        showToast('已恢复未保存的内容')
      }
    } catch (err) {
      // 存档读不出来（多半已损坏），清掉它，否则每次启动都会再问一次
      void window.api.recoveryDiscard()
      showToast(`恢复失败：${(err as Error).message}`)
    } finally {
      recoveryPendingRef.current = false
    }
  }, [showToast, recoveryPendingRef, recovery])

  const handleDiscardRecovery = useCallback((): void => {
    recoveryPendingRef.current = false
    setRecovery(null)
    void window.api.recoveryDiscard()
  }, [recoveryPendingRef])

  return { recovery, handleRestore, handleDiscardRecovery }
}
