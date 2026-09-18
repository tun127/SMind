/**
 * 布局内核。
 *
 * 约定：布局算法分两个阶段
 *   1. 摆放（place）：只确定每个节点的 x / y
 *   2. 连线（connect）：在坐标归一化之后，用最终坐标生成连线与装饰
 *
 * 这样拆分的原因是连线是 SVG path 字符串，无法随坐标平移，
 * 必须在最终坐标确定后再生成，才能避免反复换算偏移量。
 */
import type { StructureClass, Topic } from '../model/types'
// 别名：类里也有个同名方法（它只是转发到这个纯函数），不加别名读起来像递归
import { visibleChildren as visibleChildrenOf } from '../model/tree'
import { DEFAULT_STRUCTURE, getStructureDef } from '../xmind/constants'
import { mix, subtreeStamp } from './stamp'
import type {
  Decoration,
  LayoutBounds,
  LayoutResult,
  MeasureFn,
  MeasureResult,
  NodeLayout,
  Side
} from './types'

export const LAYOUT_DEFAULTS = { gapX: 56, gapY: 18, padding: 60 }

/* ------------------------------------------------------------------ */
/* 增量布局的持久缓存                                                  */
/* ------------------------------------------------------------------ */

/** 带版本号的缓存条目：戳一致才敢用 */
export interface MemoEntry<T> {
  stamp: number
  value: T
}

/** 复用计数：自检靠它证明"确实省掉了活"，而不是只有结果对 */
export interface LayoutStats {
  /** 真的调用了测量函数的次数（其余都命中了缓存） */
  measureCalls: number
  measuresReused: number
  extentsComputed: number
  extentsReused: number
  nodesReused: number
  edgesReused: number
  decorationsReused: number
}

export function emptyLayoutStats(): LayoutStats {
  return {
    measureCalls: 0,
    measuresReused: 0,
    extentsComputed: 0,
    extentsReused: 0,
    nodesReused: 0,
    edgesReused: 0,
    decorationsReused: 0
  }
}

/**
 * 跨轮次保留的缓存。
 *
 * 存在的理由：编辑一个节点时，绝大多数子树与它无关，但布局过去每轮都要
 * 重新测量、重新算子树占用、重新拼每一条连线的 path。这里把这几样按
 * 「子树戳」留着，下一轮只对**真的变了的那条路径**重算。
 *
 * 只有 `layoutSheetCached`（incremental.ts）会创建并持有它；
 * 每次内容都要与它比对的输入签名也在那边维护。
 */
export interface LayoutMemo {
  gapX: number
  gapY: number
  padding: number
  /** 每个节点的测量结果：连主题对象与层数一起记，别把别的节点的尺寸用错了 */
  measures: Map<string, { topic: Topic; depth: number; value: MeasureResult }>
  /** 每棵子树的戳（见 stamp.ts） */
  stamps: Map<string, number>
  /** 上一轮每个节点的最终几何（主题对象没换、坐标也没换时直接复用同一个对象） */
  nodes: Map<string, NodeLayout>
  /** 子树占用 / 纵向占用 / 横向占用 / 层数的结果缓存 */
  extents: Map<string, MemoEntry<{ width: number; height: number }>>
  verticals: Map<string, MemoEntry<number>>
  horizontals: Map<string, MemoEntry<number>>
  depths: Map<string, MemoEntry<number>>
  /** 连线 path：键是「父|子|形状」，签名是这条线依赖到的几何版本 */
  edgePaths: Map<string, { sig: string; d: string }>
  /** 上一轮的装饰线（整表按几何哈希复用） */
  decorations: { hash: number; items: Decoration[] }
  /** 上一轮的分支配色索引（只取决于树的形状与顺序） */
  branchIndex?: Map<string, number>
  stats: LayoutStats
}

export function createLayoutMemo(gapX: number, gapY: number, padding: number): LayoutMemo {
  return {
    gapX,
    gapY,
    padding,
    measures: new Map(),
    stamps: new Map(),
    nodes: new Map(),
    extents: new Map(),
    verticals: new Map(),
    horizontals: new Map(),
    depths: new Map(),
    edgePaths: new Map(),
    decorations: { hash: -1, items: [] },
    branchIndex: undefined,
    stats: emptyLayoutStats()
  }
}

