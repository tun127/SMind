/**
 * 工具栏「文件」组：新建 / 打开 / 保存 / 另存为 + 导入菜单 + 导出菜单 + 一键导出 Markdown。
 *
 * JSX 自 Toolbar.tsx 整块搬出、逐字未改；`quick`（收纳外壳）与 `actions` 由入口原样传入。
 */

import {
  FileInput,
  FileOutput,
  FilePlus,
  FileText,
  FolderOpen,
  ImageDown,
  Palette,
  Save,
  SaveAll
} from 'lucide-react'
import type { ReactElement } from 'react'
import type { ToolbarActions } from '../Toolbar'
import type { QuickRender } from './quick-items'
import ToolMenu from './tool-menu'

interface Props {
  actions: ToolbarActions
  quick: QuickRender
}

export default function FileGroup({ actions, quick }: Props): ReactElement {
  return (
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
  )
}
