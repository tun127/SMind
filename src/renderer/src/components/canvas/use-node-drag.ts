import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react'
import { alsoDraggedOf, moveRootsOf, resolveDragMove, type DragMove } from '@shared/model/dragmove'
import {
  blockReasonOf,
  distanceToRect,
  nearestInRegion,
  nearestSiblingGap,
  resolveDrop,
  type DropMode,
  type DropRect,
  type DropResult,
  type SiblingStack,
  type SnapNode
} from '@shared/model/drop'
import { findTopic } from '@shared/model/tree'
import type { Topic } from '@shared/model/types'
import { attrTranslate, cssTranslate } from '../../render/transform'
import { useEditor } from '../../store/editor'
import type { useCanvasGeometry } from './use-canvas-geometry'
import { DROP_HYSTERESIS, DROP_HYSTERESIS_TARGET, SNAP_PREFILTER } from './geometry'

/**
 * 拖动节点（自 `Canvas.tsx` 整块搬出，函数体逐字未改）。
 *
 * 这一批搬的是「拖拽」这一件事的**全部内部状态**：落点 state 5 个、拖拽用的 ref 7 个、
 * 贴边自动滚动、以及 391 行的 `handleNodePointerDown`（它内部还带着 `applyGhostTransform`、
 * `onMove` / `onUp` / `onCancel` / `onKeyDown` 与 `detach`）。
 *
 * **留在画布的两个东西**（以参数进 hook，因为它们要更早被用到）：
 * `dragVisual` 与 `nodePointerHeldRef`——视角锁定那条 follow hook 在画布更靠上的位置就要读它们
 * （拖拽期间镜头必须一动不动）。`setDragVisual` 也以参数进来：拖拽处理器要写它。
 *
 * **依赖数组**：`handleNodePointerDown` 原来的 `[screenToWorld, zoneForPointer, snapRegionOf,
 * siblingStacks, sideFlipTarget, dragAutoScroll, dropCandidates]` 逐字保留（这些名字在这里
 * 要么是入参、要么是本模块内的 `dragAutoScroll`）。lint 要求补进来的 ref 参数是**恒定身份**，
 * 不改任何回调的重建时机。
 */

/** 手里抓着的那个节点在拖拽期间的可视状态（与画布里那份 `useState` 同型） */
export interface DragVisual {
  /** 手里抓着的那一个（多选时是抓的那个，不是整群的第一个） */
  anchorId: string
  dx: number
  dy: number
  moving: DragMove
  /** 整群被拖时，用来把「点谁拖谁」说明白 */
  group: number
}

type Geometry = ReturnType<typeof useCanvasGeometry>

interface Deps {
  containerRef: RefObject<HTMLDivElement | null>
  panRef: RefObject<{ x: number; y: number }>
  rootRef: RefObject<Topic>
  zoomRef: RefObject<number>
  selectionRef: RefObject<string[]>
  /** 「手上正按着一个节点」——跟随循环要看它，所以它留在画布 */
  nodePointerHeldRef: RefObject<boolean>
  /** 供吸附用的候选节点表（画布里的 `useMemo`，随布局重算） */
  dropCandidates: Array<{ id: string; rect: DropRect; depth: number }>
  screenToWorld: Geometry['screenToWorld']
  siblingStacks: Geometry['siblingStacks']
  sideFlipTarget: Geometry['sideFlipTarget']
  snapRegionOf: Geometry['snapRegionOf']
  zoneForPointer: Geometry['zoneForPointer']
  setPan(pan: { x: number; y: number }): void
  setDragVisual(value: DragVisual | null): void
}