/** 布局参数（间距/留白）变了：几何类的缓存全部作废（测量结果还能留着） */
export function resetLayoutGeometry(memo: LayoutMemo): void {
  memo.extents.clear()
  memo.verticals.clear()
  memo.horizontals.clear()
  memo.depths.clear()
  memo.edgePaths.clear()
  memo.decorations = { hash: -1, items: [] }
  memo.branchIndex = undefined
}

/** 排版环境变了（字体就绪、默认字号/对齐改变）：连测量结果一起作废 */
export function resetLayoutMemo(
  memo: LayoutMemo,
  gapX: number,
  gapY: number,
  padding: number
): void {
  resetLayoutGeometry(memo)
  memo.measures.clear()
  memo.stamps.clear()
  memo.nodes.clear()
  memo.gapX = gapX
  memo.gapY = gapY
  memo.padding = padding
  memo.stats = emptyLayoutStats()
}

/**
 * 当前这一轮的运行时（模块级单例）。
 *
 * 为什么用单例而不是把缓存一路传参：`addEdge` / `addDecoration` 是各结构算法
 * 直接调用的**自由函数**（它们的签名是稳定的、被 9 个家族共用），
 * 为复用把缓存当第 7 个参数传下去会污染所有调用点。
 * 布局是**同步且单线程**的（`finish` 里挂上、`commit` 里摘掉），
 * 所以这里用一个显式生命周期管理的运行时是安全的。
 */
interface LayoutRuntime {
  memo: LayoutMemo
  /** 全图几何的混合值：正交折线要绕开挡路的节点，所以它依赖全图 */
  geometryHash: number
  /** 每个节点的几何版本，用于连线的精确复用判据 */
  versions: Map<string, number>
  /** 本轮的结果（`spine` 复用要顺着它找回整列） */
  result: LayoutResult | null
  /**
   * 本轮树的形状没变（增量路径才成立）。
   *
   * 装饰线是**按顺序**整批复用的，而条数由形状决定（矩阵的列数、表格的行数），
   * 所以只有形状稳定时才敢整批沿用——形状变了就必须重画。
   */
  shapeStable: boolean
}

let activeRuntime: LayoutRuntime | null = null

export function round(n: number): number {
  return Math.round(n * 10) / 10
}

export type Anchor = 'left' | 'right' | 'top' | 'bottom' | 'center'

export interface Point {
  x: number
  y: number
}

export function anchorPoint(node: NodeLayout, anchor: Anchor): Point {
  switch (anchor) {
    case 'left':
      return { x: node.x, y: round(node.y + node.height / 2) }
    case 'right':
      return { x: round(node.x + node.width), y: round(node.y + node.height / 2) }
    case 'top':
      return { x: round(node.x + node.width / 2), y: node.y }
    case 'bottom':
      return { x: round(node.x + node.width / 2), y: round(node.y + node.height) }
    default:
      return { x: round(node.x + node.width / 2), y: round(node.y + node.height / 2) }
  }
}

/* ------------------------------------------------------------------ */
/* 连线路径                                                            */
/* ------------------------------------------------------------------ */

/**
 * 连线形状。
 *
 * `spine` 是给**纵向列**用的：子节点在父节点的正上/正下方（时间轴的刻目、鱼骨的骨刺、
 * 矩阵的格位、树状表格的列）。这类子节点不能用"父下 → 子上"的直线连——
 * 兄弟排在同一列上，连到更远那个的线会从更近那个身上**穿过去**；
 * 正确形状是「父节点 → 侧边的竖脊 → 横着进子节点侧缘」：一条脊 + 一排短横线，
 * 读起来就是一份列表（Xmind 的时间轴 / 鱼骨也是这个形状）。
 */
export type ConnectorKind = 'bezier' | 'elbow-h' | 'elbow-v' | 'spine' | 'line'

/** 竖脊与子节点侧缘之间留的空隙 */
const SPINE_GAP = 8

