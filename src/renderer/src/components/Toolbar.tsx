import type { MouseEvent, ReactElement, ReactNode } from 'react'
import {
  AppWindow,
  Braces,
  CircleHelp,
  Code2,
  Copy,
  Crosshair,
  FilePlus,
  FileText,
  FolderOpen,
  Frame,
  History as HistoryIcon,
  ListTree,
  Maximize,
  MoreHorizontal,
  Palette,
  PanelRight,
  Plus,
  Redo2,
  Save,
  SaveAll,
  Search as SearchIcon,
  Sigma,
  Spline,
  Trash2,
  Undo2,
  Wand2,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import type { OutlineFormat } from '@shared/outline'
import { activeRoot } from '@shared/model/tree'
import { viewportActions } from '../render/viewport'
import { patchAppSettings, useEditor } from '../store/editor'
import AiGroup from './toolbar/ai-group'
import EditGroup from './toolbar/edit-group'
import FileGroup from './toolbar/file-group'
import OverlayGroup from './toolbar/overlay-group'
import PanelGroup from './toolbar/panel-group'
import PinnedGroup from './toolbar/pinned-group'
import PinWrap from './toolbar/pin-wrap'
import StructurePicker from './toolbar/structure-picker'
import { MENU_PINNABLE, type QuickItemMeta, type QuickRender } from './toolbar/quick-items'
import ToolMenu from './toolbar/tool-menu'
import ViewControls from './toolbar/view-controls'

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
 * 工具栏入口：装配各组 + 快捷栏的「收纳 / 移回」逻辑 + 「更多 ▾」菜单。
 *
 * 各组与两个通用外壳（`ToolMenu` / `PinWrap`）已拆进 `toolbar/`（A5）。
 * `quickMeta` 与「更多 ▾」菜单留在本层：菜单要用整张功能表（含被收纳项）渲染，
 * 收纳状态（`shown`）也由这里决定；`quick` 由这里构造后原样传给各组，故各组只收 props。
 */
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
  const quick: QuickRender = (id: string, node: ReactNode, hint?: string): ReactElement | null => (
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
      <FileGroup actions={actions} quick={quick} />

      <div className="toolbar__divider" />

      <EditGroup
        quick={quick}
        canUndo={canUndo}
        canRedo={canRedo}
        selectedId={selectedId}
        rootId={root.id}
      />

      <div className="toolbar__divider" />

      <StructurePicker />

      <div className="toolbar__divider" />

      <OverlayGroup quick={quick} />

      <div className="toolbar__divider" />

      <PanelGroup actions={actions} quick={quick} outlineOpen={outlineOpen} />

      <div className="toolbar__divider" />

      <AiGroup actions={actions} />

      <div className="toolbar__spacer" />

      <ViewControls quick={quick} zoom={zoom} viewLock={viewLock} />

      <PinnedGroup actions={actions} quick={quick} defaultViewLock={appSettings.defaultViewLock} />

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
