/**
 * 自检域：testOverlayReserve / testIncrementalLayout / testLayoutNoOverlap / testLayout / testStructures / testOverlays / testOverlayToggles（由 scripts/selfcheck.ts 按行范围搬出，行为零变化）。
 *
 * 域文件**不能从入口 import**（入口要调用域函数，会成环），
 * 所以共用助手一律从 `../helpers`、断言原语从 `../harness` 取。
 */

/**
 * 编辑器内核自检。
 *
 * 这里不测 UI，只测「不依赖浏览器」的核心逻辑：
 * 状态操作、撤销重做、节点移动与循环保护、复制粘贴、折叠、
 * .xmind 往返保真、布局引擎、以及各种边界情况。
 *
 * 运行：npm run selfcheck
 */
import { overlayToggleOf } from '../../../src/renderer/src/store/editor'

import {
  activeRoot,
  activeSheet,
  countTopics,
  detachToFloating,
  isRootDetached,
  findTopic,
  reattachFloating,
  subtreeIds
} from '../../../src/shared/model/tree'

import {
  buildRange,
  createLayoutCache,
  indexTree,
  layoutSheet,
  layoutSheetCached,
  overlayReserves,
  parseRange,
  readCurveOffset,
  resolveRange,
  sameRange
} from '../../../src/shared/layout'
import { RELATIONSHIP_CURVE_KEY, STRUCTURES } from '../../../src/shared/xmind/constants'

import { parseXmind } from '../../../src/shared/xmind/parse'
import { serializeXmind } from '../../../src/shared/xmind/serialize'

import type { MindPackage } from '../../../src/shared/model/types'
import type { MeasureFn } from '../../../src/shared/layout/types'

/* ---- D1 拆分：断言原语搬进 ./selfcheck/harness.ts，按域拆分的其它文件共用它 ---- */
import { check, eq, firstDiff, group, normalize } from '../harness'

/* ---- D1 拆分：共享测试助手搬进 ./selfcheck/helpers.ts（域文件也从那里取） ---- */
import {
  STRUCTURE_SWEEP,
  store,
  root,
  sheet,
  find,
  reset,
  addChildOf,
  multilineMeasure,
  boxesOverlap,
  firstOverlap,
  pathSegments,
  crossingProblems,
  endpointInsideProblems,
  lineCrossingProblems,
  buildSweepTopic,
  overlayIntruder,
  layoutDigest,
  fixedSizeMeasure,
  fakeMeasure,
  buildStructureSample,
  overlapReport
} from '../helpers'

/* ---- D1 拆分：域 testInit/testAddAndCommit/testCommitGuard/testCommitAndAdd/testUndoRedo/testDelete/testMove/testMoveMany 搬进 ./selfcheck/domains/edit.ts ---- */

/* ---- D1 拆分：域 testSortAndDedupe/testNodeDrag/testCollapseSelection/testUndoGranularity/testStructureIsCanvasLevel/testUndoSelectionAndRelayout 搬进 ./selfcheck/domains/canvas.ts ---- */

export function testOverlayReserve(): void {
  group('布局预留：边界/概要不再侵入相邻分支')

  // 逻辑图：给中间两支加边界，上方/下方那两支不许被标题带或边框压住
  reset()
  const rRoot = root().id
  addChildOf(rRoot, '上方分支')
  const mid1 = addChildOf(rRoot, '中间一')
  const mid2 = addChildOf(rRoot, '中间二')
  addChildOf(rRoot, '下方分支')
  store().setStructure('org.xmind.ui.logic.right')
  const boundaryId = store().addBoundaryFor([mid1, mid2], '边界标题')
  const logicLayout = layoutSheet(root(), fakeMeasure, {}, store().workbook.sheets[0])
  check(
    '边界进入了布局',
    logicLayout.boundaries.some((item) => item.id === boundaryId),
    String(logicLayout.boundaries.length)
  )
  const logicHit = overlayIntruder(logicLayout, new Set([mid1, mid2]))
  check('逻辑图：边界不侵入相邻分支', logicHit === null, logicHit ? logicHit.join(' ⨯ ') : '')

  // 组织架构图：给前两个表头加边界，父节点与这一行之间要让出标题带
  reset()
  const oRoot = root().id
  const h1 = addChildOf(oRoot, '表头一')
  const h2 = addChildOf(oRoot, '表头二')
  addChildOf(oRoot, '表头三')
  store().setStructure('org.xmind.ui.org-chart.down')
  const orgBoundary = store().addBoundaryFor([h1, h2], '边界标题')
  const orgLayout = layoutSheet(root(), fakeMeasure, {}, store().workbook.sheets[0])
  check(
    '组织架构图：边界进入了布局',
    orgLayout.boundaries.some((item) => item.id === orgBoundary)
  )
  const orgHit = overlayIntruder(orgLayout, new Set([h1, h2]))
  check('组织架构图：边界不侵入相邻分支', orgHit === null, orgHit ? orgHit.join(' ⨯ ') : '')

  // 预留真的接进了摆放：有边界时区间首支必须比没有边界时更靠下
  reset()
  const pRoot = root().id
  addChildOf(pRoot, '上方分支')
  const q1 = addChildOf(pRoot, '中间一')
  const q2 = addChildOf(pRoot, '中间二')
  store().setStructure('org.xmind.ui.logic.right')
  const plain = layoutSheet(root(), fakeMeasure, {}, store().workbook.sheets[0])
  store().addBoundaryFor([q1, q2], '边界标题')
  const reserved = layoutSheet(root(), fakeMeasure, {}, store().workbook.sheets[0])
  const plainMidY = plain.nodeMap.get(q1)?.y ?? 0
  const reservedMidY = reserved.nodeMap.get(q1)?.y ?? 0
  check(
    '有边界时区间首支被往下让开（预留真的接进了摆放）',
    reservedMidY > plainMidY,
    `${Math.round(plainMidY)} → ${Math.round(reservedMidY)}`
  )

  /**
   * 概要让在**哪一侧**由结构家族决定（多方向结构跟这一支自己的方向，单方向跟 `grows`）。
   * 这里把方向逐个钉住：错了的话「向左的图、括号画在右边」会当场复现。
   */
  const summarySideOf = (structure: string): string => {
    reset()
    addChildOf(root().id, '一')
    const second = addChildOf(root().id, '二')
    store().setStructure(structure)
    store().addSummaryFor([second], '概要')
    const reserves = overlayReserves(root(), store().workbook.sheets[0])
    if ((reserves.left.get(second) ?? 0) > 0) return 'left'
    if ((reserves.right.get(second) ?? 0) > 0) return 'right'
    if ((reserves.top.get(second) ?? 0) > 0) return 'up'
    if ((reserves.bottom.get(second) ?? 0) > 0) return 'down'
    return 'none'
  }

  eq('逻辑图（向右）：概要让在右侧', summarySideOf('org.xmind.ui.logic.right'), 'right')
  eq('逻辑图（向左）：概要让在左侧', summarySideOf('org.xmind.ui.logic.left'), 'left')
  eq('树形图（向左）：概要让在左侧', summarySideOf('org.xmind.ui.tree.left'), 'left')
  eq('组织架构图（向下）：概要让在下方', summarySideOf('org.xmind.ui.org-chart.down'), 'down')
  eq('组织架构图（向上）：概要让在上方', summarySideOf('org.xmind.ui.org-chart.up'), 'up')
  eq('矩阵图：概要让在下方', summarySideOf('org.xmind.ui.matrix'), 'down')
  eq('树状表格：概要让在右侧', summarySideOf('org.xmind.ui.spreadsheet'), 'right')
  // 平衡思维导图的第二个分支落在左侧，括号就该往左让
  eq('平衡思维导图（左支）：概要让在左侧', summarySideOf('org.xmind.ui.map.unbalanced'), 'left')
  eq('顺时针思维导图（左支）：概要让在左侧', summarySideOf('org.xmind.ui.map.clockwise'), 'left')

  /**
   * 全结构验收：给「A 支的两个子节点」加边界、给「B 支的子节点」加概要，
   * 覆盖层不许压到任何**非成员**节点上。
   *
   * 以前预留只接进了「垂直堆叠」与「组织架构」两个家族，鱼骨 / 时间轴 / 放射 /
   * 矩阵 / 树状表格这五种结构根本不为边界与概要留白——加一个边界就会压住
   * 相邻的大骨 / 刻目 / 格子（`known-issues.md` 记的那条遗留）。
   */
  for (const def of STRUCTURES) {
    if (!def.supported) continue
    reset()
    const top = root().id
    const branchA = addChildOf(top, 'A 支')
    const a1 = addChildOf(branchA, 'A 一')
    const a2 = addChildOf(branchA, 'A 二')
    addChildOf(a1, 'A 一甲')
    const branchB = addChildOf(top, 'B 支')
    const b1 = addChildOf(branchB, 'B 一')
    addChildOf(b1, 'B 一甲')
    const branchC = addChildOf(top, 'C 支')
    addChildOf(branchC, 'C 一')

    store().setStructure(def.class)
    store().addBoundaryFor([a1, a2], '边界标题')
    store().addSummaryFor([b1], '概要文字')
    const layered = layoutSheet(root(), fakeMeasure, {}, store().workbook.sheets[0])
    // 区间成员**连它们的子树**都算"里面"：边界与概要把整棵子树都框住才是对的
    const members = new Set([
      ...subtreeIds(root(), a1),
      ...subtreeIds(root(), a2),
      ...subtreeIds(root(), b1)
    ])
    const intruder = overlayIntruder(layered, members)
    check(
      `结构「${def.label}」：边界/概要不侵入相邻分支`,
      intruder === null,
      intruder ? intruder.join(' ⨯ ') : ''
    )
  }
}