/**
 * 列脊的折点：父节点锚点 → 先离开一小段 → 走到脊 → 沿脊走 → 横入子节点侧缘。
 *
 * 两个方向的列都走这一套：子节点在**正上/正下方**（时间轴刻目、鱼骨骨刺、矩阵格位）
 * 脊是竖的；在**正左/正右**（树状表格的列头与条目）脊是横的。
 *
 * 脊的位置按**这一列的所有子节点**算，而不是只看当前这个：某个兄弟被手动拖偏之后，
 * 按单个子节点算出来的脊会落在那个兄弟的范围里，连线又从它身上穿过去了。
 * 同理，"离开父节点的一小段"走在父节点与最近那个子节点之间的空档里，
 * 免得那条线贴着子节点的边缘蹭过去。
 */
function spinePoints(result: LayoutResult, parent: NodeLayout, child: NodeLayout): Point[] {
  const boxes = visibleChildrenOf(parent.topic)
    .map((topic) => result.nodeMap.get(topic.id))
    .filter((node): node is NodeLayout => node !== undefined)
  const column = boxes.length > 0 ? boxes : [child]

  const pcx = parent.x + parent.width / 2
  const pcy = parent.y + parent.height / 2
  const ccx = child.x + child.width / 2
  const ccy = child.y + child.height / 2
  const vertical = Math.abs(ccy - pcy) >= Math.abs(ccx - pcx)

  if (vertical) {
    const below = ccy >= pcy
    const anchorY = below ? round(parent.y + parent.height) : parent.y
    const from: Point = { x: round(pcx), y: anchorY }
    /**
     * 正上/正下的**单链**：就是一条竖线。
     *
     * 这类父子在布局里本来就在同一条竖线上（列摆放不做逐层缩进），
     * 再"绕到脊上"就画成了没必要的 Z 形——用户要的就是「直接垂直」。
     *
     * 必须限定**只有一个子节点**：列里有多个格子时，第二个格子的中心 x 往往也和父节点
     * 相同，直连就会从上面那个格子身上穿过去（自检的"穿框"当场抓到过）。
     */
    if (column.length === 1 && Math.abs(ccx - pcx) < 2) {
      // 终点落在子节点**近侧边框**上（落在中心就会插进框里、压住文字）
      return [from, { x: from.x, y: below ? child.y : round(child.y + child.height) }]
    }
    /**
     * 同一父节点下的所有子节点**永远从左边进**（脊在整列的左侧）。
     *
     * 不能按"这个子节点相对父节点中线在哪边"逐个决定：那样拖偏一个子节点就会让它翻到
     * 另一边去，同一列里一半脊在左、一半在右——用户看到的正是"两边格式不一样"。
     * 结构化的东西就该给出与内容无关的稳定形状。
     */
    const to: Point = { x: child.x, y: round(ccy) }
    const spineX = Math.min(from.x, Math.min(...column.map((node) => node.x)) - SPINE_GAP)
    const nearest = column.reduce(
      (acc, node) => (below ? Math.min(acc, node.y) : Math.max(acc, node.y)),
      anchorY
    )
    const gap = Math.abs(nearest - anchorY)
    const departY = round(anchorY + (below ? 1 : -1) * Math.max(2, Math.min(SPINE_GAP, gap / 2)))
    return [
      from,
      { x: from.x, y: departY },
      { x: round(spineX), y: departY },
      { x: round(spineX), y: to.y },
      to
    ]
  }

  /**
   * 子节点在**另一个列**里（树状表格：父在左列，子在同一右列里上下堆叠）。
   * 脊竖在父列与子列之间：父节点横出来接脊 → 沿脊上下 → 再逐格横进子节点侧缘。
   * 脊落在**所有子节点的外侧**，所以不会从任何一个兄弟身上穿过去。
   */
  const right = ccx >= pcx
  const near = right
    ? Math.min(...column.map((node) => node.x)) - SPINE_GAP
    : Math.max(...column.map((node) => node.x + node.width)) + SPINE_GAP
  const railX = right
    ? Math.max(near, round(parent.x + parent.width) + 4)
    : Math.min(near, parent.x - 4)
  const from: Point = { x: right ? round(parent.x + parent.width) : parent.x, y: round(pcy) }
  const to: Point = {
    x: right ? child.x : round(child.x + child.width),
    y: round(ccy)
  }
  return [from, { x: round(railX), y: from.y }, { x: round(railX), y: to.y }, to]
}

