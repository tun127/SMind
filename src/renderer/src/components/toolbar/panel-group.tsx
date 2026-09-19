/**
 * 工具栏「面板与视图」组：大纲 / 节点属性 / 主题外观 / 公式 / 代码块 / 恢复布局 / 搜索。
 *
 * JSX 自 Toolbar.tsx 整块搬出、逐字未改；`quick`、`actions`、`outlineOpen` 由入口原样传入。
 */

import {
  Code2,
  ListTree,
  Palette,
  PanelRight,
  Search as SearchIcon,
  Sigma,
  Wand2
} from 'lucide-react'
import type { ReactElement } from 'react'
import type { ToolbarActions } from '../Toolbar'
import type { QuickRender } from './quick-items'

interface Props {
  actions: ToolbarActions
  quick: QuickRender
  /** 大纲面板是否已打开（用于按钮的按下态） */
  outlineOpen: boolean
}

export default function PanelGroup({ actions, quick, outlineOpen }: Props): ReactElement {
  return (
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
  )
}
