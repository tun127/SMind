/**
 * 从 `TopicNode.tsx` 抽出的「附件与指示器行（备注 / 链接 / 附件）」（A3-2）：只搬 JSX，逐字未改。
 * 外面包一层 Fragment（不产生 DOM 节点），条件判断仍在内部，渲染结果与搬前一致。
 */
import type { ReactElement } from 'react'
import { useEditor } from '../../store/editor'
import { IndicatorIcon } from '../MarkerIcon'
import type { TopicNodeProps } from './props'

export function TopicAccessoryRow({ node }: { node: TopicNodeProps['node'] }): ReactElement {
  return (
    <>
      {/* 顶部图标行：备注 / 链接 / 附件指示（标记已移到左侧） */}
      {node.accessory.items.length > 0 && (
        <div className="topic__accessory" style={{ height: node.accessory.height }}>
          {node.accessory.items.map((item, index) => (
            <button
              key={`i-${index}-${item.kind}`}
              type="button"
              className="topic__indicator"
              title={
                item.kind === 'notes'
                  ? '有备注 · 点击查看 / 编辑'
                  : item.kind === 'link'
                    ? '有超链接 · 点击打开节点属性'
                    : '有附件 · 点击打开节点属性'
              }
              onClick={(event) => {
                // 别让点击冒泡成「选中 / 进入编辑」：用户点的是指示图标
                event.stopPropagation()
                const editor = useEditor.getState()
                if (item.kind === 'notes') editor.requestNotesFocus()
                else editor.requestNodePanel()
              }}
            >
              <IndicatorIcon kind={item.kind} />
            </button>
          ))}
        </div>
      )}
    </>
  )
}