export function testIncrementalLayout(): void {
  group('增量布局：结果必须逐个字段等于全量')

  reset()
  const rootId = root().id
  const branchA = addChildOf(rootId, '甲支')
  const leafA = addChildOf(branchA, '甲一')
  addChildOf(leafA, '甲一甲')
  addChildOf(branchA, '甲二')
  const branchB = addChildOf(rootId, '乙支')
  addChildOf(branchB, '乙一')
  addChildOf(branchB, '乙二')
  const branchC = addChildOf(rootId, '丙支')
  addChildOf(branchC, '丙一')

  /**
   * 逐结构跑：改一个叶子的标题（宽度随之变化，逐轮递增但都远低于折行阈值），
   * 走的必须是增量、而且结果要逐个字段等于全量。
   */
  let round = 0
  for (const def of STRUCTURES) {
    if (!def.supported) continue
    round += 1
    store().setStructure(def.class)
    const cache = createLayoutCache()
    layoutSheetCached(root(), fakeMeasure, {}, sheet(), cache)
    eq(`结构「${def.label}」：首轮走全量`, cache.pass, 'full')

    // 标题每轮都不一样：`setTitle` 在内容没变时不产生补丁，那就退化成"零变更"了
    const shorter = round % 2 === 0
    store().setTitle(leafA, shorter ? '甲一' : '甲一一一一一一一一')
    const incremental = layoutSheetCached(root(), fakeMeasure, {}, sheet(), cache)
    eq(`结构「${def.label}」：尺寸变化走增量`, cache.pass, 'incremental')
    eq(
      `结构「${def.label}」：增量结果 == 全量结果`,
      layoutDigest(incremental),
      layoutDigest(layoutSheet(root(), fakeMeasure, {}, sheet()))
    )
    check(
      `结构「${def.label}」：没有把整棵树重新测量一遍`,
      cache.stats.measureCalls <= 4,
      String(cache.stats.measureCalls)
    )
  }

  group('增量布局：只有文字变了（尺寸不变）时连摆放都不跑')

  reset()
  const textRoot = root().id
  const textBranch = addChildOf(textRoot, '甲支')
  const textLeaf = addChildOf(textBranch, 'aaaa')
  addChildOf(textBranch, '甲二')
  const textBranchB = addChildOf(textRoot, '乙支')
  addChildOf(textBranchB, '乙一')
  const textCache = createLayoutCache()
  const before = layoutSheetCached(root(), fixedSizeMeasure, {}, sheet(), textCache)
  store().setTitle(textLeaf, 'bbbb')
  const refreshed = layoutSheetCached(root(), fixedSizeMeasure, {}, sheet(), textCache)
  eq('走的是「只换文字」那条路径', textCache.pass, 'refresh')
  eq(
    '结果仍然等于全量',
    layoutDigest(refreshed),
    layoutDigest(layoutSheet(root(), fixedSizeMeasure, {}, sheet()))
  )
  // 没被碰到的那一支必须整块是同一批对象（渲染层的 memo 才能跳过重画）
  const untouched = new Set(subtreeIds(root(), textBranchB))
  let reused = 0
  for (const node of refreshed.nodes) {
    if (untouched.has(node.id) && before.nodeMap.get(node.id) === node) reused += 1
  }
  eq('未受影响的整支整块复用', reused, untouched.size)
  const textNode = refreshed.nodes.find((node) => node.id === textLeaf)
  check('被改的那个换成了新对象', textNode !== before.nodeMap.get(textLeaf))
  eq('换成新对象后文字也跟着更新', textNode?.lines[0]?.segments[0]?.text, 'bbbb')
  check(
    '没被改的节点没有被改动内容',
    refreshed.nodes.some(
      (node) => node.id === textBranchB && node === before.nodeMap.get(textBranchB)
    )
  )

  const again = layoutSheetCached(root(), fixedSizeMeasure, {}, sheet(), textCache)
  eq('同一份输入再来一次是零变更短路', textCache.pass, 'fit')
  eq('零变更时原样还回上一轮的结果对象', again, refreshed)

  group('增量布局：结构变了整棵重排，缓存照样生效')

  store().setCollapsed(textBranch, true)
  const collapsed = layoutSheetCached(root(), fixedSizeMeasure, {}, sheet(), textCache)
  eq('折叠改变了形状 → 全量', textCache.pass, 'full')
  eq(
    '折叠后的结果等于全量',
    layoutDigest(collapsed),
    layoutDigest(layoutSheet(root(), fixedSizeMeasure, {}, sheet()))
  )
  store().setCollapsed(textBranch, false)
  addChildOf(textLeaf, 'cccc')
  const grown = layoutSheetCached(root(), fixedSizeMeasure, {}, sheet(), textCache)
  eq(
    '增删节点后仍然等于全量',
    layoutDigest(grown),
    layoutDigest(layoutSheet(root(), fixedSizeMeasure, {}, sheet()))
  )

  /* ---- 报告 §28：编辑期"测量变了、主题对象没变" —— 宽度必须跟着变 ---- */
  group('增量布局：测量变了但主题对象没变时，宽度必须跟着变（编辑期）')

  reset()
  const editLeaf = addChildOf(root().id, 'aaaa')
  const editCache = createLayoutCache()
  /**
   * 模拟编辑期：**主题对象一个字节都没变**，但测量源在 topic 之外
   * （实时草稿 / `editingText`），所以同一棵树的宽度会变。
   *
   * 旧实现在"平移 + 归一化"那一步只比 `topic` 引用与坐标就整块复用上一轮的节点对象，
   * 于是新测量被静默丢掉 → 表现就是"打字时框不长、按 Enter 才正常"。
   */
  let liveWidth = 120
  const liveMeasure: MeasureFn = (topic, depth) => {
    const base = fakeMeasure(topic, depth)
    return topic.id === editLeaf ? { ...base, width: liveWidth } : base
  }

  const live1 = layoutSheetCached(root(), liveMeasure, {}, sheet(), editCache, '', [editLeaf])
  eq('编辑节点第一次用新测量', live1.nodeMap.get(editLeaf)?.width, 120)

  liveWidth = 320
  const live2 = layoutSheetCached(root(), liveMeasure, {}, sheet(), editCache, '', [editLeaf])
  eq(
    '同一 topic、新测量 → 宽度必须跟着变（不许整块复用旧对象）',
    live2.nodeMap.get(editLeaf)?.width,
    320
  )

  liveWidth = 90
  const live3 = layoutSheetCached(root(), liveMeasure, {}, sheet(), editCache, '', [editLeaf])
  eq('还能缩回去（覆盖 D-14 的方向）', live3.nodeMap.get(editLeaf)?.width, 90)

  group('增量布局：大文档下只碰脏路径')

  reset()
  const bigRoot = root().id
  const leafIds: string[] = []
  for (let i = 0; i < 12; i += 1) {
    const branch = addChildOf(bigRoot, `分支 ${i}`)
    for (let j = 0; j < 12; j += 1) {
      const node = addChildOf(branch, `子 ${i}-${j}`)
      const grand = addChildOf(node, `孙 ${i}-${j}`)
      if (i === 5 && j === 5) leafIds.push(node, grand)
    }
  }
  const total = countTopics(root())
  const bigCache = createLayoutCache()
  layoutSheetCached(root(), fakeMeasure, {}, sheet(), bigCache)
  // 把中间某个分支里的一个节点改短：宽度变了 → 走增量，但不至于改变整张画布的包围盒
  store().setTitle(leafIds[0] ?? '', '子')
  const bigIncremental = layoutSheetCached(root(), fakeMeasure, {}, sheet(), bigCache)
  eq('走增量', bigCache.pass, 'incremental')
  eq(
    '增量结果 == 全量结果',
    layoutDigest(bigIncremental),
    layoutDigest(layoutSheet(root(), fakeMeasure, {}, sheet()))
  )
  check(
    '测量只做了脏路径上那几个节点',
    bigCache.stats.measureCalls <= 8,
    `${bigCache.stats.measureCalls} / ${total} 个节点`
  )
  check(
    '子树占用没有整树重算',
    bigCache.stats.extentsComputed <= 40,
    `${bigCache.stats.extentsComputed} 次`
  )
  check(
    '未受影响的节点整块复用',
    bigCache.stats.nodesReused > total * 0.4,
    `复用 ${bigCache.stats.nodesReused} / ${total}`
  )
  check('复用计数不会超过节点总数', bigCache.stats.nodesReused <= total, String(total))
}

