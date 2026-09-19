import { useMemo } from 'react'
import type { LayoutResult } from '@shared/layout/types'
import { topicsInBox, type DropPoint, type DropRect } from '@shared/model/drop'
import { activeRoot, activeSheet, findTopic } from '@shared/model/tree'
import type { ThemeColors, Workbook } from '@shared/model/types'
import {
  applyTopicFilter,
  hitTopicIds,
  isFilterActive,
  searchSheet,
  type TopicFilter
} from '@shared/search'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { branchColorOf } from '../../render/theme'
import type { SearchState } from '../../store/editor'
import type { useCanvasGeometry } from './use-canvas-geometry'
import type { DragVisual, useNodeDrag } from './use-node-drag'
import type { Marquee } from './use-marquee-select'

/**
 * 画布的**展示层派生值**（自 `Canvas.tsx` 整块搬出，函数体逐字未改）。
 *
 * 一组「纯计算、无 effect、没有顺序语义」的 `useMemo`：落点预览（空位框 / 插入线）、左右对调
 * 预览、多选徽标、视口裁剪（可见节点 / 可见连线）、搜索命中、筛选结果、拖拽焦点集、框选高亮、
 * 拖拽带来的连线两分。**只有 effect 有顺序语义**——它们不写任何外部状态，可以整块搬。
 *
 * **调用点**落在原来这组 memo 的位置（原 L602）：必须排在 `useCanvasGeometry(...)` /
 * `useNodeDrag(...)` / `useMarqueeSelect(...)` 之后（它读 `dropIndex` / `axesOf` / `growthAxis` /
 * `insertAxis` / `dropTarget` / `dropLabel` / `sideTarget` / `marquee`），且排在读 `dragSet` 的
 * effect 之前。**依赖数组逐字保留**：它们读的就是外面传进来的同一个值（`layout` / `colors` /
 * `pan` / `zoom` / `size` / `editingId` / `search` / `filter`），memo 的重算时机与搬迁前同拍。
 *
 * 返回值**不写显式类型**：结果是「可空对象 + 判别式联合」（`dropPreview` 是
 * `{kind:"bar"…} | {kind:"slot"…} | null`），手抄只会成为第二份真相；画布按名字解构即可。
 */

type Geometry = ReturnType<typeof useCanvasGeometry>
type NodeDrag = ReturnType<typeof useNodeDrag>

interface Deps {
  layout: LayoutResult
  workbook: Workbook
  /** 当前生效的主题配色（画布里那个 `themeColorsOf(workbook)` 的 memo） */
  colors: ThemeColors
  /** 手里抓着的那一个（多选时是抓的那个）在拖拽期间的可视状态 */
  dragVisual: DragVisual | null
  dropTarget: NodeDrag['dropTarget']
  dropLabel: NodeDrag['dropLabel']
  sideTarget: NodeDrag['sideTarget']
  dropIndex: Geometry['dropIndex']
  axesOf: Geometry['axesOf']
  growthAxis: Geometry['growthAxis']
  insertAxis: Geometry['insertAxis']
  /** 左键框选矩形（容器局部坐标），由 `useMarqueeSelect` 持有 */
  marquee: Marquee | null
  zoom: number
  pan: { x: number; y: number }
  size: { width: number; height: number }
  editingId: string | null
  search: SearchState
  filter: TopicFilter
}

