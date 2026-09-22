/**
 * 移动与布局切片（「结构操作」分节的**后半**，成员体逐字未改）：键盘移动/选择导航、结构调整、
 * 拖放落点、同级排序、合并、自由摆放偏移、恢复自动布局、复制粘贴。
 *
 * `clipboard` 归本切片：它只被 `copySelection` / `paste` 写读（结构操作的后半段），
 * 初值 `null` 随本切片搬来。跨切片的 `get().addChild/addSibling/...` 调用与搬迁前一致。
 *
 * 本文件同时拥有这些成员在 `EditorState` 里的**声明**（接口逐字搬来）。
 */

import type { Topic } from '@shared/model/types'

import {
  activeRoot,
  activeSheet,
  cloneTopicDeep,
  detachTopic,
  ensureExpanded,
  findParent,
  findTopic,
  flatten,
  isSelfOrDescendant,
  moveTopic,
  subtreeIds
} from '@shared/model/tree'

import { resolveDrop, type DropMode } from '@shared/model/drop'
import { pruneOverlays, settleAfterMove } from '@shared/model/editor-pure'
import {
  mergeTopicContent,
  navigateTargetOf,
  orderChildren,
  renumberChildren,
  resolveKeyMove
} from '@shared/model/editor-ops'
import type { StateCreator } from 'zustand'
import type { EditorState } from './types'

