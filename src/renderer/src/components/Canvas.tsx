import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { layoutSheet } from '@shared/layout'
import type { LayoutResult } from '@shared/layout/types'
import type { Topic } from '@shared/model/types'
import { activeRoot, activeSheet, isSelfOrDescendant } from '@shared/model/tree'
import { measureTopic, bumpMeasureEpoch } from '../render/measure'
import { clearFormulaCache } from '../render/formula'
import { branchColorOf } from '../render/theme'
import { viewportActions } from '../render/viewport'
import { themeColorsOf, useEditor } from '../store/editor'
import TopicNode from './TopicNode'

export default function Canvas(): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  const workbook = useEditor((s) => s.workbook)
  const docSeq = useEditor((s) => s.docSeq)
  const zoom = useEditor((s) => s.zoom)
  const pan = useEditor((s) => s.pan)
  const selection = useEditor((s) => s.selection)
  const editingId = useEditor((s) => s.editingId)
  const editingText = useEditor((s) => s.editingText)
  const editingRich = useEditor((s) => s.editingRich)
  const setPan = useEditor((s) => s.setPan)
  const setZoom = useEditor((s) => s.setZoom)

  const [dragVisual, setDragVisual] = useState<{ id: string; dx: number; dy: number } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

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

  useEffect(() => {
    viewportActions.fit = fit
    viewportActions.centerRoot = centerRoot
    viewportActions.zoomTo = zoomTo
    viewportActions.ensureVisible = ensureVisible
  }, [fit, centerRoot, zoomTo, ensureVisible])

  /* ---- 进入编辑态时保证节点可见（新建主题可能超出视口） ---- */
  useEffect(() => {
    if (!editingId) return
    const target = editingId
    const frame = window.requestAnimationFrame(() => viewportActions.ensureVisible(target))
    return () => window.cancelAnimationFrame(frame)
  }, [editingId])

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

  /* ---- 拖动节点 ---- */
  const handleNodePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, id: string): void => {
      if (e.button !== 0) return
      e.stopPropagation()
      const store = useEditor.getState()
      if (store.editingId === id) return
      if (store.editingId) store.commitEdit()
      store.select(id, e.ctrlKey || e.metaKey)

      const startX = e.clientX
      const startY = e.clientY
      let moved = false
      let target: string | null = null

      const onMove = (ev: PointerEvent): void => {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        if (!moved && Math.hypot(dx, dy) < 4) return
        moved = true
        const z = zoomRef.current
        setDragVisual({ id, dx: dx / z, dy: dy / z })
        const world = screenToWorld(ev.clientX, ev.clientY)
        target = hitTest(world.x, world.y, id)
        setDropTarget(target)
      }

      const detach = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
      }

      /** 指针被系统取消（例如切窗口）时只清理状态，不执行移动 */
      const onCancel = (): void => {
        detach()
        setDragVisual(null)
        setDropTarget(null)
      }

      const onUp = (ev: PointerEvent): void => {
        detach()
        setDragVisual(null)
        setDropTarget(null)
        if (!moved) return
        const dx = (ev.clientX - startX) / zoomRef.current
        const dy = (ev.clientY - startY) / zoomRef.current
        const state = useEditor.getState()
        if (target) state.moveNode(id, target)
        else state.offsetPosition(id, dx, dy)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
    },
    [hitTest, screenToWorld]
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
  const visibleEdges = useMemo(
    () => layout.edges.filter((e) => visibleIds.has(e.toId) || visibleIds.has(e.fromId)),
    [layout.edges, visibleIds]
  )

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

          {visibleEdges.map((edge) => {
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
          })}
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
            highlighted={dropTarget === node.id || handleDrag?.targetId === node.id}
            dragOffset={dragVisual && dragVisual.id === node.id ? { dx: dragVisual.dx, dy: dragVisual.dy } : null}
            onPointerDown={handleNodePointerDown}
            onDoubleClick={(id) => useEditor.getState().beginEdit(id)}
            onRichChange={(id, rich) => {
              const store = useEditor.getState()
              if (store.editingId === id) store.updateEditingRich(rich)
            }}
            onCancelEdit={() => useEditor.getState().cancelEdit()}
            onCommitAndAddChild={() => useEditor.getState().commitAndAddChild()}
            onCommitAndAddSibling={() => useEditor.getState().commitAndAddSibling()}
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

                {/* 线身加粗透明的命中区：拖动即可整体移动弧线，双击恢复自动弯度 */}
                <path
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
