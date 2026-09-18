/**
 * 布局内核：摆放阶段的构建器（LayoutBuilder）。
 *
 * 约定：布局算法分两个阶段
 *   1. 摆放（place）：只确定每个节点的 x / y —— 本文件；
 *   2. 连线（connect）：坐标归一化之后，用最终坐标生成连线与装饰 —— core/connect.ts。
 *
 * 这样拆分的原因是连线是 SVG path 字符串，无法随坐标平移，
 * 必须在最终坐标确定后再生成，才能避免反复换算偏移量。
 *
 * 缓存策略见 core/cache.ts，几何原语见 core/geometry.ts。
 * 三者在本文件统一再导出，所以历史调用点（from './core'）无需改动。
 */
import type { StructureClass, Topic } from '../model/types'
// 别名：类里也有个同名方法（它只是转发到这个纯函数），不加别名读起来像递归
import { allChildrenOf, visibleChildren as visibleChildrenOf } from '../model/tree'
import { DEFAULT_STRUCTURE, getStructureDef } from '../xmind/constants'
import { mix, subtreeStamp } from './stamp'
import {
  activeRuntimeOf,
  emptyLayoutStats,
  type LayoutStats,
  setActiveRuntime,
  type LayoutMemo,
  type LayoutRuntime,
  type MemoEntry
} from './core/cache'
import { round } from './core/geometry'
import type {
  LayoutBounds,
  LayoutResult,
  MeasureFn,
  MeasureResult,
  NodeLayout,
  Side
} from './types'

export const LAYOUT_DEFAULTS = { gapX: 56, gapY: 18, padding: 60 }

export * from './core/cache'
export * from './core/geometry'
export * from './core/connect'

/* ------------------------------------------------------------------ */
/* 布局构建器                                                          */
/* ------------------------------------------------------------------ */

export class LayoutBuilder {
  readonly nodes: NodeLayout[] = []
  readonly nodeMap = new Map<string, NodeLayout>()
  /** 复用计数：不给 memo 时也照样统计（自检与诊断用） */
  readonly stats: LayoutStats
  /** 本轮所有节点最终几何的混合值（连线与装饰的复用判据之一） */
  geometryHash = 0

  private readonly sizes = new Map<string, MeasureResult>()
  private readonly finishHooks: Array<(result: LayoutResult) => void> = []

  constructor(
    private readonly measure: MeasureFn,
    readonly gapX: number = LAYOUT_DEFAULTS.gapX,
    readonly gapY: number = LAYOUT_DEFAULTS.gapY,
    readonly padding: number = LAYOUT_DEFAULTS.padding,
    /** 增量布局的跨轮缓存；不传就是纯全量布局（行为与以前完全一致） */
    readonly memo?: LayoutMemo,
    /**
     * 本轮「可能有变化」的子树根（见 `incremental.ts`）。
     *
     * 不在这个集合里的子树**整棵都没动**：测量结果、子树占用现在就能从
     * `memo` 里直接取，不必再递归一遍。全量布局不传它 → 每棵子树都走一遍。
     */
    private readonly touched?: ReadonlySet<string>
  ) {
    /**
     * 复用计数**每轮清零**：它回答的是"这一轮省了多少活"，
     * 累加的话"第一轮全量 + 第二轮增量"会读起来像"增量也把整棵树跑了一遍"。
     */
    if (memo) memo.stats = emptyLayoutStats()
    this.stats = memo?.stats ?? emptyLayoutStats()
  }

  /** 这一棵子树本轮是不是可以整体沿用上一轮的结果 */
  private isClean(topic: Topic): boolean {
    return this.touched !== undefined && !this.touched.has(topic.id)
  }

  private stampOf(topic: Topic): number {
    return this.memo?.stamps.get(topic.id) ?? 0
  }

