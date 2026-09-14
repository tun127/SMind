/**
 * 核心数据模型。
 *
 * 设计原则（与 .xmind 保持最大兼容）：
 * 1. `title` / `notes` 一律使用纯文本，与 .xmind 的 content.json 字段一一对应，
 *    保证文件被真实 Xmind 打开时内容不丢失。
 * 2. 本软件自己的扩展能力（富文本片段格式、公式等）存放在 `extensions` 中，
 *    Xmind 打开时会忽略它们，但我们的读写不会丢失。
 * 3. 所有对象只使用普通对象/数组，确保可以通过 Electron IPC 结构化克隆。
 */

/** 结构类型，取值与 Xmind 的 structureClass 完全一致，便于双向兼容 */
export type StructureClass = string

/** 富文本片段（P2 启用，P1 仅做数据承载） */
export interface RichTextRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  /**
   * 高亮（Markdown 的 `==文字==` / HTML 的 `<mark>`）。
   * 渲染成底色，让重点在画布上一眼可见。
   */
  highlight?: boolean
  /**
   * 上标 / 下标（Markdown 的 `^上标^` 与 `~下标~`，也来自 HTML 的 `<sup>` / `<sub>`）。
   * 渲染时字号会缩小并上/下偏移。
   */
  script?: 'super' | 'sub'
  color?: string
  fontSize?: number
  fontFamily?: string
}

export interface RichTextParagraph {
  align?: 'left' | 'center' | 'right'
  bullet?: boolean
  runs: RichTextRun[]
}

export interface RichText {
  paragraphs: RichTextParagraph[]
}

/** 标记图标引用 */
export interface MarkerRef {
  markerId: string
}

/** 附件（打包在 .xmind 的 resources/ 内） */
export interface Attachment {
  id: string
  /** 包内相对路径，如 resources/abc.png */
  path: string
  name: string
  size?: number
  mime?: string
}

/** 节点内嵌图片 */
export interface TopicImage {
  path: string
  width?: number
  height?: number
}

/**
 * 节点里的一段代码。
 *
 * 为什么不用富文本凑：代码块要**等宽字体、保留缩进与换行、语法高亮**，
 * 富文本的富样式是"逐段逐字"的、行内还可能混排，做不到整块等宽。
 */
export interface TopicCode {
  /** 语言标识（ts / js / python / json / sql …）；空串＝当作纯文本排版 */
  language: string
  text: string
}

/** 节点样式（properties 的键沿用 Xmind 的 svg:* / fo:* 命名） */
export interface NodeStyle {
  id?: string
  properties: Record<string, string>
}

export interface Topic {
  id: string
  /** 纯文本标题，多行以 \n 分隔 */
  title: string
  /** 富文本格式信息（P2），与 title 的纯文本内容对应 */
  titleRich?: RichText
  /** 该分支使用的结构类型，缺省时继承父级 */
  structureClass?: StructureClass
  children: Topic[]
  /** 浮动主题（不参与自动布局） */
  detachedChildren: Topic[]
  labels: string[]
  markers: MarkerRef[]
  /** 备注纯文本 */
  notes?: string
  /** 备注富文本 HTML（对应 Xmind 的 notes.realHTML） */
  notesHtml?: string
  /** 超链接 */
  href?: string
  image?: TopicImage
  /** LaTeX 公式源码（P4） */
  formula?: string
  /** 节点里的一段代码（P7）：等宽排版 + 语法高亮 */
  code?: TopicCode
  /**
   * 手动拉伸后的节点尺寸覆盖（拖右下角手柄设置）。
   *
   * 只覆盖**下限**：内容需要更高时仍然会长高（绝不裁切内容），
   * 宽度则作为文本换行上限（文字按给定宽度重排）。
   */
  sizeOverride?: { width: number; height: number }
  attachments: Attachment[]
  style?: NodeStyle
  /** 是否折叠子节点 */
  collapsed?: boolean
  /** 自由定位偏移（相对自动布局位置的增量） */
  position?: { x: number; y: number }
  /** 原样保留的 Xmind 扩展字段，避免另存丢信息 */
  extensions?: unknown[]
}

export interface Relationship {
  id: string
  end1Id: string
  end2Id: string
  title?: string
  style?: NodeStyle
  extensions?: unknown[]
}

export interface Boundary {
  id: string
  /** Xmind 的区间表示，如 (topicId1,topicId2) */
  range: string
  title?: string
  style?: NodeStyle
  extensions?: unknown[]
}

export interface Summary {
  id: string
  /** 概要自身主题的 id */
  topicId: string
  range: string
  title?: string
  style?: NodeStyle
  extensions?: unknown[]
}

/**
 * 主题配色。
 * 这是本软件自己的主题模型；落到 .xmind 时存放在 theme 的命名空间键下，
 * Xmind 不认识该键会忽略，不会影响它自己那套主题结构。
 */
export interface ThemeColors {
  /** 画布背景色 */
  canvas: string
  /** 画布网格点颜色 */
  grid: string
  /** 中心主题填充色 */
  rootFill: string
  /** 中心主题文字色 */
  rootText: string
  /** 一级主题填充色 */
  level1Fill: string
  /** 一级主题文字色 */
  level1Text: string
  /** 二级及更深主题的文字色 */
  deepText: string
  /** 一级分支配色，按顺序循环使用 */
  branches: string[]
  /** 连线宽度 */
  edgeWidth: number
  /** 连线不透明度 */
  edgeOpacity: number
}

export interface Theme {
  id?: string
  name?: string
  /** 本软件的主题配色 */
  colors?: ThemeColors
  /** 原样保留 Xmind 主题结构，避免另存丢信息 */
  raw?: Record<string, unknown>
}

export interface Sheet {
  id: string
  title: string
  rootTopic: Topic
  theme?: Theme
  relationships: Relationship[]
  boundaries: Boundary[]
  summaries: Summary[]
  topicPositioning?: 'fixed' | 'floating'
  extensions?: unknown[]
}

export interface Workbook {
  /** 本软件模型版本号 */
  version: number
  sheets: Sheet[]
  activeSheetId: string
  creator: { name: string; version: string }
}

/** 一个 .xmind 包 = 工作簿 + 资源文件 */
export interface MindPackage {
  workbook: Workbook
  /** 包内相对路径 -> 二进制内容 */
  resources: Record<string, Uint8Array>
}

export const MODEL_VERSION = 1
export const CREATOR = { name: 'SMind', version: '0.4.1' }
