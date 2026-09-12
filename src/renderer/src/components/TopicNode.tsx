import { memo, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import type { LayoutResult, NodeLayout, StyledSegment } from '@shared/layout/types'
import { BLOCK_GAP, imageBoxSize } from '@shared/layout/accessory'
import type { RichText, ThemeColors } from '@shared/model/types'
import { richFromPlain } from '@shared/richtext'
import { formulaHtml, formulaSize } from '../render/formula'
import { resourceUrl } from '../render/resource'
import { branchColorOf, visualFor } from '../render/theme'
import MarkerIcon, { IndicatorIcon } from './MarkerIcon'
import RichTextEditor from './RichTextEditor'

export interface TopicNodeProps {
  node: NodeLayout
  layout: LayoutResult
  colors: ThemeColors
  selected: boolean
  editing: boolean
  editingRich: RichText | null
  highlighted: boolean
  /** 命中当前搜索关键词 */
  searchHit: boolean
  /** 被筛选条件排除（淡出显示） */
  dimmed: boolean
  dragOffset: { dx: number; dy: number } | null
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, id: string) => void
  onDoubleClick: (id: string) => void
  onRichChange: (id: string, rich: RichText) => void
  onCancelEdit: () => void
  onCommitAndAddChild: () => void
  onCommitAndAddSibling: () => void
  onToggleCollapse: (id: string) => void
}

function segmentStyle(segment: StyledSegment): CSSProperties {
  const decoration = [segment.underline ? 'underline' : '', segment.strike ? 'line-through' : '']
    .filter(Boolean)
    .join(' ')
  const style: CSSProperties = {
    fontWeight: segment.weight,
    fontSize: segment.fontSize
  }
  if (segment.italic) style.fontStyle = 'italic'
  if (decoration) style.textDecoration = decoration
  if (segment.color) style.color = segment.color
  if (segment.fontFamily) style.fontFamily = segment.fontFamily
  return style
}

