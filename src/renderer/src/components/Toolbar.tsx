import { useMemo, type MouseEvent, type ReactElement } from 'react'
import {
  Braces,
  ChevronDown,
  FilePlus,
  FolderOpen,
  Frame,
  Maximize,
  Palette,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Spline,
  Tag,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { DEFAULT_STRUCTURE, STRUCTURES } from '@shared/xmind/constants'
import { activeRoot, findTopic } from '@shared/model/tree'
import { viewportActions } from '../render/viewport'
import { overlayToggleOf, useEditor } from '../store/editor'

export interface ToolbarActions {
  onNew(): void
  onOpen(): void
  onSave(): void
  onSaveAs(): void
  onHelp(): void
  onThemes(): void
  onNodes(): void
}

interface Props {
  actions: ToolbarActions
}

export default function Toolbar({ actions }: Props): ReactElement {
  const workbook = useEditor((s) => s.workbook)
  const selection = useEditor((s) => s.selection)
  const zoom = useEditor((s) => s.zoom)
  const canUndo = useEditor((s) => s.undoStack.length > 0)
  const canRedo = useEditor((s) => s.redoStack.length > 0)

  const root = activeRoot(workbook)
  const selectedId = selection[0]
  const selectedTopic = selectedId ? findTopic(root, selectedId) : null
  const currentStructure = selectedTopic?.structureClass ?? root.structureClass ?? DEFAULT_STRUCTURE
  const hasFreePosition = Boolean(selectedTopic?.position)

  const store = useEditor.getState

  // 这三个按钮是「开关」：当前选择已经有对应元素时显示为已按下，再点一次即移除。
  // 必须用 useMemo 包住：selector 每次都返回新对象会导致无限重渲染。
  const toggle = useMemo(() => overlayToggleOf(workbook, selection), [workbook, selection])

  // 禁用状态的 button 不会弹出 title 提示，所以提示挂在外面那层 span 上，
  // 用户始终能看到「为什么现在点不了」。
  const relationshipHint =
    selection.length !== 2
      ? `关系线：请先按住 Ctrl 选中两个主题（当前选中 ${selection.length} 个）`
      : toggle.relationshipId
        ? '再点一次即取消这条关系线（拖动线身可移动，拖动两端圆点可改接）'
        : '在两个选中主题之间画关系线（画好后可拖动线身移动、拖动两端圆点改接）'
  const summaryHint =
    selection.length === 0
      ? '概要：请先选中若干个同级主题（按住 Ctrl 可多选）'
      : toggle.summaryId
        ? '再点一次即取消这个概要'
        : '给选中的同级主题加概要（按住 Ctrl 可多选）'
  const boundaryHint =
    selection.length === 0
      ? '边界：请先选中若干个同级主题（按住 Ctrl 可多选）'
      : toggle.boundaryId
        ? '再点一次即取消这个边界'
        : '给选中的同级主题加边界（按住 Ctrl 可多选）'

  // 工具栏按钮不抢焦点：否则点过按钮后按 Enter / Tab 会先被按钮吃掉。
  // 只对按钮生效，下拉框需要保留默认行为才能正常展开。
  const keepFocus = (e: MouseEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement | null
    if (target && target.closest('button')) e.preventDefault()
  }

  return (
    <div className="toolbar" onMouseDown={keepFocus}>
      <div className="toolbar__group">
        <button type="button" className="tool-btn" title="新建 (Ctrl+N)" onClick={actions.onNew}>
          <FilePlus size={17} />
        </button>
        <button type="button" className="tool-btn" title="打开 (Ctrl+O)" onClick={actions.onOpen}>
          <FolderOpen size={17} />
        </button>
        <button type="button" className="tool-btn" title="保存 (Ctrl+S)" onClick={actions.onSave}>
          <Save size={17} />
        </button>
      </div>

      <div className="toolbar__divider" />

      <div className="toolbar__group">
        <button
          type="button"
          className="tool-btn"
          title="撤销 (Ctrl+Z)"
          disabled={!canUndo}
          onClick={() => store().undo()}
        >
          <Undo2 size={17} />
        </button>
        <button
          type="button"
          className="tool-btn"
          title="重做 (Ctrl+Shift+Z)"
          disabled={!canRedo}
          onClick={() => store().redo()}
        >
          <Redo2 size={17} />
        </button>
      </div>

      <div className="toolbar__divider" />

      <div className="toolbar__group">
        <button
          type="button"
          className="tool-btn"
          title="添加子主题 (Tab)"
          onClick={() => store().addChild(selectedId ?? root.id)}
        >
          <Plus size={17} />
        </button>
        <button
          type="button"
          className="tool-btn"
          title="删除所选主题 (Delete)"
          disabled={!selectedId || selectedId === root.id}
          onClick={() => store().deleteSelection()}
        >
          <Trash2 size={17} />
        </button>
        <button
          type="button"
          className="tool-btn"
          title="恢复自动布局"
          disabled={!hasFreePosition}
          onClick={() => selectedId && store().clearPosition(selectedId)}
        >
          <RotateCcw size={17} />
        </button>
      </div>

      <div className="toolbar__divider" />

      <div className="toolbar__group toolbar__structure">
        <span className="toolbar__label">结构</span>
        <div className="select-wrap">
          <select
            className="select"
            value={currentStructure}
            onChange={(e) => store().setStructure(e.target.value, selectedId ?? root.id)}
          >
            {STRUCTURES.map((item) => (
              <option key={item.class} value={item.class} disabled={!item.supported}>
                {item.label}
                {item.supported ? '' : '（开发中）'}
              </option>
            ))}
          </select>
          <ChevronDown size={14} className="select-arrow" />
        </div>
      </div>

      <div className="toolbar__divider" />

      {/* 画布级元素：创建入口放在工具栏，常用操作不用再翻面板 */}
      <div className="toolbar__group">
        <span className="tool-btn-wrap" title={relationshipHint}>
          <button
            type="button"
            className={
              toggle.relationshipId ? 'tool-btn tool-btn--labeled tool-btn--active' : 'tool-btn tool-btn--labeled'
            }
            disabled={selection.length !== 2}
            onClick={() => store().addRelationship()}
          >
            <Spline size={16} />
            关系线
          </button>
        </span>
        <span className="tool-btn-wrap" title={summaryHint}>
          <button
            type="button"
            className={
              toggle.summaryId ? 'tool-btn tool-btn--labeled tool-btn--active' : 'tool-btn tool-btn--labeled'
            }
            disabled={selection.length === 0}
            onClick={() => store().addSummary()}
          >
            <Braces size={16} />
            概要
          </button>
        </span>
        <span className="tool-btn-wrap" title={boundaryHint}>
          <button
            type="button"
            className={
              toggle.boundaryId ? 'tool-btn tool-btn--labeled tool-btn--active' : 'tool-btn tool-btn--labeled'
            }
            disabled={selection.length === 0}
            onClick={() => store().addBoundary()}
          >
            <Frame size={16} />
            边界
          </button>
        </span>
      </div>

      <div className="toolbar__divider" />

      <div className="toolbar__group">
        <button type="button" className="tool-btn" title="节点属性（标记 / 标签 / 备注 / 超链接）" onClick={actions.onNodes}>
          <Tag size={17} />
        </button>
        <button type="button" className="tool-btn" title="主题外观" onClick={actions.onThemes}>
          <Palette size={17} />
        </button>
      </div>

      <div className="toolbar__spacer" />

      <div className="toolbar__group">
        <button type="button" className="tool-btn" title="缩小 (Ctrl+-)" onClick={() => viewportActions.zoomTo(zoom / 1.2)}>
          <ZoomOut size={17} />
        </button>
        <button
          type="button"
          className="tool-btn tool-btn--text"
          title="实际大小 (Ctrl+0)"
          onClick={() => viewportActions.zoomTo(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" className="tool-btn" title="放大 (Ctrl+=)" onClick={() => viewportActions.zoomTo(zoom * 1.2)}>
          <ZoomIn size={17} />
        </button>
        <button type="button" className="tool-btn" title="适应画布 (Ctrl+1)" onClick={() => viewportActions.fit()}>
          <Maximize size={17} />
        </button>
      </div>
    </div>
  )
}
