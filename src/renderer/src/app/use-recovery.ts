import { useCallback, useEffect, useState, type RefObject } from 'react'
import type { RecoveryInfo } from '@shared/ipc'
import { setStage } from '../dev/stage'
import { activeDocId, useTabs } from '../store/tabs'

/**
 * 崩溃恢复：启动时查一次存档，然后**逐份**恢复或丢弃。
 *
 * 为什么是「逐份」（报告 D-02 的最后一步）：自动存档现在按「窗口 + 文档」分文件，
 * 一个窗口开过几个标签就可能留下几份存档。以前这里只读 `list.items[0]`，
 * 界面与改动前完全一样 —— 数据层已经备好了几份，用户却只看得到一份。
 *
 * 做法（刻意**不改任何 UI 组件**）：把剩下的几份放进 `restQueue`；用户对当前这份做完决定后，
 * 队列里的下一份成为新的 `recovery` —— 同一个对话框会接着弹，用户看到的就是「一份一份确认」。
 * 还有下一份时 `recoveryPendingRef` 继续保持 true：否则关窗链路会以为「用户已经决定完了」。
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
  /** 除当前这份之外、还没处理的其它存档（一个窗口开过几个标签就有几份） */
  const [restQueue, setRestQueue] = useState<RecoveryInfo[]>([])

  useEffect(() => {
    void (async () => {
      try {
        const list = await window.api.recoveryCheck()
        const [first, ...rest] = list.items
        if (!first) return
        recoveryPendingRef.current = true
        setRecovery(first)
        setRestQueue(rest)
        if (rest.length > 0) {
          showToast(`发现 ${list.total} 份未保存的内容，逐份确认`)
        }
      } catch {
        /* 忽略 */
      }
    })()
  }, [recoveryPendingRef, showToast])

  /** 处理完一份之后：队列里的下一份成为当前这份；没有了才放开关窗链路 */
  const moveToNext = useCallback(
    (queue: RecoveryInfo[]): void => {
      const [head, ...rest] = queue
      setRestQueue(rest)
      setRecovery(head ?? null)
      recoveryPendingRef.current = Boolean(head)
      if (head) showToast(`还有 ${queue.length} 份未保存的内容`)
    },
    [recoveryPendingRef, showToast]
  )

  const handleRestore = useCallback(async (): Promise<void> => {
    const savedDocId = recovery?.docId
    const queue = restQueue
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
      // 存档读不出来（多半已损坏），只丢**这一份**，否则每次启动都会再问一次
      void window.api.recoveryDiscard(savedDocId)
      showToast(`恢复失败：${(err as Error).message}`)
    } finally {
      moveToNext(queue)
    }
  }, [showToast, recovery, restQueue, moveToNext])

  const handleDiscardRecovery = useCallback((): void => {
    const savedDocId = recovery?.docId
    const queue = restQueue
    setRecovery(null)
    // 只丢这一份：别的标签的存档不能被顺手删掉（D-02）
    void window.api.recoveryDiscard(savedDocId)
    moveToNext(queue)
  }, [recovery, restQueue, moveToNext])

  return { recovery, handleRestore, handleDiscardRecovery }
}