export interface MoveSlice {
  clipboard: Topic | null
  /**
   * 切换**整张画布**的结构。
   *
   * 刻意的签名（没有 targetId）：结构是画布级属性，只住在中心主题上。
   * 以前它接一个可选目标，于是能在分支上写 `structureClass`——布局随即把那一支
   * 交给别的家族排，画面变成"主干对、下面那截乱"。数据字段仍保留（导入的文件里
   * 可能带着它，另存时原样写回），但**不再参与布局**。
   */
  setStructure(structureClass: string): void
  /**
   * 移动主题。
   *
   * 刻意**没有** coalesceKey：移动会重排 children 数组，
   * 而撤销是基于 immer patch 的，数组重排的 patch 带下标——
   * 把连续两步的 inverse 合成一个再套到"后来的状态"上会下标错位、改坏数组
   * （自检里抓到过 `["甲","乙","甲"]` 这种结果）。
   * 合并只对「替换某个值」类操作安全：折叠、调色、拉伸尺寸。
   */
  moveNode(id: string, targetId: string, index?: number): boolean
  /**
   * 批量移动（AI 的 `moveTopics` 工具走这里）：一次写入落完，返回**实际成功**的条目。
   *
   * 逐条调 `moveNode` 终态相同，但每条都要跑一次 `settleAfterMove` → `pruneOverlays`
   * 的**全树扫描**——一次最多 200 条就是 200 遍全树（O(k×N)），
   * 正是「AI 批量整理大导图」时的固定放大器。
   */
  moveNodes(moves: Array<{ id: string; targetId: string; index: number | null }>): Array<{
    id: string
    targetId: string
  }>
  /**
   * 同级排序（AI 的 `sortSiblings` 走这里）：按给定顺序重排某个主题的子主题。
   * `renumber` 为真时顺便加「1. 2. 」编号（先去掉旧编号，避免「1. 1. xxx」）。
   */
  sortChildren(parentId: string, orderedIds: string[], renumber: boolean): void
  /**
   * 合并同名主题（AI 的 `mergeDuplicates` 走这里）。
   *
   * 每组保留 keepId，把 mergeIds 的**子主题搬过来、缺的备注/代码/公式/标签/标记补上**，
   * 然后删掉那些多余节点。整批算**一步撤销**（`mutate` 一次）。
   */
  mergeTopics(groups: Array<{ keepId: string; mergeIds: string[] }>): number
  /**
   * 用快捷键微调选中主题（与亿图脑图一致，适合结构复杂时精确挪动）：
   * - `↑` / `↓`：在同级里上移 / 下移一位
   * - `Home` / `End`：移到同级的最前 / 最后
   * - `←`：升级，成为父级的后一个兄弟
   * - `→`：降级，成为前一个兄弟的最后一个子主题
   */
  moveSelectionByKey(
    key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'
  ): boolean
  /**
   * 按方向键在主题之间移动**选择**（← 父级、→ 第一个子级、↑↓ 同级）。
   *
   * 抽到 store 里是因为**编辑态**也要用它：刚建出来的空主题里按方向键，
   * 应当退出编辑并移到相邻主题，而不是把光标在一个空格子里挪来挪去（看起来像"方向键失灵"）。
   * 另外它有兜底：选择指向已不存在的主题时自动回到根，键盘永远不会"死掉"。
   */
  navigateSelection(key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'): void
  /**
   * 拖拽节点释放。落点一律由 `resolveDrop` 裁决（在 shared/model/drop 里，
   * 与画布上的落点预览共用同一套规则）：
   * - `child` → 成为目标的**最后一个子主题**；
   * - `before` / `after` → 插到目标**前面 / 后面**、与它同级；
   * - 落点非法（自己 / 自己的后代 / 原地不动）→ 返回 false，不做改动。
   * 因为判定只看"目标是谁 + 指针在它的哪个分区"，所以**任意两个节点之间**都能拖。
   */
  dropNode(id: string, targetId: string, mode: DropMode): boolean
  offsetPosition(id: string, dx: number, dy: number): void
  /**
   * 一次写完多个主题的自由位置（多选拖拽用）。
   * 走一次 mutate，所以整群移动在撤销里是**一步**，而不是一堆零碎记录。
   */
  offsetPositions(moves: Array<{ id: string; dx: number; dy: number }>): void
  /**
   * 恢复自动布局：把**选中的自由摆放主题**放回自动位置；选中里没有这样的主题就整张画布一起恢复。
   * 返回实际恢复的个数（0 = 没什么可恢复）。
   *
   * 为什么只留一个入口：以前「选中」「全部」各有按钮、菜单里还各有一条名字几乎一样的项
   * （三个入口、两种实现，其中两个完全相同），用户面对的是"我该点哪个"。
   * 现在范围交给选择决定、结果用提示条说清：想只恢复一个，先选中它。
   */
  restoreAutoLayout(): number
  copySelection(): void
  paste(): void
}

export const createMoveSlice: StateCreator<EditorState, [], [], MoveSlice> = (set, get) => ({
  clipboard: null,

  /* ------------------------------------------------------------------ */
  /* 结构操作（后半）                                                           */
  /* ------------------------------------------------------------------ */

  moveSelectionByKey: (key) => {
    const state = get()
    const id = state.selection[0]
    if (!id) return false
    const root = activeRoot(state.workbook)
    const plan = resolveKeyMove(root, id, key)
    if (!plan) return false

    // 每次按键各记一步撤销，**刻意不合并**：移动是数组重排，
    // 合并两步的 inverse 会因为下标错位而改坏 children（见 moveNode 的说明）。
    return state.moveNode(id, plan.targetId, plan.index)
  },

  navigateSelection: (key) => {
    const state = get()
    const root = activeRoot(state.workbook)
    const selectedId = state.selection[0]
    const selected = selectedId ? findTopic(root, selectedId) : null
    // 选择可能已经失效（比如它刚被删掉、或撤销回到了另一个版本）→ 先把选择收回根，
    // 保证"键盘永远可用"，不再出现按了没反应、只能拿鼠标点一下的死状态。
    if (selectedId && !selected) set({ selection: [root.id] })
    const currentId = selected ? selected.id : root.id

    const target = navigateTargetOf(root, currentId, key)
    if (target) set({ selection: [target] })
  },

  setStructure: (structureClass) => {
    const root = activeRoot(get().workbook)
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), root.id)
      if (topic) topic.structureClass = structureClass
    }, '切换结构')
  },

  moveNode: (id, targetId, index) => {
    const root = activeRoot(get().workbook)
    if (id === root.id) return false
    if (isSelfOrDescendant(root, id, targetId)) return false
    const parent = findParent(root, id)
    // 同父级且没给插入位置 → 等于原地不动，直接忽略（避免产生空的撤销记录）。
    // 给了 index 才是「同级排序」，那是允许的。
    if (parent && parent.id === targetId && index === undefined) return false
    let ok = false
    get().mutate((draft) => {
      ok = moveTopic(activeRoot(draft), id, targetId, index)
      if (ok) settleAfterMove(draft, id)
    }, '移动主题')
    if (ok) set({ selection: [id] })
    return ok
  },

  moveNodes: (moves) => {
    const applied: Array<{ id: string; targetId: string }> = []
    get().mutate((draft) => {
      const draftRoot = activeRoot(draft)
      for (const move of moves) {
        // 与 moveNode 逐条调用时的准入规则完全一致，只是不再每条都清一遍覆盖层
        if (move.id === draftRoot.id) continue
        if (isSelfOrDescendant(draftRoot, move.id, move.targetId)) continue
        const parent = findParent(draftRoot, move.id)
        // 同父级、又没给插入位置 → 等于原地不动（与 moveNode 的规则一致）
        if (parent && parent.id === move.targetId && move.index === null) continue
        if (!moveTopic(draftRoot, move.id, move.targetId, move.index ?? undefined)) continue
        // 必须清掉自由摆放偏移：留着它节点会落在「自动位置 + 偏移」，
        // 看起来像「落点预览在这里、松手却跑到别处」（与 settleAfterMove 同理）
        const moved = findTopic(draftRoot, move.id)
        if (moved) moved.position = undefined
        applied.push({ id: move.id, targetId: move.targetId })
      }
      // 失效覆盖层只在这里清一次：pruneOverlays 只看最终树、结果幂等，
      // 所以终态与「每条都清一遍」等价，成本从 O(k×N) 降到 O(N + k)
      if (applied.length > 0) pruneOverlays(activeSheet(draft))
    }, '批量移动主题')
    // 逐条调用时每次都会把选中设成刚移动的那个，这里保留同一语义：落到最后一个成功的
    const last = applied[applied.length - 1]
    if (last) set({ selection: [last.id] })
    return applied
  },

  sortChildren: (parentId, orderedIds, renumber) => {
    get().mutate(
      (draft) => {
        const parent = findTopic(activeRoot(draft), parentId)
        if (!parent) return
        // 只按给定顺序排**还在的**子主题；没给到的（模型看不到的）保持原相对顺序、排在最后
        const ordered = orderChildren(parent.children, orderedIds)
        parent.children = ordered
        if (!renumber) return
        renumberChildren(ordered)
      },
      renumber ? '同级排序并编号' : '同级排序'
    )
  },

  mergeTopics: (groups) => {
    let merged = 0
    get().mutate((draft) => {
      const draftRoot = activeRoot(draft)
      for (const group of groups) {
        const keep = findTopic(draftRoot, group.keepId)
        if (!keep) continue
        for (const mergeId of group.mergeIds) {
          const loser = findTopic(draftRoot, mergeId)
          if (!loser || loser.id === keep.id) continue
          // 互为祖先时跳过（规划阶段已拦一道，这里是执行侧的最后一道）
          if (
            isSelfOrDescendant(draftRoot, keep.id, loser.id) ||
            isSelfOrDescendant(draftRoot, loser.id, keep.id)
          ) {
            continue
          }
          // 内容并入：保留方缺什么补什么（不覆盖它已有的内容）
          mergeTopicContent(keep, loser)

          // 子主题原样搬到保留方下面
          for (const child of [...loser.children]) {
            if (!moveTopic(draftRoot, child.id, keep.id, keep.children.length)) continue
            // 清掉自由摆放偏移：留着会落到"自动位置 + 偏移"的地方，看着像搬丢了
            const placed = findTopic(draftRoot, child.id)
            if (placed) placed.position = undefined
          }
          detachTopic(draftRoot, loser.id)
          merged += 1
        }
      }
      // 被删掉的主题可能挂着关系线/边界/概要：一并清掉悬空元素
      if (merged > 0) pruneOverlays(activeSheet(draft))
    }, '合并同名主题')
    return merged
  },

  dropNode: (id, targetId, mode) => {
    const root = activeRoot(get().workbook)
    // 与画布上的落点预览共用同一套裁决规则，避免"预览说这样、落下去却那样"
    const plan = resolveDrop(root, id, targetId, mode)
    if (!plan) return false

    if (plan.mode === 'child') {
      // 落进折叠的目标时顺手展开它，并和移动**合并成同一笔**：
      // 否则新加的子主题被藏起来看不见，而分成两笔又会让撤销要按两次。
      const ok = get().mutate((draft) => {
        const target = findTopic(activeRoot(draft), plan.targetId)
        if (target) ensureExpanded(target)
        moveTopic(activeRoot(draft), id, plan.targetId)
        settleAfterMove(draft, id)
      }, '移动主题')
      if (ok) set({ selection: [id] })
      return ok
    }

    // 同级插入：下标必须在「先把自己摘掉」的数组上算——
    // moveTopic 是先摘后插，若自己原本排在目标之前，用摘除前的下标
    // 插入会整体前移一位、落到错误的位置。
    const parent = findTopic(root, plan.parentId)
    if (!parent) return false
    const rest = parent.children.filter((child) => child.id !== id)
    const at = rest.findIndex((child) => child.id === targetId)
    if (at < 0) return false
    return get().moveNode(id, plan.parentId, plan.mode === 'before' ? at : at + 1)
  },

  offsetPosition: (id, dx, dy) => {
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      const base = topic.position ?? { x: 0, y: 0 }
      topic.position = { x: base.x + dx, y: base.y + dy }
    }, '移动位置')
  },

  offsetPositions: (moves) => {
    if (moves.length === 0) return
    get().mutate((draft) => {
      const root = activeRoot(draft)
      for (const move of moves) {
        const topic = findTopic(root, move.id)
        if (!topic) continue
        const base = topic.position ?? { x: 0, y: 0 }
        topic.position = { x: base.x + move.dx, y: base.y + move.dy }
      }
    }, '移动位置')
  },

  restoreAutoLayout: () => {
    const state = get()
    const root = activeRoot(state.workbook)
    /**
     * 独立主题子树不参与自动布局，也不该被「恢复自动布局」清掉 position：
     * 它们的位置是用户在画布上摆的，不是树里那种"自动位置 + 偏移"。
     */
    const detachedIds = new Set(
      root.detachedChildren.flatMap((topic) => subtreeIds(root, topic.id))
    )
    const floating = flatten(root).filter(
      (topic) => topic.position !== undefined && !detachedIds.has(topic.id)
    )
    if (floating.length === 0) return 0

    /**
     * 范围规则：**选中里只要有自由摆放的主题，就只恢复这些**；否则整张画布一起恢复。
     *
     * 宁可这样也不做两个入口——只有一个按钮时，用户不会在"选中 vs 全部"之间猜；
     * 而"想只恢复一个"这件事本身就已经在手上有选择了，直接用它最自然。
     */
    const selected = state.selection.filter((id) => {
      const topic = findTopic(root, id)
      return topic !== null && topic.position !== undefined && !detachedIds.has(id)
    })
    const targets = selected.length > 0 ? selected : floating.map((topic) => topic.id)
    const scope = new Set(targets)

    get().mutate((draft) => {
      for (const topic of flatten(activeRoot(draft))) {
        if (scope.has(topic.id)) topic.position = undefined
      }
    }, '恢复自动布局')
    return targets.length
  },

  copySelection: () => {
    const { selection, workbook } = get()
    const root = activeRoot(workbook)
    const id = selection[0]
    if (!id) return
    const topic = findTopic(root, id)
    if (!topic) return
    set({ clipboard: cloneTopicDeep(topic) })
  },

  paste: () => {
    const { clipboard, selection, workbook } = get()
    if (!clipboard) return
    const root = activeRoot(workbook)
    const targetId = selection[0] ?? root.id
    const copy = cloneTopicDeep(clipboard)
    get().mutate((draft) => {
      const target = findTopic(activeRoot(draft), targetId) ?? activeRoot(draft)
      target.children.push(copy)
      ensureExpanded(target)
    }, '粘贴主题')
    set({ selection: [copy.id] })
  }
})
