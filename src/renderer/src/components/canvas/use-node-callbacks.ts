import { useCallback, type RefObject } from 'react'
import type { LayoutResult } from '@shared/layout/types'
import type { FoldSide } from '@shared/model/tree'
import type { RichText } from '@shared/model/types'
import { useEditor } from '../../store/editor'
import type { TopicNodeProps } from '../topic/props'

/**
 * 节点的十个回调（自 `Canvas.tsx` 整块搬出，函数体逐字未改）。
 *
 * **为什么必须留成「引用永远稳定」**：`TopicNode` 有 `memo`，只要传进去的回调每次渲染都是新函数，
 * 浅比较必然失败、`memo` 就整个被架空——以前 8 个内联箭头函数正是这样把「每次 pan 更新」放大成
 * 「全部可见节点重渲染」的。这一族回调全部只走 `useEditor.getState()` / `ref` 拿最新值，
 * 依赖数组一律 `[]`（逐字保留），所以引用恒定。
 *
 * 折叠 / 展开那两个要读 `layoutRef` / `zoomRef` / `panRef` / `containerRef`——它们从参数进来，
 * 是画布里的同一批 `RefObject`（恒定身份）；**没有**为了少传参改成 state 或闭包捕获渲染值。
 *
 * 返回类型直接用 `TopicNodeProps` 上对应的处理器类型推导，不手抄签名。
 */

export function useNodeCallbacks({
  containerRef,
  layoutRef,
  zoomRef,
  panRef
}: {
  containerRef: RefObject<HTMLDivElement | null>
  layoutRef: RefObject<LayoutResult>
  zoomRef: RefObject<number>
  panRef: RefObject<{ x: number; y: number }>
}): {
  handleNodeDoubleClick: TopicNodeProps['onDoubleClick']
  handleNodeRichChange: TopicNodeProps['onRichChange']
  handleNodeCancelEdit: TopicNodeProps['onCancelEdit']
  handleNodeCommitEdit: TopicNodeProps['onCommitEdit']
  handleNodeCommitAndAddChild: TopicNodeProps['onCommitAndAddChild']
  handleNodeCommitAndAddSibling: TopicNodeProps['onCommitAndAddSibling']
  handleNodeNavigateEdit: TopicNodeProps['onNavigateEdit']
  handleNodeToggleCollapse: TopicNodeProps['onToggleCollapse']
  handleNodeToggleFoldSide: TopicNodeProps['onToggleFoldSide']
} {
  const handleNodeDoubleClick = useCallback((id: string): void => {
    useEditor.getState().beginEdit(id)
  }, [])
  const handleNodeRichChange = useCallback((id: string, rich: RichText): void => {
    const store = useEditor.getState()
    if (store.editingId === id) store.updateEditingRich(rich)
  }, [])
  const handleNodeCancelEdit = useCallback((): void => {
    useEditor.getState().cancelEdit()
  }, [])
  const handleNodeCommitEdit = useCallback((): void => {
    useEditor.getState().commitEdit()
  }, [])
  const handleNodeCommitAndAddChild = useCallback((): void => {
    useEditor.getState().commitAndAddChild()
  }, [])
  const handleNodeCommitAndAddSibling = useCallback((): void => {
    useEditor.getState().commitAndAddSibling()
  }, [])
  const handleNodeNavigateEdit = useCallback(
    (key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'): void => {
      // 空主题上的方向键：先提交（空内容不会进撤销栈），再移动选择
      const store = useEditor.getState()
      if (store.editingId) store.commitEdit()
      store.navigateSelection(key)
    },
    []
  )
  const handleNodeToggleCollapse = useCallback(
    (id: string): void => {
      // 折叠 / 展开会重排整张图：把被点的那个主题**按在原处**，
      // 否则用户眼前的画面会整体跳走（看着看着，那一支忽然不见了）。
      // 视口值走 ref：回调才能保持引用稳定，又不失真（点击瞬间 ref 与渲染值一致）。
      const lay = layoutRef.current
      const z = zoomRef.current
      const p = panRef.current
      const before = lay?.nodeMap.get(id)
      const screen = before ? { x: before.x * z + p.x, y: before.y * z + p.y } : null
      useEditor.getState().toggleCollapse(id)
      if (!screen || !containerRef.current) return
      window.requestAnimationFrame(() => {
        const after = layoutRef.current?.nodeMap.get(id)
        if (!after) return
        // 反解平移量：让 after 的世界坐标仍落在同一个屏幕位置
        useEditor.getState().setPan({ x: screen.x - after.x * z, y: screen.y - after.y * z })
      })
      // 四个 ref 从参数进来（搬迁前是画布里的本地 useRef）：lint 要求列出，它们身份恒定，
      // 列进来不改变本回调的重建时机（仍然是「只建一次」），与搬迁前逐一同拍
    },
    [containerRef, layoutRef, panRef, zoomRef]
  )

  const handleNodeToggleFoldSide = useCallback(
    (id: string, side: FoldSide): void => {
      /**
       * 平衡思维导图的中心主题：收起/展开某一侧。
       * 与整体折叠同一处理——重排后把被点的中心主题**按在屏幕原处**，
       * 否则用户正看着左侧收起来，画面却整体跳走。
       */
      const lay = layoutRef.current
      const z = zoomRef.current
      const p = panRef.current
      const before = lay?.nodeMap.get(id)
      const screen = before ? { x: before.x * z + p.x, y: before.y * z + p.y } : null
      useEditor.getState().toggleFoldSide(id, side)
      if (!screen || !containerRef.current) return
      window.requestAnimationFrame(() => {
        const after = layoutRef.current?.nodeMap.get(id)
        if (!after) return
        useEditor.getState().setPan({ x: screen.x - after.x * z, y: screen.y - after.y * z })
      })
      // 同上：四个 ref 身份恒定，不改变重建时机
    },
    [containerRef, layoutRef, panRef, zoomRef]
  )

  return {
    handleNodeDoubleClick,
    handleNodeRichChange,
    handleNodeCancelEdit,
    handleNodeCommitEdit,
    handleNodeCommitAndAddChild,
    handleNodeCommitAndAddSibling,
    handleNodeNavigateEdit,
    handleNodeToggleCollapse,
    handleNodeToggleFoldSide
  }
}