  /**
   * 测量全树（增量时只走"可能有变化"的那部分）。
   *
   * 顺带把子树戳算出来：戳是后面所有复用（子树占用、连线、节点对象）的凭据，
   * 而它必须**自底向上**算（子节点戳参与了父节点戳），所以放在这里最省一趟遍历。
   */
  measureAll(root: Topic): void {
    const walk = (topic: Topic, depth: number): void => {
      // 整棵子树没动：尺寸与戳都还是上一轮的，直接返回
      if (this.isClean(topic)) {
        this.stats.measuresReused += 1
        return
      }
      const seeded = this.sizes.get(topic.id)
      if (seeded) {
        // 增量层已经量过它了：顺手把测量缓存也刷新，下一轮还能命中
        this.memo?.measures.set(topic.id, { topic, depth, value: seeded })
      } else {
        const memoized = this.memo?.measures.get(topic.id)
        if (memoized && memoized.topic === topic && memoized.depth === depth) {
          this.sizes.set(topic.id, memoized.value)
          this.stats.measuresReused += 1
        } else {
          this.stats.measureCalls += 1
          const value = this.measure(topic, depth)
          this.sizes.set(topic.id, value)
          this.memo?.measures.set(topic.id, { topic, depth, value })
        }
      }
      const childStamps: number[] = []
      for (const child of topic.children) {
        walk(child, depth + 1)
        childStamps.push(this.stampOf(child))
      }
      const own = this.sizes.get(topic.id) ?? this.memo?.measures.get(topic.id)?.value
      this.memo?.stamps.set(
        topic.id,
        subtreeStamp({
          topic,
          width: own?.width ?? 0,
          height: own?.height ?? 0,
          childStamps,
          reserves: [
            this.reserveTop(topic),
            this.reserveBottom(topic),
            this.reserveLeft(topic),
            this.reserveRight(topic)
          ],
          cls: topic.structureClass
        })
      )
    }
    walk(root, 0)
  }

  /** 直接塞进已经算好的测量结果（增量层在变更检测阶段已经量过一遍了） */
  seedMeasures(sizes: ReadonlyMap<string, MeasureResult>): void {
    for (const [id, size] of sizes) this.sizes.set(id, size)
  }

  size(id: string): MeasureResult {
    const size = this.sizes.get(id) ?? this.memo?.measures.get(id)?.value
    if (!size) throw new Error(`布局：节点 ${id} 尚未测量`)
    return size
  }

  add(topic: Topic, x: number, y: number, depth: number, side: Side): NodeLayout {
    const size = this.size(topic.id)
    const node: NodeLayout = {
      id: topic.id,
      topic,
      x: round(x),
      y: round(y),
      width: size.width,
      height: size.height,
      depth,
      side,
      lines: size.lines,
      fontSize: size.fontSize,
      lineHeight: size.lineHeight,
      paddingX: size.paddingX,
      paddingY: size.paddingY,
      accessory: size.accessory,
      labelRow: size.labelRow,
      imageBox: size.imageBox,
      formulaBox: size.formulaBox,
      codeBox: size.codeBox,
      codeMetrics: size.codeMetrics,
      markerStrip: size.markerStrip
    }
    this.nodes.push(node)
    this.nodeMap.set(topic.id, node)
    return node
  }

  /**
   * 读跨轮缓存：子树戳一致就说明这棵子树和上一轮一模一样，占用不必重算。
   *
   * 返回里带着 `stamp` 与 `ok`，是为了让"未命中"的那条路径能把同一个戳写回去
   * （写回时再取一次戳会拿到同样的值，但多一次 Map 查询没有意义）。
   */
  private memoRead<T>(
    store: Map<string, MemoEntry<T>> | undefined,
    key: string,
    topic: Topic
  ): { hit: boolean; value?: T; stamp: number; ok: boolean } {
    if (!store) return { hit: false, stamp: 0, ok: false }
    const stamp = this.memo?.stamps.get(topic.id)
    if (stamp === undefined) return { hit: false, stamp: 0, ok: false }
    const entry = store.get(key)
    if (entry && entry.stamp === stamp) return { hit: true, value: entry.value, stamp, ok: true }
    return { hit: false, stamp, ok: true }
  }