export function pathFor(kind: ConnectorKind, from: Point, to: Point): string {
  const x1 = round(from.x)
  const y1 = round(from.y)
  const x2 = round(to.x)
  const y2 = round(to.y)

  switch (kind) {
    case 'line':
      return `M ${x1} ${y1} L ${x2} ${y2}`
    case 'elbow-h': {
      const midX = round(x1 + (x2 - x1) / 2)
      return `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`
    }
    case 'elbow-v': {
      const midY = round(y1 + (y2 - y1) / 2)
      return `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`
    }
    default: {
      const midX = round(x1 + (x2 - x1) / 2)
      return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`
    }
  }
}

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
          for (const grand of topic.children) mark(grand)
        }
        mark(child)
      })
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
      activeRuntime = {
        memo: this.memo,
        geometryHash: this.geometryHash,
        versions,
        result: null,
        shapeStable: this.touched !== undefined
      }
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
    if (activeRuntime) activeRuntime.result = result
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
      activeRuntime = null
      return
    }
    this.memo.nodes.clear()
    for (const node of result.nodes) this.memo.nodes.set(node.id, node)
    this.memo.decorations = { hash: this.geometryHash, items: result.decorations.slice() }
    activeRuntime = null
  }
}

/* ------------------------------------------------------------------ */
/* 连线与装饰的收集                                                    */
/* ------------------------------------------------------------------ */

/**
 * 连线的复用键与依赖签名。
 *
 * 一条线的 path 依赖哪些几何，各形状不一样，这里必须一个个说清楚——
 * 判据放宽就会画出一条**指向旧位置**的线（比不缓存更糟）：
 * - `line` / `bezier`：只依赖两个端点，端点版本一致就能沿用；
 * - `spine`（列脊）：脊的位置按**父节点 + 它这一列的全部可见子节点**算，都要进签名；
 * - `elbow-*`（正交折线）：要看全图有没有节点挡路（`crossedNodes`），
 *   所以它依赖**整图**几何哈希——全图一点没动才敢复用。
 */
function edgeMemoKey(
  result: LayoutResult,
  fromId: string,
  toId: string,
  kind: ConnectorKind
): { key: string; sig: string } | null {
  const runtime = activeRuntime
  if (!runtime) return null
  const version = (id: string): number => runtime.versions.get(id) ?? -1
  const parts = [String(version(fromId)), String(version(toId))]
  if (kind === 'elbow-h' || kind === 'elbow-v') parts.push(String(runtime.geometryHash))
  if (kind === 'spine') {
    const parent = result.nodeMap.get(fromId)
    if (parent) {
      for (const sibling of visibleChildrenOf(parent.topic)) parts.push(String(version(sibling.id)))
    }
  }
  return { key: `${fromId}|${toId}|${kind}`, sig: parts.join(',') }
}

export function addEdge(
  result: LayoutResult,
  fromId: string,
  toId: string,
  from: Point,
  to: Point,
  kind: ConnectorKind
): void {
  const memo = activeRuntime?.memo
  const reuse = edgeMemoKey(result, fromId, toId, kind)
  if (memo && reuse) {
    const cached = memo.edgePaths.get(reuse.key)
    if (cached && cached.sig === reuse.sig) {
      result.edges.push({ fromId, toId, d: cached.d })
      memo.stats.edgesReused += 1
      return
    }
  }

  /**
   * 列脊：由结构显式声明（它知道自己的子节点是不是排成一列）。
   * 锚点由这里重算——列脊要进的是子节点的**侧缘**，而不是结构原来给的上/下缘。
   */
  if (kind === 'spine') {
    const parent = result.nodeMap.get(fromId)
    const child = result.nodeMap.get(toId)
    if (parent && child) {
      storeEdge(memo, reuse, polyline(spinePoints(result, parent, child)), result, fromId, toId)
      return
    }
  }

  /**
   * 折线连线加一层**竖井绕行**：连线不许从别的节点身上穿过去。
   *
   * 为什么需要：各结构算锚点时只看父子两个节点，于是当兄弟排成一列时——
   * 矩阵的格位、时间轴的刻目、鱼骨的骨刺、树状表格的列——连到"更远那一格"的线
   * 会从"更近那一格"身上直插过去（用户截图：一条竖线穿过中间那个框）。
   */
  const d =
    kind === 'elbow-v' || kind === 'elbow-h'
      ? orthogonalPath(result, fromId, toId, from, to, kind)
      : pathFor(kind, from, to)
  storeEdge(memo, reuse, d, result, fromId, toId)
}

function storeEdge(
  memo: LayoutMemo | undefined,
  reuse: { key: string; sig: string } | null,
  d: string,
  result: LayoutResult,
  fromId: string,
  toId: string
): void {
  if (memo && reuse) memo.edgePaths.set(reuse.key, { sig: reuse.sig, d })
  result.edges.push({ fromId, toId, d })
}

/** 离开锚点的小段：太短会贴着节点边框看不出转折 */
const LANE_STUB = 10
/** 竖井与挡路节点之间留的空隙 */
const LANE_GAP = 8
/** 判"穿过"时的容差：贴边不算穿过（连线本来就该贴着节点边缘走） */
const HIT_TOLERANCE = 2

function polyline(points: Point[]): string {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${round(point.x)} ${round(point.y)}`)
    .join(' ')
}

/** 轴对齐线段是否伸进了矩形内部（留容差，贴边不算） */
function segmentHitsRect(a: Point, b: Point, rect: NodeLayout): boolean {
  const x0 = Math.min(a.x, b.x)
  const x1 = Math.max(a.x, b.x)
  const y0 = Math.min(a.y, b.y)
  const y1 = Math.max(a.y, b.y)
  if (x1 <= rect.x + HIT_TOLERANCE || x0 >= rect.x + rect.width - HIT_TOLERANCE) return false
  if (y1 <= rect.y + HIT_TOLERANCE || y0 >= rect.y + rect.height - HIT_TOLERANCE) return false
  return true
}

/** 这条折线穿过了哪些节点（父子两端不算） */
function crossedNodes(
  result: LayoutResult,
  fromId: string,
  toId: string,
  points: Point[]
): NodeLayout[] {
  const out: NodeLayout[] = []
  for (const node of result.nodes) {
    if (node.id === fromId || node.id === toId) continue
    for (let i = 0; i + 1 < points.length; i += 1) {
      const a = points[i]
      const b = points[i + 1]
      if (a && b && segmentHitsRect(a, b, node)) {
        out.push(node)
        break
      }
    }
  }
  return out
}

function pathLength(points: Point[]): number {
  let total = 0
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]
    const b = points[i + 1]
    if (a && b) total += Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
  }
  return total
}

