/**
 * .xmind 格式常量：结构类型、常用标记图标、包内文件名。
 * 取值与 Xmind 官方保持一致，保证双向兼容。
 */

import type { StructureClass } from '../model/types'
import { RESOURCES_DIR } from '../model/resources'

/** 分支整体展开的方向（中心主题折叠后看不见子节点，靠它给徽标定位） */
export type StructureGrowth = 'left' | 'right' | 'up' | 'down'

export interface StructureDef {
  class: StructureClass
  /** 界面显示名 */
  label: string
  /** 布局是否已实现 */
  supported: boolean
  /** 布局方向分组，供布局引擎选择算法 */
  family:
    | 'mindmap'
    | 'logic'
    | 'tree'
    | 'orgchart'
    | 'fishbone'
    | 'timeline'
    | 'brace'
    | 'spreadsheet'
    | 'matrix'
  /**
   * 分支整体展开的方向。
   *
   * 只用于「中心主题折叠后，折叠徽标该挂哪一边」：中心主题没有方向属性
   * （布局给它的 `side` 恒为 `'root'`），而它一旦折叠就看不见子节点了，
   * 只能靠结构方向判断——否则会出现「向左（向上/向下）的图、徽标却挂在右边」。
   * 未声明时按默认结构方向（向右）处理。
   */
  grows?: StructureGrowth
}

export const STRUCTURES: StructureDef[] = [
  {
    class: 'org.xmind.ui.map.unbalanced',
    label: '思维导图（平衡）',
    supported: true,
    family: 'mindmap',
    grows: 'right'
  },
  {
    class: 'org.xmind.ui.map.clockwise',
    label: '思维导图（顺时针）',
    supported: true,
    family: 'mindmap',
    grows: 'right'
  },
  {
    class: 'org.xmind.ui.logic.right',
    label: '逻辑图（向右）',
    supported: true,
    family: 'logic',
    grows: 'right'
  },
  {
    class: 'org.xmind.ui.logic.left',
    label: '逻辑图（向左）',
    supported: true,
    family: 'logic',
    grows: 'left'
  },
  {
    class: 'org.xmind.ui.tree.right',
    label: '树形图（向右）',
    supported: true,
    family: 'tree',
    grows: 'right'
  },
  {
    class: 'org.xmind.ui.tree.left',
    label: '树形图（向左）',
    supported: true,
    family: 'tree',
    grows: 'left'
  },
  {
    class: 'org.xmind.ui.org-chart.down',
    label: '组织架构图（向下）',
    supported: true,
    family: 'orgchart',
    grows: 'down'
  },
  {
    class: 'org.xmind.ui.org-chart.up',
    label: '组织架构图（向上）',
    supported: true,
    family: 'orgchart',
    grows: 'up'
  },
  {
    class: 'org.xmind.ui.fishbone.leftHeaded',
    label: '鱼骨图',
    supported: true,
    family: 'fishbone',
    grows: 'right'
  },
  {
    class: 'org.xmind.ui.timeline.horizontal',
    label: '时间轴（水平）',
    supported: true,
    family: 'timeline',
    grows: 'right'
  },
  {
    class: 'org.xmind.ui.timeline.vertical',
    label: '时间轴（垂直）',
    supported: true,
    family: 'timeline',
    grows: 'down'
  },
  {
    class: 'org.xmind.ui.brace.right',
    label: '括号图',
    supported: true,
    family: 'brace',
    grows: 'right'
  },
  {
    class: 'org.xmind.ui.spreadsheet',
    label: '树状表格',
    supported: true,
    family: 'spreadsheet',
    grows: 'down'
  },
  {
    class: 'org.xmind.ui.matrix',
    label: '矩阵图',
    supported: true,
    family: 'matrix',
    grows: 'down'
  }
]

/**
 * 新建导图的默认结构：**逻辑图（向右）**。
 * 单侧展开、层级一眼看清，比平衡图更适合承载长文本，也更接近大多数人日常画导图的习惯。
 */
export const DEFAULT_STRUCTURE: StructureClass = 'org.xmind.ui.logic.right'

const STRUCTURE_MAP = new Map(STRUCTURES.map((s) => [s.class, s]))

export function getStructureDef(cls: StructureClass | undefined): StructureDef {
  return (cls && STRUCTURE_MAP.get(cls)) || STRUCTURE_MAP.get(DEFAULT_STRUCTURE)!
}

/** 常用标记图标（P4 接入图标库，这里先提供 id -> 中文名映射） */
export const MARKER_LABELS: Record<string, string> = {
  'priority-1': '优先级 1',
  'priority-2': '优先级 2',
  'priority-3': '优先级 3',
  'priority-4': '优先级 4',
  'priority-5': '优先级 5',
  'task-start': '未开始',
  'task-oct': '进行中 1/4',
  'task-quarter': '进行中 2/4',
  'task-3quar': '进行中 3/4',
  'task-done': '已完成',
  'smiley-smile': '笑脸',
  'smiley-laugh': '大笑',
  'smiley-angry': '生气',
  'smiley-cry': '难过',
  'star-red': '红星',
  'star-orange': '橙星',
  'star-yellow': '黄星',
  'flag-red': '红旗',
  'flag-green': '绿旗',
  'flag-blue': '蓝旗',
  'symbol-plus': '加号',
  'symbol-minus': '减号',
  'symbol-question': '疑问',
  'symbol-exclam': '感叹',
  'arrow-up': '上升',
  'arrow-down': '下降',
  people: '人物',
  'light-bulb': '灵感',
  crown: '皇冠',
  finance: '金钱'
}

