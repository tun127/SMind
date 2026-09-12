import { useEffect, useMemo, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import {
  Braces,
  ChevronDown,
  CircleHelp,
  FileInput,
  FileOutput,
  FilePlus,
  FileText,
  FolderOpen,
  Frame,
  ImageDown,
  ListTree,
  Maximize,
  Palette,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  SaveAll,
  Search as SearchIcon,
  Settings2,
  Sparkles,
  Spline,
  Tag,
  Trash2,
  Undo2,
  Wand2,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { DEFAULT_STRUCTURE, STRUCTURES } from '@shared/xmind/constants'
import type { OutlineFormat } from '@shared/outline'
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
  onOutline(): void
  onSearch(): void
  onExport(): void
  /** 导入主题文件（.json） */
  onImportTheme(): void
  /** 直接导出大纲（不带设置框） */
  onExportOutline(format: OutlineFormat): void
  /** AI 相关 */
  onAiGenerate(): void
  onAiExpand(): void
  onAiPolish(): void
  onAiSettings(): void
}

interface Props {
  actions: ToolbarActions
  /** 大纲面板是否已打开（用于按钮的按下态） */
  outlineOpen?: boolean
}

/**
 * 工具栏上的下拉菜单。
 * 点按钮展开，点菜单项或点别处收起；按钮本身不抢焦点（否则会吃掉 Enter/Tab）。
 */
function ToolMenu({
  icon,
  label,
  title,
  items
}: {
  icon: ReactNode
  label: string
  title: string
  items: Array<{ key: string; label: string; hint?: string; icon?: ReactNode; onSelect(): void }>
}): ReactElement {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span className="tool-menu">
      <button
        type="button"
        className={open ? 'tool-btn tool-btn--labeled tool-btn--active' : 'tool-btn tool-btn--labeled'}
        title={title}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
        {label}
        <ChevronDown size={13} />
      </button>

      {open && (
        <div className="tool-menu__list" onPointerDown={(event) => event.stopPropagation()}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              className="tool-menu__item"
              title={item.hint}
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
            >
              <span className="tool-menu__icon">{item.icon}</span>
              <span className="tool-menu__text">
                {item.label}
                {item.hint ? <em className="tool-menu__hint">{item.hint}</em> : null}
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

export default function Toolbar({ actions, outlineOpen = false }: Props): ReactElement {
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
        <button
          type="button"
          className="tool-btn"
          title="打开 / 导入 .xmind 文件 (Ctrl+O)"
          onClick={actions.onOpen}
        >
          <FolderOpen size={17} />
        </button>
        <button type="button" className="tool-btn" title="保存 (Ctrl+S)" onClick={actions.onSave}>
          <Save size={17} />
        </button>
        <button
          type="button"
          className="tool-btn"
          title="另存为 (Ctrl+Shift+S)"
          onClick={actions.onSaveAs}
        >
          <SaveAll size={17} />
        </button>

        {/* 导入 / 导出：常用功能不藏在菜单里 */}
        <ToolMenu
          icon={<FileInput size={16} />}
          label="导入"
          title="导入文件"
          items={[
            {
              key: 'import-xmind',
              label: '打开 .xmind 文件',
              hint: 'Ctrl+O',
              icon: <FolderOpen size={15} />,
              onSelect: actions.onOpen
            },
            {
              key: 'import-theme',
              label: '导入主题文件',
              hint: '.json',
              icon: <Palette size={15} />,
              onSelect: actions.onImportTheme
            }
          ]}
        />

        <ToolMenu
          icon={<FileOutput size={16} />}
          label="导出"
          title="导出图片、PDF 或大纲"
          items={[
            {
              key: 'export-image',
              label: 'PNG / SVG / PDF…',
              hint: '可选清晰度与背景',
              icon: <ImageDown size={15} />,
              onSelect: actions.onExport
            },
            {
              key: 'export-txt',
              label: '大纲 · TXT',
              hint: '纯文本',
              icon: <FileText size={15} />,
              onSelect: () => actions.onExportOutline('txt')
            },
            {
              key: 'export-md',
              label: '大纲 · Markdown',
              hint: '.md',
              icon: <FileText size={15} />,
              onSelect: () => actions.onExportOutline('md')
            },
            {
              key: 'export-opml',
              label: '大纲 · OPML',
              hint: '可导入其它导图软件',
              icon: <FileText size={15} />,
              onSelect: () => actions.onExportOutline('opml')
            }
          ]}
        />
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
        <button
          type="button"
          className={outlineOpen ? 'tool-btn tool-btn--active' : 'tool-btn'}
          title={outlineOpen ? '关闭大纲视图' : '大纲视图（与导图双向实时同步）'}
          onClick={actions.onOutline}
        >
          <ListTree size={17} />
        </button>
        <button type="button" className="tool-btn" title="节点属性（标记 / 标签 / 备注 / 超链接）" onClick={actions.onNodes}>
          <Tag size={17} />
        </button>
        <button
          type="button"
          className="tool-btn"
          title="搜索 / 筛选 / 统计（Ctrl+F）"
          onClick={actions.onSearch}
        >
          <SearchIcon size={17} />
        </button>
        <button type="button" className="tool-btn" title="主题外观" onClick={actions.onThemes}>
          <Palette size={17} />
        </button>
      </div>

      <div className="toolbar__divider" />

      {/* AI：常用动作放在工具栏，设置也在同一处 */}
      <div className="toolbar__group">
        <ToolMenu
          icon={<Sparkles size={16} />}
          label="AI"
          title="AI 助手（OpenAI 兼容接口）"
          items={[
            {
              key: 'ai-generate',
              label: '一键生成导图…',
              hint: '给个主题就出整张图',
              icon: <Sparkles size={15} />,
              onSelect: actions.onAiGenerate
            },
            {
              key: 'ai-expand',
              label: '扩写子主题',
              hint: '给选中的主题补下级',
              icon: <ListTree size={15} />,
              onSelect: actions.onAiExpand
            },
            {
              key: 'ai-polish',
              label: '润色标题',
              hint: '改写选中主题的文字',
              icon: <Wand2 size={15} />,
              onSelect: actions.onAiPolish
            },
            {
              key: 'ai-settings',
              label: 'AI 设置…',
              hint: 'BaseURL / Key / 模型',
              icon: <Settings2 size={15} />,
              onSelect: actions.onAiSettings
            }
          ]}
        />
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

      <div className="toolbar__divider" />

      <div className="toolbar__group">
        <button type="button" className="tool-btn" title="快捷键说明" onClick={actions.onHelp}>
          <CircleHelp size={17} />
        </button>
      </div>
    </div>
  )
}
