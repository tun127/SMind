/**
 * 一次拖拽到底要动哪些主题。
 *
 * 抽成纯函数放在 shared 里（而不是塞在画布组件中），是因为它是拖拽的**语义核心**：
 * 拖拽时画什么、松手后写什么，都要用同一份答案。纯函数也让它能被自检完整覆盖。
 */
import type { Topic } from './types'
import { subtreeIds } from './tree'

/** 一次拖拽涉及的完整集合，以及这些主题之间的父子对照表 */
export interface DragMove {
  /** 要移动的所有主题 id（含后代；不重复） */
  ids: string[]
  /** id -> 父级 id（根与游离主题的父级是 null） */
  parentOf: Map<string, string | null>
}

/** 按树里的父子关系建立对照表（游离主题也算在内） */
export function parentMapOf(root: Topic): Map<string, string | null> {
  const parentOf = new Map<string, string | null>()
  const collect = (topic: Topic, parentId: string | null): void => {
    parentOf.set(topic.id, parentId)
    for (const child of topic.children) collect(child, topic.id)
    for (const child of topic.detachedChildren) collect(child, topic.id)
  }
  collect(root, null)
  return parentOf
}

/**
 * 解析这次拖拽要移动哪些主题。
 *
 * - 抓在「已选中的一群」里的任意一个上：整群一起走（多选拖拽）；
 * - 抓在没被选中的主题上、或只选中了一个：只走它自己；
 * - 再做一次「去冗余」：父子同时入选时只保留最上面那个父级——
 *   父级一动，它的后代本来就跟着走，两边都记会让这些后代被移动两次。
 */
export function resolveDragMove(
  root: Topic,
  anchorId: string,
  selection: readonly string[]
): DragMove {
  const parentOf = parentMapOf(root)
  const candidates = selection.includes(anchorId) && selection.length > 1 ? selection : [anchorId]

  const redundant = new Set<string>()
  for (const id of candidates) {
    if (!parentOf.has(id)) continue
    for (let up = parentOf.get(id) ?? null; up; up = parentOf.get(up) ?? null) {
      if (candidates.includes(up)) {
        redundant.add(id)
        break
      }
    }
  }

  // 先按树里的先后顺序排一遍（Map 保持插入顺序），再整棵子树展开
  const ordered = [...parentOf.keys()].filter((id) => candidates.includes(id) && !redundant.has(id))
  const ids = new Set<string>()
  for (const id of ordered) for (const sub of subtreeIds(root, id)) ids.add(sub)

  return { ids: [...ids], parentOf }
}

/**
 * 被拖主题里那些「父级没在被拖集合中」的，才真正需要写新的自由位置。
 * 例如父子同时被选中时只写父级：子级跟在父级里一起动，
 * 若再给它写一次相同的位移，就会移动两倍的距离。
 */
export function moveRootsOf(drag: DragMove): string[] {
  return drag.ids.filter((id) => {
    const parent = drag.parentOf.get(id) ?? null
    return parent === null || !drag.ids.includes(parent)
  })
}

/**
 * 传给 `resolveDrop` 的「同时被拖的**其它**主题」。
 *
 * 必须是「除被抓住的那个之外的**顶层**被拖主题」，而不是整棵子树：
 * 多选时「成为某人的子主题」被有意禁用（一群主题挂到一个人下面解释不通），
 * 但若把锚点自己（以及它的后代）也算进去，这个列表就**永远非空**，
 * 于是**单选拖动时"成为子主题"也被一起禁掉**——落点恒为 null、松手什么都不发生。
 *
 * 抽成纯函数是为了让画布与自检**共用同一份取参逻辑**：
 * 之前用例调 `resolveDrop` 时不传这个参数、画布却传了错的，导致自检全绿而线上全废。
 */
export function alsoDraggedOf(drag: DragMove, anchorId: string): string[] {
  return moveRootsOf(drag).filter((other) => other !== anchorId)
}
