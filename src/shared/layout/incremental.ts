/**
 * 增量布局：把「每次击键都全量重排」变成「只重算真的变了的那一部分」。
 *
 * ## 为什么需要
 *
 * 编辑一个节点时，`editingText` 每敲一个键都会变，而画布的布局 `useMemo` 依赖它，
 * 于是整棵树重新走一遍：重新测量、重新递归算子树占用、重新拼每一条连线的 path、
 * 重新分配每个节点对象。万级节点下这一串就是几十毫秒的卡顿。
 *
 * ## 怎么做到"只重算真的变了的那一部分"
 *
 * 三层判据叠加，越往下越贵，所以从最便宜的开始：
 *
 * ① **零变更**：根主题、画布、排版环境三个引用都没动 → 直接还上一轮那个结果对象（O(1)）；
 * ② **形状比较**：并行走新旧两棵树，**引用相同就整棵剪掉**
 *    （zustand + immer 保证未改动的子树引用不变）→ 变了的只有"改动点到根"这一条路径，
 *    检测成本是 O(脏路径 × 分支数) 而不是 O(节点数)；
 * ③ **子树戳**（见 `stamp.ts`）：每棵子树按「内容 + 尺寸 + 预留」算一个版本号，
 *    戳没变的子树，测量结果、子树占用、层数、连线 path 全都从缓存里取。
 *
 * 形状变了（增删 / 换序 / 折叠 / 换结构）也能受益：戳是按子树算的，
 * 没被碰到的那几支依旧命中缓存——只是无法再保证"层数不变"，所以换成整树走一遍
 * （不剪枝），不用脏路径那套判定。
 *
 * ## 正确性
 *
 * 增量与全量走的是**同一段摆放代码**（`run.ts` 的 `runLayout`），
 * 差别只在 builder 里带不带缓存。自检里有一条硬断言：
 * 同一棵树，先全量、再增量，逐字段（节点坐标/尺寸、每条连线的 d、装饰线、
 * 边界/概要/关系线、bounds、分支配色）必须完全一致。
 */
import type { Sheet, Topic } from '../model/types'
import { allChildrenOf, visibleChildren } from '../model/tree'
import {
  LayoutBuilder,
  LAYOUT_DEFAULTS,
  createLayoutMemo,
  emptyLayoutStats,
  resetLayoutMemo,
  type LayoutMemo,
  type LayoutStats
} from './core'
import { runLayout } from './run'
import type { LayoutOptions, LayoutResult, MeasureFn, MeasureResult, NodeLayout } from './types'

/** 这一轮实际走的是哪条路径 */
export type LayoutPass =
  /** 输入完全没变：原样返回上一轮的结果对象 */
  | 'fit'
  /** 只有正在编辑的节点文字变了、尺寸没变：只换那几个节点对象，不重排 */
  | 'refresh'
  /** 尺寸变了：只重算受影响的子树，其余全部复用 */
  | 'incremental'
  /** 结构 / 画布 / 排版环境变了：整棵重排（缓存仍然生效，只是不再限定脏路径） */
  | 'full'

/**
 * 上一轮的输入签名。
 *
 * ⚠️ 边界/概要**不能**拿画布对象的引用去比：画布是工作簿的一部分，
 * 改任何一个节点都会顺着 immer 产生一张新的画布对象，
 * 于是"改个标题"会被误判成"边界/概要变了"、整棵重排（第一版就踩了这个坑）。
 * 真正影响摆放的只有边界与概要 —— 它们各自的数组在没被改动时会保持同一引用。
 */
export interface LayoutInput {
  root: Topic
  sheet: Sheet | undefined
  boundaries: unknown
  summaries: unknown
  extras: string
}

export interface LayoutCache {
  memo: LayoutMemo
  key: LayoutInput | null
  result: LayoutResult | null
  pass: LayoutPass
  stats: LayoutStats
}

function inputOf(root: Topic, sheet: Sheet | undefined, extras: string): LayoutInput {
  return {
    root,
    sheet,
    boundaries: sheet?.boundaries,
    summaries: sheet?.summaries,
    extras
  }
}

