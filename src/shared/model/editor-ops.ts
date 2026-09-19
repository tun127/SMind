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

import { sameRange } from '../layout'
import type { Size } from '../layout/types'
import { notesHtmlFrom } from '../richtext'
import { allChildrenOf, findParent, findTopic } from './tree'
import type { Topic, TopicImage } from './types'

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

/* ------------------------------------------------------------------ */
/* 结构操作：删除之后的**选择落点**                                     */
/* ------------------------------------------------------------------ */

/**
 * 删除主题之后选择落到哪个主题上。
 *
 * 删完必须把选择落到一个**还存在**的主题上：否则选择指向"空"，
 * 方向键、Delete、Tab/Enter 全都失灵，用户只能先拿鼠标点一下才能继续用键盘
 * （这就是反馈里的「删除节点后选择失效，必须鼠标点击才能生效」）。
 *
 * `first` = 被删的第一个主题（调用方已经从 `targets` 取过并做过空值早退），
 * `targets` = 这一批会被全部删掉的 id。
 */
export function selectionAfterDelete(root: Topic, first: string, targets: string[]): string[] {
  const parent = findParent(root, first)
  if (!parent) return []
  // 兄弟要按「挂着的 + 自由摆放的」一起算：自由摆放的主题被选中时，
  // 它不在 parent.children 里，只按 children 算会挑到一个不相干的兄弟
  const siblings = allChildrenOf(parent)
  const firstIndex = siblings.findIndex((child) => child.id === first)
  const after = siblings.slice(firstIndex + 1).find((child) => !targets.includes(child.id))
  const before = siblings
    .slice(0, Math.max(firstIndex, 0))
    .reverse()
    .find((child) => !targets.includes(child.id))
  return [after?.id ?? before?.id ?? parent.id]
}

/* ------------------------------------------------------------------ */
/* 节点尺寸：归一与钳制                                                */
/* ------------------------------------------------------------------ */

/** 手动拉伸尺寸的归一：宽高必须**都**为正才算有效（否则等于「恢复自动尺寸」），有效值四舍五入取整 */
export function normalizeSizeOverride(size: { width: number; height: number } | null): Size | null {
  return size && size.width > 0 && size.height > 0
    ? { width: Math.round(size.width), height: Math.round(size.height) }
    : null
}

/**
 * 把尺寸**钳制**到不小于内容最小盒（`mins` 里任一项都不许被压过去）。
 *
 * `mins` 的构造刻意留在 store：它要用 renderer 的 `nodePaddingOf` / `NODE_FONT_SIZES` /
 * `formulaSize`（`shared` 不许 import `renderer`），这里只做紧随其后的纯计算。
 * 不需要钳制时**原样返回传入的那个对象**（不复制），与搬迁前一致。
 */
export function clampSizeToContent(size: Size, mins: Size[]): Size {
  const minWidth = Math.max(0, ...mins.map((item) => item.width))
  const minHeight = Math.max(0, ...mins.map((item) => item.height))
  return minWidth > size.width || minHeight > size.height
    ? {
        width: Math.max(size.width, Math.round(minWidth)),
        height: Math.max(size.height, Math.round(minHeight))
      }
    : size
}

/* ------------------------------------------------------------------ */
/* 节点内图片：尺寸归一                                                */
/* ------------------------------------------------------------------ */

/**
 * 图片尺寸归一：拿不到有效像素尺寸时给 `undefined`，**不要写 0**
 * ——写 0 会让渲染层画出一个 0×0 的框，`undefined` 才走「尺寸未知」的兜底框。
 */
export function normalizeImage(image: TopicImage | null): TopicImage | null {
  const positive = (value: number | undefined): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
  return image
    ? { path: image.path, width: positive(image.width), height: positive(image.height) }
    : null
}

/* ------------------------------------------------------------------ */
/* 同级排序与编号                                                      */
/* ------------------------------------------------------------------ */

/**
 * 按给定顺序重排子主题。
 * **只按给定顺序排「还在的」子主题**；没给到的（模型看不到的）保持原相对顺序、排在最后
 * ——`sort` 稳定，且未给到的一律取 `MAX_SAFE_INTEGER`，所以它们的相对次序原样保留。
 */
export function orderChildren(children: Topic[], orderedIds: string[]): Topic[] {
  const index = new Map(orderedIds.map((id, at) => [id, at]))
  return [...children].sort((left, right) => {
    const leftAt = index.get(left.id) ?? Number.MAX_SAFE_INTEGER
    const rightAt = index.get(right.id) ?? Number.MAX_SAFE_INTEGER
    return leftAt - rightAt
  })
}

/** 按 `「序号. 标题」` 就地重新编号；已经是目标写法就跳过，不产生无谓的 patch。 */
export function renumberChildren(children: Topic[]): void {
  children.forEach((child, at) => {
    const stripped = child.title.replace(/^\s*\d+\s*[.、)]\s*/, '').trim()
    if (stripped.length === 0) return
    const next = `${at + 1}. ${stripped}`
    if (child.title === next) return
    child.title = next
    // 与手工改名一致：局部格式（加粗/颜色）是按字符位置贴的，留着会盖在错的字上
    child.titleRich = undefined
  })
}

/* ------------------------------------------------------------------ */
/* 合并同名主题：内容并入                                              */
/* ------------------------------------------------------------------ */

/**
 * 合并时把 `loser` 的内容并入 `keep`：**保留方缺什么补什么**（不覆盖它已有的内容）。
 * 标签取并集；标记按 `markerId` 去重后取并集。子主题的搬运与 loser 的摘除不在这里（要动树）。
 */
export function mergeTopicContent(keep: Topic, loser: Topic): void {
  if (!keep.notes && loser.notes) {
    keep.notes = loser.notes
    keep.notesHtml = notesHtmlFrom(loser.notes)
  }
  if (!keep.code && loser.code) keep.code = loser.code
  if (!keep.formula && loser.formula) keep.formula = loser.formula
  const labels = new Set([...(keep.labels ?? []), ...(loser.labels ?? [])])
  if (labels.size > 0) keep.labels = [...labels]
  const markers = new Map((keep.markers ?? []).map((marker) => [marker.markerId, marker]))
  for (const marker of loser.markers ?? []) {
    if (!markers.has(marker.markerId)) markers.set(marker.markerId, marker)
  }
  if (markers.size > 0) keep.markers = [...markers.values()]
}

/* ------------------------------------------------------------------ */
/* 画布级元素查重                                                      */
/* ------------------------------------------------------------------ */

/**
 * 找一条**同一对端点**的关系线（**不分方向**）。
 * `addRelationship`（读当前选择）与 `connectTopics`（模型直接给 id）原来各写一份同样的扫描；
 * 这里只抽原语——两个调用点各自的策略（一个是开关、一个返回已有 id）留在 store。
 */
export function findRelationshipBetween<T extends { end1Id: string; end2Id: string }>(
  relationships: T[],
  end1Id: string,
  end2Id: string
): T | undefined {
  return relationships.find(
    (item) =>
      (item.end1Id === end1Id && item.end2Id === end2Id) ||
      (item.end1Id === end2Id && item.end2Id === end1Id)
  )
}

/**
 * 找一段**同一个区间**的边界 / 概要（判据仍是共享的 `sameRange`，不在这里重写比较）。
 * `addBoundary` / `addSummary` / `addBoundaryFor` / `addSummaryFor` 四个调用点共用。
 */
export function findOverlayByRange<T extends { range: string }>(
  items: T[],
  range: string
): T | undefined {
  return items.find((item) => sameRange(item.range, range))
}