export function testLayoutNoOverlap(): void {
  group('布局正确性：自动布局无节点重叠（多行长文本）')
  const titles = [
    '这是一个相当长的标题用来模拟真实场景中多行换行的节点内容',
    '短标题',
    '另一个也很长的标题，负责把节点撑成三行甚至更多行来暴露布局问题',
    '中等长度的标题大概两行左右的宽度测试用'
  ]
  for (const def of STRUCTURES) {
    reset()
    const rootId = root().id
    const branches = ['A 分支', 'B 分支', 'C 分支'].map((label) => {
      const branch = addChildOf(rootId, `${label}：${titles[0]}`)
      addChildOf(branch, titles[1])
      const child = addChildOf(branch, titles[2])
      addChildOf(child, titles[3])
      return branch
    })
    void branches
    store().setStructure(def.class)
    const layout = layoutSheet(root(), multilineMeasure)
    const hit = firstOverlap(layout)
    check(`结构「${def.label}」无节点重叠`, hit === null, hit ? hit.join(' ⨯ ') : '')
  }

  /**
   * 形状 × 结构全铺一遍：**连线也不许穿过节点**。
   *
   * 用户连着报的四种"错位"（矩阵的竖线穿过第一个格子、时间轴刻目、鱼骨骨刺、
   * 组织架构行）其实是**同一个缺陷**——连线只按父子两个节点算路径，
   * 兄弟排成一列时就会从中间那个身上直插过去；拖过之后更容易撞上。
   * 这里按「形状 × 结构」铺开（8 × 14），以后再有任何结构把子节点摆成一列，穿框会当场报错。
   */
  for (const doc of STRUCTURE_SWEEP) {
    for (const def of STRUCTURES.filter((item) => item.supported)) {
      const sweepRoot = buildSweepTopic(doc.root)
      sweepRoot.structureClass = def.class
      const sweep = layoutSheet(sweepRoot, multilineMeasure)
      const overlap = firstOverlap(sweep)
      const problems = [
        ...(overlap ? [`重叠「${overlap[0]}」⨯「${overlap[1]}」`] : []),
        ...crossingProblems(sweep),
        ...lineCrossingProblems(sweep),
        ...endpointInsideProblems(sweep)
      ]
      check(
        `形状「${doc.name}」× ${def.label}：无重叠、无连线穿框、无线穿线、连线端点在边框上`,
        problems.length === 0,
        problems.slice(0, 3).join('；')
      )
    }
  }

  // 手动拖过的兄弟 + 新插入的节点：偏移不许压到别人（用户反馈「新节点和老节点重合」）
  reset()
  const dragRoot = root().id
  const dragged = addChildOf(dragRoot, '被拖过的节点')
  const inserted = addChildOf(dragRoot, '后插入的节点')
  store().offsetPositions([{ id: dragged, dx: 0, dy: 40 }])
  const offsetLayout = layoutSheet(root(), multilineMeasure)
  const draggedBox = offsetLayout.nodeMap.get(dragged)!
  const insertedBox = offsetLayout.nodeMap.get(inserted)!
  check(
    '手动拖过的节点不会被新节点压到',
    !boxesOverlap(draggedBox, insertedBox),
    `${JSON.stringify({ dx: Math.round(draggedBox.x), dy: Math.round(draggedBox.y), dh: Math.round(draggedBox.height) })} vs ${JSON.stringify({ ix: Math.round(insertedBox.x), iy: Math.round(insertedBox.y) })}`
  )
  check('拖过的节点仍带偏移（不是被强行归位）', Boolean(draggedBox.topic.position))

  // 组织架构行：横向偏移过的兄弟不许压到右边的人（竖直家族那套避让的**转置**）
  reset()
  const orgRowRoot = root().id
  const orgA = addChildOf(orgRowRoot, '被拖向右的节点')
  addChildOf(orgRowRoot, '右邻居一')
  addChildOf(orgRowRoot, '右邻居二')
  store().setStructure('org.xmind.ui.org-chart.down')
  store().offsetPositions([{ id: orgA, dx: 170, dy: 0 }])
  const orgRow = layoutSheet(root(), multilineMeasure)
  const orgRowHit = firstOverlap(orgRow)
  check(
    '组织架构行：横向偏移不会压到右邻居',
    orgRowHit === null,
    orgRowHit ? orgRowHit.join(' ⨯ ') : ''
  )
  check('组织架构行：偏移仍然保留', Boolean(orgRow.nodeMap.get(orgA)?.topic.position))

  /**
   * 行内的**纵向**偏移不生效：一行里的兄弟必须坐在同一条基线上。
   *
   * 认了它，这一格就从那一行里挪出去（用户截图里的"错位"），
   * 拖得狠一点还会直接压到父节点身上（下面这条断言就是那个场景）。
   */
  store().offsetPositions([{ id: orgA, dx: 170, dy: -40 }])
  const orgRowVertical = layoutSheet(root(), multilineMeasure)
  const orgA2 = orgRowVertical.nodeMap.get(orgA)!
  const orgSiblings = root().children.slice(1)
  check(
    '组织架构行：纵向偏移被忽略（同行同基线）',
    orgSiblings.every(
      (sibling) => Math.abs((orgRowVertical.nodeMap.get(sibling.id)?.y ?? 0) - orgA2.y) < 2
    ),
    `${Math.round(orgA2.y)} vs ${orgSiblings.map((s) => Math.round(orgRowVertical.nodeMap.get(s.id)?.y ?? 0)).join('/')}`
  )
  check('组织架构行：横向偏移照旧生效', orgA2.x > (orgRow.nodeMap.get(orgA)?.x ?? 0) + 100)
  const orgRowParent = orgRowVertical.nodeMap.get(root().id)!
  check(
    '组织架构行：不会压到父节点',
    orgA2.y >= orgRowParent.y + orgRowParent.height,
    `${Math.round(orgA2.y)} vs ${Math.round(orgRowParent.y + orgRowParent.height)}`
  )

  // 矩阵＝**二维网格**：列＝一级主题（第一维）、行＝序号（第二维），同一行共用基线
  reset()
  const matrixRoot = root().id
  const colA = addChildOf(matrixRoot, '表头甲')
  const colB = addChildOf(matrixRoot, '表头乙')
  const a1 = addChildOf(colA, '甲一')
  const a2 = addChildOf(colA, '甲二')
  const b1 = addChildOf(colB, '乙一')
  const b2 = addChildOf(colB, '乙二')
  store().setStructure('org.xmind.ui.matrix')
  const matrixPlain = layoutSheet(root(), multilineMeasure)
  store().offsetPositions([{ id: a1, dx: 0, dy: 60 }])
  const matrix = layoutSheet(root(), multilineMeasure)
  const nodeAt = (layout: typeof matrix, id: string) => {
    const node = layout.nodeMap.get(id)
    if (!node) throw new Error(`节点 ${id} 不在布局里`)
    return node
  }
  check(
    '矩阵：同一行共用基线（列=第一维、行=第二维）',
    Math.abs(nodeAt(matrix, a1).y - nodeAt(matrix, b1).y) < 2 &&
      Math.abs(nodeAt(matrix, a2).y - nodeAt(matrix, b2).y) < 2,
    `${Math.round(nodeAt(matrix, a1).y)}/${Math.round(nodeAt(matrix, b1).y)} · ` +
      `${Math.round(nodeAt(matrix, a2).y)}/${Math.round(nodeAt(matrix, b2).y)}`
  )
  check(
    '矩阵：第 2 行在第 1 行下方',
    nodeAt(matrix, a2).y > nodeAt(matrix, a1).y + nodeAt(matrix, a1).height - 1
  )
  /**
   * 纵向偏移**不生效**——与「组织架构行」同一套语义（表格里一格挪出自己的行就说不通了）。
   * 字段本身照旧保留在数据里，只是布局忽略它。横向偏移仍生效（钳在列内）。
   */
  check(
    '矩阵：纵向偏移不生效（格子不许挪出自己的行）',
    Math.abs(nodeAt(matrix, a1).y - nodeAt(matrixPlain, a1).y) < 0.01,
    `${Math.round(nodeAt(matrixPlain, a1).y)} → ${Math.round(nodeAt(matrix, a1).y)}`
  )
  check('矩阵：偏移字段本身仍在（不丢数据）', Boolean(nodeAt(matrix, a1).topic.position))
  check('矩阵：没有父子连线', matrix.edges.length === 0)
  check('矩阵：偏移不会造成重叠', firstOverlap(matrix) === null)

  const matrixSegments = matrix.decorations.flatMap((item) => pathSegments(item.d))
  const matrixColLines = matrixSegments.filter((seg) => Math.abs(seg[0] - seg[2]) < 0.01)
  const matrixRowLines = matrixSegments.filter((seg) => Math.abs(seg[1] - seg[3]) < 0.01)
  check(
    '矩阵：列线纵贯全表（上下端点一致）',
    matrixColLines.length > 0 &&
      new Set(matrixColLines.map((seg) => `${Math.round(seg[1])}/${Math.round(seg[3])}`)).size === 1
  )
  check(
    '矩阵：行线横贯全表（左右端点一致）',
    matrixRowLines.length > 0 &&
      new Set(matrixRowLines.map((seg) => `${Math.round(seg[0])}/${Math.round(seg[2])}`)).size === 1
  )
  check(
    '矩阵：行线＝表头上下边 + 每行一条',
    matrixRowLines.length === 4,
    String(matrixRowLines.length)
  )

  /**
   * 括号图：层级**完全由大括号表达**，不画父子连线。
   * 以前这里补了"括号 → 每个子节点"的直线，图就脏了（用户说的"括号图也不对"）。
   */
  reset()
  const braceRoot = root().id
  const braceBranch = addChildOf(braceRoot, '分支')
  addChildOf(braceBranch, '子一')
  addChildOf(braceBranch, '子二')
  store().setStructure('org.xmind.ui.brace.right')
  const braceCanvas = layoutSheet(root(), multilineMeasure)
  check('括号图：没有父子连线', braceCanvas.edges.length === 0, String(braceCanvas.edges.length))
  check('括号图：画出了大括号', braceCanvas.decorations.length > 0)

  /**
   * 逻辑图 vs 树形图：两个结构的区分**恰恰就在连线形状**上（曲线 vs 直角折线）。
   * 有一轮把树形图也改成了曲线，两个结构就长得一模一样了（用户当场指出）。
   * 这里把"可区分"钉死：逻辑图全是贝塞尔（C 指令），树形图一条贝塞尔都不许有。
   */
  buildStructureSample()
  store().setStructure('org.xmind.ui.logic.right')
  const logicCurves = layoutSheet(root(), fakeMeasure)
  check(
    '逻辑图：连线是曲线（贝塞尔）',
    logicCurves.edges.length > 0 && logicCurves.edges.every((edge) => edge.d.includes('C'))
  )
  buildStructureSample()
  store().setStructure('org.xmind.ui.tree.right')
  const treeElbows = layoutSheet(root(), fakeMeasure)
  check(
    '树形图：连线是直角折线（与逻辑图可区分）',
    treeElbows.edges.length > 0 && treeElbows.edges.every((edge) => !edge.d.includes('C')),
    treeElbows.edges[0]?.d
  )
}

