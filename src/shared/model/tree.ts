import type { NodeStyle, Sheet, Topic, Workbook } from './types'
import { createId } from './factory'
import { getStructureDef, TOPIC_FOLD_KEY, TOPIC_SIDE_KEY } from '../xmind/constants'

/** 子主题的展开方向：按侧收起就收「落在这一侧」的那些分支 */
export type FoldSide = 'left' | 'right' | 'up' | 'down'

/** 画布上依次摆放徽标的顺序（左右上下），保证同一份数据每次都渲染成同一个样子 */
const FOLD_SIDE_ORDER: FoldSide[] = ['left', 'right', 'up', 'down']

/**
 * 顺时针（放射）结构的起点角度：**右上**（约 1 点钟），随后顺时针递增。
 *
 * 官方只规定"顺时针"这个方向，起点角度属于**我方取值**（见 `docs/structure-spec.md`）。
 * 布局（`layoutRadial`）与「左右半圈」判定（`childFoldSides`）必须用同一个值，
 * 否则收起一侧之后剩下的分支会被重新判定到另一侧去——所以这里只写一份。
 */
export const RADIAL_START_ANGLE = -Math.PI / 3

/** 深度优先遍历（含根） */
export function walk(
  root: Topic,
  visit: (topic: Topic, parent: Topic | null, depth: number) => void
): void {
  const inner = (topic: Topic, parent: Topic | null, depth: number): void => {
    visit(topic, parent, depth)
    for (const child of topic.children) inner(child, topic, depth + 1)
    for (const child of topic.detachedChildren) inner(child, topic, depth + 1)
  }
  inner(root, null, 0)
}

/** 深度优先收集所有节点 */
export function flatten(root: Topic): Topic[] {
  const out: Topic[] = []
  walk(root, (t) => out.push(t))
  return out
}

export function findTopic(root: Topic, id: string): Topic | null {
  let found: Topic | null = null
  walk(root, (t) => {
    if (t.id === id) found = t
  })
  return found
}

/** 查找父节点，根节点返回 null */
export function findParent(root: Topic, id: string): Topic | null {
  let found: Topic | null = null
  walk(root, (_t, parent) => {
    if (parent && _t.id === id) found = parent
  })
  return found
}

/**
 * 一个主题的**全部**子节点：正常子主题 + 自由摆放（floating / detached）的主题。
 *
 * 为什么要收成一个函数：`walk`（上面）本来就是两类都走的，但树操作里有几处
 * 只写 `topic.children`，于是同一棵树上出现两套口径——
 * 自由摆放的主题能被找到、能被统计，却**删不掉也移不动**（`detachTopic` 只在
 * `children` 里找），而且删除还会对外报「成功」。以后凡是要遍历子节点，
 * 一律用这个函数，别再手写 `topic.children`（除非明确只要"挂在树上的那些"）。
 */
export function allChildrenOf(topic: Topic): Topic[] {
  return topic.detachedChildren.length > 0
    ? [...topic.children, ...topic.detachedChildren]
    : topic.children
}

/** 某节点的所有祖先 id（从根到父） */
export function ancestorsOf(root: Topic, id: string): string[] {
  const chain: string[] = []
  const search = (topic: Topic, trail: string[]): boolean => {
    if (topic.id === id) {
      chain.push(...trail)
      return true
    }
    // 自由摆放的主题也算树的一部分（`walk` 就是这么走的）：
    // 只走 `children` 会让它们的祖先链为空，地址解析、路径显示、导出层级全部落空
    return allChildrenOf(topic).some((c) => search(c, [...trail, topic.id]))
  }
  search(root, [])
  return chain
}

/** 是否是自己或自己的后代（用于阻止把节点拖进自己的子树） */
export function isSelfOrDescendant(root: Topic, ancestorId: string, targetId: string): boolean {
  if (ancestorId === targetId) return true
  const ancestor = findTopic(root, ancestorId)
  if (!ancestor) return false
  let hit = false
  walk(ancestor, (t) => {
    if (t.id === targetId) hit = true
  })
  return hit
}

/**
 * 某个节点连同它全部后代的 id。
 * 拖拽时整棵子树要一起移动（否则子节点的连接线会掉队），所以需要这个集合。
 */
