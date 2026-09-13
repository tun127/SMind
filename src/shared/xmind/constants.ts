/**
 * .xmind 格式常量：结构类型、常用标记图标、包内文件名。
 * 取值与 Xmind 官方保持一致，保证双向兼容。
 */

import type { StructureClass } from '../model/types'

export interface StructureDef {
  class: StructureClass
  /** 界面显示名 */
  label: string
  /** 布局是否已实现 */
  supported: boolean
  /** 布局方向分组，供布局引擎选择算法 */
  family: 'mindmap' | 'logic' | 'tree' | 'orgchart' | 'fishbone' | 'timeline' | 'brace' | 'spreadsheet' | 'matrix'
}

export const STRUCTURES: StructureDef[] = [
  { class: 'org.xmind.ui.map.unbalanced', label: '思维导图（平衡）', supported: true, family: 'mindmap' },
  { class: 'org.xmind.ui.map.clockwise', label: '思维导图（顺时针）', supported: true, family: 'mindmap' },
  { class: 'org.xmind.ui.logic.right', label: '逻辑图（向右）', supported: true, family: 'logic' },
  { class: 'org.xmind.ui.logic.left', label: '逻辑图（向左）', supported: true, family: 'logic' },
  { class: 'org.xmind.ui.tree.right', label: '树形图（向右）', supported: true, family: 'tree' },
  { class: 'org.xmind.ui.tree.left', label: '树形图（向左）', supported: true, family: 'tree' },
  { class: 'org.xmind.ui.org-chart.down', label: '组织架构图（向下）', supported: true, family: 'orgchart' },
  { class: 'org.xmind.ui.org-chart.up', label: '组织架构图（向上）', supported: true, family: 'orgchart' },
  { class: 'org.xmind.ui.fishbone.leftHeaded', label: '鱼骨图', supported: true, family: 'fishbone' },
  { class: 'org.xmind.ui.timeline.horizontal', label: '时间轴（水平）', supported: true, family: 'timeline' },
  { class: 'org.xmind.ui.timeline.vertical', label: '时间轴（垂直）', supported: true, family: 'timeline' },
  { class: 'org.xmind.ui.brace.right', label: '括号图', supported: true, family: 'brace' },
  { class: 'org.xmind.ui.spreadsheet', label: '树状表格', supported: true, family: 'spreadsheet' },
  { class: 'org.xmind.ui.matrix', label: '矩阵图', supported: true, family: 'matrix' }
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

export function structureLabel(cls: StructureClass | undefined): string {
  return getStructureDef(cls).label
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
  'people': '人物',
  'light-bulb': '灵感',
  'crown': '皇冠',
  'finance': '金钱'
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

/** .xmind 包内固定文件名 */
export const XMIND_FILES = {
  content: 'content.json',
  metadata: 'metadata.json',
  manifest: 'manifest.json',
  legacyContent: 'content.xml',
  thumbnail: 'Thumbnails/thumbnail.png',
  resourcesDir: 'resources/'
} as const