  private memoWrite<T>(
    store: Map<string, MemoEntry<T>> | undefined,
    key: string,
    read: { stamp: number; ok: boolean },
    value: T
  ): void {
    if (store && read.ok) store.set(key, { stamp: read.stamp, value })
  }

  /** 子树垂直占用的高度（含自身与间距、以及边界/概要的预留） */
  verticalExtent(topic: Topic): number {
    const read = this.memoRead(this.memo?.verticals, topic.id, topic)
    if (read.hit) {
      this.stats.extentsReused += 1
      return read.value as number
    }
    const size = this.size(topic.id)
    const kids = visibleChildrenOf(topic)
    let total = 0
    for (let i = 0; i < kids.length; i += 1) {
      const kid = kids[i]
      if (!kid) continue
      // 预留量要一起往上传播：否则祖先那一层按「没有留白」估槽位，又会压回来
      total +=
        this.verticalExtent(kid) +
        this.reserveTop(kid) +
        this.reserveBottom(kid) +
        (i > 0 ? this.gapY : 0)
    }
    // 自己身上的边界留白也要算进来（纵向列按它排前后两格）
    const own = size.height + this.reserveSpanY(topic)
    const value = Math.max(own, kids.length > 0 ? total : 0)
    this.stats.extentsComputed += 1
    this.memoWrite(this.memo?.verticals, topic.id, read, value)
    return value
  }

  /** 子树水平占用的宽度（含自身与间距） */
  horizontalExtent(topic: Topic): number {
    const read = this.memoRead(this.memo?.horizontals, topic.id, topic)
    if (read.hit) {
      this.stats.extentsReused += 1
      return read.value as number
    }
    const size = this.size(topic.id)
    const kids = visibleChildrenOf(topic)
    let total = 0
    for (let i = 0; i < kids.length; i += 1) {
      const kid = kids[i]
      if (!kid) continue
      total += this.horizontalExtent(kid) + (i > 0 ? this.gapX : 0)
    }
    const value = Math.max(size.width, kids.length > 0 ? total : 0)
    this.stats.extentsComputed += 1
    this.memoWrite(this.memo?.horizontals, topic.id, read, value)
    return value
  }

  visibleChildren(topic: Topic): Topic[] {
    return visibleChildrenOf(topic)
  }

  /**
   * 子树层数：叶子返回 1。
   *
   * 按 id 缓存：鱼骨图与时间轴会对**每个一级分支**问一次（用来定主脊长度），
   * 分支自己又声明同类结构时会层层再问——不缓存就退化成 O(节点数 × 深度)。
   * 只依赖树的形状（`collapsed` 只在跑布局前定好），一次布局里结果恒定；
   * 跨轮也一样（戳里含折叠与子节点戳），所以它能进跨轮缓存。
   */
  maxDepth(topic: Topic): number {
    const read = this.memoRead(this.memo?.depths, topic.id, topic)
    if (read.hit) {
      this.stats.extentsReused += 1
      return read.value as number
    }
    let depth = 0
    for (const child of this.visibleChildren(topic)) {
      depth = Math.max(depth, this.maxDepth(child))
    }
    const value = depth + 1
    this.stats.extentsComputed += 1
    this.memoWrite(this.memo?.depths, topic.id, read, value)
    return value
  }

  /**
   * 直接子节点纵向排列所需的总高度（不含自身）。
   *
   * 含边界/概要在子节点上占用的外侧空间：时间轴（垂直）用它把整列**居中**，
   * 不算预留就会把整列往上偏，留白全堆在下面。
   */
  childrenColumnHeight(topic: Topic): number {
    const kids = this.visibleChildren(topic)
    let total = 0
    for (let i = 0; i < kids.length; i += 1) {
      const kid = kids[i]
      if (!kid) continue
      total +=
        this.size(kid.id).height +
        this.reserveTop(kid) +
        this.reserveBottom(kid) +
        (i > 0 ? this.gapY : 0)
    }
    return total
  }