/** 边界/概要是否没变（它们变了才会改变"要留多少白"） */
function overlaysSame(a: LayoutInput, b: LayoutInput): boolean {
  return a.boundaries === b.boundaries && a.summaries === b.summaries
}

export function createLayoutCache(): LayoutCache {
  return {
    memo: createLayoutMemo(LAYOUT_DEFAULTS.gapX, LAYOUT_DEFAULTS.gapY, LAYOUT_DEFAULTS.padding),
    key: null,
    result: null,
    pass: 'full',
    stats: emptyLayoutStats()
  }
}

/* ------------------------------------------------------------------ */
/* 变更检测                                                            */
/* ------------------------------------------------------------------ */

interface ScanResult {
  /** 自己这个对象换了的主题（要重新测量） */
  changed: Array<{ topic: Topic; depth: number }>
  /** 脏节点 + 它们的祖先：不在这个集合里的子树整棵没动 */
  touched: Set<string>
  /** 形状变了（增删 / 换序 / 折叠 / 换结构 / 位置）→ 不能再按脏路径走 */
  shapeChanged: boolean
}

function visibleIds(topic: Topic): string {
  return visibleChildren(topic)
    .map((child) => child.id)
    .join(',')
}

/** 只有中心主题的直接独立主题参与布局；非根级 detached 不在这里比较。 */
function detachedIds(topic: Topic): string {
  return topic.detachedChildren.map((child) => child.id).join(',')
}

/**
 * 并行比较新旧两棵树。
 *
 * `prev === next` 就是"这棵子树一个字节都没动"，直接剪掉——
 * 这是整套增量之所以能做到 O(脏路径) 的根据。
 */
function scanTree(
  prev: Topic | null,
  next: Topic,
  depth: number,
  out: ScanResult,
  includeDetached: boolean
): void {
  if (prev === next) return

  out.touched.add(next.id)
  out.changed.push({ topic: next, depth })

  if (!prev) {
    // 新节点：整棵新子树都算脏（它的每个后代都不在上一轮里）
    out.shapeChanged = true
    for (const child of next.children) scanTree(null, child, depth + 1, out, false)
    if (includeDetached) {
      for (const child of next.detachedChildren) scanTree(null, child, depth + 1, out, false)
    }
    return
  }

  if (visibleIds(prev) !== visibleIds(next)) out.shapeChanged = true
  if (includeDetached && detachedIds(prev) !== detachedIds(next)) out.shapeChanged = true
  if (prev.collapsed !== next.collapsed) out.shapeChanged = true
  if (prev.structureClass !== next.structureClass) out.shapeChanged = true
  /**
   * 手动摆放偏移（`position`）只改"这一格放哪儿"，不改尺寸，也不改形状——
   * 它变了必须走摆放（不能走"只换文字"的 refresh），否则节点会停在旧位置。
   */
  if (prev.position !== next.position) out.shapeChanged = true

  for (const child of next.children) {
    const match = prev.children.find((item) => item.id === child.id) ?? null
    scanTree(match, child, depth + 1, out, false)
  }
  if (includeDetached) {
    for (const child of next.detachedChildren) {
      const match = prev.detachedChildren.find((item) => item.id === child.id) ?? null
      scanTree(match, child, depth + 1, out, false)
    }
  }
}

/**
 * 「正在编辑的节点」这一条从根到它的路径。
 *
 * 编辑态的文字还没提交进工作簿，所以那个主题的**对象引用可能一个都没变**，
 * 引用比较发现不了它。但它确实是脏的（宽度每敲一键就变），
 * 必须把它自己和它所有祖先标脏，祖先的子树占用才会重算。
 */
function hotPathOf(root: Topic, hot: ReadonlySet<string>): string[] {
  const path: string[] = []
  const visit = (topic: Topic): boolean => {
    let hit = hot.has(topic.id)
    for (const child of allChildrenOf(topic)) {
      if (visit(child)) hit = true
    }
    if (hit) path.push(topic.id)
    return hit
  }
  visit(root)
  return path
}

/* ------------------------------------------------------------------ */
/* 只换文字、不动几何                                                  */
/* ------------------------------------------------------------------ */

