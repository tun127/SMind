import type { Sheet, Topic, Workbook } from './types'
import { createId } from './factory'

/** 深度优先遍历（含根） */
export function walk(root: Topic, visit: (topic: Topic, parent: Topic | null, depth: number) => void): void {
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

/** 某节点的所有祖先 id（从根到父） */
export function ancestorsOf(root: Topic, id: string): string[] {
  const chain: string[] = []
  const search = (topic: Topic, trail: string[]): boolean => {
    if (topic.id === id) {
      chain.push(...trail)
      return true
    }
    return topic.children.some((c) => search(c, [...trail, topic.id]))
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
    for (const child of topic.children) collect(child)
  }
  collect(start)
  return ids
}

/** 从树上摘除节点并返回它 */
export function detachTopic(root: Topic, id: string): Topic | null {
  let removed: Topic | null = null
  walk(root, (_t, parent) => {
    if (!parent || removed) return
    const i = parent.children.findIndex((c) => c.id === id)
    if (i >= 0) {
      removed = parent.children.splice(i, 1)[0] ?? null
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

/** 某个主题的**后代**总数（不含自己）：折叠徽标显示「折叠了多少个节点」用它 */
export function countDescendants(topic: Topic): number {
  let n = 0
  for (const child of topic.children) n += 1 + countDescendants(child)
  for (const floating of topic.detachedChildren ?? []) n += 1 + countDescendants(floating)
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
    style: source.style ? { ...source.style, properties: { ...source.style.properties } } : undefined,
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