  /* ---- 边界 / 概要用掉的外侧空间（见 overlays.overlayReserves） ---- */
  private overlayTop = new Map<string, number>()
  private overlayBottom = new Map<string, number>()
  private overlayLeft = new Map<string, number>()
  private overlayRight = new Map<string, number>()

  /**
   * 交给布局一份「哪些主题的外侧要留白」。
   *
   * 边界/概要画在区间外面，以前布局不为此留白 → 紧邻的分支会被标题带或括号压住。
   * 这里把留白量接进摆放算法（与绘制共用同一批常量，所以留白与图形一致）。
   */
  applyOverlayReserves(reserves: {
    top: Map<string, number>
    bottom: Map<string, number>
    left: Map<string, number>
    right: Map<string, number>
  }): void {
    this.overlayTop = reserves.top
    this.overlayBottom = reserves.bottom
    this.overlayLeft = reserves.left
    this.overlayRight = reserves.right
  }

  /** 这个主题上方要为边界标题带留出的高度 */
  reserveTop(topic: Topic): number {
    return this.overlayTop.get(topic.id) ?? 0
  }

  /** 这个主题下方要为边界边框留出的高度 */
  reserveBottom(topic: Topic): number {
    return this.overlayBottom.get(topic.id) ?? 0
  }

  /** 这个主题左侧要为概要括号留出的宽度 */
  reserveLeft(topic: Topic): number {
    return this.overlayLeft.get(topic.id) ?? 0
  }

  /** 这个主题右侧要为概要括号留出的宽度 */
  reserveRight(topic: Topic): number {
    return this.overlayRight.get(topic.id) ?? 0
  }

  /**
   * 这个主题在**横向**上为概要让出的总宽度（左 + 右）。
   *
   * 单方向结构只有一侧非零；平衡思维导图的两侧分支各自让自己那一侧，
   * 但布局按「这一支占多宽」记账，所以取和不会重复计算（同一主题只会有一侧非零）。
   */
  reserveSpanX(topic: Topic): number {
    return this.reserveLeft(topic) + this.reserveRight(topic)
  }

  /** 这个主题在**纵向**上为边界让出的总高度（上 + 下） */
  reserveSpanY(topic: Topic): number {
    return this.reserveTop(topic) + this.reserveBottom(topic)
  }

  /** 注册一个「坐标归一化之后」执行的钩子：嵌套结构的装饰与连线要在最终坐标上补画 */
  onFinish(hook: (result: LayoutResult) => void): void {
    this.finishHooks.push(hook)
  }

