import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import { createLayoutCache, layoutSheetCached } from '@shared/layout'
import type { LayoutResult } from '@shared/layout/types'
import { OVERLAY_TITLE_LINE_HEIGHT, overlayTitleLines } from '@shared/layout/overlays'
import { readOverlayTextStyle } from '@shared/model/overlay-style'
import type { RichText, Topic } from '@shared/model/types'
import { activeRoot, activeSheet, countTopics, findTopic, type FoldSide } from '@shared/model/tree'
import type { DragMove } from '@shared/model/dragmove'
import { topicsInBox, type DropPoint, type DropRect } from '@shared/model/drop'
import { applyTopicFilter, hitTopicIds, isFilterActive, searchSheet } from '@shared/search'
import { measureTopic, bumpMeasureEpoch } from '../render/measure'
import { beginCost, count, isDiagArmed, mark, setStage } from '../dev/stage'
import { usePacedWorkbook } from '../hooks/usePacedWorkbook'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { clearFormulaCache } from '../render/formula'
import { branchColorOf } from '../render/theme'
import { attrTranslate, cssTranslate } from '../render/transform'
import { themeColorsOf, useEditor } from '../store/editor'
import TopicNode from './TopicNode'
import { clipText } from './canvas/clip-text'
import { useCanvasGeometry } from './canvas/use-canvas-geometry'
import { useCanvasViewport } from './canvas/use-canvas-viewport'
import { useFlashNodes } from './canvas/use-flash-nodes'
import { useFoldAnchor } from './canvas/use-fold-anchor'
import { useViewFollow } from './canvas/use-view-follow'
import { useWheelPanZoom } from './canvas/use-wheel-pan-zoom'
import { useNodeDrag } from './canvas/use-node-drag'

