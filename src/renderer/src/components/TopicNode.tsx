import { memo, useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import { collapseBadgeSide } from '@shared/layout/core'
import {
  MARKER_MAX_COLUMNS,
  MARKER_PER_COLUMN,
  codeBlockMetrics,
  codeMinNodeSize,
  formulaMinNodeSize,
  imageBoxSize
} from '@shared/layout/accessory'
import { nodePaddingOf } from '../render/measure'
import { CODE_TOKEN_COLORS, highlightCode } from '@shared/code/highlight'
import { foldedSidesOf, splitFoldSidesOf } from '@shared/model/tree'
import { count, isDiagArmed, noteAmount } from '../dev/stage'
import { richFromPlain } from '@shared/richtext'
import { formulaSize } from '../render/formula'
import { branchColorOf, visualFor } from '../render/theme'
import RichTextEditor from './RichTextEditor'

/* ---- A3 拆分：props 契约与行内样式函数搬进 ./topic/，入口保留同名再导出 ---- */
import type { TopicNodeProps } from './topic/props'
import { TopicMarkersStrip } from './topic/markers'
import { TopicAccessoryRow } from './topic/accessories'
import { TopicTextLines } from './topic/text-lines'
import { TopicLabelRow } from './topic/label-row'
import { TopicImageBlock } from './topic/image-block'
import { TopicFormulaBlock } from './topic/formula-block'
import { TopicCodeBlock } from './topic/code-block'
import { TopicResizeHandle } from './topic/resize-handle'
import { TopicCollapseBadges } from './topic/collapse-badges'
export type { TopicNodeProps } from './topic/props'

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
  writing,
  pulsing,
  dimmed,
  dragOffset,
  dragPrimary,
  dragged,
  draggable,
  onPointerDown,
  onContextMenu,
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
    node.detached ? 'topic--detached' : node.topic.position ? 'topic--floating' : '',
    !dragged && highlight === 'child' ? 'topic--drop' : '',
    !dragged && highlight === 'sibling' ? 'topic--drop-sibling' : '',
    searchHit ? 'topic--hit' : '',
    marqueeHit ? 'topic--marquee' : '',
    flash ? 'topic--ai-flash' : '',
    writing ? 'topic--ai-writing' : '',
    pulsing ? 'topic--ai-pulsing' : '',
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
      onContextMenu={(event) => onContextMenu(event, node.id)}
      onDoubleClick={(event) => {
        event.stopPropagation()
        onDoubleClick(node.id)
      }}
    >
      <TopicMarkersStrip
        markerColumns={markerColumns}
        markerSide={markerSide}
        markerStripWidth={markerStripWidth}
      />

      <div className="topic__body">
        <TopicAccessoryRow node={node} />

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
            <TopicTextLines node={node} />
          </div>
        )}

        <TopicImageBlock
          image={image}
          imageBox={imageBox}
          imageFailed={imageFailed}
          setFailedImagePath={setFailedImagePath}
        />

        <TopicFormulaBlock node={node} formula={formula} formulaBox={formulaBox} />

        <TopicCodeBlock
          node={node}
          code={code}
          codeMetrics={codeMetrics}
          codeBox={codeBox}
          codeLines={codeLines}
        />

        <TopicLabelRow node={node} />
      </div>

      <TopicResizeHandle
        node={node}
        selected={selected}
        editing={editing}
        minNodeWidth={minNodeWidth}
        minNodeHeight={minNodeHeight}
      />

      <TopicCollapseBadges
        node={node}
        splitSides={splitSides}
        foldedSides={foldedSides}
        color={color}
        canCollapse={canCollapse}
        collapseSide={collapseSide}
        onToggleFoldSide={onToggleFoldSide}
        onToggleCollapse={onToggleCollapse}
      />
    </div>
  )
}

const TopicNode = memo(TopicNodeInner)
export default TopicNode
