/**
 * 结构切片（「结构操作」分节的**前半**，成员体逐字未改）：节点增删、标题/富文本、折叠与侧向、尺寸覆盖。
 *
 * 「结构操作」分节原本 559 行 > DoD 的 400 行，按**成员自然断层**拆成两个切片：
 * 前半＝「建/删/改一个节点自己」（本文件），后半＝「动它在树里的位置与布局」(`move.ts`)。
 * 两半都只经 `get().mutate(...)` 写文档，互相之间没有共享的局部状态。
 *
 * 本文件同时拥有这些成员在 `EditorState` 里的**声明**（接口逐字搬来）。
 */

import type { RichText } from '@shared/model/types'
import { createTopic } from '@shared/model/factory'
import { hasFormatting, normalizeRich, plainTextOf, richFromPlain } from '@shared/richtext'

import { BLOCK_GAP, codeMinNodeSize } from '@shared/layout/accessory'
import type { Size } from '@shared/layout/types'
import { NODE_FONT_SIZES, nodePaddingOf } from '../../render/measure'
import { formulaSize } from '../../render/formula'
import {
  activeRoot,
  activeSheet,
  allChildrenOf,
  detachTopic,
  ensureExpanded,
  findParent,
  findTopic,
  childFoldSides,
  foldedSidesOf,
  isSelfOrDescendant,
  splitFoldSidesOf,
  withFoldedSides,
  type FoldSide
} from '@shared/model/tree'
import { TOPIC_SIDE_KEY } from '@shared/xmind/constants'
import { editingContent, pruneOverlays, stampNodeDefaults } from '@shared/model/editor-pure'
import {
  clampSizeToContent,
  normalizeSizeOverride,
  selectionAfterDelete
} from '@shared/model/editor-ops'
import type { StateCreator } from 'zustand'
import type { EditorState } from './types'
import { NO_EDITING } from './types'

export interface StructureSlice {
  /* ---- 结构操作 ---- */
  addChild(parentId?: string): string
  addSibling(id?: string): string
  deleteSelection(): void
  /**
   * 删除指定主题（连同子树）。
   *
   * AI 写工具用：`deleteSelection` 是给键盘操作的，会连带改用户的选择；
   * AI 不该有这种副作用，所以按 id 删、只在必要时把选择挪到父级。
   */
  deleteTopic(id: string): boolean
  setTitle(id: string, title: string): void
  setRichText(id: string, rich: RichText | null): void
  toggleCollapse(id: string): void
  /**
   * 直接指定折叠状态。拖拽时用它把落点那个折叠着的主题**展开**——
   * 不展开就看不见新子主题会落在哪，落点预览成了空谈。
   */
  setCollapsed(id: string, collapsed: boolean): void
  /**
   * 平衡思维导图的中心主题：**按侧收起 / 展开**（左右分开收）。
   *
   * 只在「中心主题 + 平衡结构 + 该侧确实挂着分支」时生效；
   * 一般主题的收起走 `toggleCollapse`（那里是整体收起）。
   *
   * 刻意做成**设置值**而不是开关（与 `setCollapsed` 同一口径）：AI 重试一次
   * 不会把刚收起来的那一侧又翻回去。
   */
  setFoldSide(id: string, side: FoldSide, folded: boolean): void
  /** 界面上点徽标用：切换某一侧的收起状态（转发到 `setFoldSide`） */
  toggleFoldSide(id: string, side: FoldSide): void
  /**
   * 把一级主题对调到中心主题的另一侧（知犀 / Xmind 的「左右位置调整」）。
   * 平衡结构默认按顺序交替分配左右，这里写入的是显式覆盖。
   */
  setTopicSide(id: string, side: 'left' | 'right'): void
  /** 手动拉伸节点尺寸；传 null 恢复自动尺寸（拖拽过程中会合并成一步撤销） */
  setSizeOverride(id: string, size: { width: number; height: number } | null): void
}

