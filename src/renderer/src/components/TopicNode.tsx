import { memo, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import type { LayoutResult, NodeLayout, StyledSegment } from '@shared/layout/types'
import {
  BLOCK_GAP,
  MARKER_MAX_COLUMNS,
  MARKER_PER_COLUMN,
  MARKER_STRIP_GAP,
  codeBoxSize,
  imageBoxSize
} from '@shared/layout/accessory'
import { CODE_LANGUAGES } from '@shared/code-language'
import { CODE_TOKEN_COLORS, highlightCode } from '@shared/code/highlight'
import { countDescendants } from '@shared/model/tree'
import { useEditor } from '../store/editor'
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
  /**
   * 落点高亮：
   * - `child`：松手后成为它的子主题（绿色虚线）；
   * - `sibling`：松手后插到它前面 / 后面（蓝色虚线）——只标**参照的那个主题本身**。
   *   绝不标它的父级：把父级框出来会让用户误以为"要落到父级上"（尤其父级是中心主题时）。
   */
  highlight: 'child' | 'sibling' | null
  /** 命中当前搜索关键词 */
  searchHit: boolean
  /** 被筛选条件排除（淡出显示） */
  dimmed: boolean
  dragOffset: { dx: number; dy: number } | null
  /** 是否是「手里正抓着的那一个」（它随之移动的后代不算），用于区分抬起的手感 */
  dragPrimary: boolean
  /** 正被拖着（含跟着走的子树）。拖动中不再显示落点高亮，免得和"抓着的东西"打架 */
  dragged: boolean
  /**
   * 是否可拖动。中心主题是整张图的锚点，不能拖走，
   * 所以它不显示「抓取」光标——光标本身就是最省事的操作提示。
   */
  draggable: boolean
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, id: string) => void
  onDoubleClick: (id: string) => void
  onRichChange: (id: string, rich: RichText) => void
  onCancelEdit: () => void
  /** 提交编辑并退出（编辑中按 Enter）——只退出，不新建 */
  onCommitEdit: () => void
  onCommitAndAddChild: () => void
  onCommitAndAddSibling: () => void
  /**
   * 空主题里按方向键：交给上层「提交本次编辑 + 移动选择」。
   * 不做这件事的话，刚建出来的空节点上按方向键会"像失灵一样"毫无反应。
   */
  onNavigateEdit: (key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight') => void
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
  highlight,
  searchHit,
  dimmed,
  dragOffset,
  dragPrimary,
  dragged,
  draggable,
  onPointerDown,
  onDoubleClick,
  onRichChange,
  onCancelEdit,
  onCommitEdit,
  onCommitAndAddChild,
  onCommitAndAddSibling,
  onNavigateEdit,
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

  const code = node.topic.code

  const codeBox = code ? node.codeBox ?? codeBoxSize(code) : null

  // 标记条挂在节点**外面**：默认左侧；左向分支放右侧，免得压到它自己的子节点
  const markerIds = node.markerStrip?.markerIds ?? []
  const markerStripWidth = node.markerStrip?.width ?? 0
  const markerSide: 'left' | 'right' = node.side === 'left' ? 'right' : 'left'
  const markerColumns: string[][] = []
  if (markerIds.length > 0) {
    // 分列规则与 markerStripSize 一致：≤4 个一列，否则两列，行数 = ceil(总数 / 列数)
    const columns = markerIds.length <= MARKER_PER_COLUMN ? 1 : MARKER_MAX_COLUMNS
    const rows = Math.ceil(markerIds.length / columns)
    for (let i = 0; i < markerIds.length; i += rows) markerColumns.push(markerIds.slice(i, i + rows))
  }
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
    // 抓着的那一个额外加一层投影，看起来是「被拎起来了」；
    // 跟着走的后代不加，否则整棵子树都在发光，反而看不出抓到的是谁
    boxShadow: dragPrimary
      ? [visual.boxShadow, '0 10px 22px rgba(16, 24, 40, 0.24)'].filter(Boolean).join(', ')
      : visual.boxShadow,
    transform: dragOffset ? `translate(${dragOffset.dx}px, ${dragOffset.dy}px)` : undefined,
    zIndex: dragOffset ? 30 : selected ? 20 : 1
  }

  const className = [
    'topic',
    draggable ? 'topic--draggable' : '',
    node.depth === 0 ? 'topic--root' : node.depth === 1 ? 'topic--level1' : 'topic--deep',
    selected ? 'topic--selected' : '',
    // 自由摆放（有位置偏移）的主题标出来：它们会被自动布局甩在一边、连线横穿画布，
    // 一眼能认出"这几个是我手动摆过的"，而不是莫名其妙就乱了
    node.topic.position ? 'topic--floating' : '',
    !dragged && highlight === 'child' ? 'topic--drop' : '',
    !dragged && highlight === 'sibling' ? 'topic--drop-sibling' : '',
    searchHit ? 'topic--hit' : '',
    dimmed ? 'topic--dimmed' : '',
    dragOffset ? 'topic--dragging' : '',
    dragPrimary ? 'topic--drag-primary' : '',
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
      {/* 标记条：挂在节点**外侧**竖排（默认左侧，左向分支放右侧） */}
      {markerColumns.length > 0 && (
        <div
          className="topic__markers"
          style={
            markerSide === 'left'
              ? { left: -(markerStripWidth + MARKER_STRIP_GAP) }
              : { right: -(markerStripWidth + MARKER_STRIP_GAP) }
          }
        >
          {markerColumns.map((column, columnIndex) => (
            <div key={columnIndex} className="topic__marker-col">
              {column.map((markerId, index) => (
                <MarkerIcon key={`mk-${columnIndex}-${index}-${markerId}`} markerId={markerId} />
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="topic__body">
      {/* 顶部图标行：备注 / 链接 / 附件指示（标记已移到左侧） */}
      {node.accessory.items.length > 0 && (
        <div className="topic__accessory" style={{ height: node.accessory.height }}>
          {node.accessory.items.map((item, index) => (
            <IndicatorIcon key={`i-${index}-${item.kind}`} kind={item.kind} />
          ))}
        </div>
      )}

      {editing ? (
        <RichTextEditor
          node={node}
          rich={editingRich ?? node.topic.titleRich ?? richFromPlain(node.topic.title)}
          onChange={(rich) => onRichChange(node.id, rich)}
          onCancel={onCancelEdit}
          onCommit={onCommitEdit}
          onAddChild={onCommitAndAddChild}
          onAddSibling={onCommitAndAddSibling}
          onNavigate={onNavigateEdit}
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
                : line.segments.map((segment, segmentIndex) =>
                    segment.formula ? (
                      // 行内公式（标题里的 $…$）：交给 KaTeX，垂直居中对齐文字
                      <span
                        key={segmentIndex}
                        className="topic__inline-formula"
                        // KaTeX 的输出由渲染器生成，不是用户 HTML
                        dangerouslySetInnerHTML={{ __html: formulaHtml(segment.formula) }}
                      />
                    ) : (
                      <span key={segmentIndex} style={segmentStyle(segment)}>
                        {segment.text}
                      </span>
                    )
                  )}
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

      {/* 代码块：等宽排版，尺寸来自布局测量；超出行数内部滚动；语言小标可直接切换 */}
      {code && codeBox && (
        <div
          className="topic__code"
          style={{ width: codeBox.width, height: codeBox.height, marginTop: BLOCK_GAP }}
        >
          <select
            className="topic__code-lang"
            value={code.language || 'text'}
            title="切换代码语言"
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onChange={(event) =>
              useEditor.getState().setCode(node.id, { language: event.target.value, text: code.text })
            }
          >
            {CODE_LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>
                {lang === 'text' ? 'text' : lang}
              </option>
            ))}
          </select>
          <pre className="topic__code-pre">
            {highlightCode(code.text, code.language).map((line, lineIndex, all) => (
              <span key={lineIndex} className="topic__code-line">
                {line.tokens.map((token, tokenIndex) => (
                  <span
                    key={tokenIndex}
                    style={{
                      color: CODE_TOKEN_COLORS[token.kind],
                      // 注释用斜体，和常见编辑器观感一致
                      fontStyle: token.kind === 'comment' ? 'italic' : undefined
                    }}
                  >
                    {token.text}
                  </span>
                ))}
                {lineIndex < all.length - 1 ? '\n' : null}
              </span>
            ))}
          </pre>
        </div>
      )}

      {/* 底部标签行 */}
      {node.labelRow.items.length > 0 && (
        <div className="topic__labels" style={{ height: node.labelRow.height }}>
          {node.labelRow.items.map((label, index) => (
            <span
              key={`l-${index}-${label.text}`}
              className="topic__label"
              style={{ width: label.width }}
              // 过长时标签画的是截断后的文字，hover 用完整原文提示
              title={label.full ?? label.text}
            >
              {label.text}
            </span>
          ))}
        </div>
      )}

      </div>

      {/* 手动拉伸手柄：选中且不在编辑态时出现，拖右下角改尺寸，双击恢复自动尺寸 */}
      {selected && !editing && (
        <span
          className="topic__resize"
          title="拖动调整节点大小；双击恢复自动尺寸"
          onPointerDown={(event) => {
            event.stopPropagation()
            event.preventDefault()
            const startX = event.clientX
            const startY = event.clientY
            const startWidth = node.width
            const startHeight = node.height
            const zoom = useEditor.getState().zoom || 1
            const move = (moveEvent: PointerEvent): void => {
              useEditor.getState().setSizeOverride(node.id, {
                width: Math.max(60, startWidth + (moveEvent.clientX - startX) / zoom),
                height: Math.max(28, startHeight + (moveEvent.clientY - startY) / zoom)
              })
            }
            const up = (): void => {
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', up)
            }
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', up)
          }}
          onDoubleClick={(event) => {
            event.stopPropagation()
            useEditor.getState().setSizeOverride(node.id, null)
          }}
        />
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
          {node.topic.collapsed ? `+${countDescendants(node.topic)}` : '−'}
        </button>
      )}
    </div>
  )
}

const TopicNode = memo(TopicNodeInner)
export default TopicNode