export function subtreeIds(root: Topic, id: string): string[] {
  const start = findTopic(root, id)
  if (!start) return []
  const ids: string[] = []
  const collect = (topic: Topic): void => {
    ids.push(topic.id)
    // 与 `walk` 同口径：自由摆放的子树也属于这棵子树，拖拽时要跟着一起走
    for (const child of allChildrenOf(topic)) collect(child)
  }
  collect(start)
  return ids
}

/**
 * 从树上摘除节点并返回它。
 *
 * 两类子节点都要找：以前只在 `parent.children` 里找，于是**自由摆放的主题删不掉**
 * （`detachTopic` 返回 null，但 `deleteTopic` 照样对外报成功——用户看到"删了却没删"）。
 */
export function detachTopic(root: Topic, id: string): Topic | null {
  let removed: Topic | null = null
  walk(root, (_t, parent) => {
    if (!parent || removed) return
    const fromAttached = parent.children.findIndex((c) => c.id === id)
    if (fromAttached >= 0) {
      removed = parent.children.splice(fromAttached, 1)[0] ?? null
      return
    }
    const fromFloating = parent.detachedChildren.findIndex((c) => c.id === id)
    if (fromFloating >= 0) {
      removed = parent.detachedChildren.splice(fromFloating, 1)[0] ?? null
    }
  })
  return removed
}

/** 插入子节点 */
export function attachChild(parent: Topic, child: Topic, index?: number): void {
  if (index === undefined || index < 0 || index > parent.children.length) {
    parent.children.push(child)
  } else {
    parent.children.splice(index, 0, child)
  }
}

/** 移动节点到新父级 */
export function moveTopic(root: Topic, id: string, newParentId: string, index?: number): boolean {
  if (id === root.id) return false
  if (isSelfOrDescendant(root, id, newParentId)) return false
  const node = detachTopic(root, id)
  if (!node) return false
  const parent = findTopic(root, newParentId)
  if (!parent) {
    // 目标不存在，把节点放回原位会丢数据，这里退回到根下
    attachChild(root, node, index)
    return false
  }
  attachChild(parent, node, index)
  return true
}

/* ------------------------------------------------------------------ */
/* 折叠（整体折叠 + 平衡思维导图的「左右分别收起」）                     */
/* ------------------------------------------------------------------ */

/** 这个主题已收起的方向（写在 style.properties 的私有键里，见 TOPIC_FOLD_KEY） */
export function foldedSidesOf(topic: Topic): FoldSide[] {
  const raw = topic.style?.properties?.[TOPIC_FOLD_KEY]
  if (!raw) return []
  const out: FoldSide[] = []
  for (const part of raw.split(',')) {
    const value = part.trim()
    if (FOLD_SIDE_ORDER.includes(value as FoldSide) && !out.includes(value as FoldSide)) {
      out.push(value as FoldSide)
    }
  }
  return out
}

/** 写回已收起的方向；空数组 = 删掉该键，让模型里只留「有折叠」这一种状态 */
export function withFoldedSides(topic: Topic, sides: FoldSide[]): void {
  const properties: Record<string, string> = { ...(topic.style?.properties ?? {}) }
  if (sides.length === 0) delete properties[TOPIC_FOLD_KEY]
  else properties[TOPIC_FOLD_KEY] = sides.join(',')
  const next: NodeStyle = { ...(topic.style ?? {}), properties }
  // 没有别的属性、也没有 style.id 时整个丢掉，避免写出一堆空对象（另存产生结构性差异）
  topic.style = Object.keys(properties).length === 0 && next.id === undefined ? undefined : next
}

/**
 * 这个主题的子主题各自朝哪个方向展开——**布局与「按侧收起」共用的唯一来源**。
 *
 * 关键性质有两条：
 * ① **按全部子主题算，与折叠无关**：否则收起一侧后剩下的会重新编号、
 *    被判定到另一边去，收起一侧等于收起全部；
 * ② 单方向的结构返回**空表**（子主题都在同一个方向，没有分组可言）。
 *
 * 各结构的方向：
 * - 平衡思维导图：显式指定优先，其余按序号交替（1 右 2 左 3 右…）。
 *   不能按子树高度配平：那样挪一个子节点就会让归属整体翻转（历史缺陷）；
 * - 顺时针思维导图：按角度分左右半圈（起点右上、顺时针均分，与 `layoutRadial` 同一取值）；
 * - 时间轴（水平）/ 鱼骨图：沿主轴**上下交替**（序号 0 在上）——
 *   注意这只是**布局方向**：这两种结构不提供按侧收起，见 `splitFoldSidesOf`；
 * - 时间轴（垂直）：**左右交替**（序号 0 在左），同样只在布局层面有意义；
 * - 逻辑图 / 树形图 / 括号图 / 树状表格 / 矩阵图 / 组织架构图：子主题都在同一个方向。
 *
 * 结构是画布级属性、只写在中心主题上，所以这张表实际只在中心主题上有意义
 * （见 `splitFoldSidesOf` 的 `isRoot` 门）。
 */