/* ------------------------------------------------------------------ */
/* 标记的「类别」与同类别互斥                                          */
/* ------------------------------------------------------------------ */

/** 面板里的一**行**标记：同一行（同一类别）同时只能有一个 */
export interface MarkerGroup {
  title: string
  markers: string[]
}

/**
 * 可选标记的分组表。**这一行就是互斥单位**——与 Xmind 一致：
 * 优先级里选了 3，之前选的 1 就该消失；再点 3 才取消。
 *
 * 为什么必须有这张表：直接给节点挂标记的模型（以及文件带来的标记）可以一次带很多个，
 * 以前是一串并列图标里同时亮着 1/3/4/5 四个优先级——同一个维度给出四个互相矛盾的答案，
 * 用户既没法读也没法用。
 */
export const MARKER_GROUPS: MarkerGroup[] = [
  {
    title: '优先级',
    markers: ['priority-1', 'priority-2', 'priority-3', 'priority-4', 'priority-5']
  },
  { title: '进度', markers: ['task-start', 'task-oct', 'task-quarter', 'task-3quar', 'task-done'] },
  { title: '星标', markers: ['star-red', 'star-orange', 'star-yellow'] },
  { title: '旗帜', markers: ['flag-red', 'flag-green', 'flag-blue'] },
  { title: '表情', markers: ['smiley-smile', 'smiley-laugh', 'smiley-angry', 'smiley-cry'] },
  { title: '符号', markers: ['symbol-plus', 'symbol-minus', 'symbol-question', 'symbol-exclam'] },
  { title: '趋势', markers: ['arrow-up', 'arrow-down'] },
  { title: '其他', markers: ['people', 'light-bulb', 'crown', 'finance'] }
]

/** 面板里全部可选标记的 id（供自检校验覆盖面） */
export const ALL_PICKABLE_MARKERS: string[] = MARKER_GROUPS.flatMap((group) => group.markers)

/**
 * 这个标记属于哪一行（类别）。不在表里的返回 null——
 * 文件带来的自定义标记就属于这一类：它们**自成一族**，互不影响，
 * 也不能因为"不在表里"就被抹掉。
 */
export function markerGroupOf(markerId: string): string | null {
  for (const group of MARKER_GROUPS) {
    if (group.markers.includes(markerId)) return group.title
  }
  return null
}

/**
 * 点一下某个标记之后，这个节点上应该剩哪些标记（**同类互斥**）。
 *
 * - 已选中的再点一次 = 取消它；
 * - 点同一行的另一个 = **替换**（不是叠加）；
 * - 不同行的照旧叠加（优先级 + 进度 + 星标是三个维度，本来就该并存）；
 * - 不在表里的自定义标记自成一族，互不影响。
 */
export function withMarkerToggled(current: string[], markerId: string): string[] {
  if (markerId.length === 0) return current
  if (current.includes(markerId)) return current.filter((id) => id !== markerId)
  const group = markerGroupOf(markerId)
  const rest = group === null ? current : current.filter((id) => markerGroupOf(id) !== group)
  return [...rest, markerId]
}

/**
 * 把一整串标记 id 收敛成「每行一个」：去重，且同类别只留**最先出现**的那个。
 *
 * 用在「整体替换」这类入口（`setMarkers`）：输入可能带着同一行的多个标记，
 * 留第一个、其余丢掉，好过在界面上亮出一排自相矛盾的图标。
 * 不在表里的标记原样保留（见 `markerGroupOf`）。
 */
export function reconcileMarkers(ids: string[]): string[] {
  const seen = new Set<string>()
  const groups = new Set<string>()
  const out: string[] = []
  for (const raw of ids) {
    const id = raw.trim()
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const group = markerGroupOf(id)
    if (group !== null) {
      if (groups.has(group)) continue
      groups.add(group)
    }
    out.push(id)
  }
  return out
}

/**
 * 本软件主题配色的命名空间键。
 * 存在 theme 对象里，Xmind 不认识它就会忽略，不影响 Xmind 自己那套主题结构。
 */
export const THEME_NAMESPACE = 'com.mindmap.local.theme'

/**
 * 关系线弯度偏移存放的位置：relationship.style.properties 下的这个键。
 * 用 style 而不是新增字段，是因为 style 会被原样往返保存，
 * Xmind 也会忽略不认识的属性键，不影响兼容性。
 */
export const RELATIONSHIP_CURVE_KEY = 'com.mindmap.local.curve'

/**
 * 一级主题被手动调到中心主题哪一侧。存在 topic.style.properties 下。
 * 平衡结构默认按顺序交替分配左右，用户把它拖到另一侧时写这个键覆盖；
 * 不认识的键 Xmind 会忽略，往返不丢。
 */
export const TOPIC_SIDE_KEY = 'com.mindmap.local.side'

/**
 * 平衡思维导图里「中心主题哪些方向的子主题被收起」。
 * 存在 topic.style.properties 下，取值 `left` / `right` / `left,right`。
 *
 * 为什么单开一个私有键而不是用 Xmind 的 `branch: "folded"`：那个字段只有
 * 「整体折叠 / 展开」两态，表达不了「只收起左边」；而 `style.properties` 会被
 * 原样往返保存，Xmind 也会忽略不认识的键（与 `TOPIC_SIDE_KEY` 同一套做法）。
 */
export const TOPIC_FOLD_KEY = 'com.mindmap.local.fold'

/** .xmind 包内固定文件名 */
export const XMIND_FILES = {
  content: 'content.json',
  metadata: 'metadata.json',
  manifest: 'manifest.json',
  legacyContent: 'content.xml',
  thumbnail: 'Thumbnails/thumbnail.png',
  resourcesDir: RESOURCES_DIR
} as const