export function testLayout(): void {
  group('布局引擎')
  reset()
  const rootId = root().id
  const b1 = addChildOf(rootId, '分支一')
  const b2 = addChildOf(rootId, '分支二')
  addChildOf(rootId, '分支三')
  addChildOf(b1, '一甲')
  addChildOf(b1, '一乙')
  addChildOf(b2, '二甲')

  // 新建导图默认是「逻辑图（向右）」这种单侧结构；本组要验证的是**平衡图**的左右分配，
  // 所以这里显式把结构切回思维导图（平衡）。
  store().setStructure('org.xmind.ui.map.unbalanced')

  const result = layoutSheet(root(), fakeMeasure)
  const total = countTopics(root())

  check('每个节点都有布局', result.nodes.length === total, `${result.nodes.length} vs ${total}`)
  check(
    '连线数 = 节点数 - 1',
    result.edges.length === total - 1,
    `${result.edges.length} vs ${total - 1}`
  )
  check('根节点 side 为 root', result.nodeMap.get(rootId)?.side === 'root')
  check('根节点 depth 为 0', result.nodeMap.get(rootId)?.depth === 0)

  const allFinite = result.nodes.every(
    (n) => Number.isFinite(n.x) && Number.isFinite(n.y) && n.width > 0 && n.height > 0
  )
  check('所有坐标与尺寸均为有效正数', allFinite)

  const inBounds = result.nodes.every(
    (n) =>
      n.x >= 0 &&
      n.y >= 0 &&
      n.x + n.width <= result.bounds.width + 1 &&
      n.y + n.height <= result.bounds.height + 1
  )
  check('所有节点都在画布范围内', inBounds)
  check('画布尺寸为正', result.bounds.width > 0 && result.bounds.height > 0)

  const sides = new Set(root().children.map((c) => result.nodeMap.get(c.id)?.side))
  check('一级分支分布在左右两侧', sides.has('left') && sides.has('right'), [...sides].join(','))

  const descendantSideOk = root().children.every((child) => {
    const childSide = result.nodeMap.get(child.id)?.side
    return child.children.every((gc) => result.nodeMap.get(gc.id)?.side === childSide)
  })
  check('后代与所属分支同侧', descendantSideOk)

  const edgesHavePath = result.edges.every((e) => e.d.startsWith('M ') && e.d.includes('C '))
  check('连线路径格式正确', edgesHavePath)

  const branchIndexOk = result.nodes.every((n) => result.branchIndex.has(n.id))
  check('每个节点都有分支配色索引', branchIndexOk)
  check('根节点配色索引为 -1', result.branchIndex.get(rootId) === -1)

  // 折叠后子节点不参与布局
  store().toggleCollapse(b1)
  const collapsed = layoutSheet(root(), fakeMeasure)
  const hidden = find(b1)!.children.map((c) => c.id)
  check(
    '折叠后子节点不再布局',
    hidden.every((id) => !collapsed.nodeMap.has(id))
  )
  check('折叠后连线数相应减少', collapsed.edges.length === collapsed.nodes.length - 1)

  // 自由定位会体现在坐标上
  reset()
  store().offsetPosition(store().addChild(activeRoot(store().workbook).id)!, 120, 0)
  const withOffset = layoutSheet(root(), fakeMeasure)
  const offsetNode = withOffset.nodes.find((n) => n.topic.position)
  check('自由定位被应用', Boolean(offsetNode), '未找到带偏移的节点')

  // 边界情况：只有一个根节点
  store().newDocument()
  store().select(root().children[0].id)
  store().deleteSelection()
  store().select(root().children[0].id)
  store().deleteSelection()
  const single = layoutSheet(root(), fakeMeasure)
  check('只有根节点时不崩', single.nodes.length === 1 && single.edges.length === 0)

  // 边界情况：超长标题与空标题
  const longId = store().addChild(root().id)!
  store().setTitle(longId, '很长的标题'.repeat(60))
  const emptyId = store().addChild(root().id)!
  store().setTitle(emptyId, '')
  const extreme = layoutSheet(root(), fakeMeasure)
  check('超长标题与空标题都能布局', extreme.nodes.length === 3)
  check(
    '超长标题不会产生 NaN',
    extreme.nodes.every((n) => Number.isFinite(n.width) && n.width > 0)
  )

  group('独立主题：模型语义与布局产出')
  reset()
  const floatRootId = root().id
  const floatBranchA = addChildOf(floatRootId, '甲支')
  const floatBranchB = addChildOf(floatRootId, '乙支')
  const floatBranchC = addChildOf(floatRootId, '丙支')
  const floatParent = addChildOf(floatBranchA, '浮动父')
  const floatChild = addChildOf(floatParent, '浮动子')
  const floatGrand = addChildOf(floatChild, '浮动孙')
  const floatDefault = addChildOf(floatBranchC, '默认浮动')
  const floatSubtree = subtreeIds(root(), floatParent).sort()

  // 纯函数先在可变副本上验证语义；store 动作在下面验证一步撤销。
  const pureRoot = structuredClone(root())
  eq('纯函数：根主题不可脱', detachToFloating(pureRoot, floatRootId, { x: 0, y: 0 }), false)
  eq(
    '纯函数：不存在的主题不可脱',
    detachToFloating(pureRoot, 'missing-topic', { x: 0, y: 0 }),
    false
  )
  eq('纯函数：第一次脱离成功', detachToFloating(pureRoot, floatParent, { x: 260, y: -40 }), true)
  check(
    '纯函数：脱离后原父级 children 不再有它',
    !findTopic(pureRoot, floatBranchA)?.children.some((child) => child.id === floatParent)
  )
  check(
    '纯函数：脱离后进入 root.detachedChildren',
    pureRoot.detachedChildren.some((child) => child.id === floatParent)
  )
  eq(
    '纯函数：子树整体跟着走',
    subtreeIds(pureRoot, floatParent).sort().join(','),
    floatSubtree.join(',')
  )
  eq('纯函数：重复脱离是 no-op', detachToFloating(pureRoot, floatParent, { x: 99, y: 99 }), false)
  eq('纯函数：放回结构成功', reattachFloating(pureRoot, floatParent, floatBranchB, 0), true)
  check('纯函数：放回后 position 被清空', findTopic(pureRoot, floatParent)?.position === undefined)
  check(
    '纯函数：放回后回到目标父级的指定下标',
    findTopic(pureRoot, floatBranchB)?.children[0]?.id === floatParent
  )

  eq('store：脱离成功', store().detachToFloating(floatParent, { x: 260, y: -40 }), true)
  check('store：root.detachedChildren 有它', isRootDetached(root(), floatParent) === true)
  eq('store：无 position 也能脱离', store().detachToFloating(floatDefault), true)

  const floatLayout = layoutSheet(root(), fakeMeasure)
  const floatRootNode = floatLayout.nodeMap.get(floatRootId)
  const floatNode = floatLayout.nodeMap.get(floatParent)
  const floatDefaultNode = floatLayout.nodeMap.get(floatDefault)
  check('独立主题进入布局 nodes', Boolean(floatNode))
  check('无 position 的独立主题也有确定性位置', Boolean(floatDefaultNode))
  check('独立主题节点的 detached 标记为真', floatNode?.detached === true)
  check(
    '子树每个节点都进入布局',
    [floatParent, floatChild, floatGrand].every((id) => floatLayout.nodeMap.has(id))
  )
  check(
    'position 决定独立主题相对根的位置',
    Boolean(
      floatRootNode &&
      floatNode &&
      Math.abs(floatNode.x - floatRootNode.x - 260) < 0.5 &&
      Math.abs(floatNode.y - floatRootNode.y + 40) < 0.5
    ),
    floatNode && floatRootNode
      ? `dx=${(floatNode.x - floatRootNode.x).toFixed(2)} dy=${(floatNode.y - floatRootNode.y).toFixed(2)}`
      : 'missing node'
  )
  check(
    '所有节点（含独立主题）都在画布范围内',
    floatLayout.nodes.every(
      (node) =>
        Number.isFinite(node.x) &&
        Number.isFinite(node.y) &&
        node.x >= 0 &&
        node.y >= 0 &&
        node.x + node.width <= floatLayout.bounds.width + 1 &&
        node.y + node.height <= floatLayout.bounds.height + 1
    )
  )
  check(
    '独立主题子树连线也产出了',
    floatLayout.edges.some((edge) => edge.fromId === floatParent) &&
      floatLayout.edges.some((edge) => edge.fromId === floatChild)
  )
  const floatCache = createLayoutCache()
  layoutSheetCached(root(), fakeMeasure, {}, sheet(), floatCache)
  store().setTitle(floatChild, '浮动子已改')
  const floatIncremental = layoutSheetCached(root(), fakeMeasure, {}, sheet(), floatCache)
  eq('独立主题：尺寸变化走增量', floatCache.pass, 'incremental')
  eq(
    '独立主题：增量结果 == 全量结果',
    layoutDigest(floatIncremental),
    layoutDigest(layoutSheet(root(), fakeMeasure, {}, sheet()))
  )

  eq('store：放回结构成功', store().attachBackFromFloating(floatParent, floatBranchB, 0), true)
  check('store：放回后 position 被清空', find(floatParent)?.position === undefined)
  check('store：放回后回到目标父级的指定下标', find(floatBranchB)?.children[0]?.id === floatParent)
  check('store：放回后 root.detachedChildren 不再含它', !isRootDetached(root(), floatParent))
}