export function childFoldSides(topic: Topic): Map<string, FoldSide> {
  const map = new Map<string, FoldSide>()
  const def = getStructureDef(topic.structureClass)

  switch (def.family) {
    case 'mindmap': {
      if (def.class === 'org.xmind.ui.map.clockwise') {
        const count = topic.children.length
        if (count <= 1) return map
        const sector = (Math.PI * 2) / count
        topic.children.forEach((child, index) => {
          const angle = RADIAL_START_ANGLE + sector * index
          map.set(child.id, Math.cos(angle) < 0 ? 'left' : 'right')
        })
        return map
      }
      topic.children.forEach((child, index) => {
        const manual = child.style?.properties?.[TOPIC_SIDE_KEY]
        if (manual === 'left') map.set(child.id, 'left')
        else if (manual === 'right') map.set(child.id, 'right')
        else map.set(child.id, index % 2 === 0 ? 'right' : 'left')
      })
      return map
    }
    case 'timeline': {
      const vertical = def.class === 'org.xmind.ui.timeline.vertical'
      topic.children.forEach((child, index) => {
        const first: FoldSide = vertical ? 'left' : 'up'
        const second: FoldSide = vertical ? 'right' : 'down'
        map.set(child.id, index % 2 === 0 ? first : second)
      })
      return map
    }
    case 'fishbone':
      topic.children.forEach((child, index) => {
        map.set(child.id, index % 2 === 0 ? 'up' : 'down')
      })
      return map
    default:
      return map
  }
}

/**
 * 主题当前**可见**的子主题：考虑整体折叠（`collapsed`）与按方向折叠（`foldedSides`）。
 *
 * 布局、大纲、包围盒三处都从这里取，口径只有一个——以前各自写
 * `topic.collapsed ? [] : topic.children`，加一种折叠方式就得改三处、漏一处就出现
 * 「画布收起了、大纲还列着」这种不一致。
 */
export function visibleChildren(topic: Topic): Topic[] {
  if (topic.collapsed) return []
  const folded = foldedSidesOf(topic)
  if (folded.length === 0) return topic.children
  const sides = childFoldSides(topic)
  // 单侧结构没有分组可言：收起状态在这里不该生效（守卫在 store 里，这里只兜底）
  if (sides.size === 0) return topic.children
  return topic.children.filter((child) => !folded.includes(sides.get(child.id) ?? 'right'))
}

/**
 * 要不要按侧显示**多根徽标**（分别收起）。
 *
 * 只有**思维导图（平衡 / 顺时针）**的中心主题提供：
 * - 时间轴与鱼骨图**刻意不提供**——它们的上下两侧是"沿主轴的交替摆放"，
 *   把一侧收起来只会让图变得难读（用户明确要求这两种保持「一个折叠点」）；
 * - 其余结构是单方向的（逻辑图 / 树形图 / 括号图 / 树状表格 / 矩阵图 / 组织架构图）。
 *
 * 还要**两个方向都真的挂着分支**才算（只有一侧有分支时，单徽标就够）。
 * 返回顺序固定为 左 → 右 → 上 → 下，徽标每次都渲染在同一个位置。
 */
export function splitFoldSidesOf(topic: Topic, isRoot: boolean): FoldSide[] {
  if (!isRoot) return []
  if (getStructureDef(topic.structureClass).family !== 'mindmap') return []
  const present = new Set(childFoldSides(topic).values())
  if (present.size < 2) return []
  return FOLD_SIDE_ORDER.filter((side) => present.has(side))
}

/** 让这个主题展开（整体折叠与按方向折叠一起清掉） */
export function ensureExpanded(topic: Topic): void {
  if (topic.collapsed) topic.collapsed = undefined
  if (foldedSidesOf(topic).length > 0) withFoldedSides(topic, [])
}

