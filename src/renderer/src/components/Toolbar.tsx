import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  AlignStartVertical,
  Braces,
  ChevronDown,
  CircleHelp,
  Code2,
  Crosshair,
  FileInput,
  FileOutput,
  FilePlus,
  FileText,
  FolderOpen,
  Frame,
  History as HistoryIcon,
  ImageDown,
  ListTree,
  Maximize,
  MoreHorizontal,
  Palette,
  PanelRight,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  SaveAll,
  Search as SearchIcon,
  Settings2,
  Sigma,
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
  /** 导入 Markdown / OPML 一键生成导图 */
  onImportMarkdown(): void
  onImportOpml(): void
  /** 直接导出大纲（不带设置框） */
  onExportOutline(format: OutlineFormat): void
  /** AI 相关 */
  onAiGenerate(): void
  onAiExpand(): void
  onAiPolish(): void
  onAiSettings(): void
  /** 历史记录 / 常用 / 默认保存位置 */
  onHistory(): void
  /** 全部恢复自动布局（清空手动位置偏移） */
  onRelayout(): void
  /** 插入/编辑公式（打开节点面板并聚焦公式输入框） */
  onFormula(): void
  /** 插入/编辑代码块（打开节点面板并聚焦代码输入框） */
  onCode(): void
  /** 开一个新窗口（一份新文档） */
  onNewWindow(): void
  /** 在新窗口打开当前画布（并排看两张画布） */
  onOpenSheetWindow(): void
}

interface Props {
  actions: ToolbarActions
  /** 大纲面板是否已打开（用于按钮的按下态） */
  outlineOpen?: boolean
}

/**
 * 工具栏上的下拉菜单。
 *
 * 菜单渲染在 **document.body 的传送门**里，而不是按钮旁边：
 * 工具栏是横排容器（窗口变窄时会换行/滚动），绝对定位的菜单会被它裁掉——
 * 之前「点 AI 没反应」就是这个原因。用传送门 + fixed 定位后不再受任何祖先容器影响。
 */
