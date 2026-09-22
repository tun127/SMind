import { useCallback, useEffect, useState, type RefObject } from 'react'
import type { RecoveryInfo } from '@shared/ipc'
import { setStage } from '../dev/stage'
import { activeDocId, useTabs } from '../store/tabs'
import {
  recoveryCountText,
  recoveryStateFromList,
  removeRecoveryItem,
  type RecoveryState
} from './recovery-list'

/**
 * 崩溃恢复：启动时查一次存档，然后**逐份列出、逐份或全部恢复**。
 *
 * 数据层已经按「窗口 + 文档」分文件，`recoveryCheck` 也返回列表（报告 D-02 第一步）；
 * 以前这里只取 `list.items[0]`，用户依旧只看得到最近一份。现在把整个列表交给
 * RecoveryDialog：每份都可单独恢复/忽略，并提供“全部恢复”和“最近一份”的快速路径。
 *
 * `recoveryPendingRef` 仍由 App 拥有并传入：退出前只要列表里还有候选没处理，
 * 关窗链路就不能直接放行。
 */

interface Deps {
  /** 是否还停在「发现未保存内容」这一步没做决定（关窗链路也要读） */
  recoveryPendingRef: RefObject<boolean>
  showToast(message: string): void
}

interface Api {
  recovery: RecoveryState | null
  handleRestore(item: RecoveryInfo): Promise<void>
  handleRestoreLatest(): Promise<void>
  handleRestoreAll(): Promise<void>
  handleDiscardRecovery(item: RecoveryInfo): void
  handleDiscardAll(): void
}

export function useRecovery({ recoveryPendingRef, showToast }: Deps): Api {
  const [recovery, setRecovery] = useState<RecoveryState | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const list = await window.api.recoveryCheck()
        const state = recoveryStateFromList(list)
        if (state.items.length === 0) return
        recoveryPendingRef.current = true
        setRecovery(state)
        showToast(recoveryCountText(state.items.length))
      } catch {
        /* 忽略 */
      }
    })()
  }, [recoveryPendingRef, showToast])

  /** 从界面状态里移除一份，并维护关窗链路的 pending 标记。 */
  const dropFromState = useCallback(
    (item: RecoveryInfo): void => {
      setRecovery((prev) => {
        if (!prev) return null
        const next = removeRecoveryItem(prev, item)
        recoveryPendingRef.current = next.items.length > 0
        return next.items.length > 0 ? next : null
      })
    },
    [recoveryPendingRef]
  )

  const restoreOne = useCallback(
    async (item: RecoveryInfo): Promise<void> => {
      try {
        // 分步打点：「点恢复就卡死」这类问题必须能看出卡在哪一步
        setStage('恢复：读取存档')
        const result = await window.api.recoveryLoad(activeDocId(), item.docId)
        if (result) {
          setStage('恢复：载入工作簿')
          useTabs.getState().openWorkbook(result.workbook, result.path || null)
          setStage('恢复：完成')
          showToast(`已恢复《${item.title || '未命名导图'}》`)
          return
        }
        // 读出来是 null（多半文件已损坏）：只丢这一份，避免每次启动都再问一次
        void window.api.recoveryDiscard(item.docId)
        showToast(`《${item.title || '未命名导图'}》的存档读不出来，已忽略`)
      } catch (err) {
        void window.api.recoveryDiscard(item.docId)
        showToast(`恢复失败：${(err as Error).message}`)
      }
    },
    [showToast]
  )

  const handleRestore = useCallback(
    async (item: RecoveryInfo): Promise<void> => {
      await restoreOne(item)
      dropFromState(item)
    },
    [dropFromState, restoreOne]
  )

  /** 列表已按最近在前排序；这个按钮保留改动前的“点一下恢复最近一份”快速路径。 */
  const handleRestoreLatest = useCallback(async (): Promise<void> => {
    const first = recovery?.items[0]
    if (!first) return
    await handleRestore(first)
  }, [handleRestore, recovery])

  const handleRestoreAll = useCallback(async (): Promise<void> => {
    const items = recovery?.items ?? []
    if (items.length === 0) return
    for (const item of items) await restoreOne(item)
    setRecovery(null)
    recoveryPendingRef.current = false
    showToast(`已恢复 ${items.length} 份未保存的内容`)
  }, [recovery, recoveryPendingRef, restoreOne, showToast])

  const handleDiscardRecovery = useCallback(
    (item: RecoveryInfo): void => {
      // 只丢这一份：别的标签的存档不能被顺手删掉（D-02）
      void window.api.recoveryDiscard(item.docId)
      dropFromState(item)
    },
    [dropFromState]
  )

  const handleDiscardAll = useCallback((): void => {
    void window.api.recoveryDiscard()
    setRecovery(null)
    recoveryPendingRef.current = false
    showToast('已忽略全部未保存的内容')
  }, [recoveryPendingRef, showToast])

  return {
    recovery,
    handleRestore,
    handleRestoreLatest,
    handleRestoreAll,
    handleDiscardRecovery,
    handleDiscardAll
  }
}
