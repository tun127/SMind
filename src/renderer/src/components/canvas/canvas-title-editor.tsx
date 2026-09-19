import type { ReactElement } from 'react'
import { OVERLAY_TITLE_LINE_HEIGHT, overlayTitleLines } from '@shared/layout/overlays'
import type { useTitleEdit } from './use-title-edit'

/**
 * 覆盖层标题的就地编辑框（自 `Canvas.tsx` 整块搬出，逐字未改）。
 *
 * 放在**世界容器内**，所以会随画布一起缩放。关系线 / 边界 / 概要都支持手动换行（Enter 换行、
 * Esc 取消、Ctrl+Enter 提交、失焦也提交）——以前只有概要能换行，另外两种用单行 input。
 *
 * `useTitleEdit()` 的四个返回值（`titleEdit` / `setTitleEdit` / `cancelTitleRef` / `commitTitleEdit`）
 * 原样从 props 进来：`cancelTitleRef` 是那个「Esc 取消」标记的 `RefObject`，写法与搬迁前同源。
 */

export function CanvasTitleEditor({
  titleEdit,
  setTitleEdit,
  cancelTitleRef,
  commitTitleEdit
}: {
  titleEdit: ReturnType<typeof useTitleEdit>['titleEdit']
  setTitleEdit: ReturnType<typeof useTitleEdit>['setTitleEdit']
  cancelTitleRef: ReturnType<typeof useTitleEdit>['cancelTitleRef']
  commitTitleEdit: ReturnType<typeof useTitleEdit>['commitTitleEdit']
}): ReactElement {
  return (
    <>
      {/* 双击标题后的就地编辑框。放在世界容器内，所以会随画布一起缩放。
            关系线 / 边界 / 概要**都支持手动换行**（Enter 换行、Esc 取消、Ctrl+Enter 提交、失焦也提交）——
            以前只有概要能换行，另外两种用单行 input，用户根本没法换行 */}
      {titleEdit ? (
        <textarea
          className="overlay-title-editor overlay-title-editor--multi"
          rows={Math.max(1, overlayTitleLines(titleEdit.value).length)}
          style={{
            left: titleEdit.x,
            // 多行时整块按中线对齐（与画布上的排布方式一致）
            top:
              titleEdit.y -
              13 -
              ((Math.max(1, overlayTitleLines(titleEdit.value).length) - 1) *
                OVERLAY_TITLE_LINE_HEIGHT) /
                2,
            transform:
              titleEdit.anchor === 'middle'
                ? 'translateX(-50%)'
                : titleEdit.anchor === 'end'
                  ? 'translateX(-100%)'
                  : 'none'
          }}
          value={titleEdit.value}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            const next = e.currentTarget.value
            setTitleEdit((current) => (current ? { ...current, value: next } : current))
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            // 输入法组词期间交给输入法处理（React 合成事件没有 isComposing）
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            // Enter = 换行（这就是「手动换行」，关系线 / 边界 / 概要一视同仁）；
            // Esc = 取消；Ctrl/Cmd+Enter = 直接提交并退出（单行标签改完想快点收工）
            if (e.key === 'Escape') {
              e.preventDefault()
              cancelTitleRef.current = true
              e.currentTarget.blur()
              return
            }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              e.currentTarget.blur()
            }
          }}
          onBlur={commitTitleEdit}
        />
      ) : null}
    </>
  )
}
