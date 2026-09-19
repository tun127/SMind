import { useEffect, useMemo, useRef, type RefObject } from 'react'
import type { LayoutResult } from '@shared/layout/types'
import type { DragMove } from '@shared/model/dragmove'
import { activeRoot, findTopic } from '@shared/model/tree'
import type { Workbook } from '@shared/model/types'
import { count, mark, setStage } from '../../dev/stage'
import { warnViewLock } from './view-lock-warn'

/**
 * 视角锁定：把选中的主题稳稳按在视口中央（自 `Canvas.tsx` 整块搬出）。
 *
 * **搬迁单位**：从「盯住哪个主题」到「跟随循环」是**一件事**，所以一起搬——
 * `focus` / `focusId` / `focusFromSelection` / `focusKey` 四个派生值在整个画布里
 * **只被这一条跟随 effect 用**（已逐一 grep 核对），留在外面就是四个没有消费者的常量。
 *
 * **两条 effect 的先后顺序与依赖数组一字未动**：先是「刚打开锁定」标记的记录，
 * 然后是跟随循环本体。`focusKey` 那三个 `useMemo` 没有顺序语义（只有 effect 有），
 * 搬进 hook 不影响任何行为。
 *
 * 依赖数组里补进来的 ref（`nodePointerHeldRef` / `containerRef` / `layoutRef` /
 * `zoomRef` / `panRef` / `viewGestureAtRef`）都是**恒定身份**，不改本 effect 的重跑时机
 * （原来它们是本地 `useRef`、被 lint 规则豁免，现在从参数进来必须显式列出）。
 */

interface Deps {
  selection: string[]
  workbook: Workbook
  layout: LayoutResult
  viewLock: boolean
  /** 正在拖主题（拖拽期间必须一动不动，见 effect 体注释） */
  dragVisual: { anchorId: string; dx: number; dy: number; moving: DragMove; group: number } | null
  nodePointerHeldRef: RefObject<boolean>
  editingId: string | null
  zoom: number
  size: { width: number; height: number }
  setPan(pan: { x: number; y: number }): void
  containerRef: RefObject<HTMLDivElement | null>
  layoutRef: RefObject<LayoutResult>
  zoomRef: RefObject<number>
  panRef: RefObject<{ x: number; y: number }>
  viewGestureAtRef: RefObject<number>
}

