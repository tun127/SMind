/**
 * 布局的跨轮缓存与运行时。
 *
 * 单一职责：只说清「哪些东西可以跨轮沿用、判据是什么」，不参与怎么摆放。
 * 从 core.ts 拆出来，让「缓存策略」与「摆放算法」能各自独立演进。
 */
import type { Topic } from '../../model/types'
import type { Decoration, LayoutResult, MeasureResult, NodeLayout } from '../types'

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
export interface LayoutRuntime {
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
/**
 * 挂上本轮运行时（布局是同步且单线程的：`finish` 里挂上、`commit` 里摘掉）。
 *
 * 用访问器而不是直接导出变量：ESM 的导入绑定不能赋值，跨文件改写必须走函数。
 */
export function setActiveRuntime(runtime: LayoutRuntime | null): void {
  activeRuntime = runtime
}

/** 本轮运行时；不在布局过程中时为 null */
export function activeRuntimeOf(): LayoutRuntime | null {
  return activeRuntime
}