/**
 * 正交折线：默认走中位折角；被别的节点挡住时改走**竖井**。
 *
 * 竖井位置取「挡住路的那几个节点的外侧 ±8px」，左右（上下）各试一条，
 * 取更短的一条；两条都还挡着就退回默认路径——**宁可不好看，也不能绕出更乱的线**。
 */
function orthogonalPath(
  result: LayoutResult,
  fromId: string,
  toId: string,
  from: Point,
  to: Point,
  kind: 'elbow-v' | 'elbow-h'
): string {
  const vertical = kind === 'elbow-v'
  const mid = vertical ? round(from.y + (to.y - from.y) / 2) : round(from.x + (to.x - from.x) / 2)
  const direct: Point[] = vertical
    ? [from, { x: from.x, y: mid }, { x: to.x, y: mid }, to]
    : [from, { x: mid, y: from.y }, { x: mid, y: to.y }, to]

  const blockers = crossedNodes(result, fromId, toId, direct)
  if (blockers.length === 0) return polyline(direct)

  const lanes = vertical
    ? [
        Math.min(...blockers.map((n) => n.x)) - LANE_GAP,
        Math.max(...blockers.map((n) => n.x + n.width)) + LANE_GAP
      ]
    : [
        Math.min(...blockers.map((n) => n.y)) - LANE_GAP,
        Math.max(...blockers.map((n) => n.y + n.height)) + LANE_GAP
      ]

  // 离开锚点的小段：连线很短时按一半收窄，免得冲过子节点
  const span = vertical ? Math.abs(to.y - from.y) : Math.abs(to.x - from.x)
  const stub = Math.min(LANE_STUB, Math.max(span / 2, 0))
  const away = vertical ? Math.sign(mid - from.y) || 1 : Math.sign(mid - from.x) || 1

  let best: Point[] | null = null
  let bestLength = Number.POSITIVE_INFINITY
  for (const lane of lanes) {
    const path: Point[] = vertical
      ? [
          from,
          { x: from.x, y: round(from.y + away * stub) },
          { x: round(lane), y: round(from.y + away * stub) },
          { x: round(lane), y: to.y },
          to
        ]
      : [
          from,
          { x: round(from.x + away * stub), y: from.y },
          { x: round(from.x + away * stub), y: round(lane) },
          { x: to.x, y: round(lane) },
          to
        ]
    if (crossedNodes(result, fromId, toId, path).length > 0) continue
    const length = pathLength(path)
    if (length < bestLength) {
      best = path
      bestLength = length
    }
  }
  return polyline(best ?? direct)
}