export const createStructureSlice: StateCreator<EditorState, [], [], StructureSlice> = (
  set,
  get
) => ({
  /* ------------------------------------------------------------------ */
  /* 结构操作                                                            */
  /* ------------------------------------------------------------------ */

  addChild: (parentId) => {
    const { workbook, selection } = get()
    const root = activeRoot(workbook)
    const baseId = parentId ?? selection[0] ?? root.id
    const parent = findTopic(root, baseId) ?? root
    const node = createTopic('')
    stampNodeDefaults(node, get().appSettings)
    get().mutate((draft) => {
      const target = findTopic(activeRoot(draft), parent.id) ?? activeRoot(draft)
      target.children.push(node)
      // 只在确实折叠着时才改：避免写入多余的 collapsed: false，
      // 否则「打开 → 另存」会因为默认值产生结构性差异
      ensureExpanded(target)
    }, '新建子主题')
    set({ selection: [node.id], editingId: node.id, ...editingContent(richFromPlain('')) })
    return node.id
  },

  addSibling: (id) => {
    const { workbook, selection } = get()
    const root = activeRoot(workbook)
    const baseId = id ?? selection[0]
    if (!baseId || baseId === root.id) return get().addChild(root.id)
    const parent = findParent(root, baseId)
    if (!parent) return get().addChild(root.id)
    const index = parent.children.findIndex((c) => c.id === baseId)
    const node = createTopic('')
    stampNodeDefaults(node, get().appSettings)
    get().mutate((draft) => {
      const draftParent = findTopic(activeRoot(draft), parent.id)
      if (!draftParent) return
      draftParent.children.splice(index < 0 ? draftParent.children.length : index + 1, 0, node)
    }, '新建同级主题')
    set({ selection: [node.id], editingId: node.id, ...editingContent(richFromPlain('')) })
    return node.id
  },

  deleteSelection: () => {
    // 选中的是画布元素（概要 / 边界 / 关系线）时，Delete 删的是它而不是主题
    const overlay = get().selectedOverlay
    if (overlay) {
      const state = get()
      if (overlay.kind === 'summary') state.removeSummary(overlay.id)
      else if (overlay.kind === 'boundary') state.removeBoundary(overlay.id)
      else state.removeRelationship(overlay.id)
      set({ selectedOverlay: null })
      return
    }

    const { workbook, selection } = get()
    const root = activeRoot(workbook)
    const targets = selection.filter((id) => id !== root.id && findTopic(root, id))
    if (targets.length === 0) return

    // 删完必须把选择落到一个**还存在**的主题上：否则选择指向"空"，
    // 方向键、Delete、Tab/Enter 全都失灵，用户只能先拿鼠标点一下才能继续用键盘
    // （这就是反馈里的「删除节点后选择失效，必须鼠标点击才能生效」）。
    // 落点顺序：原位置**之后**的下一个未删除兄弟 → **之前**的上一个 → 父级。
    const first = targets[0]
    if (!first) return
    const nextIds = selectionAfterDelete(root, first, targets)

    get().mutate((draft) => {
      const draftRoot = activeRoot(draft)
      for (const id of targets) detachTopic(draftRoot, id)
      // 指向已删除主题的关系线/边界/概要会变成悬空元素，必须一起清掉
      pruneOverlays(activeSheet(draft))
    }, '删除主题')
    set({
      selection: nextIds,
      ...NO_EDITING
    })
  },

  deleteTopic: (id) => {
    const { workbook } = get()
    const root = activeRoot(workbook)
    if (id === root.id || !findTopic(root, id)) return false

    const parent = findParent(root, id)
    // 真正能摘下来才动手：以前这里不检查，`detachTopic` 找不到（自由摆放的主题）
    // 也会走完整个流程并 `return true`——界面报"已删除"，树却没变
    const removable = parent !== null && allChildrenOf(parent).some((child) => child.id === id)
    if (!removable) return false

    get().mutate((draft) => {
      const draftRoot = activeRoot(draft)
      detachTopic(draftRoot, id)
      // 指向已删除主题的关系线/边界/概要会变成悬空元素，必须一起清掉
      pruneOverlays(activeSheet(draft))
    }, '删除主题')

    // 选择落在**被删节点的父级**上（不是随便挑一个），用户不会觉得焦点丢了；
    // 原本还选着的其它节点仍然保留
    const stillThere = get().selection.filter(
      (item) => item !== id && findTopic(activeRoot(get().workbook), item) !== null
    )
    set({
      selection: stillThere.length > 0 ? stillThere : parent ? [parent.id] : [],
      ...NO_EDITING
    })
    return true
  },

  setTitle: (id, title) => {
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (topic) {
        topic.title = title
        topic.titleRich = undefined
      }
    }, '修改文本')
  },

  setRichText: (id, rich) => {
    const normalized = rich ? normalizeRich(rich) : null
    const keep = normalized && hasFormatting(normalized) ? normalized : null
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      topic.titleRich = keep ?? undefined
      if (keep) topic.title = plainTextOf(keep)
    }, '修改格式')
  },

  toggleCollapse: (id) => {
    const topic = findTopic(activeRoot(get().workbook), id)
    if (!topic || topic.children.length === 0) return
    /**
     * 「**按侧收起**」也算折叠着：大纲那一行会显示成「展开」按钮（`outlineRows` 的
     * `collapsed` 判据是"有子节点但不是全部可见"），画布上 `Ctrl+/` 也是同一个入口。
     * 此时按一下必须**展开**（把按侧标记清掉），否则就是"提示写展开、点下去把两侧都收起来"——
     * 动作与提示相反，比不做还糟（真踩过）。
     */
    const folded = foldedSidesOf(topic)
    if (folded.length > 0 && !topic.collapsed) {
      get().setCollapsed(id, false)
      return
    }
    /**
     * 只有「**超过 1 个子主题**」才允许折叠（与 `TopicNode` 的徽标显示同一条规则）：
     * 只有一个子节点时折叠没有信息量，而且界面上已经不显示折叠徽标——
     * 这里不守卫的话，键盘（Ctrl + /）或 AI 仍能把折叠状态写进去，
     * 用户就会遇到"看不见任何徽标、图却少了一截"的怪状态。
     * 已折叠的主题总是可以展开（不然一个子节点的折叠状态就永远打不开了）。
     */
    if (!topic.collapsed && topic.children.length < 2) return
    get().setCollapsed(id, !topic.collapsed)
  },

  setCollapsed: (id, collapsed) => {
    const before = get()
    get().mutate(
      (draft) => {
        const topic = findTopic(activeRoot(draft), id)
        if (!topic || topic.children.length === 0) return
        // 用 undefined 表示展开，让模型中只存在「折叠 / 未设置」两种状态
        const next = collapsed ? true : undefined
        const hadFolded = foldedSidesOf(topic).length > 0
        // 按侧收起也算「折叠着」：只有它存在时，展开同样要落一步（否则点了没反应）
        if (topic.collapsed === next && !hadFolded) return
        topic.collapsed = next
        /**
         * 「整体折叠」与「按侧收起」互斥：两者的模型标记各存一处，
         * 不同时清掉就会出现「整体展开了、某一侧却还收着」这种读不懂的状态。
         */
        if (hadFolded) withFoldedSides(topic, [])
      },
      '折叠/展开',
      // 同一个主题、同一个方向的连续折叠（例如连按空格）合并成一步；
      // 方向一变就是新的一步——否则「折叠又展开」会被并成一次空操作，撤销看起来没反应
      `collapse:${id}:${collapsed ? 'fold' : 'unfold'}`
    )

    // 记下"刚折叠/展开的是谁"：画布拿它当镜头锚点（见 lastFold 的说明）
    set({ lastFold: { id, at: Date.now() } })

    // 折叠会把整棵子树**藏起来**：选中的主题若正在里面，它就从布局里消失了——
    // 视角锁定再也盯不到它，用户看到的是「锁定突然失效、画面不跟了」。
    // 把选择挪到折叠节点自己身上：既看得见，锁定也能继续跟。
    if (collapsed) {
      const root = activeRoot(before.workbook)
      if (before.selection.some((sel) => sel !== id && isSelfOrDescendant(root, id, sel))) {
        get().select(id)
      }
    }
  },

  setFoldSide: (id, side, folded) => {
    const before = get()
    get().mutate(
      (draft) => {
        const root = activeRoot(draft)
        const topic = findTopic(root, id)
        if (!topic) return
        // 只对「中心主题 + 两个方向都真的挂着分支」的结构生效（与 TopicNode 的多根徽标同一判据）
        if (splitFoldSidesOf(topic, topic.id === root.id).length < 2) return
        if (![...childFoldSides(topic).values()].includes(side)) return
        const current = foldedSidesOf(topic)
        // 已经是这个状态就什么都不写：AI 重试 / 重复点击不该产生撤销记录
        if (current.includes(side) === folded) return
        // 切到按侧收起模式：整体折叠标记要先清掉，否则整体折叠优先、这一侧点了没反应
        if (topic.collapsed) topic.collapsed = undefined
        const next: FoldSide[] = folded
          ? [...current, side]
          : current.filter((item) => item !== side)
        withFoldedSides(topic, next)
      },
      '折叠/展开',
      // 同一侧同一方向连续操作合并成一步；**方向或侧别一变就是新的一步**——
      // 否则「收起又展开」会被并成一次空操作，撤销看起来没反应（与 setCollapsed 同一套口径）
      `fold:${id}:${side}:${folded ? 'fold' : 'unfold'}`
    )

    // 与 setCollapsed 同一处理：刚折叠/展开的是谁，交给画布做镜头锚点
    set({ lastFold: { id, at: Date.now() } })

    /**
     * 收起后，落在这一侧的选中主题已经从布局里消失——视角锁定再也盯不到它。
     * 与整体折叠同一处理：把选择挪到中心主题身上（它一定看得见）。
     */
    const after = findTopic(activeRoot(get().workbook), id)
    if (!after || !foldedSidesOf(after).includes(side)) return
    const sides = childFoldSides(after)
    const hidden = after.children.filter((child) => sides.get(child.id) === side)
    const root = activeRoot(before.workbook)
    if (
      before.selection.some((sel) =>
        hidden.some((child) => isSelfOrDescendant(root, child.id, sel))
      )
    ) {
      get().select(id)
    }
  },

  toggleFoldSide: (id, side) => {
    const topic = findTopic(activeRoot(get().workbook), id)
    if (!topic) return
    get().setFoldSide(id, side, !foldedSidesOf(topic).includes(side))
  },

  setTopicSide: (id, side) => {
    get().mutate((draft) => {
      const root = activeRoot(draft)
      const topic = findTopic(root, id)
      if (!topic) return
      const properties: Record<string, string> = { ...(topic.style?.properties ?? {}) }
      const moved = properties[TOPIC_SIDE_KEY] !== side
      if (moved) {
        properties[TOPIC_SIDE_KEY] = side
        topic.style = { ...(topic.style ?? {}), properties }
      }
      /**
       * 拖到的那一侧如果正**收起着**，这个分支会当场消失（看着像把数据弄丢了）——
       * 刚挪过去的东西必须看得见，所以顺手把那一侧展开。
       * 与「新建子主题时自动展开」是同一条规矩。
       */
      if (!moved) return
      const parent = findParent(root, id)
      if (!parent) return
      const folded = foldedSidesOf(parent)
      if (folded.includes(side))
        withFoldedSides(
          parent,
          folded.filter((item) => item !== side)
        )
    }, '调整分支左右')
  },

  setSizeOverride: (id, size) => {
    const next = normalizeSizeOverride(size)
    get().mutate(
      (draft) => {
        const root = activeRoot(draft)
        const topic = findTopic(root, id)
        if (!topic) return
        if (!next) {
          if (topic.sizeOverride === undefined) return
          topic.sizeOverride = undefined
          return
        }
        // 兜底：框不能小于内容。代码块最小只能缩到缩放下限、公式是整块原子，
        // 任一方都按「内容尺寸 + 内边距」夹一下（渲染层的拉伸手柄也夹，双保险）
        let depth = 0
        let cursor = topic
        while (cursor) {
          const parent = findParent(root, cursor.id)
          if (!parent) break
          depth += 1
          cursor = parent
        }
        const padding = nodePaddingOf(depth)
        // 下标已经 clamp 在数组范围内
        const fontSize = NODE_FONT_SIZES[Math.min(depth, NODE_FONT_SIZES.length - 1)]!
        const mins: Size[] = []
        const codeMin = codeMinNodeSize(topic.code, padding)
        if (codeMin) mins.push(codeMin)
        // 公式块：宽度 = 公式宽 + 内边距；高度 = 公式高 + 一行标题 + 间隔 + 内边距
        // （这里拿不到排版行高，用 1.6 倍字号近似——渲染层手柄才是精确钳制，这里只防历史遗留的过小值）
        if (topic.formula) {
          const box = formulaSize(topic.formula, fontSize)
          mins.push({
            width: box.width + padding.x * 2,
            height: box.height + Math.round(fontSize * 1.6) + BLOCK_GAP + padding.y * 2
          })
        }
        const clamped = clampSizeToContent(next, mins)
        if (
          topic.sizeOverride?.width === clamped.width &&
          topic.sizeOverride?.height === clamped.height
        )
          return
        topic.sizeOverride = clamped
      },
      next ? '拉伸节点' : '恢复节点自动尺寸',
      // 拖动过程中每帧都写，合并成一步撤销
      next ? `size:${id}` : undefined
    )
  }
})
