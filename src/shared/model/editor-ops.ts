/**
 * 编辑器纯逻辑（第二批：`store/editor.ts` 里**内联**纯计算的下沉）。
 *
 * 与第一批 `editor-pure.ts` 同一条判据：不读 zustand 的 `set`/`get`，不碰 `window`/DOM/
 * `localStorage`/IPC，只做计算（个别就地修改传入的 draft，在 immer 里同样算纯逻辑），
 * 依赖面只有 `@shared` 下的模块——所以放 `shared/model/` 合法（`shared` 不许 import `renderer`），
 * 也能被 selfcheck 直接覆盖。
 *
 * **与第一批的差别**：第一批搬的是**整个函数**；这一批搬的是 **store 方法体里的内联代码**，
 * 所以每个方法体都被改写成「读入参 → 调这里的纯函数 → 照原顺序 `set` / `mutate` / 调其它 action」。
 * 每次改写都逐字保留语义与副作用顺序：`set` / `get` / `mutate` 的**调用次数与先后一律未动**。
 *
 * **依赖 renderer 的部分刻意留在 store**（`shared` 不许反向依赖）：
 * `../render/measure` 的 `nodePaddingOf` / `NODE_FONT_SIZES`、`../render/formula` 的 `formulaSize`
 * ——也就是 `setSizeOverride` 里「算 minBox」那一段；下沉的只有紧随其后的**钳制**。
 *
 * 公开面：这里新增的都是 `store/editor.ts` 内部使用的实现细节，**没有**改动 `editor.ts` 的导出集合，
 * 所以外部文件一行都不用改。
 */

import { findParent, findTopic } from './tree'
import type { Topic } from './types'

/* ------------------------------------------------------------------ */
/* 选择与键盘                                                          */
/* ------------------------------------------------------------------ */

/**
 * `select` 的 reducer 本体。
 *
 * 返回值刻意保持「部分状态」的形状：`additive` 且命中的那一支**不带** `selectedOverlay`，
 * 于是 `set()` 合并时不会去动它——这是搬迁前就有的行为，逐字保留。
 */
export function selectReducer(
  selection: string[],
  id: string | null,
  additive: boolean
): { selection: string[]; selectedOverlay?: null } {
  // 动主题就把画布元素的选中取消（两者不同时高亮）
  if (id === null) return { selection: [], selectedOverlay: null }
  if (!additive) return { selection: [id], selectedOverlay: null }
  return selection.includes(id)
    ? { selection: selection.filter((x) => x !== id) }
    : { selection: [...selection, id], selectedOverlay: null }
}

/** `moveSelectionByKey` 算出来的落点：要调用的就是 `moveNode(id, targetId, index)` */
export interface KeyMovePlan {
  targetId: string
  index?: number
}

/**
 * 快捷键微调的落点计算（`↑↓` 同级上下移、`Home`/`End` 到最前/最后、
 * `←` 升级成父级的兄弟、`→` 降级成前一个兄弟的子主题）。
 * 返回 `null` = 这次按键不该移动（对应原来直接 `return false` 的每一支）。
 */
export function resolveKeyMove(
  root: Topic,
  id: string,
  key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'
): KeyMovePlan | null {
  // 中心主题不能被移动
  if (id === root.id) return null
  const parent = findParent(root, id)
  if (!parent) return null
  const index = parent.children.findIndex((child) => child.id === id)
  if (index < 0) return null
  const last = parent.children.length - 1

  if (key === 'ArrowUp') return index === 0 ? null : { targetId: parent.id, index: index - 1 }
  if (key === 'ArrowDown') return index === last ? null : { targetId: parent.id, index: index + 1 }
  if (key === 'Home') return index === 0 ? null : { targetId: parent.id, index: 0 }
  if (key === 'End')
    return index === last ? null : { targetId: parent.id, index: parent.children.length }

  if (key === 'ArrowLeft') {
    // 升级：挪到父级的后面，成为父级的兄弟
    const grandParent = findParent(root, parent.id)
    if (!grandParent) return null
    const parentIndex = grandParent.children.findIndex((child) => child.id === parent.id)
    if (parentIndex < 0) return null
    return { targetId: grandParent.id, index: parentIndex + 1 }
  }

  // 降级：挂到前一个兄弟下面。没有前一个兄弟就无处可降。
  const previous = index > 0 ? parent.children[index - 1] : undefined
  if (!previous) return null
  return { targetId: previous.id }
}

/**
 * 方向键移动**选择**的目标（`←` 父级、`→` 第一个子级、`↑↓` 同级）。
 * 返回 `null` = 这次按键不改选择（对应原来 `set` 根本没被调用的每一支）。
 */
export function navigateTargetOf(
  root: Topic,
  currentId: string,
  key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
): string | null {
  if (key === 'ArrowLeft') {
    const parent = findParent(root, currentId)
    return parent ? parent.id : null
  }
  if (key === 'ArrowRight') {
    const firstChild = findTopic(root, currentId)?.children[0]
    return firstChild ? firstChild.id : null
  }
  const parent = findParent(root, currentId) ?? root
  const index = parent.children.findIndex((child) => child.id === currentId)
  if (index < 0) return null
  const nextIndex = key === 'ArrowUp' ? index - 1 : index + 1
  if (nextIndex >= 0 && nextIndex < parent.children.length) {
    const next = parent.children[nextIndex]
    if (next) return next.id
  }
  return null
}