function ToolMenu({
  icon,
  label,
  title,
  items,
  iconOnly = false
}: {
  icon: ReactNode
  label: string
  title: string
  items: Array<{ key: string; label: string; hint?: string; icon?: ReactNode; onSelect(): void }>
  iconOnly?: boolean
}): ReactElement {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const open = position !== null

  const openMenu = (): void => {
    const el = buttonRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const width = 236
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    // 下方放不下就往上弹
    const estimatedHeight = 60 + 62 * 0 + 0
    const top =
      rect.bottom + 6 + estimatedHeight > window.innerHeight - 8 && rect.top > 240
        ? Math.max(8, rect.top - 6 - 300)
        : rect.bottom + 6
    setPosition({ top, left })
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target && (listRef.current?.contains(target) || buttonRef.current?.contains(target))) return
      setPosition(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPosition(null)
    }
    // 滚动/改窗口大小后按钮位置会变，直接收起最省心
    const onScrollOrResize = (): void => setPosition(null)

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onScrollOrResize)
    window.addEventListener('scroll', onScrollOrResize, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onScrollOrResize)
      window.removeEventListener('scroll', onScrollOrResize, true)
    }
  }, [open])

  const menu = (
    <div
      ref={listRef}
      className="tool-menu__list"
      style={{ position: 'fixed', top: position?.top ?? 0, left: position?.left ?? 0 }}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className="tool-menu__item"
          title={item.hint}
          onClick={() => {
            setPosition(null)
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
  )

  return (
    <span className="tool-menu">
      <button
        ref={buttonRef}
        type="button"
        className={[
          'tool-btn',
          iconOnly ? '' : 'tool-btn--labeled',
          open ? 'tool-btn--active' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        title={title}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (open) setPosition(null)
          else openMenu()
        }}
      >
        {icon}
        {iconOnly ? null : label}
        {iconOnly ? null : <ChevronDown size={13} />}
      </button>

      {open && position ? createPortal(menu, document.body) : null}
    </span>
  )
}

export default function Toolbar({ actions, outlineOpen = false }: Props): ReactElement {
  const workbook = useEditor((s) => s.workbook)
  const selection = useEditor((s) => s.selection)
  const zoom = useEditor((s) => s.zoom)
  const viewLock = useEditor((s) => s.viewLock)
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
              key: 'import-markdown',
              label: '导入 Markdown 生成导图',
              hint: '按标题/列表自动生成',
              icon: <FileText size={15} />,
              onSelect: actions.onImportMarkdown
            },
            {
              key: 'import-opml',
              label: '导入 OPML 生成导图',
              hint: 'Xmind / 幕布 / 亿图都能导出',
              icon: <FileText size={15} />,
              onSelect: actions.onImportOpml
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
          title="导出图片、PDF、Markdown 等"
          items={[
            {
              key: 'export-image',
              label: '图片 / PDF（PNG、SVG、PDF）',
              hint: '可选清晰度与背景',
              icon: <ImageDown size={15} />,
              onSelect: actions.onExport
            },
            {
              key: 'export-md',
              label: 'Markdown（.md）',
              hint: '标题 + 列表 + 备注引用块，可直接粘进笔记软件',
              icon: <FileText size={15} />,
              onSelect: () => actions.onExportOutline('md')
            },
            {
              key: 'export-txt',
              label: '纯文本（.txt）',
              hint: '缩进式大纲',
              icon: <FileText size={15} />,
              onSelect: () => actions.onExportOutline('txt')
            },
            {
              key: 'export-opml',
              label: 'OPML（.opml）',
              hint: '可导入其它导图软件',
              icon: <FileText size={15} />,
              onSelect: () => actions.onExportOutline('opml')
            }
          ]}
        />

        {/* Markdown 是最常用的导出，直接给个按钮，不用翻菜单 */}
        <button
          type="button"
          className="tool-btn tool-btn--labeled"
          title="一键导出 Markdown（.md）：根主题作标题、层级作列表、备注作引用块"
          onClick={() => actions.onExportOutline('md')}
        >
          <FileText size={15} />
          Markdown
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

      {/* 画布级元素：创建入口放在工具栏。
          只留图标（文字会把工具栏撑长），怎么用写在提示里 */}
      <div className="toolbar__group">
        <span className="tool-btn-wrap" title={relationshipHint}>
          <button
            type="button"
            className={toggle.relationshipId ? 'tool-btn tool-btn--active' : 'tool-btn'}
            disabled={selection.length !== 2}
            onClick={() => store().addRelationship()}
          >
            <Spline size={17} />
          </button>
        </span>
        <span className="tool-btn-wrap" title={summaryHint}>
          <button
            type="button"
            className={toggle.summaryId ? 'tool-btn tool-btn--active' : 'tool-btn'}
            disabled={selection.length === 0}
            onClick={() => store().addSummary()}
          >
            <Braces size={17} />
          </button>
        </span>
        <span className="tool-btn-wrap" title={boundaryHint}>
          <button
            type="button"
            className={toggle.boundaryId ? 'tool-btn tool-btn--active' : 'tool-btn'}
            disabled={selection.length === 0}
            onClick={() => store().addBoundary()}
          >
            <Frame size={17} />
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
        <button type="button" className="tool-btn" title="节点属性（备注 / 图片 / 代码块 / 标记…）" onClick={actions.onNodes}>
          <PanelRight size={17} />
        </button>
        <button type="button" className="tool-btn" title="主题（换配色 / 边框样式）" onClick={actions.onThemes}>
          <Palette size={17} />
        </button>
        <button
          type="button"
          className="tool-btn"
          title="插入 / 编辑公式（也支持 $x^2$、$$…$$ 这类 Markdown 写法）"
          onClick={actions.onFormula}
        >
          <Sigma size={17} />
        </button>
        <button
          type="button"
          className="tool-btn"
          title="插入 / 编辑代码块（Alt+C；节点上的语言小标可直接切换语言）"
          onClick={actions.onCode}
        >
          <Code2 size={17} />
        </button>
        <button
          type="button"
          className="tool-btn"
          title="全部恢复自动布局：清空手动拖拽的位置偏移（含悬浮主题），可撤销"
          onClick={actions.onRelayout}
        >
          <Wand2 size={17} />
        </button>
        <button
          type="button"
          className="tool-btn"
          title="搜索 / 筛选 / 统计（Ctrl+F）"
          onClick={actions.onSearch}
        >
          <SearchIcon size={17} />
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
        <button
          type="button"
          className={viewLock ? 'tool-btn tool-btn--active' : 'tool-btn'}
          title={
            viewLock
              ? '视角锁定：视角正跟住选中的主题（再点一次取消，Ctrl+Shift+L）'
              : '视角锁定：让视角始终跟住选中的主题（Ctrl+Shift+L）'
          }
          onClick={() => store().toggleViewLock()}
        >
          <Crosshair size={17} />
        </button>
      </div>

      <div className="toolbar__divider" />

      {/* 不常用但仍需要一键到达的：收进「更多」，让主行保持短 */}
      <div className="toolbar__group">
        <ToolMenu
          iconOnly
          icon={<MoreHorizontal size={17} />}
          label="更多"
          title="更多功能"
          items={[
            {
              key: 'new-window',
              label: '新建窗口',
              hint: '一个窗口一份文档（Ctrl+Shift+N）',
              icon: <Frame size={15} />,
              onSelect: actions.onNewWindow
            },
            {
              key: 'open-sheet-window',
              label: '在新窗口打开当前画布',
              hint: '并排看两张画布',
              icon: <PanelRight size={15} />,
              onSelect: actions.onOpenSheetWindow
            },
            {
              key: 'history',
              label: '历史记录与常用',
              hint: '最近打开 / 固定常用 / 默认保存位置',
              icon: <HistoryIcon size={15} />,
              onSelect: actions.onHistory
            },
            {
              key: 'nodes',
              label: '节点属性',
              hint: '标记 / 标签 / 备注 / 超链接 / 附件 / 公式',
              icon: <Tag size={15} />,
              onSelect: actions.onNodes
            },
            {
              key: 'themes',
              label: '主题外观',
              hint: '配色与主题库',
              icon: <Palette size={15} />,
              onSelect: actions.onThemes
            },
            {
              key: 'reset-layout',
              label: '恢复自动布局',
              hint: hasFreePosition ? '把自由摆放的主题放回自动位置' : '选中自由摆放的主题后可用',
              icon: <RotateCcw size={15} />,
              onSelect: () => selectedId && store().clearPosition(selectedId)
            },
            {
              key: 'reset-all-layout',
              label: '全部恢复自动布局',
              hint: '把这张画布上所有自由摆放的主题一次性放回去',
              icon: <AlignStartVertical size={15} />,
              onSelect: () => store().clearAllPositions()
            },
            {
              key: 'shortcuts',
              label: '快捷键说明',
              hint: '全部快捷键速查',
              icon: <CircleHelp size={15} />,
              onSelect: actions.onHelp
            }
          ]}
        />
      </div>
    </div>
  )
}
