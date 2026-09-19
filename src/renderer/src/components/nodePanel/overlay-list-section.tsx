/**
 * 面板「选到节点」分支里的「画布元素」段（关系线 / 边界 / 概要的标题列表）。
 *
 * 整块 JSX 与 `overlayRow` 助手一起搬出；props 原样传，
 * store 订阅随块一起搬进本模块。
 */

import { X } from 'lucide-react'
import type { ReactElement } from 'react'
import type { Sheet } from '@shared/model/types'
import { useEditor } from '../../store/editor'

interface Props {
  sheet: Sheet
}

export default function OverlayListSection({ sheet }: Props): ReactElement {
  const removeRelationship = useEditor((s) => s.removeRelationship)
  const removeBoundary = useEditor((s) => s.removeBoundary)
  const removeSummary = useEditor((s) => s.removeSummary)
  const setRelationshipTitle = useEditor((s) => s.setRelationshipTitle)
  const setBoundaryTitle = useEditor((s) => s.setBoundaryTitle)
  const setSummaryTitle = useEditor((s) => s.setSummaryTitle)

  /**
   * 画布元素的一行。
   * 标题用「非受控输入 + 失焦提交」：既不会被中文输入法打断，
   * 也不会每敲一个字就写一条撤销记录。
   * key 里带上已保存的标题，撤销/重做后能自动同步显示。
   */
  const overlayRow = (
    kind: string,
    items: Array<{ id: string; title: string | undefined }>,
    setTitle: (id: string, title: string) => void,
    remove: (id: string) => void,
    multiline = false
  ): ReactElement[] =>
    items.map((item) => (
      <div key={`${kind}-${item.id}`} className="overlay-row">
        <span className="overlay-row__tag">{kind}</span>
        {multiline ? (
          <textarea
            key={`${item.id}-${item.title ?? ''}`}
            className="input input--mini overlay-row__multi"
            rows={2}
            defaultValue={item.title ?? ''}
            placeholder="标题（可留空，Enter 换行）"
            onBlur={(event) => setTitle(item.id, event.currentTarget.value)}
          />
        ) : (
          <input
            key={`${item.id}-${item.title ?? ''}`}
            className="input input--mini"
            defaultValue={item.title ?? ''}
            placeholder="标题（可留空）"
            onBlur={(event) => setTitle(item.id, event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
          />
        )}
        <button
          type="button"
          className="chip__del"
          title={`移除这条${kind}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => remove(item.id)}
        >
          <X size={10} />
        </button>
      </div>
    ))

  return (
    <>
      <div className="side-panel__title">画布元素</div>
      <div className="side-panel__hint">
        新建请用<b>工具栏</b>上的「关系线 / 概要 / 边界」：
        <br />
        关系线需按住 <b>Ctrl</b> 选中两个主题；概要 / 边界需选中若干个<b>同级</b>主题。
        <br />
        <b>双击画布上的标题</b>可直接改文字；关系线拖动<b>两端圆点</b>改接、拖动<b>线身</b>移动。
      </div>

      {overlayRow(
        '关系线',
        sheet.relationships.map((item) => ({ id: item.id, title: item.title })),
        setRelationshipTitle,
        removeRelationship,
        // 关系线标题也要能手动换行（与概要一致），否则画布上排不了两行
        true
      )}
      {overlayRow(
        '边界',
        sheet.boundaries.map((item) => ({ id: item.id, title: item.title })),
        setBoundaryTitle,
        removeBoundary,
        true
      )}
      {overlayRow(
        '概要',
        sheet.summaries.map((item) => ({ id: item.id, title: item.title })),
        setSummaryTitle,
        removeSummary,
        true
      )}
    </>
  )
}