  /**
   * 家族感知的子树占用：按**这张画布的结构**计算宽高。
   *
   * 结构是画布级属性（由中心主题决定，见「结构▾」只作用于中心主题），所以占用一律
   * 按 `cls` 算：组织架构图横向铺行、鱼骨图沿主脊展开，不能套用「垂直堆叠」的公式，
   * 否则兄弟分支会互相重叠。
   *
   * @param cls 画布级结构，递归时原样传下去（**不再看子主题自己的 structureClass**）
   */
  subtreeExtent(topic: Topic, cls: StructureClass | undefined): { width: number; height: number } {
    // 键里带上结构：同一棵子树在不同家族下的占用完全不同
    const key = topic.id + '\u0000' + (cls ?? '')
    const read = this.memoRead(this.memo?.extents, key, topic)
    if (read.hit) {
      this.stats.extentsReused += 1
      return read.value as { width: number; height: number }
    }

    const effective = cls ?? DEFAULT_STRUCTURE
    const family = getStructureDef(effective).family
    const size = this.size(topic.id)
    const kids = this.visibleChildren(topic)

    let extent: { width: number; height: number }
    if (kids.length === 0) {
      extent = { width: size.width, height: size.height }
    } else if (family === 'orgchart') {
      // 横向铺行：宽 = 各子树宽之和；高 = 自身 + 一行里最高的子树
      // 边界/概要的预留同样计入：横向上给「右邻居」留出括号，纵向上给整行留出标题带
      let width = 0
      let childHeight = 0
      let topReserve = 0
      let bottomReserve = 0
      kids.forEach((child, index) => {
        width +=
          this.horizontalExtent(child) + this.reserveRight(child) + (index > 0 ? this.gapX : 0)
        childHeight = Math.max(childHeight, this.subtreeExtent(child, effective).height)
        topReserve = Math.max(topReserve, this.reserveTop(child))
        bottomReserve = Math.max(bottomReserve, this.reserveBottom(child))
      })
      extent = {
        width: Math.max(size.width, width),
        height: size.height + this.gapY + topReserve + childHeight + bottomReserve
      }
    } else if (family === 'fishbone') {
      // 沿主脊向右展开：宽 = 自身 + 各分支横向占用；高 = 上下骨刺 + 最深一列
      const boneOffset = Math.max(size.height / 2 + this.gapY * 3, 46)
      let width = size.width + this.gapX * 2
      let columnHeight = 0
      for (const child of kids) {
        width += this.horizontalExtent(child) + this.gapX
        columnHeight = Math.max(columnHeight, this.verticalExtent(child))
      }
      extent = { width, height: size.height + boneOffset * 2 + columnHeight + this.gapY * 2 }
    } else {
      // 垂直堆叠家族（以及暂不支持的家族按逻辑图回落）
      let height = 0
      kids.forEach((child, index) => {
        /**
         * 边界/概要在子节点上下占的空间必须一起算进槽位。
         *
         * `placeVerticalChildren` 摆放时是按「子树占用 + 上下预留」消费槽位的，
         * 这里少算了它，父节点那一层就会按"没有留白"分配高度：
         * 子树整体比槽位高，居中之后多出来的部分顶到下一个兄弟身上
         * （自检当场抓到过：平衡图里 A 支的边界压到 C 支）。
         */
        height +=
          this.subtreeExtent(child, effective).height +
          this.reserveTop(child) +
          this.reserveBottom(child) +
          (index > 0 ? this.gapY : 0)
      })
      // 宽度带上概要留白：树状表格/矩阵这类「按列排布」的嵌套结构靠它把列拉开
      extent = {
        width: size.width + this.reserveSpanX(topic),
        height: Math.max(size.height, height)
      }
    }

    this.stats.extentsComputed += 1
    this.memoWrite(this.memo?.extents, key, read, extent)
    return extent
  }

  /** 归一化坐标、计算边界与分支配色索引 */
  finish(root: Topic): LayoutResult {
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const node of this.nodes) {
      if (node.x < minX) minX = node.x
      if (node.y < minY) minY = node.y
      if (node.x + node.width > maxX) maxX = node.x + node.width
      if (node.y + node.height > maxY) maxY = node.y + node.height
    }
    if (!Number.isFinite(minX)) {
      minX = 0
      minY = 0
      maxX = 0
      maxY = 0
    }

    const dx = this.padding - minX
    const dy = this.padding - minY
    /**
     * 平移坐标，并在这里做**节点对象复用**。
     *
     * 为什么复用放在这一步：缓存里存的是上一轮**归一化之后**的最终坐标，
     * 而摆放阶段的坐标是"归一化之前"的——两者只有在平移量已知时才能比。
     * （第一版把复用写在 `add()` 里，拿摆放坐标去比最终坐标，于是永远不命中。）
     *
     * 复用必须**同时**看主题对象：内容变了但尺寸没变时坐标是对的，
     * 可 `lines` 已经旧了，那种情况走"只换文字"那条路径（见 incremental.ts）。
     * 也不允许原地改复用的对象——它同时挂在上一轮的结果里，渲染层正拿着它，
     * 原地改会让 `TopicNode` 的 memo 认为"没变化"而停在旧位置。
     */
    for (let index = 0; index < this.nodes.length; index += 1) {
      const node = this.nodes[index]
      if (!node) continue
      const movedX = round(node.x + dx)
      const movedY = round(node.y + dy)
      const previous = this.memo?.nodes.get(node.id)
      if (
        previous &&
        previous.topic === node.topic &&
        previous.x === movedX &&
        previous.y === movedY &&
        previous.depth === node.depth &&
        previous.side === node.side
      ) {
        this.nodes[index] = previous
        this.nodeMap.set(previous.id, previous)
        this.stats.nodesReused += 1
        continue
      }
      if (movedX === node.x && movedY === node.y) continue
      const moved: NodeLayout = { ...node, x: movedX, y: movedY }
      this.nodes[index] = moved
      this.nodeMap.set(moved.id, moved)
    }

