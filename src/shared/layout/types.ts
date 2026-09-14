import type { NodeStyle, Topic } from '../model/types'

export interface Size {
  width: number
  height: number
}

/** 一段样式一致的文本 */
export interface StyledSegment {
  /** 行内公式源码：非空时这一段的 text 只作纯文本回退，渲染要走 KaTeX */
  formula?: string
  text: string
  /** 已解析好的字体粗细，渲染层直接用 */
  weight?: number
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
  fontSize: number
  fontFamily?: string
}

export interface MeasuredLine {
  segments: StyledSegment[]
  width: number
  height: number
  align: 'left' | 'center' | 'right'
}

/**
 * 节点顶部图标行里的一项。
 * 标记图标与「有备注 / 有超链接 / 有附件 / 有公式 / 有图片」的指示图标共用一行。
 */
export interface AccessoryItem {
  kind: 'marker' | 'notes' | 'link' | 'attachment' | 'formula' | 'image'
  /** kind 为 marker 时有效 */
  markerId?: string
  width: number
}

export interface AccessoryRow {
  items: AccessoryItem[]
  /** 0 表示没有图标行 */
  height: number
  width: number
}

export interface MeasuredLabel {
  text: string
  width: number
}

export interface LabelRow {
  items: MeasuredLabel[]
  /** 0 表示没有标签行 */
  height: number
  width: number
}

/**
 * 测量结果。
 * 除了尺寸，还带着换行后的「带样式的行」、图标行、标签行与排版参数，
 * 这样渲染层直接复用布局阶段的结果，保证「测量」与「显示」完全一致。
 */
export interface MeasureResult extends Size {
  lines: MeasuredLine[]
  fontSize: number
  lineHeight: number
  paddingX: number
  paddingY: number
  /** 顶部图标行（标记 + 指示图标） */
  accessory: AccessoryRow
  /** 底部标签行 */
  labelRow: LabelRow
  /** 节点内图片的显示框（0 表示没有图片） */
  imageBox?: Size
  /** 公式块的显示框（0 表示没有公式） */
  formulaBox?: Size
  /** 代码块的显示框（0 表示没有代码） */
  codeBox?: Size
  /** 节点左侧的标记条（标记竖排；没有标记时为空） */
  markerStrip?: MarkerStrip
}

/** 节点左侧的标记条 */
export interface MarkerStrip extends Size {
  markerIds: string[]
}

/** 由渲染层注入的文本测量函数（依赖 Canvas measureText） */
export type MeasureFn = (topic: Topic, depth: number) => MeasureResult

export type Side = 'root' | 'right' | 'left' | 'down' | 'up'

export interface NodeLayout {
  id: string
  topic: Topic
  x: number
  y: number
  width: number
  height: number
  depth: number
  side: Side
  /** 以下字段来自测量结果，供渲染层直接使用 */
  lines: MeasuredLine[]
  fontSize: number
  lineHeight: number
  paddingX: number
  paddingY: number
  accessory: AccessoryRow
  labelRow: LabelRow
  /** 来自测量结果的图片/公式/代码显示框，渲染层用它摆放这些内容 */
  imageBox?: Size
  formulaBox?: Size
  codeBox?: Size
  /** 节点左侧的标记条（标记竖排） */
  markerStrip?: MarkerStrip
}

export interface EdgeLayout {
  fromId: string
  toId: string
  /** SVG path 的 d 属性 */
  d: string
}

export interface LayoutBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 结构专属的装饰线，不是父子连线。
 * 例如时间轴的主轴、鱼骨图的主脊、括号图的括号。
 * 坐标必须是归一化之后的最终坐标，渲染层直接使用。
 */
export interface Decoration {
  /** SVG path 的 d 属性 */
  d: string
  /** 使用哪个节点的分支配色；不填则用中性色 */
  branchId?: string
  /** 线宽倍率，默认 1 */
  widthScale?: number
  /** 虚线样式，用于主轴这类辅助线 */
  dashed?: boolean
}

/** 标题文字块的尺寸（画布用它做命中区与选中框） */
export interface OverlayLabelSize {
  width: number
  height: number
}

/** 画布级元素的公共部分 */
export interface OverlayLayout {
  id: string
  title?: string
  /** 取哪个节点的分支配色；找不到则用中性色 */
  branchId?: string
  /**
   * 整个元素（括号/方框/曲线 + 标题）的包围盒：
   * 画布用它做**点击命中区**与**选中框**——标题为空也要能点到它。
   */
  bounds?: { x: number; y: number; width: number; height: number }
  /** 标题文字块尺寸；标题为空时是占位区的最小尺寸 */
  labelSize?: OverlayLabelSize
  /** 标题样式（字号/粗细/斜体/颜色），渲染与导出共用同一份读取 */
  style?: NodeStyle
}

/** 关系线：任意两个主题之间的连线，带箭头与可选标题 */
export interface RelationshipLayout extends OverlayLayout {
  /** SVG path 的 d 属性 */
  d: string
  /** 起点（end1）在节点边框上的位置，也是起点拖拽手柄的位置 */
  start: { x: number; y: number }
  /** 箭头三角形的位置与朝向（弧度）；位置同时也是终点手柄的位置 */
  arrow: { x: number; y: number; angle: number }
  /** 标题锚点（曲线中点） */
  label: { x: number; y: number }
}

/** 边界：包住一组同级主题及其子树的圆角矩形 */
export interface BoundaryLayout extends OverlayLayout {
  x: number
  y: number
  width: number
  height: number
  /**
   * 圆角矩形的 SVG path。
   * 渲染层会把同色的多个边界拼成**一条** path 一次性填充，
   * 这样重叠区域不会被半透明叠加成更深的颜色。
   */
  d: string
  /** 标题锚点 */
  label: { x: number; y: number }
}

/** 概要：覆盖一组同级主题的大括号，末尾接概要文字 */
export interface SummaryLayout extends OverlayLayout {
  /** 大括号路径 */
  d: string
  label: { x: number; y: number }
  /** 概要文字的锚点对齐方式，避免文字压到括号上 */
  anchor: 'start' | 'middle' | 'end'
}

export interface LayoutResult {
  nodes: NodeLayout[]
  nodeMap: Map<string, NodeLayout>
  edges: EdgeLayout[]
  decorations: Decoration[]
  bounds: LayoutBounds
  /** 每个节点所属的一级分支下标，用于取分支配色 */
  branchIndex: Map<string, number>
  /** 画布级元素（画在普通节点之上/之下，不属于树结构） */
  relationships: RelationshipLayout[]
  boundaries: BoundaryLayout[]
  summaries: SummaryLayout[]
}

export interface LayoutOptions {
  /** 同层节点水平间距 */
  gapX?: number
  /** 同层节点垂直间距 */
  gapY?: number
  /** 画布四周留白 */
  padding?: number
}