export async function testOverlays(): Promise<void> {
  group('画布元素：区间解析')

  eq('标准区间', parseRange('(a,b)'), ['a', 'b'])
  eq('带空格的区间', parseRange('( a , b )'), ['a', 'b'])
  eq('单节点区间', parseRange('(a)'), ['a', 'a'])
  check('空括号不合法的返回 null', parseRange('()') === null)
  check('半截区间返回 null', parseRange('(a,') === null)
  check('空串返回 null', parseRange('') === null)
  check('undefined 返回 null', parseRange(undefined) === null)
  check('没有括号的串返回 null', parseRange('a,b') === null)

  group('画布元素：区间还原')

  reset()
  const rootTopic = root()
  const a = addChildOf(rootTopic.id, 'A')
  const b = addChildOf(rootTopic.id, 'B')
  const c = addChildOf(rootTopic.id, 'C')
  const deep = addChildOf(a, 'A-1')
  const index = indexTree(root())

  eq(
    '连续兄弟被完整展开',
    resolveRange(index, `(${a},${b})`).map((topic) => topic.id),
    [a, b]
  )
  eq(
    '反向区间自动纠正顺序',
    resolveRange(index, `(${c},${a})`).map((topic) => topic.id),
    [a, b, c]
  )
  eq(
    '跨父级退化成单个主题',
    resolveRange(index, `(${a},${deep})`).map((topic) => topic.id),
    [a]
  )
  eq(
    '单节点区间',
    resolveRange(index, `(${c})`).map((topic) => topic.id),
    [c]
  )
  eq('不存在的 id 返回空', resolveRange(index, '(nope,nope2)'), [])
  eq('非法区间返回空', resolveRange(index, 'garbage'), [])

  group('画布元素：由选中生成区间')

  eq('两个同级兄弟', buildRange(root(), [a, b]), `(${a},${b})`)
  eq('乱序选中会排好', buildRange(root(), [c, a]), `(${a},${c})`)
  eq('只选一个', buildRange(root(), [b]), `(${b},${b})`)
  eq('只选中心主题', buildRange(root(), [rootTopic.id]), `(${rootTopic.id},${rootTopic.id})`)
  check('空选择返回 null', buildRange(root(), []) === null)
  eq('跨父级取成员最多的那一组', buildRange(root(), [a, deep, c]), `(${a},${c})`)

  group('画布元素：几何计算')

  store().select(a)
  store().select(b, true)
  const boundaryId = store().addBoundary()
  check('边界已创建', typeof boundaryId === 'string', String(boundaryId))

  store().select(a)
  store().select(b, true)
  const summaryId = store().addSummary()
  check('概要已创建', typeof summaryId === 'string', String(summaryId))

  store().select(a)
  store().select(c, true)
  const relationshipId = store().addRelationship()
  check('关系线已创建', typeof relationshipId === 'string', String(relationshipId))

  // 只选中一个主题时不允许连线
  store().select(a)
  check('选中一个主题时不能创建关系线', store().addRelationship() === null)

  const layout = layoutSheet(root(), fakeMeasure, {}, store().workbook.sheets[0])
  eq('边界数量正确', layout.boundaries.length, 1)
  eq('概要数量正确', layout.summaries.length, 1)
  eq('关系线数量正确', layout.relationships.length, 1)

  const boundary = layout.boundaries[0]
  const nodeA = layout.nodeMap.get(a)!
  const nodeB = layout.nodeMap.get(b)!
  const nodeC = layout.nodeMap.get(c)!
  const nodeDeep = layout.nodeMap.get(deep)!

  check(
    '边界框住了 A、B 以及 A 的子树',
    boundary.x < Math.min(nodeA.x, nodeDeep.x) &&
      boundary.y < Math.min(nodeA.y, nodeDeep.y) &&
      boundary.x + boundary.width > Math.max(nodeB.x + nodeB.width, nodeDeep.x + nodeDeep.width) &&
      boundary.y + boundary.height > Math.max(nodeA.y + nodeA.height, nodeDeep.y + nodeDeep.height),
    JSON.stringify(boundary)
  )
  check('边界宽高为正', boundary.width > 0 && boundary.height > 0)

  const summary = layout.summaries[0]
  check('概要生成了括号路径', summary.d.startsWith('M ') && summary.d.includes('Q '), summary.d)
  check('概要有文字锚点', Number.isFinite(summary.label.x) && Number.isFinite(summary.label.y))
  eq('概要带默认标题', summary.title, '概要')

  const relationship = layout.relationships[0]
  check(
    '关系线是二次贝塞尔曲线',
    relationship.d.startsWith('M ') && relationship.d.includes(' Q '),
    relationship.d
  )
  check('关系线箭头角度已计算', Number.isFinite(relationship.arrow.angle))

  const onBorder = (point: { x: number; y: number }, node: typeof nodeA): boolean => {
    const eps = 0.6
    const insideX = point.x >= node.x - eps && point.x <= node.x + node.width + eps
    const insideY = point.y >= node.y - eps && point.y <= node.y + node.height + eps
    const onEdge =
      Math.abs(point.x - node.x) < eps ||
      Math.abs(point.x - (node.x + node.width)) < eps ||
      Math.abs(point.y - node.y) < eps ||
      Math.abs(point.y - (node.y + node.height)) < eps
    return insideX && insideY && onEdge
  }
  check(
    '关系线终点落在目标节点边框上',
    onBorder(relationship.arrow, nodeC),
    `${JSON.stringify(relationship.arrow)} vs ${JSON.stringify({ x: nodeC.x, y: nodeC.y, w: nodeC.width, h: nodeC.height })}`
  )

  group('画布元素：悬空引用与删除清理')

  store().mutate((draft) => {
    const target = draft.sheets.find((item) => item.id === draft.activeSheetId)!
    target.relationships.push({ id: 'ghost', end1Id: 'not-exist', end2Id: c })
  }, '造一条悬空关系线')
  const layout2 = layoutSheet(root(), fakeMeasure, {}, store().workbook.sheets[0])
  eq('指向不存在主题的关系线被跳过', layout2.relationships.length, 1)

  store().select(c)
  store().deleteSelection()
  eq('删除主题后关系线被清理', store().workbook.sheets[0].relationships.length, 0)
  eq('边界不受影响（区间两端都还在）', store().workbook.sheets[0].boundaries.length, 1)

  store().select(a)
  store().deleteSelection()
  eq('删掉区间端点后边界被清理', store().workbook.sheets[0].boundaries.length, 0)
  eq('删掉区间端点后概要被清理', store().workbook.sheets[0].summaries.length, 0)

  group('画布元素：拖动端点改接')

  reset()
  const rRoot = root()
  const n1 = addChildOf(rRoot.id, '一')
  const n2 = addChildOf(rRoot.id, '二')
  const n3 = addChildOf(rRoot.id, '三')
  store().select(n1)
  store().select(n2, true)
  const relId = store().addRelationship()
  check('关系线已创建（用于改接）', typeof relId === 'string', String(relId))

  const storedRel = (): { end1Id: string; end2Id: string } =>
    store().workbook.sheets[0].relationships[0]
  eq('初始起点', storedRel().end1Id, n1)
  eq('初始终点', storedRel().end2Id, n2)

  store().setRelationshipEnd(relId!, 'end2Id', n3)
  eq('改接终点生效', storedRel().end2Id, n3)

  store().setRelationshipEnd(relId!, 'end2Id', n1)
  eq('两端不能连到同一个主题', storedRel().end2Id, n3)

  store().setRelationshipEnd(relId!, 'end1Id', n3)
  eq('起点也不能改成与终点相同', storedRel().end1Id, n1)

  store().setRelationshipEnd(relId!, 'end1Id', n2)
  eq('改接起点生效', storedRel().end1Id, n2)
  store().undo()
  eq('改接可以撤销', storedRel().end1Id, n1)

  const layout4 = layoutSheet(root(), fakeMeasure, {}, store().workbook.sheets[0])
  const rel4 = layout4.relationships[0]
  check('改接后关系线仍然成立', Boolean(rel4))
  check(
    '起点落在起点节点边框上',
    onBorder(rel4.start, layout4.nodeMap.get(n1)!),
    JSON.stringify(rel4.start)
  )
  check(
    '终点落在终点节点边框上',
    onBorder(rel4.arrow, layout4.nodeMap.get(n3)!),
    JSON.stringify(rel4.arrow)
  )

  group('画布元素：概要括号方向')

  reset()
  const sRoot = root()
  const s1 = addChildOf(sRoot.id, '甲')
  const s2 = addChildOf(sRoot.id, '乙')
  store().select(s1)
  store().select(s2, true)
  store().addSummary()

  store().setStructure('org.xmind.ui.logic.right')
  const rightLayout = layoutSheet(root(), fakeMeasure, {}, store().workbook.sheets[0])
  const rightSummary = rightLayout.summaries[0]
  const rightNode = rightLayout.nodeMap.get(s1)!
  eq('向右结构：文字接在括号右侧', rightSummary.anchor, 'start')
  check(
    '向右结构：括号在节点右边',
    rightSummary.label.x >= rightNode.x + rightNode.width,
    `${rightSummary.label.x} vs ${rightNode.x + rightNode.width}`
  )

  store().setStructure('org.xmind.ui.logic.left')
  const leftLayout = layoutSheet(root(), fakeMeasure, {}, store().workbook.sheets[0])
  const leftSummary = leftLayout.summaries[0]
  const leftNode = leftLayout.nodeMap.get(s1)!
  eq('向左结构：文字接在括号左侧', leftSummary.anchor, 'end')
  check(
    '向左结构：括号在节点左边',
    leftSummary.label.x <= leftNode.x,
    `${leftSummary.label.x} vs ${leftNode.x}`
  )
  check('两个方向的大括号形状不同', leftSummary.d !== rightSummary.d)

  group('画布元素：落盘保真')

  reset()
  const plainRoot = root()
  const p1 = addChildOf(plainRoot.id, '第一')
  const p2 = addChildOf(plainRoot.id, '第二')
  store().select(p1)
  store().select(p2, true)
  store().addBoundary()
  store().addSummary()
  store().select(p1)
  store().select(p2, true)
  store().addRelationship()
  store().setRelationshipTitle(store().workbook.sheets[0].relationships[0].id, '有关系')

  const before = normalize(store().workbook)
  const parsed = await parseXmind(
    await serializeXmind({ workbook: store().workbook, resources: {} } as MindPackage)
  )
  check(
    '新建的画布元素往返一致',
    normalize(parsed.workbook) === before,
    firstDiff(normalize(store().workbook, 2), normalize(parsed.workbook, 2))
  )
  eq('往返保留边界区间', parsed.workbook.sheets[0].boundaries[0].range, `(${p1},${p2})`)
  eq('往返保留概要标题', parsed.workbook.sheets[0].summaries[0].title, '概要')
  eq('往返保留关系线标题', parsed.workbook.sheets[0].relationships[0].title, '有关系')
  eq('往返保留关系线两端', parsed.workbook.sheets[0].relationships[0].end1Id, p1)
}