export function useCanvasDisplay({
  layout,
  workbook,
  colors,
  dragVisual,
  dropTarget,
  dropLabel,
  sideTarget,
  dropIndex,
  axesOf,
  growthAxis,
  insertAxis,
  marquee,
  zoom,
  pan,
  size,
  editingId,
  search,
  filter
}: Deps) {
  /**
   * 落点预览，**两种落点各用一套、绝不混用**：
   *
   * - **成为子主题**（`child`）：画出被拖主题将要占据的**空位框**（实线、框里写标题、
   *   框下写「将成为『**目标名**』的子主题」），并从目标**子节点那一列**的边缘接一条实线过去。
   *   特意不从目标本体拉线：目标往往已有子节点，从它身上拉线会斜穿那些子节点，看着像连错。
   *   **提示必须带上目标名**：新子节点排在最后一个子节点之后，空位框常常离目标很远
   *   （放中心主题下面时，框会出现在它最后一个分支的下方），只写「将成为子主题」的话
   *   用户会以为目标就是框旁边的那个节点。
   *
   * - **插到同级之间**（`before` / `after`）：只在目标与相邻兄弟之间画一条**短粗插入线**
   *   （Xmind / 知犀那套「插入位置条」）。不再画空位框，更不再把父级框起来——
   *   之前那套"父级琥珀框 + 远处一个大空位框"就是用户看到的自相矛盾提示。
   *
   * 方向轴全部由 `axesOf` / `zoneForPointer` 从实际坐标推出，不按结构名写特例。
   */
  const dropPreview = useMemo(() => {
    if (!dragVisual || !dropTarget) return null
    const dragged = layout.nodeMap.get(dragVisual.anchorId)
    const target = layout.nodeMap.get(dropTarget.id)
    if (!dragged || !target) return null

    const centerOf = (rect: DropRect): DropPoint => ({
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2
    })
    /** 从矩形中心朝某点看，求与矩形边框的交点——连线要接在边框上而不是中心 */
    const border = (rect: DropRect, toward: DropPoint): DropPoint => {
      const c = centerOf(rect)
      const dx = toward.x - c.x
      const dy = toward.y - c.y
      if (dx === 0 && dy === 0) return c
      const sx = dx === 0 ? Number.POSITIVE_INFINITY : rect.width / 2 / Math.abs(dx)
      const sy = dy === 0 ? Number.POSITIVE_INFINITY : rect.height / 2 / Math.abs(dy)
      const scale = Math.min(sx, sy)
      return { x: c.x + dx * scale, y: c.y + dy * scale }
    }

    const root = activeRoot(workbook)
    const pair = axesOf(dropTarget.id)
    const growth = growthAxis(pair)
    const color = branchColorOf(colors, layout, dropTarget.id)
    const title = dropLabel
    /**
     * 目标主题的名字：**提示必须写出"成为谁的子主题"**。
     *
     * 新子节点总是排在**最后一个子节点之后**，所以空位框经常画在离目标很远的下游
     * （「放中心主题下面」时，框会出现在中心主题最后一个分支的下方）。只写「将成为子主题」
     * 的话，用户只能从框的位置反推目标——于是必然读成"要成为那个框旁边的节点的子主题"，
     * 表现就是「我明明放中心主题下面，怎么连到分支主题 2 下面去了」。把名字写进提示，
     * 这件事才有唯一答案。
     */
    const rawTarget = findTopic(root, dropTarget.id)?.title ?? ''
    /**
     * 没有标题的目标也要说清是谁——用「未命名节点」而不是退回通用文案。
     * 画布上允许存在空标题节点（新建节点就是空标题 + 直接进编辑态），
     * 一旦退回「将成为子主题」，用户就又变回"不知道落在谁身上"，
     * 而"是不是中心主题"恰恰是他最需要确认的那件事。
     */
    const targetTitle = rawTarget.trim().length > 0 ? rawTarget : '未命名节点'

    if (dropTarget.mode !== 'child') {
      // 同级插入：一条夹在"目标与相邻兄弟之间"的粗线（Xmind / 知犀那套"插入位置条"）。
      // 方向轴与 `zoneForPointer` 共用同一个 `insertAxis`，保证「线画在哪一侧、就插到哪一侧」。
      const direction = insertAxis(dropTarget.id, pair)
      const before = dropTarget.mode === 'before'
      // 线摆在哪一侧：after 摆朝前那一侧、before 摆朝后那一侧（线在两节点中间）
      const front = direction.forward === !before
      const pad = 10
      // 线的长度按**被拖主题**的尺寸来（而不是目标）：用户看到的应当是"我要占下多长一条位置"
      const span = Math.max(target.height, dragged.height) / 2 + pad
      const spanX = Math.max(target.width, dragged.width) / 2 + pad
      const bar =
        direction.axis === 'x'
          ? {
              x1: front ? target.x + target.width + 7 : target.x - 7,
              y1: centerOf(target).y - span,
              x2: front ? target.x + target.width + 7 : target.x - 7,
              y2: centerOf(target).y + span
            }
          : {
              x1: centerOf(target).x - spanX,
              y1: front ? target.y + target.height + 7 : target.y - 7,
              x2: centerOf(target).x + spanX,
              y2: front ? target.y + target.height + 7 : target.y - 7
            }
      return { kind: 'bar' as const, bar, color, title, targetTitle }
    }

    // 成为子主题：排在最后一个已有子节点之后
    const childRects: DropRect[] = []
    for (const child of findTopic(root, dropTarget.id)?.children ?? []) {
      const rect = layout.nodeMap.get(child.id)
      if (rect) childRects.push(rect)
    }
    const base = childRects[childRects.length - 1] ?? target
    // 空位框紧贴目标自己的列（gap 只留一点），不按普通兄弟间距摆——
    // 它要看起来像"这个主题新长出来的那一支"，而不是另起一列
    const gap = 12
    const slot: DropRect =
      growth.axis === 'x'
        ? {
            x: growth.forward ? base.x + base.width + gap : base.x - gap - dragged.width,
            y: base.y + base.height / 2 - dragged.height / 2,
            width: dragged.width,
            height: dragged.height
          }
        : {
            x: base.x + base.width / 2 - dragged.width / 2,
            y: growth.forward ? base.y + base.height + gap : base.y - gap - dragged.height,
            width: dragged.width,
            height: dragged.height
          }
    // 目标还没有子节点时，从目标朝生长方向的边框接出去；有子节点时从那一列接出去
    const origin: DropPoint =
      growth.axis === 'x'
        ? {
            x: growth.forward ? target.x + target.width + 10 : target.x - 10,
            y: centerOf(slot).y
          }
        : {
            x: centerOf(slot).x,
            y: growth.forward ? target.y + target.height + 10 : target.y - 10
          }

    return {
      kind: 'slot' as const,
      slot,
      from: origin,
      to: border(slot, origin),
      color,
      title,
      targetTitle
    }
  }, [dragVisual, dropTarget, dropLabel, layout, workbook, colors, axesOf, growthAxis, insertAxis])

  /** 左右对调的预览：把被拖的一级主题镜像到中心主题的另一侧 */
  const sideFlipPreview = useMemo(() => {
    if (!sideTarget || !dragVisual) return null
    const rootTopic = activeRoot(workbook)
    const rootRect = layout.nodeMap.get(rootTopic.id)
    const selfRect = layout.nodeMap.get(dragVisual.anchorId)
    if (!rootRect || !selfRect) return null
    const centerX = rootRect.x + rootRect.width / 2
    return {
      x: 2 * centerX - (selfRect.x + selfRect.width),
      y: selfRect.y,
      width: selfRect.width,
      height: selfRect.height,
      title: selfRect.topic.title,
      color: branchColorOf(colors, layout, dragVisual.anchorId)
    }
  }, [sideTarget, dragVisual, layout, workbook, colors])

  /**
   * 多选拖拽时在被抓的那个主题角上挂一个「N 个主题」的小徽标。
   * 一群人一起走的时候，光看透明度分不出到底拖走几个，
   * 有个数字就能立刻确认"这次拖的是不是我要的那几个"。
   */
  const groupBadge = useMemo(() => {
    if (!dragVisual || dragVisual.group <= 1) return null
    const anchor = layout.nodeMap.get(dragVisual.anchorId)
    if (!anchor) return null
    return {
      x: anchor.x + anchor.width + dragVisual.dx + 6,
      y: anchor.y + dragVisual.dy - 10,
      text: `${dragVisual.group} 个主题`
    }
  }, [dragVisual, layout])

  /* ---- 视口裁剪：只渲染可见范围内的节点 ---- */
  const visibleNodes = useMemo(() => {
    if (size.width === 0 || size.height === 0) return layout.nodes
    const margin = 260 / zoom
    const x0 = -pan.x / zoom - margin
    const y0 = -pan.y / zoom - margin
    const x1 = (size.width - pan.x) / zoom + margin
    const y1 = (size.height - pan.y) / zoom + margin
    return layout.nodes.filter(
      (n) =>
        n.id === editingId ||
        (n.x + n.width >= x0 && n.x <= x1 && n.y + n.height >= y0 && n.y <= y1)
    )
  }, [layout, pan.x, pan.y, zoom, size.width, size.height, editingId])

  /* ---- 搜索命中与筛选：面板与画布共用 store 里的同一份条件 ---- */
  const sheet = useMemo(() => activeSheet(workbook), [workbook])

  // 搜索词用防抖后的值：每敲一个键都要全树扫一遍，大文档下纯属白费
  const activeQuery = useDebouncedValue(search.query)

  const searchHits = useMemo(
    () =>
      activeQuery.trim().length > 0
        ? hitTopicIds(searchSheet(sheet, activeQuery, search.options))
        : null,
    [sheet, activeQuery, search.options]
  )

  const filterResult = useMemo(
    () => (isFilterActive(filter) ? applyTopicFilter(sheet.rootTopic, filter) : null),
    [sheet, filter]
  )

  /**
   * 连线裁剪：按**边的包围盒**（两端节点矩形的外接框，外扩余量）与视口求交。
   *
   * 之前按「两端节点是否可见」过滤——长连线的两端都被裁掉时，
   * 即使线身横穿屏幕中央，整条线也会凭空消失（用户报的"连线过长导致连线消失"）。
   */
  const visibleEdges = useMemo(() => {
    if (size.width === 0 || size.height === 0) return layout.edges
    const margin = 260 / zoom
    const x0 = -pan.x / zoom - margin
    const y0 = -pan.y / zoom - margin
    const x1 = (size.width - pan.x) / zoom + margin
    const y1 = (size.height - pan.y) / zoom + margin
    return layout.edges.filter((edge) => {
      const from = layout.nodeMap.get(edge.fromId)
      const to = layout.nodeMap.get(edge.toId)
      if (!from || !to) return false
      const ex0 = Math.min(from.x, to.x) - margin
      const ex1 = Math.max(from.x + from.width, to.x + to.width) + margin
      const ey0 = Math.min(from.y, to.y) - margin
      const ey1 = Math.max(from.y + from.height, to.y + to.height) + margin
      // 外接框与可见矩形相交才保留
      return ex1 >= x0 && ex0 <= x1 && ey1 >= y0 && ey0 <= y1
    })
  }, [layout.edges, layout.nodeMap, pan.x, pan.y, zoom, size.width, size.height])

  /**
   * 正在被拖拽的主题（多选时是一整群）连同它们的**整棵子树**。
   * 必须整棵一起移动：只挪自己会让子节点的连接线留在原地、看起来像断了一地。
   */
  const dragSet = useMemo(() => (dragVisual ? new Set(dragVisual.moving.ids) : null), [dragVisual])

  /**
   * 拖拽时把连线分成两拨：
   * - staticEdges：留在原地的那部分。其中「父节点 → 被拖节点」这条**特意去掉**，
   *   也就是视觉上把原来的连接断开；
   * - dragEdges：子树内部的连线，稍后跟着节点一起平移重画。
   */
  const staticEdges = useMemo(
    () => (dragSet ? visibleEdges.filter((edge) => !dragSet.has(edge.toId)) : visibleEdges),
    [visibleEdges, dragSet]
  )
  const dragEdges = useMemo(
    () =>
      dragSet
        ? visibleEdges.filter((edge) => dragSet.has(edge.toId) && dragSet.has(edge.fromId))
        : [],
    [visibleEdges, dragSet]
  )

  /**
   * 框选过程中「**将要被选中**」的节点：边拖边亮，不用等松手才知道圈到了谁。
   *
   * 判定与松手时**共用 `topicsInBox`**：亮了就一定选中，不会出现"亮了却没选中"。
   * 矩形要从容器局部坐标换算到世界坐标（减平移、除缩放），否则缩放后框会错位。
   */
  const marqueeHits = useMemo(() => {
    if (!marquee) return null
    const box: DropRect = {
      x: (Math.min(marquee.x0, marquee.x1) - pan.x) / zoom,
      y: (Math.min(marquee.y0, marquee.y1) - pan.y) / zoom,
      width: Math.abs(marquee.x1 - marquee.x0) / zoom,
      height: Math.abs(marquee.y1 - marquee.y0) / zoom
    }
    return new Set(
      topicsInBox(
        layout.nodes.map((node) => ({
          id: node.id,
          rect: { x: node.x, y: node.y, width: node.width, height: node.height }
        })),
        box
      )
    )
  }, [marquee, pan.x, pan.y, zoom, layout.nodes])

  /**
   * 拖拽时的**焦点集**：被拖子树 + 落点目标（连它的父级一起留，给点上下文）。
   *
   * 其余节点与连线在拖拽期间**轻淡**下去。理由是用户的一句原话——"画面真的非常乱"：
   * 一屏几百个节点、同色同亮、还夹着一堆自由摆放的，落点提示再正确也会被淹没。
   * 只淡不隐：参照还在，用户知道自己拖在图里的哪一块。
   */

  const dragFocus = useMemo(() => {
    if (!dragSet) return null
    const keep = new Set(dragSet)
    if (dropTarget) {
      keep.add(dropTarget.id)
      const parentId = dropIndex.parentOf.get(dropTarget.id)
      if (parentId) keep.add(parentId)
    }
    return keep
  }, [dragSet, dropTarget, dropIndex])

  return {
    dropPreview,
    sideFlipPreview,
    groupBadge,
    visibleNodes,
    searchHits,
    filterResult,
    staticEdges,
    dragEdges,
    dragSet,
    marqueeHits,
    dragFocus
  }
}