export function useViewFollow({
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
}: Deps): void {
  /**
   * 视角锁定要盯住的那个主题。
   *
   * - 选择为空（点了画布空白处）→ **跟中心主题**：开锁的瞬间视角立即有明确反馈
   *   （居中到中心主题）。以前这里是"什么都不做"，结果就是用户看到的
   *   「锁定开着却不锁」——没有目标时静默不跟随，看起来像功能坏了；
   * - 选择指向一个**已经不存在的主题**（刚删完、撤销回到另一个版本）→ 退回中心主题，
   *   而不是"盯不到就彻底不动"——那正是用户看到的「删除后视角不跟随」；
   * - 选择指向一个**被折叠收进去的主题** → 同样退回中心主题。
   *   折叠不会删节点（模型里还在，`findTopic` 找得到），但布局对折叠的子树返回空
   *   （`visibleChildren`），它已经**不在 nodeMap 里**了——不回退的话 focusId
   *   会一直指向一个永远等不到的目标，跟随循环空等 90 帧后静默放弃，
   *   镜头就此失去中心（用户看到的「折叠之后视角不居中了」）。
   * - 其余情况就是当前选中的主题。
   */
  const focus = useMemo(() => {
    const rootTopic = activeRoot(workbook)
    const picked = selection[0]
    // 「真正的选中项」＝ 存在、且**在布局里看得见**（被折叠收进去的不在 nodeMap 里）
    if (picked && findTopic(rootTopic, picked) && layout.nodeMap.has(picked)) {
      return { id: picked, fromSelection: true }
    }
    return { id: rootTopic.id, fromSelection: false }
  }, [selection, workbook, layout])
  const focusId = focus.id
  /** 盯的是不是"真正的选中项"（不是则为回退目标：中心主题） */
  const focusFromSelection = focus.fromSelection

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
  /** 这个 effect 最近一秒重跑了几次：用来抓「有东西在震荡 → 每帧重跑 → 死循环」 */
  const followRunsRef = useRef<number[]>([])

  /**
   * 用户刚把视角锁定**打开**的那一下：允许镜头居中一次中心主题。
   *
   * 为什么要这个例外：锁定开着但**没有选中项**时，如果什么都不做，用户看到的是
   * 「开了锁却没反应」——这是以前修过的问题。但反过来，把它做成"只要没选中就回中心主题"
   * 又走到另一个极端：点一下画布空白处、或折叠把选中的主题藏起来，镜头就被拽走
   * （用户明确不要这个）。所以只认"刚打开锁定"这一次。
   */
  const lockJustOnRef = useRef(false)
  const prevViewLockRef = useRef(viewLock)

  useEffect(() => {
    if (viewLock && !prevViewLockRef.current) lockJustOnRef.current = true
    prevViewLockRef.current = viewLock
  }, [viewLock])

  useEffect(() => {
    // 正在拖主题时不跟：镜头要是同时在移，指针下的画面会跟着滑，落点就抓不准了。
    // 松手（dragVisual 归零）后视野再咬住它。
    // `nodePointerHeldRef` 还要更早一步：按下就已经算"手上按着"，那一刻也不能动镜头。
    if (!viewLock || nodePointerHeldRef.current || dragVisual || !focusId || !focusKey) return
    /**
     * 盯的目标**不是选中项**（选择为空 / 选中项已被删掉 / 被折叠藏起来）时不动镜头。
     * 只有"刚打开锁定"那一次例外（见 `lockJustOnRef`）。
     */
    if (!focusFromSelection) {
      if (!lockJustOnRef.current) return
      lockJustOnRef.current = false
    }

    // 每秒重跑 60 次以上 = 依赖里有东西每帧都在变（几何/尺寸震荡）。
    // 这时再跟随下去就是**永久烧 CPU**：每次重跑都 setPan → 重渲染 → 重新测量 → 依赖又变。
    // 停手比卡死好：用户只是失去「镜头自动跟随」，还能正常用。
    const now = performance.now()
    const recent = followRunsRef.current.filter((at) => now - at < 1000)
    recent.push(now)
    followRunsRef.current = recent
    if (recent.length > 60) {
      warnViewLock('thrash', '依赖每秒变化 60 次以上（有东西在震荡），已暂停跟随', { focusKey })
      return
    }
    const id = focusId
    const el = containerRef.current
    if (!el) return
    if (el.clientWidth === 0 || el.clientHeight === 0) return

    /** 本轮跟随开始时的「用户接管次数」：中途一变就说明用户自己在动镜头，立刻让位 */
    const gestureAtStart = viewGestureAtRef.current
    let raf = 0
    /** 目标一时还没出现在布局里（刚删完、刚打开）就先等几帧，别急着放弃 */
    let misses = 0
    mark('镜头跟随开始', `节点 ${id}`)
    const MAX_MISSES = 90
    /**
     * 跟随循环必须**有止损**。
     *
     * panic 来源：目标是「每帧逼近」，只要有一处不收敛（几何每帧都变、尺寸在震荡、
     * 或者 pan/zoom 变成 NaN），`Math.abs(dx) < 0.5` 就永远为假——循环会一直跑下去，
     * 渲染进程主线程被烧满、窗口连关闭都点不动（真事：日志里连着 `unresponsive`）。
     */
    let frames = 0
    const MAX_FRAMES = 240

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
      if (viewGestureAtRef.current !== gestureAtStart) {
        // 用户接管了视角（滚轮/拖拽/缩放）：让位，本轮跟随到此为止。
        // 这里必须**立刻**返回而不是继续缓动——否则就是跟用户的手抢镜头（抽动的根因）。
        count('跟随让位')
        return
      }
      count('镜头跟随帧')
      setStage('镜头跟随')
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
      if (!Number.isFinite(wantX) || !Number.isFinite(wantY)) {
        // 几何或缩放变成了 NaN/Infinity：再算下去只会每帧写一堆 NaN 进 store
        warnViewLock('nan', '目标位置不是有限数，已停止跟随', { focusKey })
        return
      }
      frames += 1
      if (frames > MAX_FRAMES) {
        warnViewLock('no-converge', '跟随循环未在 240 帧内收敛，已停止（防止烧死主线程）', {
          focusKey,
          pan: panRef.current,
          want: { x: wantX, y: wantY }
        })
        return
      }
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
  }, [
    viewLock,
    dragVisual,
    focusId,
    focusFromSelection,
    focusKey,
    editingId,
    zoom,
    size.width,
    size.height,
    setPan,
    nodePointerHeldRef,
    containerRef,
    layoutRef,
    zoomRef,
    panRef,
    viewGestureAtRef
  ])
}