export function addDecoration(result: LayoutResult, decoration: Decoration): void {
  /**
   * 装饰线（主脊、网格线、大括号）每条都要按最终坐标拼字符串。
   * 条数由形状决定、坐标由节点决定，所以「形状没变 + 全图几何没变」时
   * 整批沿用上一轮的结果，连字符串都不必再拼。
   */
  const runtime = activeRuntime
  const memo = runtime?.memo
  if (runtime && memo && runtime.shapeStable && memo.decorations.hash === runtime.geometryHash) {
    const cached = memo.decorations.items[result.decorations.length]
    if (cached) {
      result.decorations.push(cached)
      memo.stats.decorationsReused += 1
      return
    }
  }
  result.decorations.push(decoration)
}

/**
 * 沿树生成父子连线。
 * @param anchorOf 由各结构决定从父节点/子节点的哪个锚点连出
 */
export function connectTree(
  result: LayoutResult,
  root: Topic,
  kind: ConnectorKind,
  anchorOf: (parent: NodeLayout, child: NodeLayout) => { from: Anchor; to: Anchor }
): void {
  /**
   * 括号图：括号本身就是连线，父子边不再重复画（括号由 `layoutBrace` 的钩子补画）。
   *
   * 判断依据是**这张画布的结构**（＝中心主题的 structureClass），
   * 而不是当前走到的那一层：结构是画布级属性。
   */
  const braceCanvas = getStructureDef(root.structureClass ?? DEFAULT_STRUCTURE).family === 'brace'
  const walk = (topic: Topic): void => {
    const parent = result.nodeMap.get(topic.id)
    if (!parent) return
    for (const child of visibleChildrenOf(topic)) {
      const childNode = result.nodeMap.get(child.id)
      if (!childNode) continue
      if (braceCanvas) {
        walk(child)
        continue
      }
      const anchors = anchorOf(parent, childNode)
      addEdge(
        result,
        parent.id,
        childNode.id,
        anchorPoint(parent, anchors.from),
        anchorPoint(childNode, anchors.to),
        kind
      )
      walk(child)
    }
  }
  walk(root)
}

/** 水平方向堆叠时的默认锚点：父的右/左边 -> 子的左/右边 */
export function horizontalAnchors(
  _parent: NodeLayout,
  child: NodeLayout
): { from: Anchor; to: Anchor } {
  return child.side === 'left' ? { from: 'left', to: 'right' } : { from: 'right', to: 'left' }
}

/** 折叠徽标贴在节点的哪条边上（与子节点的展开方向一致） */
export type CollapseSide = 'left' | 'right' | 'up' | 'down'

/** 中心主题之外的节点：布局给的 `side` 就是它的展开方向 */
function sideToCollapseSide(side: Side): CollapseSide {
  if (side === 'left') return 'left'
  if (side === 'up') return 'up'
  if (side === 'down') return 'down'
  return 'right'
}