    const bounds: LayoutBounds = {
      x: 0,
      y: 0,
      width: round(maxX - minX + this.padding * 2),
      height: round(maxY - minY + this.padding * 2)
    }

    /**
     * 分支配色索引只取决于树的形状与顺序（不看尺寸），
     * 增量路径下形状保证没变 → 直接沿用上一轮那张表。
     */
    let branchIndex = this.touched ? this.memo?.branchIndex : undefined
    if (!branchIndex) {
      branchIndex = new Map<string, number>()
      branchIndex.set(root.id, -1)
      root.children.forEach((child, index) => {
        const mark = (topic: Topic): void => {
          branchIndex!.set(topic.id, index)
          // 与 `walk` 同口径：分支里自由摆放的主题也属于这个分支
          for (const grand of allChildrenOf(topic)) mark(grand)
        }
        mark(child)
      })
      // 挂在中心主题上的自由摆放主题不属于任何分支 → 记 -1（与中心主题同样用默认配色）。
      // 以前不给它们写入，表里查不到，消费方各自兜底，颜色随实现漂移
      const markFloating = (topic: Topic): void => {
        branchIndex!.set(topic.id, -1)
        for (const child of allChildrenOf(topic)) markFloating(child)
      }
      for (const floating of root.detachedChildren) markFloating(floating)
      if (this.memo) this.memo.branchIndex = branchIndex
    }

    // 几何版本：给连线的精确复用当判据（`elbow-*` 要绕开全图的挡路节点，用得上整体哈希）
    const versions = new Map<string, number>()
    const hashes: number[] = []
    for (const node of this.nodes) {
      const version = mix([node.x * 10, node.y * 10, node.width, node.height])
      versions.set(node.id, version)
      hashes.push(version)
    }
    this.geometryHash = mix(hashes)
    if (this.memo) {
      const runtime: LayoutRuntime = {
        memo: this.memo,
        geometryHash: this.geometryHash,
        versions,
        result: null,
        shapeStable: this.touched !== undefined
      }
      setActiveRuntime(runtime)
    }

    const result: LayoutResult = {
      nodes: this.nodes,
      nodeMap: this.nodeMap,
      edges: [],
      decorations: [],
      bounds,
      branchIndex,
      relationships: [],
      boundaries: [],
      summaries: []
    }
    const live = activeRuntimeOf()
    if (live) live.result = result
    // 嵌套结构（如分支上的鱼骨图）的主脊、骨刺要在最终坐标上补画
    for (const hook of this.finishHooks) hook(result)
    return result
  }

  /**
   * 一轮布局收了尾：把本轮的节点几何与装饰线留给下一轮复用，并摘掉运行时。
   *
   * 必须在 `runLayout` 的最后调用——装饰线是在归一化之后才画上的，
   * 提前收尾就会把"这一轮的装饰线"漏掉。
   */
  commit(result: LayoutResult): void {
    if (!this.memo) {
      setActiveRuntime(null)
      return
    }
    this.memo.nodes.clear()
    for (const node of result.nodes) this.memo.nodes.set(node.id, node)
    this.memo.decorations = { hash: this.geometryHash, items: result.decorations.slice() }
    setActiveRuntime(null)
  }
}
