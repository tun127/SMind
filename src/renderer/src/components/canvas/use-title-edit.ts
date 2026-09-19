import { useCallback, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useEditor } from '../../store/editor'

/**
 * 双击画布元素（边界 / 概要 / 关系线）标题后的「就地编辑」（自 `Canvas.tsx` 整块搬出，逐字未改）。
 *
 * 这一件事的内部状态**全部随 hook 搬走**：编辑框的位置与当前文字（`titleEdit`）、
 * 「Esc 取消过、别把取消的内容又写回去」的标记（`cancelTitleRef`），
 * 以及失焦提交要读到最新值的镜像（`titleEditRef`）。
 *
 * `titleEdit` / `setTitleEdit` / `cancelTitleRef` 仍要**返回给画布**：JSX 里四处双击开框、
 * 拖动、Esc 都在写它们。`titleEditRef` 只有 `commitTitleEdit` 读，完全内部，不外露。
 *
 * `commitTitleEdit` 原来的依赖数组 `[]` 逐字保留；lint 要求补进来的 `titleEditRef` /
 * `cancelTitleRef` 是恒等身份的 `RefObject`，`setTitleEdit` 是 React setter，
 * 三者身份恒定，不改变本回调的重建时机。
 */

/** 就地编辑中的那个覆盖物标题（与画布里原来那份 `useState` 同型） */
export interface TitleEdit {
  kind: 'boundary' | 'summary' | 'relationship'
  id: string
  x: number
  y: number
  anchor: 'start' | 'middle' | 'end'
  value: string
}

export function useTitleEdit(): {
  titleEdit: TitleEdit | null
  /** state setter 原样带出：签名必须与 `useState` 的 `Dispatch<SetStateAction<…>>` 同型，
   *  否则画布那边 `setTitleEdit((current) => …)` 的**更新函数写法**会失去重载（A8-5 实测踩到） */
  setTitleEdit: Dispatch<SetStateAction<TitleEdit | null>>
  /** Esc 取消时置位，避免失焦又把取消的内容写回去（JSX 的 keydown 写它） */
  cancelTitleRef: { current: boolean }
  commitTitleEdit(): void
} {
  /* titleEdit 与 cancelTitleRef 的声明**逐字**从画布搬来（下方 R0 段） */
  /** 双击画布上的边界/概要/关系线标题后，就地编辑文字 */
  const [titleEdit, setTitleEdit] = useState<{
    kind: 'boundary' | 'summary' | 'relationship'
    id: string
    x: number
    y: number
    anchor: 'start' | 'middle' | 'end'
    value: string
  } | null>(null)
  /** Esc 取消时置位，避免失焦又把取消的内容写回去 */
  const cancelTitleRef = useRef(false)

  /* ---- 双击标题就地编辑 ---- */
  const commitTitleEdit = useCallback((): void => {
    const target = titleEditRef.current
    if (!target) return
    if (cancelTitleRef.current) {
      cancelTitleRef.current = false
      setTitleEdit(null)
      return
    }
    const store = useEditor.getState()
    if (target.kind === 'boundary') store.setBoundaryTitle(target.id, target.value)
    else if (target.kind === 'summary') store.setSummaryTitle(target.id, target.value)
    else store.setRelationshipTitle(target.id, target.value)
    setTitleEdit(null)
  }, [])

  // 编辑过程中输入框的值是最新来源，用 ref 保证失焦提交读到的是最新内容
  const titleEditRef = useRef(titleEdit)
  titleEditRef.current = titleEdit

  return { titleEdit, setTitleEdit, cancelTitleRef, commitTitleEdit }
}
