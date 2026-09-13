import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { layoutSheet, LAYOUT_DEFAULTS } from '@shared/layout'
import type { LayoutResult } from '@shared/layout/types'
import type { Topic } from '@shared/model/types'
import { activeRoot, activeSheet, findParent, findTopic, isSelfOrDescendant } from '@shared/model/tree'
import { alsoDraggedOf, moveRootsOf, resolveDragMove, type DragMove } from '@shared/model/dragmove'
import {
  blockReasonOf,
  distanceToRect,
  nearestInRegion,
  nearestSiblingGap,
  perpendicularOf,
  resolveDrop,
  stackDirection,
  zoneOf,
  type DropAxis,
  type DropMode,
  type DropPoint,
  type DropRect,
  type DropResult,
  type SiblingStack,
  type SnapNode
} from '@shared/model/drop'
import { applyTopicFilter, hitTopicIds, isFilterActive, searchSheet } from '@shared/search'
import { DEFAULT_STRUCTURE, getStructureDef } from '@shared/xmind/constants'
import { measureTopic, bumpMeasureEpoch } from '../render/measure'
import { clearFormulaCache } from '../render/formula'
import { branchColorOf } from '../render/theme'
import { viewportActions } from '../render/viewport'
import { themeColorsOf, useEditor } from '../store/editor'
import TopicNode from './TopicNode'

/**
 * 可吸附区域在**生长方向**上的外扩量——那里是新子主题会待的一整片区域，所以放得宽。
 *
 * 判定不能只用"到节点的直线距离"：那是**各向同性**的，而落点窗口天生是各向异性的——
 * 生长方向上能落进一整列，同级方向上只有"相邻兄弟之间那条缝"。
 * 一个半径去卡两件事，必然一边太松一边太紧，怎么调都不对
 * （这条结论来自成熟实现 simple-mind-map 的 Drag 插件：它也是分轴判定的）。
 */
const GROWTH_REACH = Math.round(LAYOUT_DEFAULTS.gapX * 1.5)

/**
 * 沿**同级方向**（以及背向生长的那一侧）的外扩量：只留一点点容错，够盖住那条缝即可。
 * 缝隙更大时由 `nearestSiblingGap` 那条规则兜底（它专门管"插进两个同级之间"）。
 */
const SIBLING_REACH = Math.round(LAYOUT_DEFAULTS.gapY * 1.6)

/**
 * 某一层**最外侧**（那一边没有相邻兄弟）向外多留的吸附带。
 *
 * 用途：把一个主题放到"最后一个子主题之后稍远一点的空白"时，仍然算
 * 「插到它后面」＝给父主题追加一个子主题——这正是大家最常用的追加动作。
 * 放在更远的地方才落到自由摆放。
 */
const OUTER_REACH = Math.round(LAYOUT_DEFAULTS.gapY * 2.4)

/** 粗筛半径：任何方向的外扩都不会超过它，比它远的节点不必细算区域 */
const SNAP_PREFILTER = Math.max(GROWTH_REACH, OUTER_REACH) + OUTER_REACH + 8

/**
 * 落点迟滞：指针要换到**另一个**落点前，必须先移动这么远。
 *
 * 单位是**世界单位**（会乘上当次缩放再和屏幕位移比较）：
 * 画布缩到 50% 时，"走够这么远"对应的屏幕位移自然翻倍，手感才和 100% 时一致。
 *
 * 没有它，指针停在"成为子主题"与"插到同级之间"的分界线上时，
 * 落点会一帧一个样地来回跳，看起来就是"吸附乱跳、提示乱闪"。
 * 有了它，同一个落点只要还够得着就保持不动，手感立刻稳定下来。
 */
const DROP_HYSTERESIS = 14

/**
 * 空位框里显示的标题：按可用宽度粗略截断，避免文字溢出虚线框。
 * 中日韩字符按整宽算，其余按半宽算。
 */
function clipText(text: string, width: number, fontSize = 12): string {
  const plain = text.replace(/\s+/g, ' ').trim()
  const limit = Math.max(0, width - 12)
  let used = 0
  let out = ''
  for (const ch of plain) {
    const charWidth = /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? fontSize : fontSize * 0.55
    if (used + charWidth > limit) return `${out}…`
    used += charWidth
    out += ch
  }
  return out
}

interface AxisPair {
  stack: DropAxis | null
  growth: DropAxis | null
}

