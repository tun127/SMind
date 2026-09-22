import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createLayoutCache, layoutSheetCached } from '@shared/layout'
import type { LayoutResult } from '@shared/layout/types'
import { activeRoot, activeSheet, countTopics } from '@shared/model/tree'
import { plainTextOf } from '@shared/richtext'
import type { Topic, Workbook } from '@shared/model/types'
import { beginCost, count, isDiagArmed, mark, setStage } from '../../dev/stage'
import { bumpMeasureEpoch, measureTopic } from '../../render/measure'
import { clearFormulaCache } from '../../render/formula'
import { branchColorOf } from '../../render/theme'
import { themeColorsOf, useEditor } from '../../store/editor'
import type { EditorState } from '../../store/editor'

/**
 * 画布的**布局与测量**（自 `Canvas.tsx` 整块搬出，函数体逐字未改）。
 *
 * 搬的是一件事：字体就绪后重算一次、把（节流后的）工作簿算成 `layout`、布局落定后打界标、
 * 从布局派生吸附候选表 / 主题配色 / 边界分组、以及容器尺寸的 `ResizeObserver`。
 *
 * **三条 effect 的相对次序一字未动**：字体就绪重算 → 渲染提交界标（`mark`）→ 容器尺寸观察。
 * hook 调用点落在原来那块代码的位置（原 L103），所以它们相对画布其它 effect 的注册顺序也不变
 * （§四.1：只有 effect 有顺序语义，所以搬 effect 时调用点必须钉在原处）。
 *
 * `size` 的 `useState` 也从画布搬进来了（原来是画布第二个 hook）：它的槽位在同一版本内稳定，
 * 且相对 `fontEpoch` 的先后（size 在前）与搬迁前一致；画布那边按名字解构，一行调用点都不用改。
 *
 * 返回值**不写显式类型**：`dropCandidates` / `boundaryGroups` 是 memo 的匿名结构类型，手抄一份
 * 只会成为第二份真相；调用方按名字解构、类型由推导式得到（§四.3 第 6 条）。
 */

export function useCanvasLayout({
  containerRef,
  workbook,
  layoutWorkbook,
  editingId,
  editingText,
  editingRich,
  editingDraftText
}: {
  containerRef: RefObject<HTMLDivElement | null>
  /** 实时工作簿：主题配色读它（颜色要即时生效，不跟布局一起节流） */
  workbook: Workbook
  /** 节流后的工作簿：**布局**读它（AI 批量写入时把重排合并到每 ~100ms 一次） */
  layoutWorkbook: Workbook
  editingId: EditorState['editingId']
  editingText: EditorState['editingText']
  editingRich: EditorState['editingRich']
  editingDraftText: EditorState['editingDraftText']
}) {
  const [size, setSize] = useState({ width: 0, height: 0 })

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
    const diag = {
      memoRuns:
        ((window as unknown as { __layoutDiag?: { memoRuns: number } }).__layoutDiag?.memoRuns ??
          0) + 1,
      pass: '',
      editingHits: 0,
      editingMisses: 0,
      /**
       * 报告 §27/§28 要求的五个**实际取值**：只有它们能区分
       * "title 空 / 通道空 / 测量对但没写进节点" —— 光看 `pass` 与 `hits` 定不了死。
       */
      titleLen: -1,
      draftLen: editingDraftText.length,
      editLen: editingText.length,
      richLen: editingRich ? plainTextOf(editingRich).length : -1,
      editingWidth: -1
    }
    /** 编辑期实时文本：草稿优先（组词/输入中的文本只存在于 DOM 里） */
    const liveTitle = editingDraftText || editingText
    const measure = (topic: Topic, depth: number): ReturnType<typeof measureTopic> => {
      if (topic.id === editingId && editingRich) {
        diag.editingHits += 1
        diag.titleLen = liveTitle.length
        /**
         * 编辑期必须**连文本一起换掉**：`measure.ts` 的口径是
         * `topic.titleRich ?? richFromPlain(topic.title)` —— `titleRich` 非空时 `title` 会被忽略，
         * 只覆盖 title 等于没覆盖（报告 §26）。
         */
        const size = measureTopic({ ...topic, title: liveTitle, titleRich: undefined }, depth)
        diag.editingWidth = size.width
        return size
      }
      diag.editingMisses += 1
      return measureTopic(topic, depth)
    }
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
    /**
     * 诊断出口（报告 §24 要求的可观测性）：这一轮走了哪条 pass、编辑节点被量了几次、
     * useMemo 重跑了几次 —— 有它就不必再靠猜"是缓存、是测量、还是没重跑"。
     */
    diag.pass = layoutCacheRef.current.pass
    ;(window as unknown as { __layoutDiag?: unknown }).__layoutDiag = diag
    return computed
  }, [
    layoutWorkbook,
    editingId,
    editingDraftText,
    editingText,
    editingRich,
    fontEpoch,
    renderEpoch
  ])

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
    // containerRef 从参数进来（搬迁前是画布里的本地 useRef）：lint 要求列出，它身份恒定，
    // 列进来不改变本 effect 的重跑时机（仍然只在挂载时建一次观察器）
  }, [containerRef])

  return { layout, layoutRef, dropCandidates, colors, boundaryGroups, size }
}
