/**
 * 工具栏「结构」选择（画布级属性，作用在中心主题上）。
 *
 * JSX 自 Toolbar.tsx 整块搬出、逐字未改；结构值自 store 里取（与入口原有的取值方式相同）。
 */

import { ChevronDown } from 'lucide-react'
import type { ReactElement } from 'react'
import { DEFAULT_STRUCTURE, STRUCTURES } from '@shared/xmind/constants'
import { activeRoot } from '@shared/model/tree'
import { useEditor } from '../../store/editor'

export default function StructurePicker(): ReactElement {
  const workbook = useEditor((s) => s.workbook)
  const store = useEditor.getState

  const root = activeRoot(workbook)
  /**
   * 结构是**画布级**属性（只住在中心主题上）：无论当前选中谁，这里显示与改动的都是整张画布。
   * 以前它跟着选中主题走，于是在分支上切一下结构，就会得到"一棵树里混着几套结构"的
   * 画面——主干是对的、下面那截乱（用户就是这么报的）。分支自己声明的结构不再参与布局。
   */
  const currentStructure = root.structureClass ?? DEFAULT_STRUCTURE

  return (
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
  )
}