export default function Canvas(): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  const workbook = useEditor((s) => s.workbook)
  const docSeq = useEditor((s) => s.docSeq)
  const zoom = useEditor((s) => s.zoom)
  const pan = useEditor((s) => s.pan)
  const viewLock = useEditor((s) => s.viewLock)
  const selection = useEditor((s) => s.selection)
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
  /**
   * 拖拽节点时的落点预测：
   * child = 松手后成为目标的**子主题**（高亮目标节点）；
   * after = 松手后**排到目标后面**（同级排序，在目标外侧显示插入条）。
   * 目标是自己的父级时什么都不会发生，此时为 null，不给任何提示。
   */
  const [dropTarget, setDropTarget] = useState<{ id: string; mode: DropMode } | null>(null)
  /**
   * 一级主题被拖到中心主题**另一侧**的空白处时，将要切到的那一侧。
   * 这是知犀 / Xmind 的「左右位置调整」：不需要"可放置"标记，松手即对调。
   */
  const [sideTarget, setSideTarget] = useState<'left' | 'right' | null>(null)

  /** 拖动落点框里显示的「是谁要落到这里」 */
  const [dropLabel, setDropLabel] = useState('')
  /** 指针落在真正的空白处：松手会自由摆放（而不是吸附进树里） */
  const [freeDrop, setFreeDrop] = useState(false)
  /**
   * 落点被判为非法的原因（例如「它已经是这个主题的子主题了」）。
   *
   * 拖拽里"挨着了却什么都不发生"最容易被误当成卡死——把原因写出来，
   * 用户才知道这是有意为之而不是软件坏了。
   */
  const [dropBlocked, setDropBlocked] = useState('')

  /** 左键框选：矩形用容器内的局部坐标，便于直接定位 */
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)

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
  /** 拖动期间固定不变：这次到底在拖哪些主题 */
  const dragNodesRef = useRef<DragMove | null>(null)
  /** 当前裁决出的落点（松手就按它落） */
  const dropPlanRef = useRef<DropResult | null>(null)
  /**
   * 落点迟滞用的「上一次裁决」。
   * 指针换目标前要先走够 `DROP_HYSTERESIS` 像素，避免在分界线上抖动。
   */
  const dropLatchRef = useRef<{
    key: string
    plan: DropResult | null
    side: 'left' | 'right' | null
    free: boolean
    px: number
    py: number
  } | null>(null)
  /** 指针位置与拖拽起点，自动滚动要用 */
  const pointerRef = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null)

  /* ---- 拖拽过程中：贴住画布边缘时自动滚动 ---- */
  const dragAutoScroll = useCallback((): void => {
    const el = containerRef.current
    const pointer = pointerRef.current
    if (!el || !pointer) return
    const rect = el.getBoundingClientRect()
    const EDGE = 72
    const MAX_SPEED = 26
    const speed = (distance: number): number => Math.min(MAX_SPEED, ((EDGE - distance) / EDGE) * MAX_SPEED)

    const left = pointer.x - rect.left
    const right = rect.right - pointer.x
    const top = pointer.y - rect.top
    const bottom = rect.bottom - pointer.y
    let dx = 0
    let dy = 0
    if (left < EDGE) dx = speed(left)
    else if (right < EDGE) dx = -speed(right)
    if (top < EDGE) dy = speed(top)
    else if (bottom < EDGE) dy = -speed(bottom)
    if (dx === 0 && dy === 0) return

    const current = panRef.current
    setPan({ x: current.x + dx, y: current.y + dy })
  }, [setPan])

  /* ---- 拖拽过程中：按 Esc 放弃这次拖拽 ---- */

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
      // 两处缓存都要失效：公式尺寸缓存 + 节点测量缓存（后者里存着 formulaBox）
      clearFormulaCache()
      bumpMeasureEpoch()
      setFontEpoch((n) => n + 1)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const layout: LayoutResult = useMemo(() => {
    const root = activeRoot(workbook)
    const sheet = activeSheet(workbook)
    // 正在编辑的节点用「未提交的内容」参与测量，做到边打字边自适应尺寸
    const measure = (topic: Topic, depth: number): ReturnType<typeof measureTopic> =>
      topic.id === editingId && editingRich
        ? measureTopic({ ...topic, title: editingText, titleRich: editingRich }, depth)
        : measureTopic(topic, depth)
    // 关系线/边界/概要在结构布局之后按最终坐标计算，所以要把画布数据一起传进去
    return layoutSheet(root, measure, {}, sheet)
    // fontEpoch 只用于「字体就绪后强制重新布局」，不是布局的输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbook, editingId, editingText, editingRich, fontEpoch])

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
      const color = boundary.branchId ? branchColorOf(colors, layout, boundary.branchId) : colors.deepText
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
    const update = (): void => setSize({ width: el.clientWidth, height: el.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /* ---- 视口动作 ---- */
  const centerRoot = useCallback((): void => {
    const el = containerRef.current
    const lay = layoutRef.current
    if (!el || !lay) return
    const rootNode = lay.nodeMap.get(rootRef.current.id)
    if (!rootNode) return
    const width = el.clientWidth
    const height = el.clientHeight
    if (width === 0 || height === 0) return
    setZoom(1)
    setPan({
      x: width / 2 - (rootNode.x + rootNode.width / 2),
      y: height / 2 - (rootNode.y + rootNode.height / 2)
    })
  }, [setPan, setZoom])

  const fit = useCallback((): void => {
    const el = containerRef.current
    const lay = layoutRef.current
    if (!el || !lay) return
    const width = el.clientWidth
    const height = el.clientHeight
    if (width === 0 || height === 0) return
    const margin = 48
    const scale = Math.min(
      (width - margin * 2) / lay.bounds.width,
      (height - margin * 2) / lay.bounds.height,
      1.5
    )
    const z = Math.max(0.1, Math.min(4, scale))
    setZoom(z)
    setPan({ x: (width - lay.bounds.width * z) / 2, y: (height - lay.bounds.height * z) / 2 })
  }, [setPan, setZoom])

  const zoomTo = useCallback(
    (next: number): void => {
      const el = containerRef.current
      if (!el) return
      const px = el.clientWidth / 2
      const py = el.clientHeight / 2
      const oldZoom = zoomRef.current
      const currentPan = panRef.current
      const z = Math.max(0.1, Math.min(4, next))
      const wx = (px - currentPan.x) / oldZoom
      const wy = (py - currentPan.y) / oldZoom
      setZoom(z)
      setPan({ x: px - wx * z, y: py - wy * z })
    },
    [setPan, setZoom]
  )

  /** 把节点滚动到可见范围内，避免新建的主题落在视口外 */
  const ensureVisible = useCallback(
    (id: string): void => {
      const el = containerRef.current
      const lay = layoutRef.current
      if (!el || !lay) return
      const node = lay.nodeMap.get(id)
      if (!node) return
      const z = zoomRef.current
      const currentPan = panRef.current
      const width = el.clientWidth
      const height = el.clientHeight
      if (width === 0 || height === 0) return
      const margin = 56
      const left = node.x * z + currentPan.x
      const top = node.y * z + currentPan.y
      const right = (node.x + node.width) * z + currentPan.x
      const bottom = (node.y + node.height) * z + currentPan.y

      let dx = 0
      let dy = 0
      if (left < margin) dx = margin - left
      else if (right > width - margin) dx = width - margin - right
      if (top < margin) dy = margin - top
      else if (bottom > height - margin) dy = height - margin - bottom

      if (dx !== 0 || dy !== 0) {
        setPan({ x: currentPan.x + dx, y: currentPan.y + dy })
      }
    },
    [setPan]
  )

  /** 把某个节点移到视口正中（搜索跳转用，缩放保持不变） */
  const centerOn = useCallback(
    (id: string): void => {
      const el = containerRef.current
      const lay = layoutRef.current
      if (!el || !lay) return
      const node = lay.nodeMap.get(id)
      if (!node) return
      const z = zoomRef.current
      const width = el.clientWidth
      const height = el.clientHeight
      if (width === 0 || height === 0) return
      // 让节点中心落在视口中心；搜索面板占了右侧，这里往左让出一点，避免被面板挡住
      const targetX = width / 2 - 150
      const targetY = height / 2
      const centerX = (node.x + node.width / 2) * z
      const centerY = (node.y + node.height / 2) * z
      setPan({ x: targetX - centerX, y: targetY - centerY })
    },
    [setPan]
  )

  useEffect(() => {
    viewportActions.fit = fit
    viewportActions.centerRoot = centerRoot
    viewportActions.zoomTo = zoomTo
    viewportActions.ensureVisible = ensureVisible
    viewportActions.centerOn = centerOn
  }, [fit, centerRoot, zoomTo, ensureVisible, centerOn])

  /* ---- 进入编辑态时保证节点可见（新建主题可能超出视口） ---- */
  useEffect(() => {
    // 视角锁定开着时交给下面的跟随循环处理：它会把编辑中的节点居中，
    // ensureVisible 只保证可见不居中，两套逻辑同时跑会互相打架
    if (!editingId || viewLock) return
    const target = editingId
    const frame = window.requestAnimationFrame(() => viewportActions.ensureVisible(target))
    return () => window.cancelAnimationFrame(frame)
  }, [editingId, viewLock])

  /**
   * 视角锁定要盯住的那个主题。
   *
   * - 选择为空（点了画布空白处）→ 什么都不跟，镜头留给用户自己摆；
   * - 选择指向一个**已经不存在的主题**（刚删完、撤销回到另一个版本）→ 退回中心主题，
   *   而不是"盯不到就彻底不动"——那正是用户看到的「删除后视角不跟随」；
   * - 其余情况就是当前选中的主题。
   */
  const focusId = useMemo(() => {
    if (selection.length === 0) return ''
    const rootTopic = activeRoot(workbook)
    const picked = selection[0]
    return picked && findTopic(rootTopic, picked) ? picked : rootTopic.id
  }, [selection, workbook])

  /**
   * 被盯住的主题在布局里的**位置与尺寸**（拼成字符串，方便直接当依赖）。
   *
   * 用它而不是"布局对象变了"来驱动镜头：删掉一整条主题、改文字让节点变大变小、
   * 拖拽重排、撤销重做……只要**被选中的主题自己动了**，镜头就跟上；
   * 跟它无关的布局变化（别的分支在动）则不会带着镜头乱跑。
   */
  const focusKey = useMemo(() => {
    if (!focusId) return ''
    const node = layout.nodeMap.get(focusId)
    if (!node) return `${focusId}|?`
    return (
      `${focusId}|${Math.round(node.x)},${Math.round(node.y)},` +
      `${Math.round(node.width)},${Math.round(node.height)}`
    )
  }, [focusId, layout])

  /* ---- 视角锁定：把选中的主题稳稳按在视口中央 ---- */
  useEffect(() => {
    // 正在拖主题时不跟：镜头要是同时在移，指针下的画面会跟着滑，落点就抓不准了。
    // 松手（dragVisual 归零）后视野再咬住它。
    if (!viewLock || dragVisual || !focusId || !focusKey) return
    const id = focusId
    const el = containerRef.current
    if (!el) return
    if (el.clientWidth === 0 || el.clientHeight === 0) return

    let raf = 0
    /** 目标一时还没出现在布局里（刚删完、刚打开）就先等几帧，别急着放弃 */
    let misses = 0
    const MAX_MISSES = 90

    /**
     * 逐帧向"该有的平移量"收敛，而不是一步跳过去：
     * 一步到位时整张图会「啪」地闪一下，眼睛跟不住到底是哪个主题被选中了；
     * 缓动过去才像镜头跟着走。收敛到亚像素就停手，不再空转。
     *
     * 依赖里带上 `zoom`：按住 Ctrl 滚轮缩放时视角会钉在选中的主题上（以它为中心缩放），
     * 而不是把主题缩放跑出屏幕。手动拖动画布则不会触发这里——想让镜头暂停跟随时
     * 直接拖就是了，下一次选择或位置变化它才重新咬住。
     */
    const step = (): void => {
      const node = layoutRef.current?.nodeMap.get(id)
      const width = el.clientWidth
      const height = el.clientHeight
      if (width === 0 || height === 0) return
      if (!node) {
        if (misses < MAX_MISSES) {
          misses += 1
          raf = window.requestAnimationFrame(step)
        }
        return
      }
      const z = zoomRef.current
      const wantX = width / 2 - (node.x + node.width / 2) * z
      const wantY = height / 2 - (node.y + node.height / 2) * z
      const current = panRef.current
      const dx = wantX - current.x
      const dy = wantY - current.y
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
        setPan({ x: wantX, y: wantY })
        return
      }
      setPan({ x: current.x + dx * 0.22, y: current.y + dy * 0.22 })
      raf = window.requestAnimationFrame(step)
    }

    raf = window.requestAnimationFrame(step)
    return () => window.cancelAnimationFrame(raf)
    // focusKey 里已经含了被盯主题的 id 与几何，用它做依赖即可（不写进函数体会被 lint 挑刺）
  }, [viewLock, dragVisual, focusId, focusKey, editingId, zoom, size.width, size.height, setPan])

  /* ---- 新文档打开后居中 ---- */
  const centeredSeqRef = useRef(-1)
  useEffect(() => {
    if (size.width === 0 || size.height === 0) return
    if (centeredSeqRef.current === docSeq) return
    centeredSeqRef.current = docSeq
    centerRoot()
  }, [size.width, size.height, docSeq, centerRoot])

  /* ---- 滚轮：平移 / Ctrl 缩放 ---- */
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (ev: WheelEvent): void => {
      ev.preventDefault()
      const currentPan = panRef.current
      if (ev.ctrlKey || ev.metaKey) {
        const rect = el.getBoundingClientRect()
        const px = ev.clientX - rect.left
        const py = ev.clientY - rect.top
        const oldZoom = zoomRef.current
        const z = Math.max(0.1, Math.min(4, oldZoom * Math.exp(-ev.deltaY * 0.0015)))
        const wx = (px - currentPan.x) / oldZoom
        const wy = (py - currentPan.y) / oldZoom
        setZoom(z)
        setPan({ x: px - wx * z, y: py - wy * z })
      } else {
        setPan({ x: currentPan.x - ev.deltaX, y: currentPan.y - ev.deltaY })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setPan, setZoom])

  /* ---- 命中测试与坐标换算 ---- */
  const screenToWorld = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const el = containerRef.current
    if (!el) return { x: 0, y: 0 }
    const rect = el.getBoundingClientRect()
    const z = zoomRef.current
    const p = panRef.current
    return { x: (clientX - rect.left - p.x) / z, y: (clientY - rect.top - p.y) / z }
  }, [])

  const hitTest = useCallback((wx: number, wy: number, excludeId = ''): string | null => {
    const lay = layoutRef.current
    if (!lay) return null
    const root = rootRef.current
    for (let i = lay.nodes.length - 1; i >= 0; i -= 1) {
      const node = lay.nodes[i]
      if (node.x <= wx && wx <= node.x + node.width && node.y <= wy && wy <= node.y + node.height) {
        // excludeId 为空串时不会命中任何子树，等价于「不排除任何节点」
        if (isSelfOrDescendant(root, excludeId, node.id)) continue
        return node.id
      }
    }
    return null
  }, [])

  /**
   * 所有「同级节点堆」（同一父级下 ≥2 个子节点）。
   * 两个用途：在空白处识别"插到这两个之间"，以及推断同级节点的排列方向。
   */
  const siblingStacks = useMemo(() => {
    const stacks: SiblingStack[] = []
    const visit = (topic: Topic): void => {
      if (topic.children.length >= 2) {
        const children: Array<{ id: string; rect: DropRect }> = []
        for (const child of topic.children) {
          const rect = layout.nodeMap.get(child.id)
          if (rect) children.push({ id: child.id, rect })
        }
        if (children.length >= 2) stacks.push({ parentId: topic.id, children })
      }
      for (const child of topic.children) visit(child)
    }
    visit(activeRoot(workbook))
    return stacks
  }, [workbook, layout])

  /** 目标的子节点往哪个方向排（拿不到就返回 null，交给调用方兜底） */
  const childGrowth = useCallback((targetId: string): DropAxis | null => {
    const lay = layoutRef.current
    const targetRect = lay?.nodeMap.get(targetId)
    if (!lay || !targetRect) return null
    const childRects: DropRect[] = []
    for (const child of findTopic(rootRef.current, targetId)?.children ?? []) {
      const rect = lay.nodeMap.get(child.id)
      if (rect) childRects.push(rect)
    }
    const last = childRects[childRects.length - 1]
    const secondLast = childRects[childRects.length - 2]
    if (last && secondLast) return stackDirection(secondLast, last)
    if (last) return stackDirection(targetRect, last)
    return null
  }, [])

  /**
   * 目标节点周围的两条方向轴，**全部由实际坐标推出**：
   * - stack：同级节点往哪边排（"插到它后面"看这条）；
   * - growth：它的子节点往哪边长。
   * 平衡思维导图的子节点是竖着排的、组织架构图是横着排的，
   * 靠实际坐标推就不用按结构名写特例，也不会把落点画到错误的一侧。
   */
  const axesOf = useCallback(
    (targetId: string): AxisPair => {
      const lay = layoutRef.current
      const targetRect = lay?.nodeMap.get(targetId)
      if (!lay || !targetRect) return { stack: null, growth: null }

      let stack: DropAxis | null = null
      const owningStack = siblingStacks.find((item) =>
        item.children.some((child) => child.id === targetId)
      )
      if (owningStack) {
        const index = owningStack.children.findIndex((child) => child.id === targetId)
        const next = owningStack.children[index + 1]
        const previous = index > 0 ? owningStack.children[index - 1] : undefined
        // 用相邻兄弟定方向，比用"父 → 子"可靠得多
        const neighbor = next ?? previous
        if (neighbor) {
          const toward = next
            ? stackDirection(targetRect, neighbor.rect)
            : stackDirection(neighbor.rect, targetRect)
          // 同级方向必须**垂直于生长方向**。平衡思维导图的一级主题分列左右，
          // 它们的坐标差只是"左右"，不是真正的同级排列方向，不能拿来当落点依据。
          const growthNow = childGrowth(targetId)
          if (!growthNow || toward.axis !== growthNow.axis) stack = toward
        }
      }

      // 「成为它的子主题」时新节点往哪里长：同一个目标在**两处**都要用这个方向
      // （判断指针是否落在它外侧、以及把空位框摆在哪儿），抽出来才能保证两处一致。
      const growth = childGrowth(targetId) ?? (stack ? perpendicularOf(stack) : null)

      return { stack, growth }
    },
    [siblingStacks, childGrowth]
  )

  /**
   * 目标的父级那一层，子节点是往哪个方向排的。
   * 用在「目标自己还没有子节点、推不出生长方向」的时候：
   * 新子主题会排在目标的兄弟之后，所以父级那一层的排列方向的**垂直方向**才是它生长的方向。
   */
  const parentStackAxis = useCallback((targetId: string): DropAxis | null => {
    const rootTopic = rootRef.current
    const parent = findParent(rootTopic, targetId)
    if (!parent) return null
    const parentRect = layoutRef.current?.nodeMap.get(parent.id)
    if (!parentRect) return null
    const kids = findTopic(rootTopic, parent.id)?.children ?? []
    const a = kids.length > 1 ? layoutRef.current?.nodeMap.get(kids[0].id) : undefined
    const b = kids.length > 1 ? layoutRef.current?.nodeMap.get(kids[1].id) : undefined
    if (a && b) return stackDirection(a, b)
    // 只有一个子节点时，用"父 → 子"的方向当这一层的排列方向
    const only = layoutRef.current?.nodeMap.get(kids[0]?.id ?? '')
    return only ? stackDirection(parentRect, only) : null
  }, [])

  /**
   * 「成为它的子主题」时新节点会往哪边长。注意这里**不拿子节点去推**：
   * 目标是折叠的、或还没有子节点时推不出方向，那就说明新节点会直接长在目标旁边——
   * 此时用「同级排列方向的垂直方向」，否则新版图里"落在中心主题身上"会把空位框
   * 画到第一个分支的正上方，看着像要排到它前面去。
   */
  const growthAxis = useCallback((pair: AxisPair): DropAxis => {
    if (pair.growth) return pair.growth
    if (pair.stack) return perpendicularOf(pair.stack)
    return { axis: 'x', forward: true }
  }, [])

  /** 目标在它那一层有没有同级兄弟（中心主题在深度 0，天然没有）。 */
  const hasSiblings = useCallback(
    (targetId: string): boolean =>
      siblingStacks.some((item) => item.children.some((child) => child.id === targetId)),
    [siblingStacks]
  )

  /**
   * 「插到它前 / 后」时，**那一层**的排列方向轴。
   *
   * 必须和 `zoneForPointer` 用同一个答案：否则会出现"提示条画在一侧、松手却插到另一侧"
   * 这种自相矛盾的提示——研究文档里用户截图反映的正是这类问题。
   *
   * - 有同级：就是相邻兄弟的坐标差（比"父 → 子"可靠得多）；
   * - 没有同级（中心主题、独苗子主题）：退回**父级那一层的排列方向**的垂直方向，
   *   那恰好就是"它这个层级往哪边排"。
   */
  const insertAxis = useCallback(
    (targetId: string, pair: AxisPair): DropAxis => {
      if (pair.stack) return pair.stack
      return perpendicularOf(
        pair.growth ?? parentStackAxis(targetId) ?? ({ axis: 'x', forward: true } as DropAxis)
      )
    },
    [parentStackAxis]
  )

  /**
   * 节点的「可吸附区域」＝本体按两条轴**分别**外扩：
   *
   * - 沿**生长方向**（子节点会待的那一侧）放宽到 `GROWTH_REACH`：
   *   在一个向右长的结构里，拖到某个主题右侧那一片空白本来就是"成为它的子主题"；
   * - 沿**同级方向**：朝相邻兄弟那一侧只留 `SIBLING_REACH`（刚好盖住那条缝）；
   *   而**最外侧**（那一边没有兄弟）留 `OUTER_REACH`——这样"放在最后一个子主题之后
   *   稍远一点"仍然算「插到它后面」＝给父主题追加一个子主题；
   * - 背向生长的一侧只用 `SIBLING_REACH`，别把父级那一带白白圈进来。
   *
   * 区域之间可以重叠，最终谁胜出由 `nearestInRegion` 按"离本体最近、更深优先"决定。
   */
  const snapRegionOf = useCallback(
    (targetId: string): DropRect | null => {
      const rect = layoutRef.current?.nodeMap.get(targetId)
      if (!rect) return null
      const pair = axesOf(targetId)
      const growth = growthAxis(pair)
      const stack = pair.stack ?? insertAxis(targetId, pair)
      const horizontal = growth.axis === 'x'
      const forward = growth.forward

      const owning = siblingStacks.find((item) => item.children.some((c) => c.id === targetId))
      let slackPrev = OUTER_REACH
      let slackNext = OUTER_REACH
      if (owning) {
        const index = owning.children.findIndex((c) => c.id === targetId)
        if (index > 0) slackPrev = SIBLING_REACH
        if (index + 1 < owning.children.length) slackNext = SIBLING_REACH
      }
      // 正方向到底是"下一个兄弟"还是"上一个兄弟"，由同级轴的朝向决定
      const negativeSlack = stack?.forward ? slackPrev : slackNext
      const positiveSlack = stack?.forward ? slackNext : slackPrev

      const left = horizontal ? (forward ? SIBLING_REACH : GROWTH_REACH) : negativeSlack
      const right = horizontal ? (forward ? GROWTH_REACH : SIBLING_REACH) : positiveSlack
      const top = horizontal ? negativeSlack : forward ? SIBLING_REACH : GROWTH_REACH
      const bottom = horizontal ? positiveSlack : forward ? GROWTH_REACH : SIBLING_REACH
      return {
        x: rect.x - left,
        y: rect.y - top,
        width: rect.width + left + right,
        height: rect.height + top + bottom
      }
    },
    [axesOf, growthAxis, insertAxis, siblingStacks]
  )

  /**
   * 指针落在目标节点的哪个分区（`child` / `before` / `after`）。
   *
   * - 目标**有同级**：沿同级排列方向分区，贴前/后段插到它前/后、中间成为它的子主题；
   * - 目标**没有同级**（中心主题、独苗子主题）：「插到它前 / 后」用的是**它那一层**的排列
   *   方向（见 `insertAxis`）。中心主题更极端——它没有父级，`resolveDrop` 会把 before/after
   *   一律收敛成"成为它的子主题"，所以它身上再也不会冒出自相矛盾的落点提示。
   */
  const zoneForPointer = useCallback(
    (targetId: string, rect: DropRect, world: DropPoint): DropMode => {
      const pair = axesOf(targetId)
      if (hasSiblings(targetId)) return zoneOf(rect, world, pair.stack)
      return zoneOf(rect, world, insertAxis(targetId, pair))
    },
    [axesOf, hasSiblings, insertAxis]
  )

  /**
   * 一级主题被拖到中心主题**另一侧**的空白处时，返回要切到的那一侧。
   * 只有「向两侧展开」的思维导图才谈得上左右，逻辑图 / 树形图 / 组织架构图都是单侧的。
   *
   * 「另一侧」是按**中心主题的边框**判定的，不是它的中心线：
   * 节点本身有宽度，用中心线会让"贴着中心主题边缘"的那一大片区域被算成同一侧，
   * 于是往左拖一小段毫无反应——那正是「拖了没反应」的常见来源。
   */
  const sideFlipTarget = useCallback(
    (world: DropPoint, draggedId: string): 'left' | 'right' | null => {
      const lay = layoutRef.current
      if (!lay) return null
      const rootTopic = rootRef.current
      const rootRect = lay.nodeMap.get(rootTopic.id)
      const selfRect = lay.nodeMap.get(draggedId)
      const parent = findParent(rootTopic, draggedId)
      if (!rootRect || !selfRect || !parent || parent.id !== rootTopic.id) return null
      // 只有"向两侧展开"的思维导图结构才有左右可言；逻辑图、树形图、组织架构图都是单侧的
      if (getStructureDef(rootTopic.structureClass ?? DEFAULT_STRUCTURE).family !== 'mindmap') return null
      const current: 'left' | 'right' =
        selfRect.x + selfRect.width / 2 < rootRect.x + rootRect.width / 2 ? 'left' : 'right'
      // 指针落在中心主题的左右边框之外才算「换到那一侧」；压在中心主题身上时维持原侧
      const wanted: 'left' | 'right' =
        world.x < rootRect.x ? 'left' : world.x > rootRect.x + rootRect.width ? 'right' : current
      return wanted === current ? null : wanted
    },
    []
  )

  /* ---- 拖动节点 ---- */
  const handleNodePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, id: string): void => {
      if (e.button !== 0) return
      e.stopPropagation()
      const store = useEditor.getState()
      if (store.editingId === id) return
      if (store.editingId) store.commitEdit()

      const rootTopic = rootRef.current
      // 中心主题是整张图的锚点，没有父级可去，也不该被摆到别处
      if (id === rootTopic.id) {
        store.select(id)
        return
      }
      const additive = e.ctrlKey || e.metaKey
      // Ctrl 点击是「加/减选」，保持原来的行为；
      // 普通点击落在**已被选中的那一群里**时不塌缩选择——否则框选一堆节点后
      // 永远只能拖走手底下那一个，多选形同虚设。
      if (additive) store.select(id, true)
      else if (!selectionRef.current.includes(id)) store.select(id, false)

      const moving = resolveDragMove(rootTopic, id, useEditor.getState().selection)
      const group = moveRootsOf(moving).length

      /** 传给 `resolveDrop` 的「同时被拖的**其它**主题」（取参规则见 `alsoDraggedOf`） */
      const alsoDragged = alsoDraggedOf(moving, id)

      const movingIds = new Set(moving.ids)
      /**
       * 拖拽期间用来判断"插进同级空隙"的分组：把被拖的主题从分组里摘掉。
       * 否则指针压在自己那一层上时，会把落点算成"插进自己旁边"，
       * 画出一个根本不可能落下的提示（而且真正接纳它的父级也是错的）。
       */
      const dragStacks: SiblingStack[] = siblingStacks
        .filter((stack) => !movingIds.has(stack.parentId))
        .map((stack) => ({
          parentId: stack.parentId,
          children: stack.children.filter((child) => !movingIds.has(child.id))
        }))
        .filter((stack) => stack.children.length >= 2)

      const startX = e.clientX
      const startY = e.clientY
      let moved = false
      let plan: DropResult | null = null
      let side: 'left' | 'right' | null = null
      /** 本帧的非法落点原因（空串表示没有） */
      let blocked = ''

      /** 自动滚动的循环：只要这次拖拽还在，就持续按指针位置推动画布 */
      let scrollFrame = 0
      const tick = (): void => {
        dragAutoScroll()
        scrollFrame = window.requestAnimationFrame(tick)
      }
      const stopScroll = (): void => {
        if (scrollFrame) window.cancelAnimationFrame(scrollFrame)
        scrollFrame = 0
      }

      const onMove = (ev: PointerEvent): void => {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        if (!moved && Math.hypot(dx, dy) < 4) return
        moved = true
        // 自动滚动与松手时的落点都读这个位置，所以每帧都要更新
        pointerRef.current = { x: ev.clientX, y: ev.clientY, startX, startY }
        const z = zoomRef.current
        setDragVisual({ anchorId: id, dx: dx / z, dy: dy / z, moving, group })

        const world = screenToWorld(ev.clientX, ev.clientY)
        const rootTopic = rootRef.current
        const exclude = new Set(moving.ids)

        plan = null
        side = null
        // 按住 Alt ＝ 明确要求「自由摆放」：不吸附，位置随手放
        let free = ev.altKey

        if (!free) {
          /**
           * 指针是不是已经"挨着"某个主题了。挨着就**不允许**掉进自由摆放——
           * 那会把主题甩在树外面，自动布局随后把它搬去别处、连线横穿整张画布。
           */
          let adjacent = false

          // ① 先按「可吸附区域」找目标。区域是**分轴**外扩的：
          //    生长方向（子节点会待的那一侧）放宽，同级方向只留一点点。
          //    命中的候选里取离本体最近的——指针压在节点身上时距离为 0，自然优先。
          const nearby = dropCandidates.filter(
            (node) => !exclude.has(node.id) && distanceToRect(world, node.rect) <= SNAP_PREFILTER
          )
          const snap: SnapNode | null = nearestInRegion(
            nearby.map((node) => ({
              id: node.id,
              rect: node.rect,
              region: snapRegionOf(node.id) ?? node.rect,
              depth: node.depth
            })),
            world,
            exclude
          )
          if (snap) {
            adjacent = true
            // 语义仍交给 `zoneForPointer` / `resolveDrop`：
            // 沿同级方向贴前 / 贴后 → 插到它前 / 后；落回本体 → 成为它的子主题。
            // 目标是自己的父级时，`resolveDrop` 会正确地给出"原地不动"或"升一级"。
            const zone = zoneForPointer(snap.id, snap.rect, world)
            plan = resolveDrop(rootTopic, id, snap.id, zone, alsoDragged)
            // 挨着了却被裁决为非法：把**原因**写出来。否则用户看到的是"拖到这儿没反应"，
            // 只会以为软件坏了（"多选只能插同级"也是这一类）。
            if (!plan) blocked = blockReasonOf(rootTopic, id, snap.id, zone, alsoDragged)
          } else {
            // ② 区域没命中，再看是不是落在某两个同级主题**之间那条缝**里。
            //    缝比较宽时靠它兜底——区域本身只盖得住窄缝。
            const gap = nearestSiblingGap(dragStacks, world)
            if (gap) {
              adjacent = true
              plan = resolveDrop(rootTopic, id, gap.targetId, gap.mode, alsoDragged)
            }
            // ③ 再把一级主题拖到中心主题另一侧的情形认掉（那不是树上的落点）
            if (!plan) side = sideFlipTarget(world, id)
            // ④ 只有"什么都没挨着"才是自由摆放
            free = !plan && !side && !adjacent
          }
        }

        // 落点迟滞：换一个落点前，指针必须先走够一段距离。
        // 判定出结果后**只有一套**语义生效（plan / side / free 三者互斥），
        // 不会同时留下两个互相矛盾的预览。
        const freshKey = plan
          ? `${plan.targetId}|${plan.mode}`
          : side
            ? `side:${side}`
            : free
              ? 'free'
              : ''
        const latch = dropLatchRef.current
        // 迟滞按**世界单位**算：缩放到 50% 时屏幕位移要翻倍，手感才和 100% 时一致
        const withinHysteresis =
          Boolean(latch) &&
          Math.hypot(ev.clientX - (latch?.px ?? 0), ev.clientY - (latch?.py ?? 0)) <
            DROP_HYSTERESIS * z
        if (latch && latch.key !== freshKey && withinHysteresis) {
          // 还在迟滞半径里：保留上一次的裁决，不让提示在分界线上乱跳。
          // 空裁决（停在父级身上＝原地不动）也一起参与，否则提示会一闪一闪。
          plan = latch.plan
          side = latch.side
          free = latch.free
        } else if (freshKey) {
          dropLatchRef.current = {
            key: freshKey,
            plan,
            side,
            free,
            px: ev.clientX,
            py: ev.clientY
          }
        } else {
          dropLatchRef.current = null
        }

        dropPlanRef.current = plan
        setDropTarget(plan ? { id: plan.targetId, mode: plan.mode } : null)
        setDropLabel(group > 1 ? `${group} 个主题` : findTopic(rootTopic, id)?.title ?? '')
        setSideTarget(side)
        setFreeDrop(free)
        setDropBlocked(blocked)

        // 落点是个折叠着的主题时先把它展开：
        // 否则"新子主题会落在哪儿"完全看不见，只能靠猜，松手才知道对不对。
        if (plan?.mode === 'child' && !moving.ids.includes(plan.targetId)) {
          const topic = findTopic(rootRef.current, plan.targetId)
          if (topic?.collapsed) useEditor.getState().setCollapsed(plan.targetId, false)
        }
      }

      const detach = (): void => {
        stopScroll()
        dropLatchRef.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        window.removeEventListener('keydown', onKeyDown)
      }

      /** 指针被系统取消（例如切窗口）时只清理状态，不执行移动 */
      const onCancel = (): void => {
        detach()
        dropPlanRef.current = null
        setDragVisual(null)
        setDropTarget(null)
        setSideTarget(null)
        setFreeDrop(false)
        setDropBlocked('')
      }

      /** Esc 放弃这次拖拽：不动数据，把节点放回原处（Xmind 同款） */
      const onKeyDown = (ev: KeyboardEvent): void => {
        if (ev.key !== 'Escape') return
        ev.preventDefault()
        onCancel()
      }

      const onUp = (): void => {
        const active = plan
        const activeSide = side
        const startClient = pointerRef.current
        detach()
        dropPlanRef.current = null
        setDragVisual(null)
        setDropTarget(null)
        setSideTarget(null)
        setFreeDrop(false)
        setDropBlocked('')
        if (!moved || !startClient) return

        const worldDx = (startClient.x - startX) / zoomRef.current
        const worldDy = (startClient.y - startY) / zoomRef.current
        const state = useEditor.getState()

        if (active) {
          // 有落点就按落点走——注意落点也可能是"落在某两个节点中间的空隙里"，
          // 那种情况命中是空的但落点有值，不能当成自由摆放丢掉。
          // 多选拖拽只支持同级插入：成为某人的子主题无法同时满足一整群主题，
          // 会变成"只动了其中一个"，所以这种情况下落点本身就被裁决为非法。
          state.dropNode(id, active.targetId, active.mode)
          return
        }
        if (activeSide) {
          state.setTopicSide(id, activeSide)
          return
        }
        // 走到这里就是**自由摆放**（按住 Alt，或指针离最近的节点都很远）。
        // 只有真的动了才写：否则单击会凭空留下一条 0 位移的撤销记录。
        if (Math.abs(worldDx) < 1.5 && Math.abs(worldDy) < 1.5) return
        state.offsetPositions(
          moveRootsOf(moving).map((target) => ({ id: target, dx: worldDx, dy: worldDy }))
        )
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
      window.addEventListener('keydown', onKeyDown)
      scrollFrame = window.requestAnimationFrame(tick)
    },
    [
      screenToWorld,
      axesOf,
      zoneForPointer,
      snapRegionOf,
      siblingStacks,
      sideFlipTarget,
      dragAutoScroll,
      dropCandidates
    ]
  )

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
   *   框下写「将成为子主题」），并从目标**子节点那一列**的边缘接一条实线过去。
   *   特意不从目标本体拉线：目标往往已有子节点，从它身上拉线会斜穿那些子节点，看着像连错。
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
      return { kind: 'bar' as const, bar, color, title }
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
      title
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

  /* ---- 拖动关系线的线身：整体移动弧线（弯度偏移） ---- */
  const handleCurvePointerDown = useCallback((e: ReactPointerEvent<SVGPathElement>, relationshipId: string): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    const store = useEditor.getState()
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
        const startX = e.clientX
        const startY = e.clientY
        const startPan = { ...panRef.current }
        const onMove = (ev: PointerEvent): void => {
          setPan({ x: startPan.x + (ev.clientX - startX), y: startPan.y + (ev.clientY - startY) })
        }
        const detach = (): void => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onCancel)
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

        const hits = (layoutRef.current?.nodes ?? [])
          .filter(
            (node) =>
              node.x <= maxX &&
              node.x + node.width >= minX &&
              node.y <= maxY &&
              node.y + node.height >= minY
          )
          .map((node) => node.id)

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
      (n) => n.id === editingId || (n.x + n.width >= x0 && n.x <= x1 && n.y + n.height >= y0 && n.y <= y1)
    )
  }, [layout, pan.x, pan.y, zoom, size.width, size.height, editingId])

  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes])

  /* ---- 搜索命中与筛选：面板与画布共用 store 里的同一份条件 ---- */
  const sheet = useMemo(() => activeSheet(workbook), [workbook])

  const searchHits = useMemo(
    () => (search.query.trim().length > 0 ? hitTopicIds(searchSheet(sheet, search.query, search.options)) : null),
    [sheet, search.query, search.options]
  )

  const filterResult = useMemo(
    () => (isFilterActive(filter) ? applyTopicFilter(sheet.rootTopic, filter) : null),
    [sheet, filter]
  )

  const visibleEdges = useMemo(
    () => layout.edges.filter((e) => visibleIds.has(e.toId) || visibleIds.has(e.fromId)),
    [layout.edges, visibleIds]
  )

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

  /** 画一条树上的连线。静态层与拖拽层共用，避免样式写两遍。 */
  const renderEdge = (edge: (typeof layout.edges)[number]): ReactElement => {
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
        opacity={colors.edgeOpacity}
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

          {/* 边界标题单独画，保证文字在填充之上 */}
          {layout.boundaries.map((boundary) =>
            boundary.title ? (
              <text
                key={`boundary-title-${boundary.id}`}
                className="overlay-title"
                x={boundary.label.x}
                y={boundary.label.y}
                fontSize={12}
                fontWeight={600}
                fill={
                  boundary.branchId
                    ? branchColorOf(colors, layout, boundary.branchId)
                    : colors.deepText
                }
                dominantBaseline="middle"
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
                {boundary.title}
              </text>
            ) : null
          )}

          {/* 概要：覆盖一组同级主题的大括号 + 概要文字 */}
          {layout.summaries.map((summary) => {
            const color = summary.branchId ? branchColorOf(colors, layout, summary.branchId) : colors.deepText
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
                {summary.title ? (
                  <text
                    className="overlay-title"
                    x={summary.label.x}
                    y={summary.label.y}
                    fontSize={13}
                    fontWeight={600}
                    fill={color}
                    textAnchor={summary.anchor}
                    dominantBaseline="middle"
                    /* 用画布色给文字描一圈边，即使压到别的内容上也读得清 */
                    stroke={colors.canvas}
                    strokeWidth={4}
                    paintOrder="stroke"
                    strokeLinejoin="round"
                    onDoubleClick={() =>
                      setTitleEdit({
                        kind: 'summary',
                        id: summary.id,
                        x: summary.label.x,
                        y: summary.label.y,
                        anchor: summary.anchor,
                        value: summary.title ?? ''
                      })
                    }
                  >
                    {summary.title}
                  </text>
                ) : null}
              </g>
            )
          })}

          {staticEdges.map(renderEdge)}

          {/* 子树内部的连线：跟着被拖的节点一起平移重画 */}
          {dragSet && dragVisual ? (
            <g transform={`translate(${dragVisual.dx} ${dragVisual.dy})`} opacity={0.9}>
              {dragEdges.map(renderEdge)}
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
            dimmed={filterResult ? !filterResult.keep.has(node.id) : false}
            dragOffset={
              dragVisual && dragSet?.has(node.id) ? { dx: dragVisual.dx, dy: dragVisual.dy } : null
            }
            dragPrimary={Boolean(dragVisual && dragVisual.anchorId === node.id)}
            onPointerDown={handleNodePointerDown}
            onDoubleClick={(id) => useEditor.getState().beginEdit(id)}
            onRichChange={(id, rich) => {
              const store = useEditor.getState()
              if (store.editingId === id) store.updateEditingRich(rich)
            }}
            onCancelEdit={() => useEditor.getState().cancelEdit()}
            onCommitEdit={() => useEditor.getState().commitEdit()}
            onCommitAndAddChild={() => useEditor.getState().commitAndAddChild()}
            onCommitAndAddSibling={() => useEditor.getState().commitAndAddSibling()}
            onNavigateEdit={(key) => {
              // 空主题上的方向键：先提交（空内容不会进撤销栈），再移动选择
              const store = useEditor.getState()
              if (store.editingId) store.commitEdit()
              store.navigateSelection(key)
            }}
            onToggleCollapse={(id) => useEditor.getState().toggleCollapse(id)}
          />
        ))}

        {/* 关系线画在节点之上，避免被节点挡住 */}
        <svg className="canvas__overlay" width={layout.bounds.width} height={layout.bounds.height}>
          {layout.relationships.map((relationship) => {
            const color = relationship.branchId
              ? branchColorOf(colors, layout, relationship.branchId)
              : colors.deepText
            const angle = ((relationship.arrow.angle * 180) / Math.PI).toFixed(1)
            return (
              <g key={`relationship-${relationship.id}`}>
                <path d={relationship.d} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
                {/* 线身的可拖拽命中区在节点下面那一层，见上方 canvas__overlay 命中层 */}

                <path
                  d="M 0 0 L -10 -4 L -10 4 Z"
                  transform={`translate(${relationship.arrow.x} ${relationship.arrow.y}) rotate(${angle})`}
                  fill={color}
                />
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
                  >
                    {relationship.title}
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
                      handleRelationshipPointerDown(event, relationship.id, handle.end, handle.point)
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
                将成为子主题
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

        {/* 双击标题后的就地编辑框。放在世界容器内，所以会随画布一起缩放 */}
        {titleEdit ? (
          <input
            className="overlay-title-editor"
            style={{
              left: titleEdit.x,
              top: titleEdit.y - 13,
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
              if (e.key === 'Enter' || e.key === 'Escape') {
                e.preventDefault()
                // 统一交给失焦处理，避免「回车提交」和「失焦提交」各写一次
                if (e.key === 'Escape') cancelTitleRef.current = true
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
          拖到主题上＝成为子主题
        </span>
        <span className="canvas__drag-legend-sep">·</span>
        <span
          className={dragVisual && dropTarget && dropTarget.mode !== 'child' ? 'is-active' : undefined}
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
