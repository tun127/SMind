/**
 * 工具栏「编辑」组的两个 toolgroup：撤销 / 重做 + 添加子主题 / 删除所选。
 *
 * 两组原本是入口里相邻的两个 `toolbar__group`（中间夹一个分隔条），一起搬进本模块，
 * DOM 顺序与原来完全一致；JSX 逐字未改，`quick` 由入口原样传入。
 */

import { Plus, Redo2, Trash2, Undo2 } from 'lucide-react'
import type { ReactElement } from 'react'
import { useEditor } from '../../store/editor'
import type { QuickRender } from './quick-items'

interface Props {
  quick: QuickRender
  canUndo: boolean
  canRedo: boolean
  selectedId: string | undefined
  rootId: string
}

export default function EditGroup({
  quick,
  canUndo,
  canRedo,
  selectedId,
  rootId
}: Props): ReactElement {
  const store = useEditor.getState

  return (
    <>
      <div className="toolbar__group">
        {quick(
          'undo',
          <button
            type="button"
            className="tool-btn"
            title="撤销 (Ctrl+Z)"
            disabled={!canUndo}
            onClick={() => store().undo()}
          >
            <Undo2 size={17} />
          </button>
        )}
        {quick(
          'redo',
          <button
            type="button"
            className="tool-btn"
            title="重做 (Ctrl+Shift+Z)"
            disabled={!canRedo}
            onClick={() => store().redo()}
          >
            <Redo2 size={17} />
          </button>
        )}
      </div>

      <div className="toolbar__divider" />

      <div className="toolbar__group">
        {quick(
          'add-child',
          <button
            type="button"
            className="tool-btn"
            title="添加子主题 (Tab)"
            onClick={() => store().addChild(selectedId ?? rootId)}
          >
            <Plus size={17} />
          </button>
        )}
        {quick(
          'delete',
          <button
            type="button"
            className="tool-btn"
            title="删除所选主题 (Delete)"
            disabled={!selectedId || selectedId === rootId}
            onClick={() => store().deleteSelection()}
          >
            <Trash2 size={17} />
          </button>
        )}
      </div>
    </>
  )
}