/** 把一份新的测量结果贴到节点上（宽高没变，所以只换内容相关的字段） */
function withMeasure(node: NodeLayout, topic: Topic, size: MeasureResult): NodeLayout {
  return {
    ...node,
    topic,
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
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 带缓存的布局。
 *
 * @param hotIds 正在编辑（或正在被外部改内容）的主题 id：这些节点的文字可能
 *   还没进工作簿，引用比较看不出变化，必须显式按"脏"处理
 */
export function layoutSheetCached(
  root: Topic,
  measure: MeasureFn,
  options: LayoutOptions,
  sheet: Sheet | undefined,
  cache: LayoutCache,
  extras = '',
  hotIds: readonly string[] = []
): LayoutResult {
  const gapX = options.gapX ?? LAYOUT_DEFAULTS.gapX
  const gapY = options.gapY ?? LAYOUT_DEFAULTS.gapY
  const padding = options.padding ?? LAYOUT_DEFAULTS.padding
  const hot = new Set(hotIds)
  const prev = cache.key
  const sameGaps =
    cache.memo.gapX === gapX && cache.memo.gapY === gapY && cache.memo.padding === padding

  // ① 零变更：连正在编辑的节点都没有 → 原样还回去（O(1)）
  if (
    prev &&
    cache.result &&
    hot.size === 0 &&
    sameGaps &&
    prev.root === root &&
    prev.boundaries === sheet?.boundaries &&
    prev.summaries === sheet?.summaries &&
    prev.extras === extras
  ) {
    cache.pass = 'fit'
    cache.stats = emptyLayoutStats()
    return cache.result
  }

  // ② 排版环境或布局参数变了（字体就绪、默认字号/对齐、间距）：连测量结果都得作废
  if (!prev || !sameGaps || prev.extras !== extras) {
    resetLayoutMemo(cache.memo, gapX, gapY, padding)
    return runAndStore(cache, root, sheet, gapX, gapY, padding, extras, measure, undefined)
  }

  const scan: ScanResult = { changed: [], touched: new Set(), shapeChanged: false }
  scanTree(prev.root, root, 0, scan, true)
  const overlayChanged = !overlaysSame(prev, inputOf(root, sheet, extras))

  /**
   * ③ 结构 / 画布变了：整棵重排。
   *
   * 缓存不清——子树戳是按子树算的，没被碰到的分支照样命中；
   * 只是不能再按"脏路径"剪枝（层数可能变了，每棵子树都要重新确认一遍）。
   */
  if (scan.shapeChanged || overlayChanged) {
    return runAndStore(cache, root, sheet, gapX, gapY, padding, extras, measure, undefined)
  }

  // ④ 尺寸判定：把"自己换了的"与"正在编辑的"都重新量一遍
  const fresh = new Map<string, MeasureResult>()
  const freshTopics = new Map<string, Topic>()
  let geometryChanged = false
  for (const item of scan.changed) {
    const size = measure(item.topic, item.depth)
    fresh.set(item.topic.id, size)
    freshTopics.set(item.topic.id, item.topic)
    const before = cache.memo.nodes.get(item.topic.id)
    if (!before || before.width !== size.width || before.height !== size.height) {
      geometryChanged = true
    }
  }
  /**
   * hot 节点可能**不在** `cache.memo.nodes` 里（例如刚新建就进编辑态的节点）。
   * 以前那个分支只置 `geometryChanged = true` 就 `continue` —— 既不量、也不把结果放进 `fresh`，
   * 下游只能回落到旧 memo（空标题量出来的 124px）。这里先按 id 建一份「当前树」索引，
   * 保证 hot 节点**一定拿到本轮的新测量**。
   */
  const byId = new Map<string, { topic: Topic; depth: number }>()
  if (hot.size > 0) {
    const collect = (topic: Topic, depth: number): void => {
      byId.set(topic.id, { topic, depth })
      for (const child of topic.children) collect(child, depth + 1)
      for (const child of topic.detachedChildren) collect(child, depth + 1)
    }
    collect(root, 0)
  }
  for (const id of hot) {
    if (fresh.has(id)) continue
    const before = cache.memo.nodes.get(id)
    const current = byId.get(id)
    const target = current ?? (before ? { topic: before.topic, depth: before.depth } : null)
    if (!target) {
      geometryChanged = true
      continue
    }
    const size = measure(target.topic, target.depth)
    fresh.set(id, size)
    freshTopics.set(id, target.topic)
    if (!before || before.width !== size.width || before.height !== size.height) {
      geometryChanged = true
    }
  }

  /**
   * ⑤ 只有文字变了、尺寸一点没动（还在同一行里改字）：连摆放都不用跑，
   * 把变了的那几个节点换上新对象、其余数组整块复用。
   *
   * ⚠️ **编辑期不允许走这一支**：它用 `withMeasure()` 构建新节点，而那个函数**只换 topic 引用、
   * 不动 width/height**（见它的注释）。编辑期一旦落进来，`cache.pass` 就是 `refresh`、
   * 节点宽度永远不变 —— 表现正是"打满 20 个字符框还是 76px、提交后才正常"（报告 §24）。
   * 所以这里加一道守卫：有 hot 节点时一律落到 ⑥ 的增量重排（真跑布局 + `seedMeasures(fresh)`）。
   * 这不是关掉增量：⑥ 仍只走脏路径，非编辑期的 ⑤ 也照旧。
   */
  if (!geometryChanged && hot.size === 0) {
    const result = cache.result
    if (result && fresh.size > 0) {
      const patched = result.nodes.map((node) => {
        const size = fresh.get(node.id)
        const topic = freshTopics.get(node.id)
        if (!size || !topic) return node
        const next = withMeasure(node, topic, size)
        cache.memo.nodes.set(node.id, next)
        cache.memo.measures.set(node.id, { topic, depth: next.depth, value: size })
        return next
      })
      const nodeMap = new Map(patched.map((node) => [node.id, node]))
      const refreshed: LayoutResult = { ...result, nodes: patched, nodeMap }
      cache.result = refreshed
      cache.key = inputOf(root, sheet, extras)
      cache.pass = 'refresh'
      cache.stats = emptyLayoutStats()
      cache.stats.nodesReused = patched.length - fresh.size
      return refreshed
    }
    // 没有正在编辑的节点却没有几何变化：说明只是"自己换了的主题尺寸恰好相同"
    // （比如改了大小写）。这里同样只需换对象，重排一遍结果也一样。
    if (result && scan.changed.length > 0) {
      const patched = result.nodes.map((node) => {
        const size = fresh.get(node.id)
        const topic = freshTopics.get(node.id)
        if (!size || !topic) return node
        const next = withMeasure(node, topic, size)
        cache.memo.nodes.set(node.id, next)
        cache.memo.measures.set(node.id, { topic, depth: next.depth, value: size })
        return next
      })
      const refreshed: LayoutResult = {
        ...result,
        nodes: patched,
        nodeMap: new Map(patched.map((item) => [item.id, item]))
      }
      cache.result = refreshed
      cache.key = inputOf(root, sheet, extras)
      cache.pass = 'refresh'
      cache.stats = emptyLayoutStats()
      cache.stats.nodesReused = patched.length - fresh.size
      return refreshed
    }
  }

  // ⑥ 尺寸变了：增量重排（只走脏路径，其余子树整棵复用）
  const touched = new Set(scan.touched)
  for (const id of hotPathOf(root, hot)) touched.add(id)
  const builder = new LayoutBuilder(measure, gapX, gapY, padding, cache.memo, touched)
  builder.seedMeasures(fresh)
  const result = runLayout(builder, root, sheet)
  builder.commit(result)
  cache.key = inputOf(root, sheet, extras)
  cache.result = result
  cache.pass = 'incremental'
  cache.stats = builder.stats
  return result
}

/** 全量重排并写入缓存 */
function runAndStore(
  cache: LayoutCache,
  root: Topic,
  sheet: Sheet | undefined,
  gapX: number,
  gapY: number,
  padding: number,
  extras: string,
  measure: MeasureFn,
  touched: ReadonlySet<string> | undefined
): LayoutResult {
  const builder = new LayoutBuilder(measure, gapX, gapY, padding, cache.memo, touched)
  const result = runLayout(builder, root, sheet)
  builder.commit(result)
  cache.key = inputOf(root, sheet, extras)
  cache.result = result
  cache.pass = 'full'
  cache.stats = builder.stats
  return result
}
