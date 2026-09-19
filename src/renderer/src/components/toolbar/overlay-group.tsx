/**
 * 工具栏「画布级元素」组：关系线 / 概要 / 边界的创建入口。
 *
 * JSX 自 Toolbar.tsx 整块搬出、逐字未改。三个按钮的按下态与「为什么现在点不了」
 * 都只属于这一组，所以 `overlayToggleOf` 与三句提示随块一起搬进本模块。
 */

import { Braces, Frame, Spline } from 'lucide-react'
import { useMemo, type ReactElement } from 'react'
import { overlayToggleOf, useEditor } from '../../store/editor'
import type { QuickRender } from './quick-items'

interface Props {
  quick: QuickRender
}

export default function OverlayGroup({ quick }: Props): ReactElement {
  const workbook = useEditor((s) => s.workbook)
  const selection = useEditor((s) => s.selection)
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

  return (
    // 画布级元素：创建入口放在工具栏。只留图标（文字会把工具栏撑长），怎么用写在提示里
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
  )
}