/**
 * 某一侧被收起时**藏起来**的节点数（该侧每个分支连同它的子树）。
 * 折叠徽标上的数字与 tooltip 用它。
 */
export function hiddenCountOfSide(topic: Topic, side: FoldSide): number {
  if (topic.collapsed) return 0
  const sides = childFoldSides(topic)
  let total = 0
  for (const child of topic.children) {
    if (sides.get(child.id) !== side) continue
    total += 1 + countDescendants(child)
  }
  return total
}

/**
 * 整张画布上**当前不显示**的节点数（整体折叠 + 按侧收起，不重复计入被祖先收起的部分）。
 *
 * 统计与骨架摘要用它告诉模型「你数到的不等于画布上显示的」——
 * 否则模型会以为被收起的那些节点正摆在画布上（或反过来，以为文档里没有它们）。
 */
export function countHiddenNodes(root: Topic): number {
  let total = 0
  const visit = (topic: Topic): void => {
    if (topic.collapsed) {
      total += countDescendants(topic)
      return
    }
    const visible = visibleChildren(topic)
    if (visible.length < topic.children.length) {
      const shown = new Set(visible.map((item) => item.id))
      for (const child of topic.children) {
        if (!shown.has(child.id)) total += 1 + countDescendants(child)
      }
    }
    for (const child of visible) visit(child)
  }
  visit(root)
  return total
}

/**
 * 后代数量的身份缓存。
 *
 * 折叠徽标/tooltip 会**每个节点**都问一次子树大小，纯递归是 O(节点数 × 平均深度)，
 * 深嵌套文档下每次重渲染都要重算一遍。主题对象是不可变快照（zustand + immer：
 * 任何改动都产生新对象、未改动的子树保持同一引用），所以按对象身份缓存是安全的——
 * 这也是渲染层测量缓存（render/measure.ts 的 identityCache）用的同一套前提。
 */
const descendantCache = new WeakMap<Topic, number>()

/** 某个主题的**后代**总数（不含自己）：折叠徽标显示「折叠了多少个节点」用它 */
export function countDescendants(topic: Topic): number {
  const cached = descendantCache.get(topic)
  if (cached !== undefined) return cached
  let n = 0
  for (const child of topic.children) n += 1 + countDescendants(child)
  for (const floating of topic.detachedChildren ?? []) n += 1 + countDescendants(floating)
  descendantCache.set(topic, n)
  return n
}

/** 节点总数（不含根时可传 false） */
export function countTopics(root: Topic, includeRoot = true): number {
  let n = 0
  walk(root, () => {
    n += 1
  })
  return includeRoot ? n : n - 1
}

/** 纯文本总字数（标题 + 标签 + 备注） */
export function countCharacters(root: Topic): number {
  let n = 0
  walk(root, (t) => {
    n += t.title.replace(/\s/g, '').length
    n += t.labels.join('').length
    n += (t.notes ?? '').replace(/\s/g, '').length
  })
  return n
}

/** 深拷贝一个节点，重新生成所有 id（用于复制粘贴） */
export function cloneTopicDeep(source: Topic): Topic {
  const copy: Topic = {
    ...source,
    id: createId('topic'),
    labels: [...source.labels],
    markers: source.markers.map((m) => ({ ...m })),
    attachments: source.attachments.map((a) => ({ ...a })),
    children: [],
    detachedChildren: [],
    style: source.style
      ? { ...source.style, properties: { ...source.style.properties } }
      : undefined,
    position: source.position ? { ...source.position } : undefined,
    titleRich: source.titleRich ? structuredClone(source.titleRich) : undefined
  }
  copy.children = source.children.map(cloneTopicDeep)
  copy.detachedChildren = source.detachedChildren.map(cloneTopicDeep)
  return copy
}

/** 获取当前激活画布 */
export function activeSheet(workbook: Workbook): Sheet {
  // 正常构造的工作簿至少有 1 张画布（新建与解析都保证）。
  // 这里刻意用断言而不是抛错：这个函数在渲染热路径上，一旦为"数据异常"抛错，
  // 会把一次显示问题放大成白屏；而上游（解析/新建）会先发现空工作簿。
  return (workbook.sheets.find((s) => s.id === workbook.activeSheetId) ?? workbook.sheets[0])!
}

/** 当前激活画布的根主题 */
export function activeRoot(workbook: Workbook): Topic {
  const sheet = activeSheet(workbook)
  return sheet.rootTopic
}