function TopicNodeInner({
  node,
  layout,
  colors,
  selected,
  editing,
  editingRich,
  highlighted,
  searchHit,
  dimmed,
  dragOffset,
  onPointerDown,
  onDoubleClick,
  onRichChange,
  onCancelEdit,
  onCommitAndAddChild,
  onCommitAndAddSibling,
  onToggleCollapse
}: TopicNodeProps): ReactElement {
  const visual = visualFor(colors, node, layout)
  const color = branchColorOf(colors, layout, node.id)
  const hasChildren = node.topic.children.length > 0

  /** 图片读不出来（资源缺失）时改显示占位，避免只留一个空白框 */
  const [failedImagePath, setFailedImagePath] = useState<string | null>(null)
  const image = node.topic.image
  const imageBox = image ? node.imageBox ?? imageBoxSize(image) : null
  const imageFailed = Boolean(image && failedImagePath === image.path)

  const formula = node.topic.formula
  // 正常情况下尺寸来自布局测量结果；个别测量实现没给时退回同一套公式尺寸函数
  const formulaBox = formula ? node.formulaBox ?? formulaSize(formula, node.fontSize) : null

  const style: CSSProperties = {
    left: node.x,
    top: node.y,
    width: node.width,
    // 编辑时高度交给内容决定，避免富文本内容被裁掉
    height: editing ? 'auto' : node.height,
    minHeight: node.height,
    background: visual.background,
    color: visual.color,
    borderRadius: visual.borderRadius,
    fontWeight: visual.fontWeight,
    boxShadow: visual.boxShadow,
    transform: dragOffset ? `translate(${dragOffset.dx}px, ${dragOffset.dy}px)` : undefined,
    zIndex: dragOffset ? 30 : selected ? 20 : 1
  }

  const className = [
    'topic',
    node.depth === 0 ? 'topic--root' : node.depth === 1 ? 'topic--level1' : 'topic--deep',
    selected ? 'topic--selected' : '',
    highlighted ? 'topic--drop' : '',
    searchHit ? 'topic--hit' : '',
    dimmed ? 'topic--dimmed' : '',
    dragOffset ? 'topic--dragging' : '',
    editing ? 'topic--editing' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={className}
      style={style}
      data-topic-id={node.id}
      onPointerDown={(event) => onPointerDown(event, node.id)}
      onDoubleClick={(event) => {
        event.stopPropagation()
        onDoubleClick(node.id)
      }}
    >
      {/* 顶部图标行：标记图标 + 备注/链接/附件/公式/图片指示 */}
      {node.accessory.items.length > 0 && (
        <div className="topic__accessory" style={{ height: node.accessory.height }}>
          {node.accessory.items.map((item, index) =>
            item.kind === 'marker' ? (
              <MarkerIcon key={`m-${index}-${item.markerId ?? ''}`} markerId={item.markerId ?? ''} />
            ) : (
              <IndicatorIcon key={`i-${index}-${item.kind}`} kind={item.kind} />
            )
          )}
        </div>
      )}

      {editing ? (
        <RichTextEditor
          node={node}
          rich={editingRich ?? node.topic.titleRich ?? richFromPlain(node.topic.title)}
          onChange={(rich) => onRichChange(node.id, rich)}
          onCancel={onCancelEdit}
          onAddChild={onCommitAndAddChild}
          onAddSibling={onCommitAndAddSibling}
        />
      ) : (
        <div className="topic__text">
          {node.lines.map((line, lineIndex) => (
            <div
              key={lineIndex}
              className="topic__line"
              style={{ height: line.height, lineHeight: `${line.height}px`, textAlign: line.align }}
            >
              {line.segments.length === 0
                ? '\u00A0'
                : line.segments.map((segment, segmentIndex) => (
                    <span key={segmentIndex} style={segmentStyle(segment)}>
                      {segment.text}
                    </span>
                  ))}
            </div>
          ))}
        </div>
      )}

      {/* 节点内图片：显示框尺寸来自布局测量结果，保证「测量=显示」 */}
      {image && imageBox && (
        <div className="topic__image" style={{ marginTop: BLOCK_GAP }}>
          {imageFailed ? (
            <div
              className="topic__image-missing"
              style={{ width: imageBox.width, height: imageBox.height }}
              title={`图片资源缺失：${image.path}`}
            >
              图片缺失
            </div>
          ) : (
            <img
              src={resourceUrl(image.path)}
              alt=""
              draggable={false}
              width={imageBox.width}
              height={imageBox.height}
              style={{ width: imageBox.width, height: imageBox.height }}
              onError={() => setFailedImagePath(image.path)}
            />
          )}
        </div>
      )}

      {/* LaTeX 公式：KaTeX 渲染成 HTML，直接内嵌在节点里 */}
      {formula && formulaBox && (
        <div
          className="topic__formula"
          style={{
            width: formulaBox.width,
            height: formulaBox.height,
            marginTop: BLOCK_GAP,
            fontSize: node.fontSize
          }}
          // KaTeX 的输出是我们自己生成的 HTML，不来自用户输入的原样注入
          dangerouslySetInnerHTML={{ __html: formulaHtml(formula) }}
        />
      )}

      {/* 底部标签行 */}
      {node.labelRow.items.length > 0 && (
        <div className="topic__labels" style={{ height: node.labelRow.height }}>
          {node.labelRow.items.map((label, index) => (
            <span
              key={`l-${index}-${label.text}`}
              className="topic__label"
              style={{ width: label.width }}
              title={label.text}
            >
              {label.text}
            </span>
          ))}
        </div>
      )}

      {hasChildren && (
        <button
          type="button"
          className={`topic__collapse topic__collapse--${node.side === 'left' ? 'left' : 'right'}`}
          title={node.topic.collapsed ? '展开子主题' : '折叠子主题'}
          style={{ background: color }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation()
            onToggleCollapse(node.id)
          }}
        >
          {node.topic.collapsed ? '+' : '−'}
        </button>
      )}
    </div>
  )
}

const TopicNode = memo(TopicNodeInner)
export default TopicNode
