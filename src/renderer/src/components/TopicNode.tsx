import { memo, useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import { collapseBadgeSide } from '@shared/layout/core'
import {
  BLOCK_GAP,
  MARKER_MAX_COLUMNS,
  MARKER_PER_COLUMN,
  MARKER_STRIP_GAP,
  codeBlockMetrics,
  codeMinNodeSize,
  formulaMinNodeSize,
  imageBoxSize
} from '@shared/layout/accessory'
import { nodePaddingOf } from '../render/measure'
import { CODE_LANGUAGES } from '@shared/code-language'
import { CODE_TOKEN_COLORS, highlightCode } from '@shared/code/highlight'
import {
  countDescendants,
  foldedSidesOf,
  hiddenCountOfSide,
  splitFoldSidesOf,
  type FoldSide
} from '@shared/model/tree'
import { useEditor } from '../store/editor'
import { count, isDiagArmed, noteAmount } from '../dev/stage'
import { richFromPlain } from '@shared/richtext'
import { formulaHtml, formulaSize } from '../render/formula'
import { resourceUrl } from '../render/resource'
import { branchColorOf, visualFor } from '../render/theme'
import MarkerIcon, { IndicatorIcon } from './MarkerIcon'
import RichTextEditor from './RichTextEditor'

/* ---- A3 拆分：props 契约与行内样式函数搬进 ./topic/，入口保留同名再导出 ---- */
import type { TopicNodeProps } from './topic/props'
import { segmentStyle } from './topic/segment-style'
export type { TopicNodeProps } from './topic/props'

/** 按侧收起时的方向名（徽标文案与提示用） */
const FOLD_SIDE_LABELS: Record<FoldSide, string> = {
  left: '左',
  right: '右',
  up: '上',
  down: '下'
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
  marqueeHit,
  flash,
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
  onToggleCollapse,
  onToggleFoldSide
}: TopicNodeProps): ReactElement {
  const visual = visualFor(colors, node, layout)
  const color = branchColorOf(colors, layout, node.id)
  /**
   * 折叠徽标只对「**超过 1 个子主题**」的主题显示（用户要求）。
   *
   * 为什么不是 `> 0`：只有一个子节点时折叠没有信息量（收起一个还是展开一个，图没变化），
   * 挂着个「−」反而像坏了一样。已折叠的**始终显示**——否则只有一个子节点的主题一旦折叠，
   * 就再也没有按钮能把它展开了。store 的 `toggleCollapse` 有同一条守卫，
   * 键盘（Ctrl + /）和 AI 的 collapse 与这里的口径一致。
   */
  const canCollapse = node.topic.children.length > 1 || node.topic.collapsed
  /**
   * 徽标挂哪一侧：跟着分支的展开方向走。
   * 中心主题自己没有左右属性（`side` 恒为 `'root'`），必须按子节点实际落在哪边定——
   * 否则「逻辑图（向左）」那种整张图往左长的结构，徽标会挂在右边（与分支相反）。
   */
  const collapseSide = collapseBadgeSide(node, layout.nodeMap)
  /**
   * 会**双向展开**的结构（平衡 / 顺时针思维导图、水平时间轴、鱼骨图、垂直时间轴），
   * 中心主题上每个方向各一根徽标，**分别收起**——一根徽标只能"全收/全开"，
   * 用户要的是「先只把左边收起来」。
   * 单侧结构（逻辑图 / 树形图 / 括号图 / 树状表格 / 矩阵图 / 组织架构图）与其余层级
   * 仍走单徽标（收起就是全收起）。
   */
  const splitSides = splitFoldSidesOf(node.topic, node.depth === 0)
  const foldedSides = new Set(foldedSidesOf(node.topic))

  /** 图片读不出来（资源缺失）时改显示占位，避免只留一个空白框 */
  const [failedImagePath, setFailedImagePath] = useState<string | null>(null)
  const image = node.topic.image
  const imageBox = image ? (node.imageBox ?? imageBoxSize(image)) : null
  const imageFailed = Boolean(image && failedImagePath === image.path)

  const formula = node.topic.formula

  const code = node.topic.code

  // 代码块的尺寸与排版指标都来自测量：节点被手动拉伸时，字号/行高/内边距一起等比缩放，
  // 所以代码块永远待在节点框里（与图片的缩放行为一致）
  const codeMetrics = code ? (node.codeMetrics ?? codeBlockMetrics(code)) : null
  const codeBox =
    code && codeMetrics ? { width: codeMetrics.width, height: codeMetrics.height } : null

  /**
   * 代码块的高亮结果 → React 元素数组，按（内容, 语言）缓存。
   *
   * 这是渲染成本的主体：**一个 token 一个带内联样式对象的 `<span>`**，
   * 10KB 代码就是约 1900 个。AI 每写一次都会让布局对象换新 → 这个节点必然重渲染，
   * 不缓存就要把整段代码的 span 全部重建一遍（24 个代码块 × 60 次写入＝百万级）。
   * 元素数组引用不变时 React 会跳过整棵子树——内容没变就一次都不用重建。
   */
  const codeText = code?.text ?? ''
  const codeLanguage = code?.language ?? ''
  /**
   * 卡死取证的计数点：代码块渲染次数 + 建出来的 span 总量。
   *
   * 这两个数正是「写入次数 × 代码总量」二次放大的直接证据：10~15 次 setCode
   * 若报出「代码块渲染×288 · span 共 45 万」，就说明每次写入都在重建整批 span。
   * 只在取证开启时统计（用户日常编辑零开销）。
   */
  if (code && isDiagArmed()) {
    count('代码块渲染')
    let spans = 0
    for (const line of highlightCode(codeText, codeLanguage)) spans += line.tokens.length
    noteAmount('代码块 span', spans)
  }

  const codeLines = useMemo(
    () =>
      highlightCode(codeText, codeLanguage).map((line, lineIndex, all) => (
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
      )),
    [codeText, codeLanguage]
  )
  /** 拉伸时的最小尺寸：代码块缩到下限时的大小 + 内边距（框不能比内容还小） */
  const padding = nodePaddingOf(node.depth)
  const minSize = codeMinNodeSize(code, padding)

  // 标记条挂在节点**外面**：默认左侧；左向分支放右侧，免得压到它自己的子节点
  const markerIds = node.markerStrip?.markerIds ?? []
  const markerStripWidth = node.markerStrip?.width ?? 0
  const markerSide: 'left' | 'right' = node.side === 'left' ? 'right' : 'left'
  const markerColumns: string[][] = []
  if (markerIds.length > 0) {
    // 分列规则与 markerStripSize 一致：≤4 个一列，否则两列，行数 = ceil(总数 / 列数)
    const columns = markerIds.length <= MARKER_PER_COLUMN ? 1 : MARKER_MAX_COLUMNS
    const rows = Math.ceil(markerIds.length / columns)
    for (let i = 0; i < markerIds.length; i += rows)
      markerColumns.push(markerIds.slice(i, i + rows))
  }
  // 正常情况下尺寸来自布局测量结果；个别测量实现没给时退回同一套公式尺寸函数
  const formulaBox = formula ? (node.formulaBox ?? formulaSize(formula, node.fontSize)) : null

  // 框不能比内容还小：代码块（可缩放下限）与公式块（整块原子）取更大的一份。
  // 公式节点被手动缩小到极限时，外框最小也要包住公式——否则左右各裁掉半边
  const formulaMin =
    formula && formulaBox ? formulaMinNodeSize(formulaBox, padding, node.lineHeight) : null
  const minNodeWidth = Math.max(minSize?.width ?? 0, formulaMin?.width ?? 0)
  const minNodeHeight = Math.max(minSize?.height ?? 0, formulaMin?.height ?? 0)

  const style: CSSProperties = {
    left: node.x,
    top: node.y,
    width: node.width,
    // 编辑时高度交给内容决定，避免富文本内容被裁掉
    height: editing ? 'auto' : node.height,
    minHeight: Math.max(node.height, minNodeHeight),
    // 双保险：就算 sizeOverride 里存了历史遗留的过小值，框也绝不含把公式裁掉
    minWidth: minNodeWidth > 0 ? minNodeWidth : undefined,
    background: visual.background,
    color: visual.color,
    borderRadius: visual.borderRadius,
    fontWeight: visual.fontWeight,
    // 抓着的那一个额外加一层投影，看起来是「被拎起来了」；
    // 跟着走的后代不加，否则整棵子树都在发光，反而看不出抓到的是谁
    boxShadow: dragPrimary
      ? [visual.boxShadow, '0 10px 22px rgba(16, 24, 40, 0.24)'].filter(Boolean).join(', ')
      : visual.boxShadow,
    /**
     * 拖拽中的位移**不在这里写**：画布在拖拽期间直接改元素的 `transform`
     * （见 `Canvas` 的 `applyGhostTransform`）。
     *
     * 以前这里写 `translate(dragOffset.dx, dy)`，位置要等 React 重渲染才生效——
     * 画布一慢（节点多、连线多，一次重渲染里全要协调），被拖的节点就跟不上指针，
     * 快甩一下能差出几百像素（用户反馈："拖拽有些不同步"）。
     * 交给命令式更新后，位移与 `pointermove` 同一帧落地。
     */
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
    marqueeHit ? 'topic--marquee' : '',
    flash ? 'topic--ai-flash' : '',
    dimmed === 'soft' ? 'topic--dimmed-soft' : dimmed ? 'topic--dimmed' : '',
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
                style={{
                  height: line.height,
                  lineHeight: `${line.height}px`,
                  textAlign: line.align
                }}
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

        {/* 代码块：等宽排版，尺寸与字号都来自测量（节点被拉伸时一起等比缩放）；语言小标可直接切换 */}
        {code && codeMetrics && codeBox && (
          <div
            className="topic__code"
            style={{ width: codeBox.width, height: codeBox.height, marginTop: BLOCK_GAP }}
          >
            <select
              className="topic__code-lang"
              value={code.language || 'text'}
              title="切换代码语言"
              style={{
                fontSize: Math.max(8, Math.round(9 * codeMetrics.scale)),
                lineHeight: `${codeMetrics.header}px`
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onChange={(event) =>
                useEditor
                  .getState()
                  .setCode(node.id, { language: event.target.value, text: code.text })
              }
            >
              {CODE_LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>
                  {lang === 'text' ? 'text' : lang}
                </option>
              ))}
            </select>
            <pre
              className="topic__code-pre"
              style={{
                fontSize: codeMetrics.fontSize,
                lineHeight: `${codeMetrics.lineHeight}px`,
                padding: `${codeMetrics.header}px ${codeMetrics.paddingX}px ${codeMetrics.paddingY}px`
              }}
            >
              {codeLines}
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
            // 框不能小于内容：代码块缩到缩放下限、公式块整块原子——取两者更大的下限
            const minWidth = Math.max(60, minNodeWidth)
            const minHeight = Math.max(28, minNodeHeight)
            const move = (moveEvent: PointerEvent): void => {
              useEditor.getState().setSizeOverride(node.id, {
                width: Math.max(minWidth, startWidth + (moveEvent.clientX - startX) / zoom),
                height: Math.max(minHeight, startHeight + (moveEvent.clientY - startY) / zoom)
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

      {/* 双向展开的结构：每个方向一根徽标，分别收起（各贴自己那一侧的边） */}
      {splitSides.map((side) => (
        <button
          key={side}
          type="button"
          className={`topic__collapse topic__collapse--${side}`}
          title={
            foldedSides.has(side)
              ? `已收起${FOLD_SIDE_LABELS[side]}侧 ${hiddenCountOfSide(node.topic, side)} 个子主题，点击展开`
              : `收起${FOLD_SIDE_LABELS[side]}侧分支`
          }
          style={{ background: color }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation()
            onToggleFoldSide(node.id, side)
          }}
        >
          {/* 收起时显示这一侧藏了多少个节点，展开时是 −（与整体折叠的徽标同一套样式） */}
          {foldedSides.has(side) ? hiddenCountOfSide(node.topic, side) : '−'}
        </button>
      ))}

      {splitSides.length === 0 && canCollapse && (
        <button
          type="button"
          className={`topic__collapse topic__collapse--${collapseSide}`}
          title={
            node.topic.collapsed
              ? `折叠了 ${countDescendants(node.topic)} 个子主题，点击展开`
              : '折叠子主题'
          }
          // 平面样式：只有分支配色的底，不再描白圈/投影（那圈白边看着像高光，用户反馈去掉）
          style={{ background: color }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation()
            onToggleCollapse(node.id)
          }}
        >
          {/* 折叠时显示折叠的后代数量，展开时是 −（XMind 式圆形简约徽标） */}
          {node.topic.collapsed ? countDescendants(node.topic) : '−'}
        </button>
      )}
    </div>
  )
}

const TopicNode = memo(TopicNodeInner)
export default TopicNode