export default function Canvas(): ReactElement {
  // 每秒渲染次数：数字爆表就是「重渲染风暴」，是这类卡死最常见的形态
  count('画布渲染')

  const containerRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  /* ---- 闪一下：状态、定时器与清理 effect 整块搬进 canvas/use-flash-nodes.ts ---- */
  const { flashIds, flashNodes } = useFlashNodes()
  const workbook = useEditor((s) => s.workbook)
  /** AI 回合进行中？（面板那边开的事务）——只用来决定「布局要不要节流」 */
  const aiTurnActive = useEditor((s) => s.aiTurn !== null)
  /**
   * **布局**用节流后的工作簿：AI 批量写入时把重排合并到每 ~100ms 一次。
   *
   * 只影响 layout 的输入：节点文字、选中态、悬停等仍然实时读 `workbook`，
   * 所以「数据不是旧的，只是位置晚一拍」。用户自己的操作不受影响（不在 AI 回合里时零延迟）。
   */
  const layoutWorkbook = usePacedWorkbook(workbook, aiTurnActive)
  const docSeq = useEditor((s) => s.docSeq)
  const zoom = useEditor((s) => s.zoom)
  const pan = useEditor((s) => s.pan)
  const viewLock = useEditor((s) => s.viewLock)
  const lastFold = useEditor((s) => s.lastFold)
  const selection = useEditor((s) => s.selection)
  const selectedOverlay = useEditor((s) => s.selectedOverlay)
  const editingId = useEditor((s) => s.editingId)
  const editingText = useEditor((s) => s.editingText)
  const editingRich = useEditor((s) => s.editingRich)
  const setPan = useEditor((s) => s.setPan)
  const setZoom = useEditor((s) => s.setZoom)
  const search = useEditor((s) => s.search)
  const filter = useEditor((s) => s.filter)

  const [dragVisual, setDragVisual] = useState<{
    /** 手里抓着的那一个（多选时是抓的那个，不是整群的第一个） */
    anchorId: string
    dx: number
    dy: number
    moving: DragMove
    /** 整群被拖时，用来把「点谁拖谁」说明白 */
    group: number
  } | null>(null)
  /** 左键框选：矩形用容器内的局部坐标，便于直接定位 */
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null
  )

  /** 双击画布上的边界/概要/关系线标题后，就地编辑文字 */
  const [titleEdit, setTitleEdit] = useState<{
    kind: 'boundary' | 'summary' | 'relationship'
    id: string
    x: number
    y: number
    anchor: 'start' | 'middle' | 'end'
    value: string
  } | null>(null)
  /** Esc 取消时置位，避免失焦又把取消的内容写回去 */
  const cancelTitleRef = useRef(false)

  /** 正在拖拽的关系线端点（拖到别的主题上即可改接） */
  const [handleDrag, setHandleDrag] = useState<{
    relationshipId: string
    end: 'end1Id' | 'end2Id'
    /** 不动的那一端（世界坐标），用来画预览线 */
    anchor: { x: number; y: number }
    pointer: { x: number; y: number }
    targetId: string | null
  } | null>(null)

  /* ---- 供原生事件处理器读取的最新值 ---- */
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const panRef = useRef(pan)
  panRef.current = pan
  const rootRef = useRef<Topic>(activeRoot(workbook))
  rootRef.current = activeRoot(workbook)

  /**
   * 拖拽过程中的「实时值」都放在 ref 里：原生 pointermove 是每帧都可能触发的高频回调，
   * 走 state 会慢半拍，落点会明显跟不上指针。
   */
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  /**
   * 「手上正按着一个节点」——从 pointerdown 到松手 / 取消之间为 true。
   *
   * 视角锁定的跟随循环必须在这段时间**一动不动**：按下就等于选中，`focusId` 一变
   * 镜头立刻开始缓动到那个节点——用户看到的就是"长按节点会有一个小的视角跳转"。
   * 而镜头一动，指针下的节点就跟着世界滑动（用户说的"飘逸"）。
   *
   * 为什么不能只判断 `dragVisual`：它要等指针越过 4px 阈值才置位，
   * 而按下的那一瞬间镜头已经在跳了。
   */
  const nodePointerHeldRef = useRef(false)

  /* ---- 布局计算 ---- */
  /**
   * 字体（含 KaTeX 的数学字体）加载完成后，公式的真实宽度才稳定。
   * 这里用它触发一次重新测量与布局，避免首次打开时公式框尺寸偏小。
   */
  const [fontEpoch, setFontEpoch] = useState(0)

  useEffect(() => {
    let cancelled = false
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    if (!fonts) return
    void fonts.ready.then(() => {
      if (cancelled) return
      setStage('字体就绪后重算')
      // 两处缓存都要失效：公式尺寸缓存 + 节点测量缓存（后者里存着 formulaBox）
      clearFormulaCache()
      bumpMeasureEpoch()
      setFontEpoch((n) => n + 1)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const renderEpoch = useEditor((s) => s.renderEpoch)

  /**
   * 布局缓存（跨渲染保留）。
   *
   * 有了它，这一格的代价就从「每次击键整图重排」变成「只重算真的变了的那一支」
   * （见 `@shared/layout/incremental.ts`）：输入没变时直接还上一轮的对象，
   * 只有编辑中的节点换了文字、尺寸没变时就只换那一个节点。
   */
  const layoutCacheRef = useRef(createLayoutCache())

  const layout: LayoutResult = useMemo(() => {
    // 注意用 layoutWorkbook（节流后）：AI 一挥而就的几十次写入不必次次整图重排
    const root = activeRoot(layoutWorkbook)
    const sheet = activeSheet(layoutWorkbook)
    // 正在编辑的节点用「未提交的内容」参与测量，做到边打字边自适应尺寸
    const measure = (topic: Topic, depth: number): ReturnType<typeof measureTopic> =>
      topic.id === editingId && editingRich
        ? measureTopic({ ...topic, title: editingText, titleRich: editingRich }, depth)
        : measureTopic(topic, depth)
    // 关系线/边界/概要在结构布局之后按最终坐标计算，所以要把画布数据一起传进去
    count('画布布局')
    setStage('画布布局')
    // 进这一阶段先落一行：布局是「写完之后的提交/排版」里最重的一步，
    // 真卡死时最后一条就是它，且带上节点数（内容依赖型问题一眼能看出来）
    const endLayout = beginCost('画布布局', isDiagArmed() ? `节点 ${countTopics(root)}` : '')
    /**
     * 编辑态的节点要显式当"脏"传进去：它的文字还没提交，工作簿里的对象没变，
     * 靠引用比较看不出来（宽度却在每个键上都变）。
     */
    const computed = layoutSheetCached(
      root,
      measure,
      {},
      sheet,
      layoutCacheRef.current,
      `${fontEpoch}:${renderEpoch}`,
      editingId ? [editingId] : []
    )
    endLayout()
    setStage('画布布局完成')
    return computed
  }, [layoutWorkbook, editingId, editingText, editingRich, fontEpoch, renderEpoch])

  /**
   * 渲染提交（DOM 落定）后的界标，与「进入 画布布局」配对。
   *
   * 卡死时最后一条日志落在哪一边，就直接指认了性质：
   * 「进入 画布布局」→ 卡在计算；「画布提交完成」→ 卡在 DOM 提交（例如 token span 爆炸）。
   */
  useEffect(() => {
    mark('画布提交完成', `节点 ${layout.nodes.length}`)
  }, [layout])

  const layoutRef = useRef<LayoutResult>(layout)
  layoutRef.current = layout

  /**
   * 吸附用的候选节点表：每帧都要扫一遍，所以按布局算一次就够。
   * 带上 `depth`：距离相同时优先落进更深的节点（和成熟实现一致，见 `nearestInRegion`）。
   */
  const dropCandidates = useMemo(
    () => layout.nodes.map((node) => ({ id: node.id, rect: node, depth: node.depth })),
    [layout]
  )

  /** 当前画布生效的主题配色 */
  const colors = useMemo(() => themeColorsOf(workbook), [workbook])

  /**
   * 边界按颜色分组：同色的多个边界拼成一条 path 一次性填充。
   * 这样即使两个边界区域重叠，也不会因为半透明填充叠加而显得颜色更深。
   */
  const boundaryGroups = useMemo(() => {
    const groups = new Map<string, { d: string; titles: typeof layout.boundaries }>()
    for (const boundary of layout.boundaries) {
      const color = boundary.branchId
        ? branchColorOf(colors, layout, boundary.branchId)
        : colors.deepText
      const entry = groups.get(color) ?? { d: '', titles: [] }
      entry.d = entry.d.length > 0 ? `${entry.d} ${boundary.d}` : boundary.d
      entry.titles.push(boundary)
      groups.set(color, entry)
    }
    return Array.from(groups.entries()).map(([color, entry]) => ({ color, ...entry }))
  }, [layout, colors])

  /* ---- 容器尺寸 ---- */
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    /**
     * 尺寸**真的变了**才写进状态。
     *
     * 以前无条件 `setSize({ width, height })`：每次都是新对象 → React 必然重渲染 →
     * 重渲染又可能让被观察的容器尺寸抖动一个像素 → 观察器再触发……一旦勾上就是**自激循环**，
     * 主线程被烧满、窗口连关闭都点不动（日志里的连续 `unresponsive` 就是这么来的）。
     * 尺寸没变时返回原对象，React 会直接跳过这次更新，环就断了。
     */
    const update = (): void => {
      count('容器尺寸回调')
      const width = el.clientWidth
      const height = el.clientHeight
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /**
   * 用户「接管视角」的次数（滚轮、拖拽平移、缩放都算）。
   *
   * 视角锁定是**自动**动镜头，用户手动操作是**意图**——两者同时动镜头就会互相对拉：
   * 你往下滚一屏，跟随循环每帧把镜头往回拽 22%，看起来就是「上下抽动一阵」，
   * 直到 240 帧止损才停（长文档里滚动多，所以「画面一长就抽风」）。
   * 「正在拖主题就不跟」这条规则早就有，但**滚轮一直漏着**——而滚轮才是浏览长文档的主要方式。
   * 这里给跟随循环一个让位信号：用户一旦自己动过视角，本轮跟随立刻退出；
   * 下一次选择变化 / 目标几何变化时重新咬住（与拖拽之后的行为一致）。
   */
  const viewGestureAtRef = useRef(0)

  /* ---- 视口动作：整块搬进 canvas/use-canvas-viewport.ts（含注册与可见性两个 effect，位置不变） ---- */
  const { centerRoot } = useCanvasViewport({
    containerRef,
    layoutRef,
    zoomRef,
    panRef,
    rootRef,
    viewGestureAtRef,
    setPan,
    setZoom,
    flashNodes,
    editingId,
    viewLock
  })

  /* ---- 视角锁定：整块搬进 canvas/use-view-follow.ts（两条 effect 的次序不变） ---- */
  useViewFollow({
    selection,
    workbook,
    layout,
    viewLock,
    dragVisual,
    nodePointerHeldRef,
    editingId,
    zoom,
    size,
    setPan,
    containerRef,
    layoutRef,
    zoomRef,
    panRef,
    viewGestureAtRef
  })
  /* ---- 折叠锚点：整块搬进 canvas/use-fold-anchor.ts ---- */
  useFoldAnchor({ layout, lastFold, setPan, zoomRef, panRef, viewGestureAtRef })
  /* ---- 新文档打开后居中 ---- */
  const centeredSeqRef = useRef(-1)
  useEffect(() => {
    if (size.width === 0 || size.height === 0) return
    if (centeredSeqRef.current === docSeq) return
    centeredSeqRef.current = docSeq
    centerRoot()
  }, [size.width, size.height, docSeq, centerRoot])

  /* ---- 滚轮：整块搬进 canvas/use-wheel-pan-zoom.ts ---- */
  useWheelPanZoom({ containerRef, zoomRef, panRef, viewGestureAtRef, setPan, setZoom })
  /* ---- 命中测试与坐标换算 / 落点几何：整块搬进 canvas/，此处按名字解构 ---- */
  const {
    dropIndex,
    siblingStacks,
    screenToWorld,
    hitTest,
    axesOf,
    growthAxis,
    insertAxis,
    snapRegionOf,
    zoneForPointer,
    sideFlipTarget
  } = useCanvasGeometry({ containerRef, zoomRef, panRef, layoutRef, rootRef, workbook, layout })

  /* ---- 拖动节点：落点 state / ref / 自动滚动 / 处理器整块搬进 canvas/use-node-drag.ts ---- */
  const {
    dropTarget,
    sideTarget,
    dropLabel,
    freeDrop,
    dropBlocked,
    ghostElsRef,
    dragEdgesRef,
    ghostOffsetRef,
    handleNodePointerDown
  } = useNodeDrag({
    containerRef,
    panRef,
    rootRef,
    zoomRef,
    selectionRef,
    nodePointerHeldRef,
    dropCandidates,
    screenToWorld,
    siblingStacks,
    sideFlipTarget,
    snapRegionOf,
    zoneForPointer,
    setPan,
    setDragVisual
  })
  /* ---- 拖动关系线的端点改接 ---- */
  const handleRelationshipPointerDown = useCallback(
    (
      e: ReactPointerEvent<SVGCircleElement>,
      relationshipId: string,
      end: 'end1Id' | 'end2Id',
      anchor: { x: number; y: number }
    ): void => {
      if (e.button !== 0) return
      // 必须阻止冒泡，否则画布会把这次按下当成「拖拽平移」
      e.stopPropagation()
      const store = useEditor.getState()
      if (store.editingId) store.commitEdit()

      const origin = screenToWorld(e.clientX, e.clientY)
      setHandleDrag({ relationshipId, end, anchor, pointer: origin, targetId: null })

      const onMove = (ev: PointerEvent): void => {
        const world = screenToWorld(ev.clientX, ev.clientY)
        setHandleDrag((current) =>
          current ? { ...current, pointer: world, targetId: hitTest(world.x, world.y) } : current
        )
      }
      const detach = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
      }
      const onCancel = (): void => {
        detach()
        setHandleDrag(null)
      }
      const onUp = (ev: PointerEvent): void => {
        detach()
        const world = screenToWorld(ev.clientX, ev.clientY)
        const target = hitTest(world.x, world.y)
        setHandleDrag(null)
        if (target) useEditor.getState().setRelationshipEnd(relationshipId, end, target)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
    },
    [hitTest, screenToWorld]
  )

  /* ---- 双击标题就地编辑 ---- */
  const commitTitleEdit = useCallback((): void => {
    const target = titleEditRef.current
    if (!target) return
    if (cancelTitleRef.current) {
      cancelTitleRef.current = false
      setTitleEdit(null)
      return
    }
    const store = useEditor.getState()
    if (target.kind === 'boundary') store.setBoundaryTitle(target.id, target.value)
    else if (target.kind === 'summary') store.setSummaryTitle(target.id, target.value)
    else store.setRelationshipTitle(target.id, target.value)
    setTitleEdit(null)
  }, [])

  // 编辑过程中输入框的值是最新来源，用 ref 保证失焦提交读到的是最新内容
  const titleEditRef = useRef(titleEdit)
  titleEditRef.current = titleEdit

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

  /** 选中画布元素（概要 / 边界 / 关系线）并打开属性面板：文字、字体、删除都在面板里 */
  const pickOverlay = useCallback(
    (
      event: ReactPointerEvent<SVGElement>,
      kind: 'summary' | 'boundary' | 'relationship',
      id: string
    ): void => {
      event.stopPropagation()
      const store = useEditor.getState()
      store.selectOverlay(kind, id)
      store.requestNodePanel()
    },
    []
  )

  /* ---- 拖动关系线的线身：整体移动弧线（弯度偏移） ---- */
  const handleCurvePointerDown = useCallback(
    (e: ReactPointerEvent<SVGPathElement>, relationshipId: string): void => {
      if (e.button !== 0) return
      e.stopPropagation()
      const store = useEditor.getState()
      // 点线身 = 选中这条关系线（顺手把属性面板打开），拖才改弯度：
      // 否则「点一下线上什么都没有发生」，看起来就像这条线选不中
      store.selectOverlay('relationship', relationshipId)
      store.requestNodePanel()
      if (store.editingId) store.commitEdit()

      let lastX = e.clientX
      let lastY = e.clientY

      const onMove = (ev: PointerEvent): void => {
        const z = zoomRef.current
        const dx = (ev.clientX - lastX) / z
        const dy = (ev.clientY - lastY) / z
        lastX = ev.clientX
        lastY = ev.clientY
        if (dx === 0 && dy === 0) return
        useEditor.getState().offsetRelationshipCurve(relationshipId, dx, dy)
      }
      const detach = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }
      const onUp = (): void => detach()

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    []
  )

  /* ---- 节点回调：全部只走 useEditor.getState() / ref 拿最新值，引用永远稳定 ---- */
  /**
   * TopicNode 有 memo，但只要这里传进去的回调每次渲染都是新函数，
   * 浅比较必然失败、memo 就整个被架空——以前 8 个内联箭头函数正是这样
   * 把「每次 pan 更新」放大成「全部可见节点重渲染」的。
   */
  const handleNodeDoubleClick = useCallback((id: string): void => {
    useEditor.getState().beginEdit(id)
  }, [])
  const handleNodeRichChange = useCallback((id: string, rich: RichText): void => {
    const store = useEditor.getState()
    if (store.editingId === id) store.updateEditingRich(rich)
  }, [])
  const handleNodeCancelEdit = useCallback((): void => {
    useEditor.getState().cancelEdit()
  }, [])
  const handleNodeCommitEdit = useCallback((): void => {
    useEditor.getState().commitEdit()
  }, [])
  const handleNodeCommitAndAddChild = useCallback((): void => {
    useEditor.getState().commitAndAddChild()
  }, [])
  const handleNodeCommitAndAddSibling = useCallback((): void => {
    useEditor.getState().commitAndAddSibling()
  }, [])
  const handleNodeNavigateEdit = useCallback(
    (key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'): void => {
      // 空主题上的方向键：先提交（空内容不会进撤销栈），再移动选择
      const store = useEditor.getState()
      if (store.editingId) store.commitEdit()
      store.navigateSelection(key)
    },
    []
  )
  const handleNodeToggleCollapse = useCallback((id: string): void => {
    // 折叠 / 展开会重排整张图：把被点的那个主题**按在原处**，
    // 否则用户眼前的画面会整体跳走（看着看着，那一支忽然不见了）。
    // 视口值走 ref：回调才能保持引用稳定，又不失真（点击瞬间 ref 与渲染值一致）。
    const lay = layoutRef.current
    const z = zoomRef.current
    const p = panRef.current
    const before = lay?.nodeMap.get(id)
    const screen = before ? { x: before.x * z + p.x, y: before.y * z + p.y } : null
    useEditor.getState().toggleCollapse(id)
    if (!screen || !containerRef.current) return
    window.requestAnimationFrame(() => {
      const after = layoutRef.current?.nodeMap.get(id)
      if (!after) return
      // 反解平移量：让 after 的世界坐标仍落在同一个屏幕位置
      useEditor.getState().setPan({ x: screen.x - after.x * z, y: screen.y - after.y * z })
    })
  }, [])

  const handleNodeToggleFoldSide = useCallback((id: string, side: FoldSide): void => {
    /**
     * 平衡思维导图的中心主题：收起/展开某一侧。
     * 与整体折叠同一处理——重排后把被点的中心主题**按在屏幕原处**，
     * 否则用户正看着左侧收起来，画面却整体跳走。
     */
    const lay = layoutRef.current
    const z = zoomRef.current
    const p = panRef.current
    const before = lay?.nodeMap.get(id)
    const screen = before ? { x: before.x * z + p.x, y: before.y * z + p.y } : null
    useEditor.getState().toggleFoldSide(id, side)
    if (!screen || !containerRef.current) return
    window.requestAnimationFrame(() => {
      const after = layoutRef.current?.nodeMap.get(id)
      if (!after) return
      useEditor.getState().setPan({ x: screen.x - after.x * z, y: screen.y - after.y * z })
    })
  }, [])

  /* ---- 空白处：右键/中键拖动平移；左键拖动框选 ---- */
  const handleBackgroundPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      const store = useEditor.getState()
      if (store.editingId) store.commitEdit()
      if (e.button !== 0 && e.button !== 1 && e.button !== 2) return

      // 与 Xmind 一致：右键（或中键）拖动平移画布
      if (e.button === 1 || e.button === 2) {
        e.preventDefault()
        // 手动拖画布＝接管视角（与滚轮同一条规则）
        viewGestureAtRef.current += 1
        const startX = e.clientX
        const startY = e.clientY
        const startPan = { ...panRef.current }
        // pointermove 同样是每秒上百次的高频事件：累进局部变量，每帧最多落账一次
        let raf = 0
        let targetX = startPan.x
        let targetY = startPan.y
        const flush = (): void => {
          raf = 0
          setStage('拖拽平移')
          setPan({ x: targetX, y: targetY })
        }
        const onMove = (ev: PointerEvent): void => {
          targetX = startPan.x + (ev.clientX - startX)
          targetY = startPan.y + (ev.clientY - startY)
          if (raf === 0) raf = window.requestAnimationFrame(flush)
        }
        const detach = (): void => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onCancel)
          if (raf !== 0) window.cancelAnimationFrame(raf)
        }
        const onCancel = (): void => detach()
        // 右键原地点击不应清空选择
        const onUp = (): void => detach()
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onCancel)
        return
      }

      // 左键：框选
      const rect = containerRef.current?.getBoundingClientRect()
      const baseLeft = rect?.left ?? 0
      const baseTop = rect?.top ?? 0
      const startClient = { x: e.clientX, y: e.clientY }
      const startLocal = { x: e.clientX - baseLeft, y: e.clientY - baseTop }
      let moved = false

      const onMove = (ev: PointerEvent): void => {
        const localX = ev.clientX - baseLeft
        const localY = ev.clientY - baseTop
        if (!moved && Math.hypot(localX - startLocal.x, localY - startLocal.y) < 3) return
        moved = true
        setMarquee({ x0: startLocal.x, y0: startLocal.y, x1: localX, y1: localY })
      }
      const detach = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
      }
      const onCancel = (): void => {
        detach()
        setMarquee(null)
      }
      const onUp = (ev: PointerEvent): void => {
        detach()
        setMarquee(null)
        const state = useEditor.getState()

        // 只是点了一下空白：取消选择
        if (!moved) {
          state.select(null)
          return
        }

        const z = zoomRef.current
        const pan = panRef.current
        const toWorld = (client: { x: number; y: number }): { x: number; y: number } => ({
          x: (client.x - baseLeft - pan.x) / z,
          y: (client.y - baseTop - pan.y) / z
        })
        const from = toWorld(startClient)
        const to = toWorld({ x: ev.clientX, y: ev.clientY })
        const minX = Math.min(from.x, to.x)
        const maxX = Math.max(from.x, to.x)
        const minY = Math.min(from.y, to.y)
        const maxY = Math.max(from.y, to.y)

        // 与拖动中的高亮共用同一套判定（`topicsInBox`）：亮了就一定会选中
        const hits = topicsInBox(
          (layoutRef.current?.nodes ?? []).map((node) => ({
            id: node.id,
            rect: { x: node.x, y: node.y, width: node.width, height: node.height }
          })),
          { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
        )

        // 按住 Ctrl 拖动是「追加选择」
        const base = ev.ctrlKey || ev.metaKey ? state.selection : []
        state.setSelection([...base, ...hits])
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
    },
    [setPan]
  )

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
  /**
   * 拖拽层（子树内部连线）是 React 渲染的：它**挂载那一刻**还没有位移，
   * 慢慢拖的时候连线会在原处停到下一次 pointermove。这里在它挂载后补一次，
   * 保证"连线和节点永远在同一位置"。
   */
  useEffect(() => {
    if (!dragSet) return
    const offset = ghostOffsetRef.current
    if (!offset) return
    for (const el of ghostElsRef.current) el.style.transform = cssTranslate(offset.dx, offset.dy)
    dragEdgesRef.current?.setAttribute('transform', attrTranslate(offset.dx, offset.dy))
    // 三个 ref 来自 useNodeDrag，身份恒定，列进依赖数组不改本 effect 的重跑时机
  }, [dragSet, ghostElsRef, dragEdgesRef, ghostOffsetRef])

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

  /** 画一条树上的连线。静态层与拖拽层共用，避免样式写两遍。 */
  const renderEdge = (edge: (typeof layout.edges)[number], dim = false): ReactElement => {
    const target = layout.nodeMap.get(edge.toId)
    const isFirstLevel = Boolean(target && target.depth === 1)
    return (
      <path
        key={`${edge.fromId}->${edge.toId}`}
        d={edge.d}
        fill="none"
        stroke={branchColorOf(colors, layout, edge.toId)}
        strokeWidth={isFirstLevel ? colors.edgeWidth * 1.5 : colors.edgeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={colors.edgeOpacity * (dim ? 0.3 : 1)}
      />
    )
  }

  return (
    <div
      ref={containerRef}
      className="canvas"
      style={{
        backgroundColor: colors.canvas,
        backgroundImage: `radial-gradient(circle, ${colors.grid} 1px, transparent 1px)`
      }}
      onPointerDown={handleBackgroundPointerDown}
      /* 右键用于拖动平移，屏蔽系统右键菜单 */
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="canvas__world"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          width: layout.bounds.width,
          height: layout.bounds.height
        }}
      >
        <svg className="canvas__edges" width={layout.bounds.width} height={layout.bounds.height}>
          {/* 结构专属的装饰线（时间轴主轴、鱼骨图主脊、括号图的括号） */}
          {layout.decorations.map((decoration, index) => (
            <path
              key={`deco-${index}`}
              d={decoration.d}
              fill="none"
              stroke={
                decoration.branchId
                  ? branchColorOf(colors, layout, decoration.branchId)
                  : colors.deepText
              }
              strokeWidth={colors.edgeWidth * (decoration.widthScale ?? 1)}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={decoration.dashed ? 0.5 : colors.edgeOpacity}
              strokeDasharray={decoration.dashed ? '6 5' : undefined}
            />
          ))}

          {/* 边界：同色的多个边界拼成一条 path 一次性填充，
              所以重叠区域不会被半透明叠加成更深的颜色 */}
          {boundaryGroups.map((group) => (
            <path
              key={`boundary-fill-${group.color}`}
              d={group.d}
              fill={group.color}
              fillOpacity={0.08}
              fillRule="nonzero"
              stroke={group.color}
              strokeWidth={1.5}
              strokeOpacity={0.6}
            />
          ))}

          {/* 每个边界一个透明命中区：双击即可改标题。
              单独画是为了能分辨出点中的是哪一个（填充是按颜色合并的） */}
          {layout.boundaries.map((boundary) => (
            <path
              key={`boundary-hit-${boundary.id}`}
              className="overlay-boundary-hit"
              d={boundary.d}
              fill="transparent"
              onPointerDown={(event) => pickOverlay(event, 'boundary', boundary.id)}
              onDoubleClick={() =>
                setTitleEdit({
                  kind: 'boundary',
                  id: boundary.id,
                  x: boundary.label.x,
                  y: boundary.label.y,
                  anchor: 'start',
                  value: boundary.title ?? ''
                })
              }
            />
          ))}

          {/* 选中边界的虚线框（与概要一致：选中就能在面板里改文字与字体） */}
          {layout.boundaries.map((boundary) =>
            selectedOverlay?.kind === 'boundary' &&
            selectedOverlay.id === boundary.id &&
            boundary.bounds ? (
              <rect
                key={`boundary-selected-${boundary.id}`}
                className="overlay-selected"
                x={boundary.bounds.x - 5}
                y={boundary.bounds.y - 5}
                width={boundary.bounds.width + 10}
                height={boundary.bounds.height + 10}
                rx={6}
              />
            ) : null
          )}

          {/* 边界标题单独画，保证文字在填充之上 */}
          {layout.boundaries.map((boundary) => {
            const boundaryText = readOverlayTextStyle(boundary.style, { fontSize: 12, bold: true })
            return boundary.title ? (
              <text
                key={`boundary-title-${boundary.id}`}
                className="overlay-title"
                x={boundary.label.x}
                y={boundary.label.y}
                fontSize={boundaryText.fontSize}
                fontWeight={boundaryText.bold ? 700 : 400}
                fontStyle={boundaryText.italic ? 'italic' : undefined}
                fill={
                  boundaryText.color ??
                  (boundary.branchId
                    ? branchColorOf(colors, layout, boundary.branchId)
                    : colors.deepText)
                }
                dominantBaseline="middle"
                onPointerDown={(event) => pickOverlay(event, 'boundary', boundary.id)}
                onDoubleClick={() =>
                  setTitleEdit({
                    kind: 'boundary',
                    id: boundary.id,
                    x: boundary.label.x,
                    y: boundary.label.y,
                    anchor: 'start',
                    value: boundary.title ?? ''
                  })
                }
              >
                {/* 边界标题同样支持换行（自上而下排） */}
                {overlayTitleLines(boundary.title).map((line, index) => (
                  <tspan
                    key={index}
                    x={boundary.label.x}
                    dy={index === 0 ? 0 : OVERLAY_TITLE_LINE_HEIGHT}
                  >
                    {line.length > 0 ? line : '\u00A0'}
                  </tspan>
                ))}
              </text>
            ) : null
          })}

          {/* 概要：覆盖一组同级主题的大括号 + 概要文字。
              文字为空时也画占位文字与命中区——否则「把文字删空」之后就再也点不到它了 */}
          {layout.summaries.map((summary) => {
            const color = summary.branchId
              ? branchColorOf(colors, layout, summary.branchId)
              : colors.deepText
            const text = readOverlayTextStyle(summary.style, { fontSize: 13, bold: true })
            const selected =
              selectedOverlay?.kind === 'summary' && selectedOverlay.id === summary.id
            const labelSize = summary.labelSize ?? { width: 48, height: OVERLAY_TITLE_LINE_HEIGHT }
            const labelLeft =
              summary.anchor === 'start'
                ? summary.label.x
                : summary.anchor === 'end'
                  ? summary.label.x - labelSize.width
                  : summary.label.x - labelSize.width / 2
            const openEditor = (): void =>
              setTitleEdit({
                kind: 'summary',
                id: summary.id,
                x: summary.label.x,
                y: summary.label.y,
                anchor: summary.anchor,
                value: summary.title ?? ''
              })
            const pick = (event: ReactPointerEvent<SVGElement>): void =>
              pickOverlay(event, 'summary', summary.id)
            return (
              <g key={`summary-${summary.id}`}>
                <path
                  d={summary.d}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeOpacity={0.75}
                />
                {/* 命中区：括号线（按描边命中）+ 文字块矩形（空文字时也能点到） */}
                <path
                  d={summary.d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={12}
                  className="overlay-hit"
                  onPointerDown={pick}
                  onDoubleClick={openEditor}
                />
                <rect
                  x={labelLeft - 3}
                  y={summary.label.y - labelSize.height / 2 - 3}
                  width={labelSize.width + 6}
                  height={labelSize.height + 6}
                  fill="transparent"
                  className="overlay-hit"
                  onPointerDown={pick}
                  onDoubleClick={openEditor}
                />
                <text
                  className="overlay-title"
                  x={summary.label.x}
                  y={summary.label.y}
                  fontSize={text.fontSize}
                  fontWeight={text.bold ? 700 : 400}
                  fontStyle={text.italic ? 'italic' : undefined}
                  fill={text.color ?? color}
                  textAnchor={summary.anchor}
                  dominantBaseline="middle"
                  /* 用画布色给文字描一圈边，即使压到别的内容上也读得清 */
                  stroke={colors.canvas}
                  strokeWidth={4}
                  paintOrder="stroke"
                  strokeLinejoin="round"
                  /* 空文字时用半透明占位，提示「双击可以输入」 */
                  opacity={summary.title ? 1 : 0.45}
                  pointerEvents="none"
                >
                  {summary.title
                    ? overlayTitleLines(summary.title).map((line, index, all) => (
                        <tspan
                          key={index}
                          x={summary.label.x}
                          dy={
                            index === 0
                              ? -(all.length - 1) * (OVERLAY_TITLE_LINE_HEIGHT / 2)
                              : OVERLAY_TITLE_LINE_HEIGHT
                          }
                        >
                          {line.length > 0 ? line : '\u00A0'}
                        </tspan>
                      ))
                    : '概要（双击输入）'}
                </text>
                {selected && summary.bounds ? (
                  <rect
                    className="overlay-selected"
                    x={summary.bounds.x - 5}
                    y={summary.bounds.y - 5}
                    width={summary.bounds.width + 10}
                    height={summary.bounds.height + 10}
                    rx={4}
                  />
                ) : null}
              </g>
            )
          })}

          {staticEdges.map((edge) =>
            renderEdge(edge, dragFocus !== null && !dragFocus.has(edge.toId))
          )}

          {/*
            子树内部的连线：跟着被拖的节点一起平移重画。
            位移由 `applyGhostTransform` **命令式**写（React 不管这个 transform——
            否则它每帧会用上一帧的状态盖回来，节点反而抖）。
          */}
          {dragSet && dragVisual ? (
            <g ref={dragEdgesRef} opacity={0.9}>
              {dragEdges.map((edge) => renderEdge(edge))}
            </g>
          ) : null}
        </svg>

        {/* 关系线线身的命中层：特意画在节点**下面**。
            否则那 18px 的透明命中区会压在上层，把经过线下方节点的拖拽操作抢走，
            表现为「某些节点怎么都拖不动」。 */}
        <svg className="canvas__overlay" width={layout.bounds.width} height={layout.bounds.height}>
          {layout.relationships.map((relationship) => (
            <path
              key={`hit-${relationship.id}`}
              className="overlay-curve"
              d={relationship.d}
              fill="none"
              stroke="transparent"
              strokeWidth={18}
              strokeLinecap="round"
              onPointerDown={(event) => handleCurvePointerDown(event, relationship.id)}
              onDoubleClick={(event) => {
                event.stopPropagation()
                useEditor.getState().resetRelationshipCurve(relationship.id)
              }}
            >
              <title>拖动可移动这条线；双击恢复自动弯度</title>
            </path>
          ))}
        </svg>

        {visibleNodes.map((node) => (
          <TopicNode
            key={node.id}
            node={node}
            layout={layout}
            colors={colors}
            selected={selection.includes(node.id)}
            editing={editingId === node.id}
            editingRich={editingId === node.id ? editingRich : null}
            highlight={
              dropTarget && dropTarget.mode === 'child' && dropTarget.id === node.id
                ? 'child'
                : dropTarget && dropTarget.mode !== 'child' && dropTarget.id === node.id
                  ? 'sibling'
                  : handleDrag?.targetId === node.id
                    ? 'child'
                    : null
            }
            dragged={Boolean(dragSet?.has(node.id))}
            draggable={node.depth > 0}
            searchHit={searchHits ? searchHits.has(node.id) : false}
            marqueeHit={marqueeHits ? marqueeHits.has(node.id) : false}
            flash={flashIds.has(node.id)}
            dimmed={
              filterResult
                ? !filterResult.keep.has(node.id)
                : dragFocus && !dragFocus.has(node.id)
                  ? 'soft'
                  : false
            }
            dragOffset={
              dragVisual && dragSet?.has(node.id) ? { dx: dragVisual.dx, dy: dragVisual.dy } : null
            }
            dragPrimary={Boolean(dragVisual && dragVisual.anchorId === node.id)}
            onPointerDown={handleNodePointerDown}
            onDoubleClick={handleNodeDoubleClick}
            onRichChange={handleNodeRichChange}
            onCancelEdit={handleNodeCancelEdit}
            onCommitEdit={handleNodeCommitEdit}
            onCommitAndAddChild={handleNodeCommitAndAddChild}
            onCommitAndAddSibling={handleNodeCommitAndAddSibling}
            onNavigateEdit={handleNodeNavigateEdit}
            onToggleCollapse={handleNodeToggleCollapse}
            onToggleFoldSide={handleNodeToggleFoldSide}
          />
        ))}

        {/* 关系线画在节点之上，避免被节点挡住 */}
        <svg className="canvas__overlay" width={layout.bounds.width} height={layout.bounds.height}>
          {layout.relationships.map((relationship) => {
            const color = relationship.branchId
              ? branchColorOf(colors, layout, relationship.branchId)
              : colors.deepText
            const angle = ((relationship.arrow.angle * 180) / Math.PI).toFixed(1)
            // 标题那一小块就是这条线的可选中区域（空标题也给一块，否则选不中）
            const size = relationship.labelSize ?? { width: 24, height: 16 }
            const labelBox = {
              x: relationship.label.x - size.width / 2 - 4,
              y: relationship.label.y - size.height / 2 - 4,
              width: size.width + 8,
              height: size.height + 8
            }
            const active =
              selectedOverlay?.kind === 'relationship' && selectedOverlay.id === relationship.id
            return (
              <g key={`relationship-${relationship.id}`}>
                <path
                  d={relationship.d}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.8}
                  strokeLinecap="round"
                />
                {/* 线身的可拖拽命中区在节点下面那一层，见上方 canvas__overlay 命中层 */}

                <path
                  d="M 0 0 L -10 -4 L -10 4 Z"
                  transform={`translate(${relationship.arrow.x} ${relationship.arrow.y}) rotate(${angle})`}
                  fill={color}
                />

                {/* 标题区的透明命中区：单击选中、双击改文字 */}
                <rect
                  className="overlay-hit"
                  x={labelBox.x}
                  y={labelBox.y}
                  width={labelBox.width}
                  height={labelBox.height}
                  rx={4}
                  fill="transparent"
                  onPointerDown={(event) => pickOverlay(event, 'relationship', relationship.id)}
                  onDoubleClick={() =>
                    setTitleEdit({
                      kind: 'relationship',
                      id: relationship.id,
                      x: relationship.label.x,
                      y: relationship.label.y,
                      anchor: 'middle',
                      value: relationship.title ?? ''
                    })
                  }
                />
                {active ? (
                  <rect
                    className="overlay-selected"
                    x={labelBox.x}
                    y={labelBox.y}
                    width={labelBox.width}
                    height={labelBox.height}
                    rx={4}
                  />
                ) : null}

                {relationship.title ? (
                  <text
                    className="overlay-title"
                    x={relationship.label.x}
                    y={relationship.label.y}
                    fontSize={12}
                    fontWeight={600}
                    fill={color}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    stroke={colors.canvas}
                    strokeWidth={4}
                    paintOrder="stroke"
                    strokeLinejoin="round"
                    pointerEvents="none"
                  >
                    {/* 关系线标题同样支持手动换行（与边界 / 概要一致）：按 \n 拆行、整体垂直居中 */}
                    {overlayTitleLines(relationship.title).map((line, index, all) => (
                      <tspan
                        key={index}
                        x={relationship.label.x}
                        dy={
                          index === 0
                            ? -((all.length - 1) * OVERLAY_TITLE_LINE_HEIGHT) / 2
                            : OVERLAY_TITLE_LINE_HEIGHT
                        }
                      >
                        {line.length > 0 ? line : '\u00A0'}
                      </tspan>
                    ))}
                  </text>
                ) : null}

                {/* 两端各一个手柄：拖到别的主题上即可改接这一端 */}
                {(
                  [
                    { end: 'end1Id' as const, point: relationship.start },
                    { end: 'end2Id' as const, point: relationship.arrow }
                  ] as const
                ).map((handle) => (
                  <circle
                    key={`${relationship.id}-${handle.end}`}
                    className={
                      handleDrag &&
                      handleDrag.relationshipId === relationship.id &&
                      handleDrag.end === handle.end
                        ? 'overlay-handle overlay-handle--active'
                        : 'overlay-handle'
                    }
                    cx={handle.point.x}
                    cy={handle.point.y}
                    r={7}
                    fill={color}
                    onPointerDown={(event) =>
                      handleRelationshipPointerDown(
                        event,
                        relationship.id,
                        handle.end,
                        handle.point
                      )
                    }
                  >
                    <title>拖到另一个主题上可改接这一端</title>
                  </circle>
                ))}
              </g>
            )
          })}

          {/* 落点预览：要么是"成为子主题"的空位框，要么是"插到同级之间"的插入线 */}
          {dropPreview && dropPreview.kind === 'slot' ? (
            <g>
              <line
                x1={dropPreview.from.x}
                y1={dropPreview.from.y}
                x2={dropPreview.to.x}
                y2={dropPreview.to.y}
                stroke={dropPreview.color}
                strokeWidth={1.8}
                /* 用实线 —— 那就是这个主题将来真正的那条连线，虚线会让人以为"还没连上" */
                strokeLinecap="round"
                opacity={0.9}
              />
              <rect
                x={dropPreview.slot.x}
                y={dropPreview.slot.y}
                width={dropPreview.slot.width}
                height={dropPreview.slot.height}
                rx={10}
                fill={dropPreview.color}
                fillOpacity={0.14}
                stroke={dropPreview.color}
                strokeWidth={2}
              />
              {/* 空位框里写上"是谁要落到这里"，比只显示一个空格子清楚得多 */}
              {dropPreview.title ? (
                <text
                  x={dropPreview.slot.x + dropPreview.slot.width / 2}
                  y={dropPreview.slot.y + dropPreview.slot.height / 2}
                  fontSize={12}
                  fontWeight={600}
                  fill={dropPreview.color}
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {clipText(dropPreview.title, dropPreview.slot.width)}
                </text>
              ) : null}
              {/* 成为子主题这件事光看几何位置不够直观，直接在空位框下写明 */}
              <text
                x={dropPreview.slot.x + dropPreview.slot.width / 2}
                y={dropPreview.slot.y + dropPreview.slot.height + 14}
                fontSize={11}
                fontWeight={700}
                fill={dropPreview.color}
                textAnchor="middle"
                dominantBaseline="middle"
                stroke={colors.canvas}
                strokeWidth={4}
                paintOrder="stroke"
                strokeLinejoin="round"
              >
                {`将成为「${
                  dropPreview.targetTitle.length > 12
                    ? `${dropPreview.targetTitle.slice(0, 12)}…`
                    : dropPreview.targetTitle
                }」的子主题`}
              </text>
            </g>
          ) : null}

          {/*
            同级插入：只画一条夹在目标与相邻兄弟之间的粗插入线（Xmind / 知犀那套"插入位置条"）。
            位置紧贴目标外缘，就在指针附近，不会像过去的空位框那样跑到很远的父级那边去。
          */}
          {dropPreview && dropPreview.kind === 'bar' ? (
            <g>
              <line
                x1={dropPreview.bar.x1}
                y1={dropPreview.bar.y1}
                x2={dropPreview.bar.x2}
                y2={dropPreview.bar.y2}
                stroke={dropPreview.color}
                strokeWidth={5}
                strokeLinecap="round"
              />
              <circle
                cx={(dropPreview.bar.x1 + dropPreview.bar.x2) / 2}
                cy={(dropPreview.bar.y1 + dropPreview.bar.y2) / 2}
                r={4.5}
                fill="#ffffff"
                stroke={dropPreview.color}
                strokeWidth={2.5}
              />
            </g>
          ) : null}

          {/* 左右对调的预览：镜像到中心主题另一侧 */}
          {sideFlipPreview ? (
            <g>
              <rect
                x={sideFlipPreview.x}
                y={sideFlipPreview.y}
                width={sideFlipPreview.width}
                height={sideFlipPreview.height}
                rx={10}
                fill={sideFlipPreview.color}
                fillOpacity={0.08}
                stroke={sideFlipPreview.color}
                strokeWidth={1.5}
                strokeDasharray="6 5"
              />
              {sideFlipPreview.title ? (
                <text
                  x={sideFlipPreview.x + sideFlipPreview.width / 2}
                  y={sideFlipPreview.y + sideFlipPreview.height / 2}
                  fontSize={12}
                  fontWeight={600}
                  fill={sideFlipPreview.color}
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {clipText(sideFlipPreview.title, sideFlipPreview.width)}
                </text>
              ) : null}
            </g>
          ) : null}

          {/* 多选拖拽：角上挂一个「N 个主题」的徽标 */}
          {groupBadge ? (
            <g>
              <rect
                x={groupBadge.x}
                y={groupBadge.y}
                width={groupBadge.text.length * 11 + 14}
                height={22}
                rx={11}
                fill="#f59e0b"
              />
              <text
                x={groupBadge.x + (groupBadge.text.length * 11 + 14) / 2}
                y={groupBadge.y + 11}
                fontSize={12}
                fontWeight={700}
                fill="#ffffff"
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {groupBadge.text}
              </text>
            </g>
          ) : null}

          {/* 拖拽端点时的预览线 */}
          {handleDrag ? (
            <line
              x1={handleDrag.anchor.x}
              y1={handleDrag.anchor.y}
              x2={handleDrag.pointer.x}
              y2={handleDrag.pointer.y}
              stroke={colors.deepText}
              strokeWidth={1.6}
              strokeDasharray="6 5"
              strokeLinecap="round"
              opacity={0.7}
            />
          ) : null}
        </svg>

        {/* 双击标题后的就地编辑框。放在世界容器内，所以会随画布一起缩放。
            关系线 / 边界 / 概要**都支持手动换行**（Enter 换行、Esc 取消、Ctrl+Enter 提交、失焦也提交）——
            以前只有概要能换行，另外两种用单行 input，用户根本没法换行 */}
        {titleEdit ? (
          <textarea
            className="overlay-title-editor overlay-title-editor--multi"
            rows={Math.max(1, overlayTitleLines(titleEdit.value).length)}
            style={{
              left: titleEdit.x,
              // 多行时整块按中线对齐（与画布上的排布方式一致）
              top:
                titleEdit.y -
                13 -
                ((Math.max(1, overlayTitleLines(titleEdit.value).length) - 1) *
                  OVERLAY_TITLE_LINE_HEIGHT) /
                  2,
              transform:
                titleEdit.anchor === 'middle'
                  ? 'translateX(-50%)'
                  : titleEdit.anchor === 'end'
                    ? 'translateX(-100%)'
                    : 'none'
            }}
            value={titleEdit.value}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              const next = e.currentTarget.value
              setTitleEdit((current) => (current ? { ...current, value: next } : current))
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              // 输入法组词期间交给输入法处理（React 合成事件没有 isComposing）
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              // Enter = 换行（这就是「手动换行」，关系线 / 边界 / 概要一视同仁）；
              // Esc = 取消；Ctrl/Cmd+Enter = 直接提交并退出（单行标签改完想快点收工）
              if (e.key === 'Escape') {
                e.preventDefault()
                cancelTitleRef.current = true
                e.currentTarget.blur()
                return
              }
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                e.currentTarget.blur()
              }
            }}
            onBlur={commitTitleEdit}
          />
        ) : null}
      </div>

      {/* 拖到真正的空白处：明确告诉用户"这一下会自由摆放"，
          免得他以为已经吸附进树里了（自由摆放的主题会被自动布局甩在一边，连线横穿整张图） */}
      {/* 常驻图例：拖拽的三种结果提前讲清楚，不用用户去试 */}
      <div className="canvas__drag-legend">
        <span className={dragVisual && dropTarget?.mode === 'child' ? 'is-active' : undefined}>
          拖到主题上＝成为它的子主题
        </span>
        <span className="canvas__drag-legend-sep">·</span>
        <span
          className={
            dragVisual && dropTarget && dropTarget.mode !== 'child' ? 'is-active' : undefined
          }
        >
          拖到同级之间＝插进那一层
        </span>
        <span className="canvas__drag-legend-sep">·</span>
        <span className={dragVisual && freeDrop ? 'is-active' : undefined}>按住 Alt＝自由摆放</span>
      </div>

      {freeDrop ? <div className="canvas__free-hint">自由摆放（按住 Alt 可随时切换）</div> : null}

      {/* 落点被判为非法的原因：不写出来，用户只会以为"拖到这里没反应"＝坏了 */}
      {dropBlocked ? <div className="canvas__blocked-hint">{dropBlocked}</div> : null}

      {/* 左键框选的橡皮筋 */}
      {marquee ? (
        <div
          className="canvas__marquee"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0)
          }}
        />
      ) : null}
    </div>
  )
}
