import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import { tabTitleOf, useTabs } from '../store/tabs'
import { useEditor } from '../store/editor'

/**
 * 关窗链路（自 `App.tsx` 整块搬出，函数体逐字未改）：关一个标签 → 通用闸门 → 退出前逐个标签问 → 放行主进程。
 *
 * 这条链决定**关窗会不会丢数据**，所以搬的时候只动「组件作用域里的 ref / state / 函数」
 * 的进出方式，确认流程、文案、询问顺序、`await` 顺序与「取消后回执主进程」一个字没改。
 *
 * **`pending` 未保存确认 state 搬到这里**：`run` / `fileName` / `discard` / `windowClose` 的语义
 * 与搬迁前完全一致（`windowClose` 就是「这次询问来自主进程的关窗请求，点取消要回执 closeCancel」）。
 * App 的 `UnsavedDialog` 用返回的 `pending` / `setPending`，调用点一个字没改。
 *
 * **effect 顺序**：本 hook 只有一条 effect（`onCloseRequest`）。在 App 里的调用点落在
 * **原来那条 effect 的位置上**，所以它在这份组件的 effect 序列里的相对位置与搬迁前一致
 * （前一条是 `openFilePending` 那条，后一条在 `useAutosave` 里）。
 *
 * **依赖数组**：`closeApp` 原来写 `[]`（它读的是 App 作用域里的 ref），现在那个 ref 从参数进来，
 * lint（`react-hooks/exhaustive-deps`）要求把它列进依赖——这是 A7 那轮定下的做法。
 * `recoveryPendingRef` 是 App 里 `useRef(false)` 出来的**恒定身份**对象，列进去不改变 `closeApp`
 * 的重建时机，于是 `closeWindowFlow` 与那条 effect 的重建时机也不变（其余依赖数组原样未动）。
 */

/** 未保存确认：run＝确认后的动作；fileName＝被确认的文档名；discard＝「不保存」的额外动作 */
interface PendingConfirm {
  run: () => void
  fileName: string
  discard?: () => void
  /** 这次询问来自主进程的关窗/退出请求：点「取消」必须回执主进程（见 closeCancel） */
  windowClose?: boolean
}

interface Deps {
  /** 先把「正在编辑但还没提交」的文本落定（来自 use-document-actions）：不然 dirty 判断不准 */
  commitPending(): void
  /** 是否还停在「发现未保存内容」这一步没做决定（App 拥有，useRecovery 共用） */
  recoveryPendingRef: RefObject<boolean>
}

interface Api {
  pending: PendingConfirm | null
  setPending: Dispatch<SetStateAction<PendingConfirm | null>>
  closeTabById(id: string): void
  guard(run: () => void): void
}

export function useWindowClose({ commitPending, recoveryPendingRef }: Deps): Api {
  const [pending, setPending] = useState<PendingConfirm | null>(null)

  /**
   * 正常关闭应用。
   * 关键：关闭前必须清掉自动存档，否则「不保存退出」后下次启动还会反复提示恢复。
   * 但如果用户还停在「发现未保存内容」的弹窗上没有做决定，就不能悄悄删掉存档。
   */
  const closeApp = useCallback((): void => {
    const finish = (): void => window.api.confirmClose()
    if (recoveryPendingRef.current) {
      finish()
      return
    }
    void (async () => {
      try {
        await window.api.clearAutosave()
      } catch {
        /* 忽略：清不掉也不该阻塞关闭 */
      }
      finish()
    })()
  }, [recoveryPendingRef])

  /** 关闭一个标签（带未保存确认；确认文案里显示这份文档自己的名字） */
  const closeTabById = useCallback(
    (id: string): void => {
      commitPending()
      const tabs = useTabs.getState()
      const tab = tabs.tabs.find((item) => item.id === id)
      if (!tab) return
      const liveDirty = id === tabs.activeId ? useEditor.getState().dirty : tab.dirty
      const run = (): void => {
        useTabs.getState().closeTab(id)
        // 主进程丢掉这份文档的图片/附件资源（别的标签不受影响）
        void window.api.releaseDoc(id).catch(() => undefined)
      }
      if (liveDirty) {
        // 保存要保的是被关的那份：先把它切到前台再问
        if (id !== tabs.activeId) useTabs.getState().switchTo(id)
        setPending({ fileName: tabTitleOf(tab), run, discard: run })
        return
      }
      run()
    },
    [commitPending]
  )

  /** 有未保存内容时先弹确认框（先把未提交的输入落定，dirty 才准确） */
  const guard = useCallback(
    (run: () => void): void => {
      commitPending()
      if (useEditor.getState().dirty) {
        const active = useTabs
          .getState()
          .tabs.find((item) => item.id === useTabs.getState().activeId)
        setPending({ fileName: active ? tabTitleOf(active) : '当前文档', run })
      } else run()
    },
    [commitPending]
  )

  /* ------------------------------------------------------------------ */
  /* 关闭窗口                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 退出前把**每个有未保存改动的标签**都问一遍（逐个切到前台询问），
   * 全部有了着落（保存 / 丢弃）才真正关闭窗口。
   */
  const forceCloseIds = useRef(new Set<string>())
  const closeWindowFlow = useCallback((): void => {
    commitPending()
    const tabs = useTabs.getState()
    const askThis = (fileName: string): void =>
      setPending({
        fileName,
        windowClose: true,
        run: closeWindowFlow,
        discard: () => {
          forceCloseIds.current.add(useTabs.getState().activeId)
          closeWindowFlow()
        }
      })
    // 先问激活的（它就是屏幕上这份，用户最有概念）
    if (useEditor.getState().dirty && !forceCloseIds.current.has(tabs.activeId)) {
      const active = tabs.tabs.find((item) => item.id === tabs.activeId)
      askThis(active ? tabTitleOf(active) : '当前文档')
      return
    }
    // 再问其余脏标签（逐个切过去问）
    const nextDirty = tabs.tabs.find(
      (item) => item.dirty && item.id !== tabs.activeId && !forceCloseIds.current.has(item.id)
    )
    if (nextDirty) {
      tabs.switchTo(nextDirty.id)
      askThis(tabTitleOf(nextDirty))
      return
    }
    closeApp()
    // closeApp 是 settle 后的最终动作：漏了它这里会一直调用**首次渲染时**的那个闭包
  }, [commitPending, closeApp])

  useEffect(() => {
    const off = window.api.onCloseRequest(() => {
      forceCloseIds.current.clear()
      closeWindowFlow()
    })
    return off
  }, [closeWindowFlow])

  return { pending, setPending, closeTabById, guard }
}
