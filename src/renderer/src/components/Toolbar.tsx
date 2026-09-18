import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import {
  AppWindow,
  Bot,
  Braces,
  ChevronDown,
  CircleHelp,
  Code2,
  Copy,
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
  Pin,
  PinOff,
  Plus,
  Redo2,
  Save,
  SaveAll,
  Search as SearchIcon,
  Settings2,
  Sigma,
  Sparkles,
  Spline,
  Trash2,
  Undo2,
  Wand2,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { DEFAULT_STRUCTURE, STRUCTURES } from '@shared/xmind/constants'
import type { OutlineFormat } from '@shared/outline'
import { activeRoot } from '@shared/model/tree'
import { viewportActions } from '../render/viewport'
import { overlayToggleOf, patchAppSettings, useEditor } from '../store/editor'

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
  onAiSettings(): void
  /** 打开 / 关闭 AI 聊天面板（三期 1a） */
  onAiChat(): void
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
  /** 已被右键收进「更多 ▾」的快捷栏功能 id（设置持久化） */
  hiddenItems?: string[]
  /** 收纳 / 移回某个快捷栏功能 */
  onToggleHidden?(id: string, hidden: boolean): void
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
  items: Array<{
    key: string
    label: string
    hint?: string
    icon?: ReactNode
    onSelect(): void
    /** 提供时在行尾显示「移回快捷栏」小按钮（收纳进来的功能用） */
    onUnpin?(): void
    /** 提供时在行尾显示「拿出到快捷栏」小按钮（还在「更多」里的功能用） */
    onTakeOut?(): void
  }>
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
    // 下方放不下就往上弹（菜单高度按固定值估算，条目数是动态的，不参与判断）
    const estimatedHeight = 60
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
      if (target && (listRef.current?.contains(target) || buttonRef.current?.contains(target)))
        return
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
          {item.onUnpin ? (
            <span
              className="tool-menu__pin"
              title="移回快捷栏"
              onClick={(event) => {
                event.stopPropagation()
                item.onUnpin?.()
                setPosition(null)
              }}
            >
              <PinOff size={13} />
            </span>
          ) : null}
          {item.onUnpin ? null : item.onTakeOut ? (
            <span
              className="tool-menu__pin"
              title="拿出到快捷栏"
              onClick={(event) => {
                event.stopPropagation()
                item.onTakeOut?.()
                setPosition(null)
              }}
            >
              <Pin size={13} />
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )

  return (
    <span className="tool-menu">
      <button
        ref={buttonRef}
        type="button"
        className={['tool-btn', iconOnly ? '' : 'tool-btn--labeled', open ? 'tool-btn--active' : '']
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

/**
 * 快捷栏按钮的「收纳」外壳：**右键**弹出「收进更多 ▾」。
 *
 * 被收纳的功能从快捷栏消失、出现在「更多 ▾」菜单里，行尾有
 * 「移回快捷栏」按钮——收纳状态持久化在设置里（toolbarHidden）。
 */
function PinWrap({
  title,
  hint,
  shown,
  onHide,
  children
}: {
  title: string
  /**
   * 补充说明（例如"为什么这个按钮现在点不了"）。
   * 必须挂在外层 span 上：**禁用状态的 button 不弹 title**，
   * 挂在按钮上等于用户永远看不到。
   */
  hint?: string
  /** false＝已收进「更多 ▾」，不占快捷栏的位置 */
  shown: boolean
  /** 右键「收进更多 ▾」的统一收尾（快捷项与「拿出」的菜单项动作不同，由调用方决定） */
  onHide(): void
  children: ReactNode
}): ReactElement | null {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menu) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target && listRef.current?.contains(target)) return
      setMenu(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  // 被收纳的功能不占快捷栏的位置（它活在「更多 ▾」里）
  if (!shown) return null

  return (
    <span
      className="tool-btn-wrap"
      title={`${hint ?? title}（右键可收进「更多 ▾」）`}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      {children}
      {menu
        ? createPortal(
            <div
              ref={listRef}
              className="tool-menu__list"
              style={{ position: 'fixed', top: menu.y, left: menu.x }}
            >
              <button
                type="button"
                className="tool-menu__item"
                onClick={() => {
                  onHide()
                  setMenu(null)
                }}
              >
                <span className="tool-menu__icon">
                  <PinOff size={15} />
                </span>
                <span className="tool-menu__text">
                  收进「更多 ▾」
                  <em className="tool-menu__hint">可随时移回快捷栏</em>
                </span>
              </button>
            </div>,
            document.body
          )
        : null}
    </span>
  )
}

/** 快捷栏功能清单：id → 更多菜单里的展示与动作（收纳后用它渲染） */
interface QuickItemMeta {
  label: string
  icon: ReactNode
  run(): void
}

/**
 * 「更多 ▾」菜单里**原生**的条目 id：这些项默认不在快捷栏，
 * 只有在菜单里点过「拿出到快捷栏」（toolbarHidden 里存 `show:${id}` 标记）才出现。
 * 其余 quickMeta 项（新建/保存等）默认在快捷栏，存裸 id 表示「已收进更多」。
 */
const MENU_PINNABLE: ReadonlySet<string> = new Set([
  'new-window',
  'sheet-copy',
  'history',
  'default-view-lock',
  'shortcuts'
])

export default function Toolbar({
  actions,
  outlineOpen = false,
  hiddenItems = [],
  onToggleHidden
}: Props): ReactElement {
  const workbook = useEditor((s) => s.workbook)
  const selection = useEditor((s) => s.selection)
  const zoom = useEditor((s) => s.zoom)
  const viewLock = useEditor((s) => s.viewLock)
  const appSettings = useEditor((s) => s.appSettings)
  const canUndo = useEditor((s) => s.undoStack.length > 0)
  const canRedo = useEditor((s) => s.redoStack.length > 0)

  const root = activeRoot(workbook)
  const selectedId = selection[0]
  /**
   * 结构是**画布级**属性（只住在中心主题上）：无论当前选中谁，这里显示与改动的都是整张画布。
   * 以前它跟着选中主题走，于是在分支上切一下结构，就会得到"一棵树里混着几套结构"的
   * 画面——主干是对的、下面那截乱（用户就是这么报的）。分支自己声明的结构不再参与布局。
   */
  const currentStructure = root.structureClass ?? DEFAULT_STRUCTURE
  const store = useEditor.getState

  const toggleHidden = (id: string, hidden: boolean): void => {
    if (!onToggleHidden) return
    onToggleHidden(id, hidden)
  }

  /**
   * 某个功能此刻**应不应该出现在快捷栏**：
   * - 原生快捷项（新建/保存…）：默认显示，toolbarHidden 存裸 id = 已收进更多；
   * - 「更多」原生项（新建窗口…）：默认不显示，存 `show:${id}` 标记 = 已拿出。
   */
  const isShown = (id: string): boolean =>
    MENU_PINNABLE.has(id) ? hiddenItems.includes(`show:${id}`) : !hiddenItems.includes(id)

  /** 右键「收进更多 ▾」：按来源写对应标记 */
  const hideFromBar = (id: string): void => {
    if (MENU_PINNABLE.has(id)) toggleHidden(`show:${id}`, false)
    else toggleHidden(id, true)
  }

  /** 菜单行尾「拿出到快捷栏」 */
  const takeOutToBar = (id: string): void => {
    if (MENU_PINNABLE.has(id)) toggleHidden(`show:${id}`, true)
  }

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

  /** 收纳进「更多 ▾」的功能：id → 展示与动作（右键移回快捷栏） */
  const quickMeta: Record<string, QuickItemMeta> = {
    new: { label: '新建', icon: <FilePlus size={15} />, run: actions.onNew },
    open: { label: '打开 / 导入 .xmind', icon: <FolderOpen size={15} />, run: actions.onOpen },
    save: { label: '保存', icon: <Save size={15} />, run: actions.onSave },
    'save-as': { label: '另存为', icon: <SaveAll size={15} />, run: actions.onSaveAs },
    'export-md': {
      label: '一键导出 Markdown',
      icon: <FileText size={15} />,
      run: () => actions.onExportOutline('md')
    },
    undo: { label: '撤销', icon: <Undo2 size={15} />, run: () => store().undo() },
    redo: { label: '重做', icon: <Redo2 size={15} />, run: () => store().redo() },
    'add-child': {
      label: '添加子主题',
      icon: <Plus size={15} />,
      run: () => store().addChild(selectedId ?? root.id)
    },
    delete: {
      label: '删除所选主题',
      icon: <Trash2 size={15} />,
      run: () => store().deleteSelection()
    },
    relationship: {
      label: '关系线',
      icon: <Spline size={15} />,
      run: () => store().addRelationship()
    },
    summary: { label: '概要', icon: <Braces size={15} />, run: () => store().addSummary() },
    boundary: { label: '边界', icon: <Frame size={15} />, run: () => store().addBoundary() },
    outline: { label: '大纲视图', icon: <ListTree size={15} />, run: actions.onOutline },
    'nodes-panel': { label: '节点属性', icon: <PanelRight size={15} />, run: actions.onNodes },
    'themes-panel': { label: '主题外观', icon: <Palette size={15} />, run: actions.onThemes },
    formula: { label: '插入 / 编辑公式', icon: <Sigma size={15} />, run: actions.onFormula },
    code: { label: '插入 / 编辑代码块', icon: <Code2 size={15} />, run: actions.onCode },
    relayout: { label: '恢复自动布局', icon: <Wand2 size={15} />, run: actions.onRelayout },
    search: { label: '搜索 / 筛选 / 统计', icon: <SearchIcon size={15} />, run: actions.onSearch },
    'zoom-out': {
      label: '缩小',
      icon: <ZoomOut size={15} />,
      run: () => viewportActions.zoomTo(zoom / 1.2)
    },
    'zoom-in': {
      label: '放大',
      icon: <ZoomIn size={15} />,
      run: () => viewportActions.zoomTo(zoom * 1.2)
    },
    fit: { label: '适应画布', icon: <Maximize size={15} />, run: () => viewportActions.fit() },
    'view-lock': {
      label: '视角锁定',
      icon: <Crosshair size={15} />,
      run: () => store().toggleViewLock()
    },

    /* ---- 以下默认住在「更多 ▾」里，可拿出到快捷栏（MENU_PINNABLE） ---- */
    'new-window': { label: '新建窗口', icon: <AppWindow size={15} />, run: actions.onNewWindow },
    'sheet-copy': {
      label: '新窗口打开画布副本',
      icon: <Copy size={15} />,
      run: actions.onOpenSheetWindow
    },
    history: { label: '历史记录与常用', icon: <HistoryIcon size={15} />, run: actions.onHistory },
    'default-view-lock': {
      label: '启动默认视角锁定',
      icon: <Crosshair size={15} />,
      run: () => void patchAppSettings({ defaultViewLock: !appSettings.defaultViewLock })
    },
    shortcuts: { label: '快捷键说明', icon: <CircleHelp size={15} />, run: actions.onHelp }
  }

  // 工具栏按钮不抢焦点：否则点过按钮后按 Enter / Tab 会先被按钮吃掉。
  // 只对按钮生效，下拉框需要保留默认行为才能正常展开。
  const keepFocus = (e: MouseEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement | null
    if (target && target.closest('button')) e.preventDefault()
  }

  /**
   * 快捷栏条目的元数据。
   * 键来自下面手工维护的列表，必然存在；用访问器收口，避免每个调用点各写一次断言。
   */
  const metaOf = (id: keyof typeof quickMeta & string): QuickItemMeta => quickMeta[id]!

  /** 快捷栏按钮：pinned 收纳外壳 + 更多菜单里的对应条目 */
  const quick = (
    id: keyof typeof quickMeta & string,
    node: ReactNode,
    hint?: string
  ): ReactElement | null => (
    <PinWrap
      title={metaOf(id).label}
      hint={hint}
      shown={isShown(id)}
      onHide={() => hideFromBar(id)}
    >
      {node}
    </PinWrap>
  )

  return (
    <div className="toolbar" onMouseDown={keepFocus}>
      <div className="toolbar__group">
        {quick(
          'new',
          <button type="button" className="tool-btn" title="新建 (Ctrl+N)" onClick={actions.onNew}>
            <FilePlus size={17} />
          </button>
        )}
        {quick(
          'open',
          <button
            type="button"
            className="tool-btn"
            title="打开 / 导入 .xmind 文件 (Ctrl+O)"
            onClick={actions.onOpen}
          >
            <FolderOpen size={17} />
          </button>
        )}
        {quick(
          'save',
          <button type="button" className="tool-btn" title="保存 (Ctrl+S)" onClick={actions.onSave}>
            <Save size={17} />
          </button>
        )}
        {quick(
          'save-as',
          <button
            type="button"
            className="tool-btn"
            title="另存为 (Ctrl+Shift+S)"
            onClick={actions.onSaveAs}
          >
            <SaveAll size={17} />
          </button>
        )}

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
        {quick(
          'export-md',
          <button
            type="button"
            className="tool-btn tool-btn--labeled"
            title="一键导出 Markdown（.md）：根主题作标题、层级作列表、备注作引用块"
            onClick={() => actions.onExportOutline('md')}
          >
            <FileText size={15} />
            Markdown
          </button>
        )}
      </div>

      <div className="toolbar__divider" />

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
            onClick={() => store().addChild(selectedId ?? root.id)}
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
            disabled={!selectedId || selectedId === root.id}
            onClick={() => store().deleteSelection()}
          >
            <Trash2 size={17} />
          </button>
        )}
      </div>

      <div className="toolbar__divider" />

      <div className="toolbar__group toolbar__structure">
        <span className="toolbar__label">结构</span>
        <div className="select-wrap">
          <select
            className="select"
            value={currentStructure}
            title="结构是整张画布的属性：改动作用在中心主题上"
            onChange={(e) => store().setStructure(e.target.value)}
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
        {quick(
          'relationship',
          <button
            type="button"
            className={toggle.relationshipId ? 'tool-btn tool-btn--active' : 'tool-btn'}
            disabled={selection.length !== 2}
            onClick={() => store().addRelationship()}
          >
            <Spline size={17} />
          </button>,
          relationshipHint
        )}
        {quick(
          'summary',
          <button
            type="button"
            className={toggle.summaryId ? 'tool-btn tool-btn--active' : 'tool-btn'}
            disabled={selection.length === 0}
            onClick={() => store().addSummary()}
          >
            <Braces size={17} />
          </button>,
          summaryHint
        )}
        {quick(
          'boundary',
          <button
            type="button"
            className={toggle.boundaryId ? 'tool-btn tool-btn--active' : 'tool-btn'}
            disabled={selection.length === 0}
            onClick={() => store().addBoundary()}
          >
            <Frame size={17} />
          </button>,
          boundaryHint
        )}
      </div>

      <div className="toolbar__divider" />

      <div className="toolbar__group">
        {quick(
          'outline',
          <button
            type="button"
            className={outlineOpen ? 'tool-btn tool-btn--active' : 'tool-btn'}
            title={outlineOpen ? '关闭大纲视图' : '大纲视图（与导图双向实时同步）'}
            onClick={actions.onOutline}
          >
            <ListTree size={17} />
          </button>
        )}
        {quick(
          'nodes-panel',
          <button
            type="button"
            className="tool-btn"
            title="节点属性（备注 / 图片 / 代码块 / 标记…）"
            onClick={actions.onNodes}
          >
            <PanelRight size={17} />
          </button>
        )}
        {quick(
          'themes-panel',
          <button
            type="button"
            className="tool-btn"
            title="主题（换配色 / 边框样式）"
            onClick={actions.onThemes}
          >
            <Palette size={17} />
          </button>
        )}
        {quick(
          'formula',
          <button
            type="button"
            className="tool-btn"
            title="插入 / 编辑公式（也支持 $x^2$、$$…$$ 这类 Markdown 写法）"
            onClick={actions.onFormula}
          >
            <Sigma size={17} />
          </button>
        )}
        {quick(
          'code',
          <button
            type="button"
            className="tool-btn"
            title="插入 / 编辑代码块（Alt+C；节点上的语言小标可直接切换语言）"
            onClick={actions.onCode}
          >
            <Code2 size={17} />
          </button>
        )}
        {quick(
          'relayout',
          <button
            type="button"
            className="tool-btn"
            title="恢复自动布局：选中了自由摆放的主题就只恢复它们，否则恢复整张画布（可撤销）"
            onClick={actions.onRelayout}
          >
            <Wand2 size={17} />
          </button>
        )}
        {quick(
          'search',
          <button
            type="button"
            className="tool-btn"
            title="搜索 / 筛选 / 统计（Ctrl+F）"
            onClick={actions.onSearch}
          >
            <SearchIcon size={17} />
          </button>
        )}
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
              key: 'ai-chat',
              label: '打开 AI 聊天…',
              hint: '用自然语言问这页导图',
              icon: <Bot size={15} />,
              onSelect: actions.onAiChat
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
        {quick(
          'zoom-out',
          <button
            type="button"
            className="tool-btn"
            title="缩小 (Ctrl+-)"
            onClick={() => viewportActions.zoomTo(zoom / 1.2)}
          >
            <ZoomOut size={17} />
          </button>
        )}
        <button
          type="button"
          className="tool-btn tool-btn--text"
          title="实际大小 (Ctrl+0)"
          onClick={() => viewportActions.zoomTo(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        {quick(
          'zoom-in',
          <button
            type="button"
            className="tool-btn"
            title="放大 (Ctrl+=)"
            onClick={() => viewportActions.zoomTo(zoom * 1.2)}
          >
            <ZoomIn size={17} />
          </button>
        )}
        {quick(
          'fit',
          <button
            type="button"
            className="tool-btn"
            title="适应画布 (Ctrl+1)"
            onClick={() => viewportActions.fit()}
          >
            <Maximize size={17} />
          </button>
        )}
        {quick(
          'view-lock',
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
        )}
      </div>

      {/* 从「更多 ▾」拿出来的功能落在这里：默认全部收着，拿出一个显示一个 */}
      <div className="toolbar__group">
        {quick(
          'new-window',
          <button
            type="button"
            className="tool-btn"
            title="新建窗口（Ctrl+Shift+N）"
            onClick={actions.onNewWindow}
          >
            <AppWindow size={17} />
          </button>
        )}
        {quick(
          'sheet-copy',
          <button
            type="button"
            className="tool-btn"
            title="在新窗口打开画布副本（副本独立，不影响当前文档）"
            onClick={actions.onOpenSheetWindow}
          >
            <Copy size={17} />
          </button>
        )}
        {quick(
          'history',
          <button
            type="button"
            className="tool-btn"
            title="历史记录与常用（最近打开 / 固定常用 / 默认保存位置）"
            onClick={actions.onHistory}
          >
            <HistoryIcon size={17} />
          </button>
        )}
        {quick(
          'default-view-lock',
          <button
            type="button"
            className={appSettings.defaultViewLock ? 'tool-btn tool-btn--active' : 'tool-btn'}
            title="启动时默认开启视角锁定（只影响新开文档，点击切换）"
            onClick={() => void patchAppSettings({ defaultViewLock: !appSettings.defaultViewLock })}
          >
            <Crosshair size={17} />
          </button>
        )}
        {quick(
          'shortcuts',
          <button type="button" className="tool-btn" title="快捷键说明" onClick={actions.onHelp}>
            <CircleHelp size={17} />
          </button>
        )}
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
            // 被右键收纳的快捷栏功能排在最前面，行尾有「移回快捷栏」
            ...hiddenItems
              .filter((id) => quickMeta[id])
              .map((id) => ({
                key: `pinned-${id}`,
                label: metaOf(id).label,
                hint: '已收纳 · 点击使用',
                icon: metaOf(id).icon,
                onSelect: metaOf(id).run,
                onUnpin: () => toggleHidden(id, false)
              })),
            // 「更多」原生条目：全部可拿出到快捷栏（已拿出的行尾是「移回快捷栏」）
            ...(
              [
                ['new-window', '一个窗口一份文档（Ctrl+Shift+N）'],
                ['sheet-copy', '副本独立：导入/导出/另存都不影响当前文档'],
                ['history', '最近打开 / 固定常用 / 默认保存位置'],
                [
                  'default-view-lock',
                  `只影响新开文档（当前${appSettings.defaultViewLock ? '开' : '关'}）`
                ],
                ['shortcuts', '全部快捷键速查']
              ] as Array<[keyof typeof quickMeta & string, string]>
            ).map(([id, hint]) => ({
              key: id,
              label: metaOf(id).label,
              hint,
              icon: metaOf(id).icon,
              onSelect: metaOf(id).run,
              // 已拿出 → 行尾「移回快捷栏」；还没拿出 → 行尾「拿出到快捷栏」
              ...(hiddenItems.includes(`show:${id}`)
                ? { onUnpin: () => toggleHidden(`show:${id}`, false) }
                : { onTakeOut: () => takeOutToBar(id) })
            }))
          ]}
        />
      </div>
    </div>
  )
}