/**
 * 折叠徽标贴在节点的哪条边上：**跟着分支的展开方向走**（左右 / 上下都跟）。
 *
 * 判定用**可见子节点的实际位置**——它们全部落在哪一边，徽标就贴哪一边：
 * - 全部在下方（组织架构图：向下、矩阵、树状表格、垂直时间轴）→ 贴下缘；
 * - 全部在上方（组织架构图：向上）→ 贴上缘；
 * - 全部在左侧（逻辑图/树形图：向左）→ 贴左缘；
 * - 其余（右侧，或左右都有分支的平衡思维导图）→ 贴右缘。
 *
 * 为什么用几何而不是子节点的 `side`：`side` 表达的是"这个节点相对父节点的位置"，
 * 不是"它的子节点往哪长"——鱼骨图里子节点排在一列却带 `up`/`down`，按 `side`
 * 判断会把徽标挂到上方。用最终坐标则各种结构都成立。
 *
 * 中心主题折叠后（以及无可见子节点时）退回自身方向；中心主题自己没有方向
 * （`side` 恒为 `'root'`），退回**结构方向** `grows`，否则「向下的图、徽标挂在右边」。
 */
export function collapseBadgeSide(
  node: NodeLayout,
  nodeMap: ReadonlyMap<string, NodeLayout>
): CollapseSide {
  const centerX = node.x + node.width / 2
  const centerY = node.y + node.height / 2
  /** 半个像素的容差：恰好居中（如父节点只有一个居中的子节点）不算"在上下" */
  const EPS = 0.5

  const kids: NodeLayout[] = []
  for (const child of node.topic.children) {
    const childNode = nodeMap.get(child.id)
    if (childNode) kids.push(childNode)
  }

  if (kids.length > 0) {
    if (kids.every((kid) => kid.y + kid.height / 2 > centerY + EPS)) return 'down'
    if (kids.every((kid) => kid.y + kid.height / 2 < centerY - EPS)) return 'up'
    if (kids.every((kid) => kid.x + kid.width / 2 < centerX - EPS)) return 'left'
    return 'right'
  }

  if (node.side !== 'root') return sideToCollapseSide(node.side)
  return getStructureDef(node.topic.structureClass).grows ?? 'right'
}

/**
 * 连接锚点：先看子节点落在父节点的哪一侧，再回落到各结构自己的默认锚点。
 *
 * 为什么需要这一层：纵向缩进列（鱼骨的骨刺、时间轴的分支、树状表格的列）里，
 * 子节点排在父节点**正下方**，若沿用父级家族的默认锚点（左右），连线会斜着穿过去。
 * `side` 是 up/down 就说明这是纵向列，改用上下锚点。
 */
export function anchorsForChild(
  parent: NodeLayout,
  child: NodeLayout,
  fallback: { from: Anchor; to: Anchor }
): { from: Anchor; to: Anchor } {
  if (child.side === 'up' || child.side === 'down') return verticalAnchors(parent, child)
  return fallback
}

/** 垂直方向堆叠时的默认锚点：父的下/上边 -> 子的上/下边 */
export function verticalAnchors(
  parent: NodeLayout,
  child: NodeLayout
): { from: Anchor; to: Anchor } {
  return child.y + child.height / 2 < parent.y + parent.height / 2
    ? { from: 'top', to: 'bottom' }
    : { from: 'bottom', to: 'top' }
}

/** 曲线圆角括号 {@code (} 形状，用于括号图；竖直列在 x，尖端向左突出 */
export function bracePath(x: number, yTop: number, yBottom: number, tipX: number): string {
  const span = yBottom - yTop
  const r = Math.max(2, Math.min(12, span / 4))
  const yMid = round((yTop + yBottom) / 2)
  return [
    `M ${round(x)} ${round(yTop)}`,
    `Q ${round(tipX)} ${round(yTop)}, ${tipX} ${round(yTop + r)}`,
    `L ${tipX} ${round(yMid - r)}`,
    `Q ${tipX} ${yMid}, ${round(tipX - r)} ${yMid}`,
    `Q ${tipX} ${yMid}, ${tipX} ${round(yMid + r)}`,
    `L ${tipX} ${round(yBottom - r)}`,
    `Q ${round(tipX)} ${round(yBottom)}, ${round(x)} ${round(yBottom)}`
  ].join(' ')
}
