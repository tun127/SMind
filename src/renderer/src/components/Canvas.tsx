import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { Topic } from '@shared/model/types'
import { activeRoot } from '@shared/model/tree'
import type { DragMove } from '@shared/model/dragmove'
import { count } from '../dev/stage'
import { usePacedWorkbook } from '../hooks/usePacedWorkbook'
import { attrTranslate, cssTranslate } from '../render/transform'
import { useEditor } from '../store/editor'
import { useCanvasGeometry } from './canvas/use-canvas-geometry'
import { useCanvasViewport } from './canvas/use-canvas-viewport'
import { useFlashNodes } from './canvas/use-flash-nodes'
import { useFoldAnchor } from './canvas/use-fold-anchor'
import { useViewFollow } from './canvas/use-view-follow'
import { useWheelPanZoom } from './canvas/use-wheel-pan-zoom'
import { useMarqueeSelect } from './canvas/use-marquee-select'
import { useRelationshipDrag } from './canvas/use-relationship-drag'
import { useTitleEdit } from './canvas/use-title-edit'
import { useNodeDrag } from './canvas/use-node-drag'
import { useCanvasDisplay } from './canvas/use-canvas-display'
import { useCanvasLayout } from './canvas/use-canvas-layout'
import { CanvasEdgesLayer } from './canvas/canvas-edges-layer'
import { CanvasNodesLayer } from './canvas/canvas-nodes-layer'
import { CanvasHints } from './canvas/canvas-hints'
import { CanvasTitleEditor } from './canvas/canvas-title-editor'
import { useNodeCallbacks } from './canvas/use-node-callbacks'
import { CanvasOverlayLayer } from './canvas/canvas-overlay-layer'
import { CanvasRelationshipHitLayer } from './canvas/canvas-relationship-hit-layer'

export default function Canvas(): ReactElement {
  // 每秒渲染次数：数字爆表就是「重渲染风暴」，是这类卡死最常见的形态
  count('画布渲染')

  const containerRef = useRef<HTMLDivElement | null>(null)

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
  /* ---- 布局与测量：整块搬进 canvas/use-canvas-layout.ts（三条 effect 的次序不变） ---- */
  const { layout, layoutRef, dropCandidates, colors, boundaryGroups, size } = useCanvasLayout({
    containerRef,
    workbook,
    layoutWorkbook,
    editingId,
    editingText,
    editingRich
  })

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
  /* ---- 拖动关系线的端点改接 + 线身移动 + 元素选中：整块搬进 canvas/use-relationship-drag.ts ---- */
  // 注意：state setter 没有解构出来（画布不再需要它——更新函数写法随处理器一起进了 hook），
  // 它仍由 hook 返回（`Dispatch<SetStateAction<…>>`），将来要用直接解构即可
  const { handleDrag, pickOverlay, handleRelationshipPointerDown, handleCurvePointerDown } =
    useRelationshipDrag({ zoomRef, screenToWorld, hitTest })
  /* ---- 双击标题就地编辑：整块搬进 canvas/use-title-edit.ts ---- */
  const { titleEdit, setTitleEdit, cancelTitleRef, commitTitleEdit } = useTitleEdit()

  /* ---- 节点回调：整块搬进 canvas/use-node-callbacks.ts（引用仍然永远稳定） ---- */
  const {
    handleNodeDoubleClick,
    handleNodeRichChange,
    handleNodeCancelEdit,
    handleNodeCommitEdit,
    handleNodeCommitAndAddChild,
    handleNodeCommitAndAddSibling,
    handleNodeNavigateEdit,
    handleNodeToggleCollapse,
    handleNodeToggleFoldSide
  } = useNodeCallbacks({ containerRef, layoutRef, zoomRef, panRef })

  /* ---- 空白处：右键/中键拖动平移、左键拖动框选：整块搬进 canvas/use-marquee-select.ts ---- */
  const { marquee, handleBackgroundPointerDown } = useMarqueeSelect({
    containerRef,
    layoutRef,
    zoomRef,
    panRef,
    viewGestureAtRef,
    setPan
  })
  /* ---- 展示层派生值：整块搬进 canvas/use-canvas-display.ts ---- */
  const {
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
  } = useCanvasDisplay({
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
  })

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
        <CanvasEdgesLayer
          layout={layout}
          colors={colors}
          boundaryGroups={boundaryGroups}
          selectedOverlay={selectedOverlay}
          pickOverlay={pickOverlay}
          setTitleEdit={setTitleEdit}
          staticEdges={staticEdges}
          dragEdges={dragEdges}
          dragSet={dragSet}
          dragVisual={dragVisual}
          dragFocus={dragFocus}
          dragEdgesRef={dragEdgesRef}
        />

        <CanvasRelationshipHitLayer
          layout={layout}
          handleCurvePointerDown={handleCurvePointerDown}
        />

        <CanvasNodesLayer
          layout={layout}
          colors={colors}
          selection={selection}
          editingId={editingId}
          editingRich={editingRich}
          visibleNodes={visibleNodes}
          handleDrag={handleDrag}
          dragVisual={dragVisual}
          dragSet={dragSet}
          dragFocus={dragFocus}
          dropTarget={dropTarget}
          searchHits={searchHits}
          marqueeHits={marqueeHits}
          flashIds={flashIds}
          filterResult={filterResult}
          handleNodePointerDown={handleNodePointerDown}
          handleNodeDoubleClick={handleNodeDoubleClick}
          handleNodeRichChange={handleNodeRichChange}
          handleNodeCancelEdit={handleNodeCancelEdit}
          handleNodeCommitEdit={handleNodeCommitEdit}
          handleNodeCommitAndAddChild={handleNodeCommitAndAddChild}
          handleNodeCommitAndAddSibling={handleNodeCommitAndAddSibling}
          handleNodeNavigateEdit={handleNodeNavigateEdit}
          handleNodeToggleCollapse={handleNodeToggleCollapse}
          handleNodeToggleFoldSide={handleNodeToggleFoldSide}
        />

        <CanvasOverlayLayer
          layout={layout}
          colors={colors}
          selectedOverlay={selectedOverlay}
          dropPreview={dropPreview}
          sideFlipPreview={sideFlipPreview}
          groupBadge={groupBadge}
          handleDrag={handleDrag}
          handleRelationshipPointerDown={handleRelationshipPointerDown}
          pickOverlay={pickOverlay}
          setTitleEdit={setTitleEdit}
        />

        {/* 双击标题后的就地编辑框（整块搬进 canvas/canvas-title-editor.tsx） */}
        <CanvasTitleEditor
          titleEdit={titleEdit}
          setTitleEdit={setTitleEdit}
          cancelTitleRef={cancelTitleRef}
          commitTitleEdit={commitTitleEdit}
        />
      </div>

      {/* 底部提示层（图例 / 自由摆放 / 非法落点原因 / 框选橡皮筋）：搬进 canvas/canvas-hints.tsx */}
      <CanvasHints
        dragVisual={dragVisual}
        dropTarget={dropTarget}
        freeDrop={freeDrop}
        dropBlocked={dropBlocked}
        marquee={marquee}
      />
    </div>
  )
}