export async function testOverlayToggles(): Promise<void> {
  group('画布元素：区间比较')

  reset()
  const tRoot = root()
  const t1 = addChildOf(tRoot.id, '甲')
  const t2 = addChildOf(tRoot.id, '乙')
  const t3 = addChildOf(tRoot.id, '丙')

  check('顺序不同视为同一区间', sameRange(`(${t1},${t2})`, `(${t2},${t1})`))
  check('空格差异不敏感', sameRange(`(${t1},${t2})`, `( ${t1} , ${t2} )`))
  check('不同区间不相等', !sameRange(`(${t1},${t2})`, `(${t2},${t3})`))
  check('非法区间不相等', !sameRange('garbage', `(${t1},${t2})`))
  check('undefined 不相等', !sameRange(undefined, `(${t1},${t2})`))

  const sheetNow = (): ReturnType<typeof activeSheet> => activeSheet(store().workbook)

  group('画布元素：开关式创建（避免重复叠加）')

  store().select(t1)
  store().select(t2, true)

  check('第一次点边界会创建', typeof store().addBoundary() === 'string')
  eq('边界数量为 1', sheetNow().boundaries.length, 1)
  check('再点一次返回 null 表示移除', store().addBoundary() === null)
  eq('再点一次边界被移除', sheetNow().boundaries.length, 0)
  check('第三次又创建回来', typeof store().addBoundary() === 'string')
  eq('边界数量回到 1', sheetNow().boundaries.length, 1)

  store().addSummary()
  eq('概要创建成功', sheetNow().summaries.length, 1)
  store().addSummary()
  eq('概要再点一次被移除', sheetNow().summaries.length, 0)

  store().select(t1)
  store().select(t2, true)
  store().addRelationship()
  eq('关系线创建成功', sheetNow().relationships.length, 1)
  store().addRelationship()
  eq('关系线再点一次被移除', sheetNow().relationships.length, 0)
  store().addRelationship()
  eq('关系线第三次创建回来', sheetNow().relationships.length, 1)

  // 反向选中同一对主题，应当仍被视为同一条线（否则会叠出第二条）
  store().select(t2)
  store().select(t1, true)
  store().addRelationship()
  eq('反向选中同一对主题也走开关逻辑', sheetNow().relationships.length, 0)

  store().select(t1)
  store().select(t2, true)
  store().addRelationship()
  eq('重新建立关系线', sheetNow().relationships.length, 1)

  group('画布元素：拖动线身（弯度偏移）')

  const relIdNow = sheetNow().relationships[0].id
  const layoutBefore = layoutSheet(root(), fakeMeasure, {}, sheetNow())
  const labelBefore = layoutBefore.relationships[0].label
  const startBefore = layoutBefore.relationships[0].start
  const arrowBefore = layoutBefore.relationships[0].arrow

  // 连续拖动 3 次，应合并成一步撤销
  store().offsetRelationshipCurve(relIdNow, 40, -20)
  store().offsetRelationshipCurve(relIdNow, 5, 5)
  store().offsetRelationshipCurve(relIdNow, 5, 5)
  eq('偏移累加并写入模型', readCurveOffset(sheetNow().relationships[0].style), { x: 50, y: -10 })

  const layoutAfter = layoutSheet(root(), fakeMeasure, {}, sheetNow())
  const labelAfter = layoutAfter.relationships[0].label
  eq('二次贝塞尔中点：x 位移是一半', Math.round(labelAfter.x - labelBefore.x), 25)
  eq('二次贝塞尔中点：y 位移是一半', Math.round(labelAfter.y - labelBefore.y), -5)
  eq('端点不受弯度偏移影响（起点）', layoutAfter.relationships[0].start, startBefore)
  eq('端点不受弯度偏移影响（终点）', layoutAfter.relationships[0].arrow.x, arrowBefore.x)

  store().undo()
  eq('连续拖动合并为一步撤销', readCurveOffset(sheetNow().relationships[0].style), { x: 0, y: 0 })

  store().offsetRelationshipCurve(relIdNow, 33, 22)
  store().resetRelationshipCurve(relIdNow)
  eq('重置后偏移归零', readCurveOffset(sheetNow().relationships[0].style), { x: 0, y: 0 })
  eq(
    '重置后不残留无用字段',
    sheetNow().relationships[0].style?.properties?.[RELATIONSHIP_CURVE_KEY],
    undefined
  )

  store().offsetRelationshipCurve(relIdNow, 33, 22)
  const workbookBefore = normalize(store().workbook)
  const parsedCurve = await parseXmind(
    await serializeXmind({ workbook: store().workbook, resources: {} } as MindPackage)
  )
  check(
    '弯度偏移往返一致',
    normalize(parsedCurve.workbook) === workbookBefore,
    firstDiff(normalize(store().workbook, 2), normalize(parsedCurve.workbook, 2))
  )
  eq('弯度偏移读回相同', readCurveOffset(parsedCurve.workbook.sheets[0].relationships[0].style), {
    x: 33,
    y: 22
  })

  group('画布元素：边界的可合并路径')

  const boundaryLayout = layoutSheet(root(), fakeMeasure, {}, sheetNow())
  const firstBoundary = boundaryLayout.boundaries[0]
  check(
    '边界给出圆角矩形路径',
    firstBoundary.d.startsWith('M ') &&
      firstBoundary.d.endsWith('Z') &&
      firstBoundary.d.includes('A '),
    firstBoundary.d
  )
  check(
    '边界路径包含四段圆角',
    firstBoundary.d.split('A ').length - 1 === 4,
    String(firstBoundary.d.split('A ').length - 1)
  )

  group('画布元素：开关状态查询（供工具栏显示「已按下」）')

  store().setSelection([t1, t2])
  store().addSummary() // 保证三者都存在
  const on = overlayToggleOf(store().workbook, store().selection)
  check('存在时能查到关系线', on.relationshipId !== null, String(on.relationshipId))
  check('存在时能查到边界', on.boundaryId !== null, String(on.boundaryId))
  check('存在时能查到概要', on.summaryId !== null, String(on.summaryId))

  const reversedSelection = overlayToggleOf(store().workbook, [t2, t1])
  eq('反向选中同一对主题查到同一条关系线', reversedSelection.relationshipId, on.relationshipId)
  eq('反向选中同一段区间也查到同一个边界', reversedSelection.boundaryId, on.boundaryId)

  const emptyToggle = overlayToggleOf(store().workbook, [])
  check(
    '未选中任何主题时三个开关都为空',
    emptyToggle.relationshipId === null &&
      emptyToggle.boundaryId === null &&
      emptyToggle.summaryId === null
  )
  const unrelatedToggle = overlayToggleOf(store().workbook, [t3])
  check(
    '选中无关主题时查不到元素',
    unrelatedToggle.relationshipId === null &&
      unrelatedToggle.boundaryId === null &&
      unrelatedToggle.summaryId === null
  )

  group('画布元素：改标题')

  const summaryId = sheetNow().summaries[0].id
  store().setSummaryTitle(summaryId, '核心任务')
  eq('概要标题可以修改', sheetNow().summaries[0].title, '核心任务')
  eq(
    '画布上的概要文字随之改变',
    layoutSheet(root(), fakeMeasure, {}, sheetNow()).summaries[0].title,
    '核心任务'
  )

  const boundaryIdNow = sheetNow().boundaries[0].id
  store().setBoundaryTitle(boundaryIdNow, '后端部分')
  eq('边界标题可以修改', sheetNow().boundaries[0].title, '后端部分')

  store().setSummaryTitle(summaryId, '   ')
  eq('清空概要标题后为空', sheetNow().summaries[0].title, '')
  eq(
    '清空后画布上也不该冒出主题的文字',
    layoutSheet(root(), fakeMeasure, {}, sheetNow()).summaries[0].title,
    ''
  )

  group('画布：框选')

  const historyBefore = store().undoStack.length
  store().setSelection([t1, t3])
  eq('框选可一次选中多个', store().selection, [t1, t3])
  store().setSelection([t1, t1, 'not-exist'])
  eq('框选会去重并过滤不存在的节点', store().selection, [t1])
  eq('框选不写入撤销历史', store().undoStack.length, historyBefore)
  store().setSelection([])
  eq('框选可以清空选择', store().selection, [])
}