export function useNodeDrag({
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
}: Deps): {
  dropTarget: { id: string; mode: DropMode } | null
  setDropTarget(value: { id: string; mode: DropMode } | null): void
  sideTarget: 'left' | 'right' | null
  setSideTarget(value: 'left' | 'right' | null): void
  dropLabel: string
  setDropLabel(value: string): void
  freeDrop: boolean
  setFreeDrop(value: boolean): void
  dropBlocked: string
  setDropBlocked(value: string): void
  ghostElsRef: RefObject<HTMLElement[]>
  dragEdgesRef: RefObject<SVGGElement | null>
  ghostOffsetRef: RefObject<{ dx: number; dy: number } | null>
  handleNodePointerDown(e: ReactPointerEvent<HTMLDivElement>, id: string): void
} {
  /**
   * 当前拖拽会话的清理函数（`detach` 要按下时才创建，所以用 ref 转交给最外层的 cleanup）。
   *
   * 为什么必须有这层兜底：4 个监听都挂在 window 上，而 `detach()` 只在松手 / 取消 / Esc 里调用。
   * 用户在**拖着不松手**的时候切标签或关抽屉，组件卸载了监听却还在 —— 之后松手还会走一次
   * `dropNode`（对已经不存在的文档是 no-op，但白做一次 hitTest，报告 D-12）。
   */
  const detachRef = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      detachRef.current?.()
      detachRef.current = null
    },
    []
  )

  /* ---- 落点状态（R1） ---- */
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

  /* ---- 拖拽用的 ref（R2） ---- */
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
  /**
   * 被拖子树对应的 DOM 元素 + 子树内部连线的分组。
   *
   * 拖拽期间这两个直接用**命令式**改 `transform`（见 `applyGhostTransform`）：
   * 位置与 `pointermove` 同帧落地，不再等 React 重渲染。放 ref 里是因为它们
   * 只在一次拖拽的生命周期内有效，不需要参与渲染。
   */
  const ghostElsRef = useRef<HTMLElement[]>([])
  const dragEdgesRef = useRef<SVGGElement | null>(null)
  /** 最近一次命令式写入的位移（拖拽层刚挂载时用它补齐，见下面的 effect） */
  const ghostOffsetRef = useRef<{ dx: number; dy: number } | null>(null)
  /** 上一次进 state 的落点目标（值形式：`id|mode`），用来避免每帧都让画布重渲染 */
  const dropTargetKeyRef = useRef('')

  /* ---- 拖拽过程中：贴住画布边缘时自动滚动 ---- */
  const dragAutoScroll = useCallback((): void => {
    const el = containerRef.current
    const pointer = pointerRef.current
    if (!el || !pointer) return
    const rect = el.getBoundingClientRect()
    const EDGE = 72
    const MAX_SPEED = 26
    const speed = (distance: number): number =>
      Math.min(MAX_SPEED, ((EDGE - distance) / EDGE) * MAX_SPEED)

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
    // ref 是恒定身份：列进依赖不改本回调的重建时机
  }, [setPan, containerRef, panRef])

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

      /**
       * 从这一刻起就算"手上按着"：下面马上会 `select(id)`，而视角锁定的跟随循环
       * 一看到 focusId 变化就会把镜头缓动过去——那就是"长按节点的小跳转"。
       * 先立标记，跟随循环就不动镜头（松手 / 取消在 `detach` 里清掉；
       * 放在这里是因为上面那两处提前返回不会再走到 `detach`）。
       */
      nodePointerHeldRef.current = true
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
      /** 拖拽开始时的镜头平移：位移要减掉镜头自己走的那一段（见 `applyMove`） */
      const startPan = { x: panRef.current.x, y: panRef.current.y }
      let moved = false
      let plan: DropResult | null = null
      let side: 'left' | 'right' | null = null

      /**
       * 吸附候选连各自的可吸附区域**只算一次**：区域只依赖布局，
       * 而布局在拖拽期间是冻结的。以前每帧都要对每个候选重算一遍 `snapRegionOf`，
       * 那是 O(节点数) 的纯几何开销，属于白烧的帧预算。
       */
      const snapCandidates: SnapNode[] = dropCandidates.map((node) => ({
        id: node.id,
        rect: node.rect,
        region: snapRegionOf(node.id) ?? node.rect,
        depth: node.depth
      }))
      /** 拖拽提示里的标题：拖拽期间不会变，不该每帧全树遍历去查 */
      const dragTitle = findTopic(rootRef.current, id)?.title ?? ''

      /**
       * 被拖子树对应的 DOM 元素（一次查完）。
       *
       * 拖拽期间**直接改它们的 transform**，不等 React：见 `applyGhostTransform`。
       * 查一次而不是每帧查，是因为 `querySelectorAll` 本身会强制样式计算。
       */
      const movingIdSet = new Set(moving.ids)
      ghostElsRef.current = Array.from(
        containerRef.current?.querySelectorAll<HTMLElement>('.topic[data-topic-id]') ?? []
      ).filter((el) => movingIdSet.has(el.dataset.topicId ?? ''))

      /** 命令式地把被拖子树与它的内部连线移到 (worldDx, worldDy) */
      const applyGhostTransform = (worldDx: number, worldDy: number): void => {
        ghostOffsetRef.current = { dx: worldDx, dy: worldDy }
        const css = cssTranslate(worldDx, worldDy)
        for (const el of ghostElsRef.current) el.style.transform = css
        dragEdgesRef.current?.setAttribute('transform', attrTranslate(worldDx, worldDy))
      }
      /** 松手 / 取消时把命令式写的位移清掉（否则会和 React 重新渲染的新位置叠加） */
      const clearGhostTransform = (): void => {
        ghostOffsetRef.current = null
        for (const el of ghostElsRef.current) el.style.transform = ''
        dragEdgesRef.current?.setAttribute('transform', '')
        ghostElsRef.current = []
      }

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

      /**
       * pointermove **只记下最新位置**，真正的计算每帧最多跑一次。
       *
       * 节点拖拽是唯一一条没有合帧的高频路径（滚轮、平移、AI 写入都合帧了）：
       * 高刷屏 / 手写板上 pointermove 能到 120~160 次/秒，每次都走一整遍落点裁决
       * 并触发一次全画布重渲染——掉帧就是这么来的。合帧之后每帧最多算一次，
       * 而且丢掉的都是同帧内的中间位置（对落点没有意义）。
       */
      let pendingEvent: PointerEvent | null = null
      let moveFrame = 0
      const flushMove = (): void => {
        moveFrame = 0
        const ev = pendingEvent
        pendingEvent = null
        if (ev) applyMove(ev)
      }
      /**
       * 每次 pointermove 都**重新排一帧**——不要用 `if (moveFrame === 0)` 防重复。
       *
       * `requestAnimationFrame` 在窗口被遮住 / 切到后台时不会派发；一旦那一帧没来，
       * 「已排队」这个标记就永远是 true，后续移动全被跳过，**拖拽就冻死在原地**。
       * （这正是我用调试端口在后台窗口里扫描时"整片无反应"的原因——不是产品缺陷，
       * 但它确实是个能冻住拖拽的隐患。）多排一个空回调的代价可以忽略：
       * 同一帧里的重复回调只是多跑几次空操作。
       */
      const onMove = (ev: PointerEvent): void => {
        pendingEvent = ev
        moveFrame = window.requestAnimationFrame(flushMove)
      }

      const applyMove = (ev: PointerEvent): void => {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        if (!moved && Math.hypot(dx, dy) < 4) return
        moved = true
        // 自动滚动与松手时的落点都读这个位置，所以每帧都要更新
        pointerRef.current = { x: ev.clientX, y: ev.clientY, startX, startY }
        const z = zoomRef.current
        /**
         * 位移要**减掉镜头自己走的那一段**。
         *
         * 节点的屏幕位置 ＝ `pan + (布局位置 + 位移) × 缩放`。拖拽期间镜头完全可能移动
         * （贴边自动滚动、用户滚轮、视角锁定重新咬住），位移里不减掉它，
         * 节点就会相对指针"飘逸"——用户报的就是这个词（起因是"长按节点有个小视角跳转"）。
         */
        const panNow = panRef.current
        const worldDx = (dx - (panNow.x - startPan.x)) / z
        const worldDy = (dy - (panNow.y - startPan.y)) / z
        /**
         * 位移**先命令式落地**，再更新 React 状态（后者只喂预览框 / 高亮 / 淡化）。
         *
         * 这一步是"拖拽不同步"的解药：以前位移要等 React 把整个画布重渲染完才生效，
         * 节点多、连线多的时候节点明显落后于指针（快甩一下差出几百像素）。
         */
        applyGhostTransform(worldDx, worldDy)
        setDragVisual({ anchorId: id, dx: worldDx, dy: worldDy, moving, group })

        const world = screenToWorld(ev.clientX, ev.clientY)
        const rootTopic = rootRef.current
        const exclude = new Set(moving.ids)

        plan = null
        side = null
        /**
         * 本帧的非法落点原因（空串表示没有）。
         * **必须每帧重置**：以前只在声明处初始化，于是"先撞上非法落点、再移到合法落点"时，
         * 底部会一直挂着过期的非法原因（用户看到的是软件在瞎报）。
         */
        let blocked = ''
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
          const nearby = snapCandidates.filter(
            (node) => !exclude.has(node.id) && distanceToRect(world, node.rect) <= SNAP_PREFILTER
          )
          const snap: SnapNode | null = nearestInRegion(nearby, world, exclude)
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
        // 迟滞按**屏幕像素**算：手感取决于"手走了多远"，与画布缩放无关。
        // 早先乘了缩放系数，放大时会异常黏、缩小时几乎失效。
        /**
         * 换**类型**（成为子主题 / 插到同级 / 自由摆放）才用完整的 14px；
         * 只是换**目标节点**时 6px 就够——纵向拖动每几十像素就会跨过一个兄弟，
         * 用 14px 会明显"慢半拍"。
         */
        const kindOf = (p: DropResult | null, s: 'left' | 'right' | null, f: boolean): string =>
          p ? `plan:${p.mode}` : s ? `side:${s}` : f ? 'free' : ''
        const freshKind = kindOf(plan, side, free)
        const sameKind = latch !== null && kindOf(latch.plan, latch.side, latch.free) === freshKind
        const needed = sameKind ? DROP_HYSTERESIS_TARGET : DROP_HYSTERESIS
        const withinHysteresis =
          Boolean(latch) &&
          Math.hypot(ev.clientX - (latch?.px ?? 0), ev.clientY - (latch?.py ?? 0)) < needed
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
        /**
         * 落点目标先按**值**比对一次再进 state。
         *
         * `{ id, mode }` 每帧都是新对象，直接 setState 会让 React **每帧**重渲染整个画布
         * （几百个节点 + 连线全部重新协调一遍）——指针在同一片落点里移动时，这些活全是白烧的。
         * 值没变就不 set：React 连一个组件都不用重渲染。
         */
        const targetKey = plan ? `${plan.targetId}|${plan.mode}` : ''
        if (targetKey !== dropTargetKeyRef.current) {
          dropTargetKeyRef.current = targetKey
          setDropTarget(plan ? { id: plan.targetId, mode: plan.mode } : null)
        }
        setDropLabel(group > 1 ? `${group} 个主题` : dragTitle)
        setSideTarget(side)
        setFreeDrop(free)
        setDropBlocked(blocked)

        // 注意：落点是折叠主题时**不要在这里展开**。
        // 悬停就改数据，会让一次被 Esc 取消的拖拽也留下改动和撤销记录；
        // 展开改在真正落下时做，且和移动合并成同一笔（见 store 的 dropNode）。
      }

      const detach = (): void => {
        stopScroll()
        if (moveFrame !== 0) window.cancelAnimationFrame(moveFrame)
        moveFrame = 0
        pendingEvent = null
        // 手上没按着了：视角锁定的跟随循环可以重新咬住目标
        nodePointerHeldRef.current = false
        // 命令式写的位移必须先清掉：松手后由 React 按新布局渲染，
        // 留着它会让节点「新的自动位置 + 旧的拖拽位移」叠在一起。
        clearGhostTransform()
        dropLatchRef.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        window.removeEventListener('keydown', onKeyDown)
      }

      // 登记给最外层的 cleanup：组件在拖拽中途被卸载时由它兜底收尾（见 hook 顶部的 detachRef）
      detachRef.current = detach

      /** 指针被系统取消（例如切窗口）时只清理状态，不执行移动 */
      const onCancel = (): void => {
        detach()
        dropPlanRef.current = null
        setDragVisual(null)
        dropTargetKeyRef.current = ''
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
        /**
         * 先把还没轮到的那次移动算掉。合帧之后 pointerup 可能紧跟在一个尚未执行的
         * rAF 后面——直接读 `plan` 会让"松手前最后一格"白丢，落点就成了上一帧的（错的）。
         */
        if (moveFrame !== 0) window.cancelAnimationFrame(moveFrame)
        const last = pendingEvent
        pendingEvent = null
        moveFrame = 0
        if (last) applyMove(last)

        const active = plan
        const activeSide = side
        const startClient = pointerRef.current
        detach()
        dropPlanRef.current = null
        setDragVisual(null)
        dropTargetKeyRef.current = ''
        setDropTarget(null)
        setSideTarget(null)
        setFreeDrop(false)
        setDropBlocked('')
        if (!moved || !startClient) return

        // 同 `applyMove`：自由摆放的落点也要减掉镜头自己走的那一段
        const panNow = panRef.current
        const worldDx = (startClient.x - startX - (panNow.x - startPan.x)) / zoomRef.current
        const worldDy = (startClient.y - startY - (panNow.y - startPan.y)) / zoomRef.current
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
      zoneForPointer,
      snapRegionOf,
      siblingStacks,
      sideFlipTarget,
      dragAutoScroll,
      dropCandidates,
      // 下面这些是从画布传进来的 ref / React setter：身份恒定，列进依赖数组不改本回调的重建时机
      containerRef,
      panRef,
      rootRef,
      zoomRef,
      selectionRef,
      nodePointerHeldRef,
      setDragVisual
    ]
  )

  return {
    dropTarget,
    setDropTarget,
    sideTarget,
    setSideTarget,
    dropLabel,
    setDropLabel,
    freeDrop,
    setFreeDrop,
    dropBlocked,
    setDropBlocked,
    ghostElsRef,
    dragEdgesRef,
    ghostOffsetRef,
    handleNodePointerDown
  }
}