export function testStructures(): void {
  group('结构：全部结构的布局不变量')

  check('结构清单覆盖 14 种', STRUCTURES.length === 14, String(STRUCTURES.length))
  check(
    '全部结构都已实现布局',
    STRUCTURES.every((item) => item.supported)
  )

  for (const structure of STRUCTURES) {
    const issues: string[] = []

    buildStructureSample()
    store().setStructure(structure.class)
    const layout = layoutSheet(root(), fakeMeasure)
    const total = countTopics(root())

    /**
     * 「靠装饰表达层级」的结构（矩阵 / 树状表格 / 括号图）**没有连线**：
     * 矩阵与树状表格靠网格线，括号图靠大括号（官方括号图页：「将主要主题放在左侧，
     * 向右扩展的支架用于显示组成部分和子部分」；通行规范也是不用连线）。
     * 其它结构仍是"每个非根节点一条入边"。
     */
    const tableLike =
      structure.family === 'matrix' ||
      structure.family === 'spreadsheet' ||
      structure.family === 'brace'
    if (layout.nodes.length !== total) issues.push(`节点数 ${layout.nodes.length}≠${total}`)
    const wantEdges = tableLike ? 0 : total - 1
    if (layout.edges.length !== wantEdges) issues.push(`连线数 ${layout.edges.length}≠${wantEdges}`)

    const invalid = layout.nodes.filter(
      (n) => !Number.isFinite(n.x) || !Number.isFinite(n.y) || !(n.width > 0) || !(n.height > 0)
    )
    if (invalid.length > 0) issues.push(`${invalid.length} 个节点坐标或尺寸无效`)

    const negative = layout.nodes.filter((n) => n.x < 0 || n.y < 0)
    if (negative.length > 0) issues.push(`${negative.length} 个节点坐标为负`)

    if (!(layout.bounds.width > 0) || !(layout.bounds.height > 0)) issues.push('画布尺寸非正')

    const outOfBounds = layout.nodes.filter(
      (n) => n.x + n.width > layout.bounds.width + 1 || n.y + n.height > layout.bounds.height + 1
    )
    if (outOfBounds.length > 0) issues.push(`${outOfBounds.length} 个节点超出画布`)

    const overlaps = overlapReport(layout.nodes)
    if (overlaps.length > 0)
      issues.push(`${overlaps.length} 处重叠（${overlaps.slice(0, 3).join('、')}）`)

    /**
     * 每个非根节点都要"有归属感"：要么自己有一条入边，要么落在结构画出的框里。
     *
     * 表格类结构（矩阵 / 树状表格）按参考**没有连线**，父子关系由**网格/框**表达，
     * 所以这里改判"必须画出框"——仍盯着原本的目的（不许出现孤立得像掉出来的节点），
     * 但不再要求表格也画线。
     */
    if (tableLike) {
      if (layout.decorations.length === 0) issues.push('表格类结构没有画出框')
    } else {
      const missingEdge = layout.nodes.filter(
        (n) => n.id !== root().id && !layout.edges.some((e) => e.toId === n.id)
      )
      if (missingEdge.length > 0) issues.push(`${missingEdge.length} 个节点没有入边`)
    }

    check(`${structure.label}`, issues.length === 0, issues.join('；'))
  }

  group('结构：各结构的特征不变量')

  // 组织架构图：同一层的子节点应共用同一个上边
  buildStructureSample()
  store().setStructure('org.xmind.ui.org-chart.down')
  const org = layoutSheet(root(), fakeMeasure)
  const rootNode = org.nodeMap.get(root().id)!
  const firstRow = root().children.map((child) => org.nodeMap.get(child.id)!)
  const sameRow = firstRow.every((node) => Math.abs(node.y - firstRow[0].y) < 0.01)
  check('组织架构图：同一层上沿齐平', sameRow, firstRow.map((n) => n.y).join(','))
  const belowRoot = firstRow.every((node) => node.y >= rootNode.y + rootNode.height)
  check('组织架构图：子节点在父节点下方', belowRoot)

  // 组织架构图（向上）：子节点应在父节点上方
  buildStructureSample()
  store().setStructure('org.xmind.ui.org-chart.up')
  const orgUp = layoutSheet(root(), fakeMeasure)
  const rootUp = orgUp.nodeMap.get(root().id)!
  const upChildren = root().children.map((child) => orgUp.nodeMap.get(child.id)!)
  check(
    '组织架构图（向上）：子节点在父节点上方',
    upChildren.every((node) => node.y + node.height <= rootUp.y)
  )

  // 树状表格：同一层的节点左边缘对齐
  buildStructureSample()
  store().setStructure('org.xmind.ui.spreadsheet')
  const table = layoutSheet(root(), fakeMeasure)
  const byDepth = new Map<number, number[]>()
  for (const node of table.nodes) {
    byDepth.set(node.depth, [...(byDepth.get(node.depth) ?? []), node.x])
  }
  const alignedColumns = [...byDepth.values()].every(
    (xs) => new Set(xs.map((x) => Math.round(x))).size === 1
  )
  check('树状表格：同一层左边缘对齐', alignedColumns)

  /**
   * 树状表格＝**带层级的多列表格**（官方：「主题以**嵌套块**的形式显示」「靠表格的行列结构与
   * 缩进/对齐表达层级」「没有枝干连线」）。
   *
   * 这组断言盯的是**网格必须贯穿**：每条行线横跨整表、每条列线纵贯整表。
   * 上一版的病根就在这儿——线只包住"一棵子树"，于是看起来是"缩进的文字下随机划了几条线"，
   * 完全不像表格（用户：「根本无法使用」）。
   */
  const tableSegments = table.decorations.flatMap((item) => pathSegments(item.d))
  const tableRows = tableSegments.filter((seg) => Math.abs(seg[1] - seg[3]) < 0.01)
  const tableCols = tableSegments.filter((seg) => Math.abs(seg[0] - seg[2]) < 0.01)
  const tableDepth = table.nodes.reduce((deepest, node) => Math.max(deepest, node.depth), 0)
  check(
    '树状表格：行线＝每主题一行 + 顶边',
    tableRows.length === table.nodes.length + 1,
    `${tableRows.length} vs ${table.nodes.length + 1}`
  )
  check(
    '树状表格：列线＝每个层级一条',
    tableCols.length === tableDepth + 1,
    `${tableCols.length} vs ${tableDepth + 1}`
  )
  check(
    '树状表格：行线贯穿整表（左右端点一致）',
    new Set(tableRows.map((seg) => `${Math.round(seg[0])}/${Math.round(seg[2])}`)).size === 1,
    [...new Set(tableRows.map((seg) => `${Math.round(seg[0])}/${Math.round(seg[2])}`))].join(' ')
  )
  check(
    '树状表格：列线贯穿整表（上下端点一致）',
    new Set(tableCols.map((seg) => `${Math.round(seg[1])}/${Math.round(seg[3])}`)).size === 1
  )
  const tableRootNode = table.nodeMap.get(root().id)!
  check(
    '树状表格：根在左上（最左列 + 最上行）',
    Math.abs(tableRootNode.x - Math.min(...table.nodes.map((node) => node.x))) < 0.01 &&
      Math.abs(tableRootNode.y - Math.min(...table.nodes.map((node) => node.y))) < 0.01
  )
  check('树状表格：没有父子连线', table.edges.length === 0)

  // 水平时间轴：一级分支应在主轴上下交替
  buildStructureSample()
  store().setStructure('org.xmind.ui.timeline.horizontal')
  const timeline = layoutSheet(root(), fakeMeasure)
  const tlRoot = timeline.nodeMap.get(root().id)!
  const spineY = tlRoot.y + tlRoot.height / 2
  const sides = root().children.map((child) => {
    const node = timeline.nodeMap.get(child.id)!
    return node.y + node.height / 2 < spineY ? -1 : 1
  })
  check(
    '水平时间轴：一级分支上下交替',
    sides.every((side, index) => side === (index % 2 === 0 ? -1 : 1)),
    sides.join(',')
  )
  check('水平时间轴：绘制了主轴', timeline.decorations.length > 0)

  // 鱼骨图：一级分支左右交替，且有主脊
  buildStructureSample()
  store().setStructure('org.xmind.ui.fishbone.leftHeaded')
  const bone = layoutSheet(root(), fakeMeasure)
  const boneRoot = bone.nodeMap.get(root().id)!
  const boneSpineY = boneRoot.y + boneRoot.height / 2
  const boneSides = root().children.map((child) => {
    const node = bone.nodeMap.get(child.id)!
    return node.y + node.height / 2 < boneSpineY ? -1 : 1
  })
  check(
    '鱼骨图：骨刺上下交替',
    boneSides.every((side, index) => side === (index % 2 === 0 ? -1 : 1)),
    boneSides.join(',')
  )
  check('鱼骨图：绘制了主脊', bone.decorations.length > 0)

  /**
   * 折叠之后**不许留下孤线**（用户截图：中心主题右边挂着一截没有任何东西的线）。
   * 主脊的兜底终点以前是"中心主题右缘 + 120"，没有可见分支时照样画出来。
   */
  const bareRootId = root().id
  store().setCollapsed(bareRootId, true)
  const bareBone = layoutSheet(root(), fakeMeasure)
  eq('鱼骨图：整体折叠后不画主脊（没有可见分支就不留孤线）', bareBone.decorations.length, 0)
  store().setCollapsed(bareRootId, false)
  const restoredBone = layoutSheet(root(), fakeMeasure)
  check('展开后主脊回来', restoredBone.decorations.length > 0)

  // 括号图：每组子节点都配了括号装饰
  buildStructureSample()
  store().setStructure('org.xmind.ui.brace.right')
  const brace = layoutSheet(root(), fakeMeasure)
  check('括号图：绘制了括号', brace.decorations.length >= root().children.length)
  const braceNodes = brace.nodes.slice().sort((a, b) => a.x - b.x)
  check(
    '括号图：子节点整体在父节点右侧',
    braceNodes[0].depth < braceNodes[braceNodes.length - 1].depth
  )

  // 矩阵图：一级主题排成一行表头
  buildStructureSample()
  store().setStructure('org.xmind.ui.matrix')
  const matrix = layoutSheet(root(), fakeMeasure)
  const headers = root().children.map((child) => matrix.nodeMap.get(child.id)!)
  check(
    '矩阵图：表头在同一行',
    headers.every((node) => Math.abs(node.y - headers[0].y) < 0.01),
    headers.map((n) => n.y).join(',')
  )
  check(
    '矩阵图：表头从左到右排列',
    headers.every((node, index) => index === 0 || node.x > headers[index - 1].x)
  )

  // 放射状：一级分支分布在多个方向上
  buildStructureSample()
  store().setStructure('org.xmind.ui.map.clockwise')
  const radial = layoutSheet(root(), fakeMeasure)
  const rRoot = radial.nodeMap.get(root().id)!
  const centerX = rRoot.x + rRoot.width / 2
  const centerY = rRoot.y + rRoot.height / 2
  const angles = root().children.map((child) => {
    const node = radial.nodeMap.get(child.id)!
    return Math.atan2(node.y + node.height / 2 - centerY, node.x + node.width / 2 - centerX)
  })
  const spread = Math.max(...angles) - Math.min(...angles)
  check('放射状：一级分支分布在不同方向', spread > Math.PI / 2, spread.toFixed(2))
  /**
   * 顺时针的**方向感**：起点在右上（约 1 点钟，−60°），随后按顺时针（角度递增）依次铺开。
   *
   * 以前从正上方（−90°）起铺：两个一级分支会落在正上／正下，"一上一下"读不出顺时针
   * （用户就是看着截图问"顺时针是这样的？"）。官方只规定了"顺时针"这个方向，
   * 起点角度属于**我方取值**（见 docs/structure-spec.md）。
   */
  const startAngle = -Math.PI / 3
  check(
    '顺时针：第一个分支在右上（约 1 点钟）',
    (angles[0] ?? 0) < 0 && (angles[0] ?? 0) > -Math.PI / 2,
    `${(((angles[0] ?? 0) * 180) / Math.PI).toFixed(0)}°`
  )
  const clockwiseOrder = angles.map((angle) => {
    let value = angle - startAngle
    while (value < 0) value += Math.PI * 2
    return value
  })
  check(
    '顺时针：分支按顺时针依次铺开',
    clockwiseOrder.every((value, index) => index === 0 || value > (clockwiseOrder[index - 1] ?? 0)),
    clockwiseOrder.map((value) => ((value * 180) / Math.PI).toFixed(0)).join('° ')
  )
}
