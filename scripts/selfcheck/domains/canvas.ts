/**
 * 自检域：testSortAndDedupe / testNodeDrag / testCollapseSelection / testUndoGranularity / testStructureIsCanvasLevel / testUndoSelectionAndRelayout（由 scripts/selfcheck.ts 按行范围搬出，行为零变化）。
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

import {
  activeRoot,
  ancestorsOf,
  countDescendants,
  countTopics,
  childFoldSides,
  countHiddenNodes,
  detachTopic,
  findParent,
  findTopic,
  foldedSidesOf,
  hiddenCountOfSide,
  splitFoldSidesOf,
  subtreeIds,
  visibleChildren
} from '../../../src/shared/model/tree'
import { createTopic } from '../../../src/shared/model/factory'
import { buildSkeletonDigest } from '../../../src/shared/ai'
import { runReadTool, type ToolContext } from '../../../src/shared/agent'

import { alsoDraggedOf, moveRootsOf, resolveDragMove } from '../../../src/shared/model/dragmove'
import {
  blockReasonOf,
  closestNodeWithin,
  distanceToRect,
  nearestInRegion,
  nearestSiblingGap,
  perpendicularOf,
  rectsIntersect,
  resolveDrop,
  stackDirection,
  topicsInBox,
  zoneOf,
  type DropAxis,
  type DropNode,
  type DropRect,
  type SiblingStack,
  type SnapNode
} from '../../../src/shared/model/drop'

import { collapseBadgeSide, layoutSheet } from '../../../src/shared/layout'
import { DEFAULT_STRUCTURE, STRUCTURES } from '../../../src/shared/xmind/constants'

import { attrTranslate, cssTranslate } from '../../../src/renderer/src/render/transform'

/* ---- D1 拆分：断言原语搬进 ./selfcheck/harness.ts，按域拆分的其它文件共用它 ---- */
import { check, eq, group } from '../harness'

/* ---- D1 拆分：共享测试助手搬进 ./selfcheck/helpers.ts（域文件也从那里取） ---- */
import { store, root, find, reset, addChildOf, fakeMeasure } from '../helpers'

/* ---- D1 拆分：域 testInit/testAddAndCommit/testCommitGuard/testCommitAndAdd/testUndoRedo/testDelete/testMove/testMoveMany 搬进 ./selfcheck/domains/edit.ts ---- */

export function testSortAndDedupe(): void {
  group('同级排序（sortChildren）：顺序、编号与撤销')

  {
    reset()
    const rootId = root().id
    const a = addChildOf(rootId, '甲')
    const b = addChildOf(rootId, '乙')
    const c = addChildOf(rootId, '丙')
    /** 只看这几个节点的相对顺序：reset() 的默认文档自己还带着别的子主题 */
    const titlesOf = (ids: string[]): string[] =>
      root()
        .children.filter((topic) => ids.includes(topic.id))
        .map((topic) => topic.title)

    store().sortChildren(rootId, [c, b, a], false)
    eq('按给定顺序重排', titlesOf([a, b, c]), ['丙', '乙', '甲'])

    store().sortChildren(rootId, [c, b, a], true)
    eq('编号跟着顺序走', titlesOf([a, b, c]), ['1. 丙', '2. 乙', '3. 甲'])

    // 再排一次不能叠成「1. 1. 丙」
    store().sortChildren(rootId, [a, b, c], true)
    eq('重复编号会先去掉旧编号', titlesOf([a, b, c]), ['1. 甲', '2. 乙', '3. 丙'])

    const before = store().undoStack.length
    store().undo()
    eq('一次排序算一步撤销', store().undoStack.length, before - 1)
    eq('撤销回到上一次编号', titlesOf([a, b, c]), ['1. 丙', '2. 乙', '3. 甲'])
  }

  {
    // 没被点名的子主题不能丢（模型可能只看得到其中一部分）
    reset()
    const rootId = root().id
    const x = addChildOf(rootId, 'X')
    const y = addChildOf(rootId, 'Y')
    const z = addChildOf(rootId, 'Z')
    store().sortChildren(rootId, [z], false)
    const titles = root().children.map((topic) => topic.title)
    check('点名的排到最前', titles[0] === 'Z', titles.join(','))
    check(
      '没给到的都还在（一个没丢）',
      titles.includes('X') && titles.includes('Y'),
      titles.join(',')
    )
    eq(
      '没给到的保持原有相对顺序',
      titles.filter((title) => title === 'X' || title === 'Y'),
      ['X', 'Y']
    )
    void x
    void y
  }

  group('合并同名（mergeTopics）：内容并入、删除多余、祖先保护')

  {
    reset()
    const rootId = root().id
    const keep = addChildOf(rootId, '性能优化')
    const dup = addChildOf(rootId, '性能优化（补充）')
    const movedChild = addChildOf(dup, '减少重排')
    store().setNotes(dup, '这段解释要留住')
    store().addLabel(dup, '重点')

    const merged = store().mergeTopics([{ keepId: keep, mergeIds: [dup] }])
    eq('合并了一个', merged, 1)
    check('多余的重复节点已删除', find(dup) === null)
    eq(
      '子主题搬到了保留方',
      find(keep)?.children.map((topic) => topic.id),
      [movedChild]
    )
    eq('备注补了过来', find(keep)?.notes, '这段解释要留住')
    eq('标签也并了过来', find(keep)?.labels, ['重点'])
    check(
      '整批算一步撤销',
      (() => {
        store().undo()
        return find(dup) !== null && find(keep)?.notes === undefined
      })()
    )
  }

  {
    // 互为祖先时不能动手：把子节点搬进自己的祖先会成环
    reset()
    const rootId = root().id
    const parent = addChildOf(rootId, 'A')
    const nested = addChildOf(parent, 'A')
    eq('组内存在父子关系时跳过', store().mergeTopics([{ keepId: parent, mergeIds: [nested] }]), 0)
    check('原样保留（什么都没改）', find(nested) !== null)
  }
}

export function testNodeDrag(): void {
  group('拖拽落点：同级排序')

  reset()
  const dragRoot = root()
  const n1 = addChildOf(dragRoot.id, '一')
  const n2 = addChildOf(dragRoot.id, '二')
  const n3 = addChildOf(dragRoot.id, '三')
  const n1a = addChildOf(n1, '一-1')

  // 根节点自带「分支主题 1/2」两个默认子节点，所以只看本用例自己造的几个，
  // 否则断言会被默认内容干扰
  const mine = new Set([n1, n2, n3, n1a])
  const order = (parentId: string): string[] =>
    (find(parentId)?.children ?? [])
      .filter((topic) => mine.has(topic.id))
      .map((topic) => topic.title)
  eq('初始顺序', order(dragRoot.id), ['一', '二', '三'])

  store().dropNode(n1, n3, 'after')
  eq('拖到兄弟上会排到它后面', order(dragRoot.id), ['二', '三', '一'])
  eq('子树跟着一起走', find(n1)?.children.length, 1)

  // 关键回归：自己原本排在目标**前面**时，下标会因先摘除而前移一位，
  // 如果用摘除前的下标就会落错位置。
  store().dropNode(n1, n2, 'after')
  eq('自己排在目标前面时也能落到正确位置', order(dragRoot.id), ['二', '一', '三'])

  store().undo()
  eq('排序可以撤销', order(dragRoot.id), ['二', '三', '一'])

  group('拖拽落点：成为子主题')

  // n2 与 n1a 既不同父级也不是兄弟，属于「任意两个节点之间」
  store().dropNode(n2, n1a, 'child')
  eq('拖到非兄弟节点上会成为它的子主题', findParent(root(), n2)?.id, n1a)
  eq('成为最后一个子主题', find(n1a)?.children.filter((topic) => mine.has(topic.id)).length, 1)
  eq('原本的父级少了一个', order(dragRoot.id), ['三', '一'])

  group('拖拽落点：拒绝的情形')

  eq('不能拖到自己的后代里', store().dropNode(n1, n1a, 'child'), false)
  eq('不能拖到自己身上', store().dropNode(n1, n1, 'child'), false)
  eq('拖到自己的父级上不做任何事', store().dropNode(n3, root().id, 'child'), false)
  eq('根主题不能被拖动', store().dropNode(root().id, n3, 'child'), false)
  eq('拒绝后顺序不变', order(dragRoot.id), ['三', '一'])

  group('拖拽落点：同父级显式下标')

  reset()
  const r2 = root()
  const x1 = addChildOf(r2.id, '甲')
  addChildOf(r2.id, '乙')
  addChildOf(r2.id, '丙')
  const own = new Set([x1])
  const titles = (): string[] =>
    (find(r2.id)?.children ?? []).filter((topic) => own.has(topic.id)).map((topic) => topic.title)
  const allTitles = (): string[] => (find(r2.id)?.children ?? []).map((topic) => topic.title)

  const startIndex = allTitles().indexOf('甲')
  check('同父级 + 无下标仍然被忽略', store().moveNode(x1, r2.id) === false)
  check('同父级 + 显式下标允许移动', store().moveNode(x1, r2.id, 99) === true)
  eq('越界下标会落到末尾', titles(), ['甲'])
  eq('确实排在了最后', allTitles()[allTitles().length - 1], '甲')
  store().undo()
  eq('同父级排序也能撤销', allTitles().indexOf('甲'), startIndex)

  group('拖拽子树集合')

  reset()
  const sRoot = root()
  const s1 = addChildOf(sRoot.id, '一级')
  const s11 = addChildOf(s1, '二级')
  const s111 = addChildOf(s11, '三级')
  const s2 = addChildOf(sRoot.id, '旁边的')

  eq('子树包含自己和所有后代', subtreeIds(root(), s1).sort(), [s1, s11, s111].sort())
  eq('叶子节点只有自己', subtreeIds(root(), s111), [s111])
  eq('根节点的子树是整棵树', subtreeIds(root(), sRoot.id).length, countTopics(root()))
  eq('不存在的 id 返回空', subtreeIds(root(), 'nope'), [])
  check('不包含无关的兄弟节点', !subtreeIds(root(), s1).includes(s2))

  /*
   * 自由摆放（floating / detached）的主题：Xmind 里合法的一类节点。
   *
   * 以前树操作里有一半只写 `topic.children`（`detachTopic`、`ancestorsOf`、
   * `subtreeIds`），于是这类主题**删也删不掉、移也移不动**，删除时界面还照报成功；
   * 而 `walk` / 统计 / 搜索 / 大纲早就把它们算作树的一部分。
   * 这一组把「浮动主题 = 树的一部分」这个口径钉死。
   */
  group('自由摆放的主题：与挂着的主题同等对待')

  reset()
  const fRootId = root().id
  let floating = ''
  store().mutate((draft) => {
    const draftRoot = activeRoot(draft)
    const node = createTopic('浮动想法')
    floating = node.id
    draftRoot.detachedChildren.push(node)
  }, '造一个自由摆放的主题')

  check('浮动主题能被 findTopic 找到', find(floating) !== null)
  check('浮动主题能算出父级', findParent(root(), floating)?.id === fRootId)
  eq('浮动主题的祖先链不为空（地址/路径可用）', ancestorsOf(root(), floating), [fRootId])
  eq('浮动主题的子树含自己', subtreeIds(root(), floating), [floating])
  check('统计口径把浮动主题算进去', countTopics(root(), false) === 3, String(countTopics(root())))

  check('deleteTopic 对浮动主题返回 true', store().deleteTopic(floating) === true)
  check('浮动主题确实被删除', find(floating) === null)
  check('对不存在的主题返回 false', store().deleteTopic('nope') === false)

  // 移得动：把挂着的一个子主题移成浮动主题之后，还能再删掉它
  reset()
  const moveTarget = addChildOf(root().id, '待移动')
  store().mutate((draft) => {
    const draftRoot = activeRoot(draft)
    const node = detachTopic(draftRoot, moveTarget)
    if (node) draftRoot.detachedChildren.push(node)
  }, '把子主题改成自由摆放')
  check('改成自由摆放后仍然在树上', find(moveTarget) !== null)
  check('改成自由摆放后仍然删得掉', store().deleteTopic(moveTarget) === true)
  check('删掉后确实不在了', find(moveTarget) === null)

  group('拖拽落点裁决：任意两个节点之间')

  reset()
  const gRoot = root()
  const ga = addChildOf(gRoot.id, 'A')
  const gb = addChildOf(gRoot.id, 'B')
  const ga1 = addChildOf(ga, 'A-1')
  const gb1 = addChildOf(gb, 'B-1')

  /** 落点裁决的比较统一用 JSON 串，避免依赖对象引用 */
  const planOf = (dragged: string, target: string, preferAfter: boolean): string =>
    JSON.stringify(resolveDrop(root(), dragged, target, preferAfter ? 'after' : 'child'))

  // 本轮反馈第 1 条：连接根节点的那几个兄弟之间要能拖
  eq(
    '根级兄弟之间：贴外侧 → 插在其后',
    planOf(ga, gb, true),
    JSON.stringify({ targetId: gb, mode: 'after', parentId: gRoot.id })
  )
  eq(
    '根级兄弟之间：停在身上 → 成为其子主题',
    planOf(ga, gb, false),
    JSON.stringify({ targetId: gb, mode: 'child', parentId: gb })
  )

  // 本轮反馈第 2 条：任意两个节点之间都能拖
  eq(
    '跨分支：贴外侧 → 插在其后（即成为该分支的兄弟）',
    planOf(ga, gb1, true),
    JSON.stringify({ targetId: gb1, mode: 'after', parentId: gb })
  )
  eq(
    '跨分支：停在身上 → 成为其子主题',
    planOf(ga, gb1, false),
    JSON.stringify({ targetId: gb1, mode: 'child', parentId: gb1 })
  )
  eq(
    '深层节点拖到另一分支的深层节点',
    planOf(ga1, gb1, false),
    JSON.stringify({ targetId: gb1, mode: 'child', parentId: gb1 })
  )
  eq(
    '深层节点贴到另一分支深层节点外侧',
    planOf(ga1, gb1, true),
    JSON.stringify({ targetId: gb1, mode: 'after', parentId: gb })
  )

  group('拖拽落点裁决：拒绝与特例')

  check('目标是自己是非法落点', resolveDrop(root(), ga, ga, 'child') === null)
  check('目标是自己的后代是非法落点', resolveDrop(root(), ga, ga1, 'child') === null)
  check('目标是自己的后代时贴外侧也非法', resolveDrop(root(), ga, ga1, 'after') === null)
  check('停在父级身上＝原地不动', resolveDrop(root(), ga1, ga, 'child') === null)
  eq(
    '贴父级外侧 → 升一级，成为父级的兄弟',
    planOf(ga1, ga, true),
    JSON.stringify({ targetId: ga, mode: 'after', parentId: gRoot.id })
  )
  check('根主题不能被拖动', resolveDrop(root(), gRoot.id, gb, 'child') === null)
  eq(
    '目标是根主题 → 只能成为它的子主题',
    planOf(gb1, gRoot.id, true),
    JSON.stringify({ targetId: gRoot.id, mode: 'child', parentId: gRoot.id })
  )

  group('多选拖拽：落点裁决与移动集合')

  // 多选时「成为某人的子主题」只解释得通一个主题，所以直接判为非法，
  // 免得预览画一个位置、松手却只动其中一个。
  check('多选拖拽时不能成为目标子主题', resolveDrop(root(), ga, gb, 'child', [ga, gb1]) === null)
  eq(
    '多选拖拽时同级插入仍然成立',
    JSON.stringify(resolveDrop(root(), ga, gb, 'after', [ga, gb1])),
    JSON.stringify({ targetId: gb, mode: 'after', parentId: gRoot.id })
  )
  check(
    '多选拖拽时不能落进任一被拖主题的子树',
    resolveDrop(root(), gb, ga1, 'after', [gb, ga]) === null
  )
  check(
    '多选拖拽时不能落在任一被拖主题自己身上',
    resolveDrop(root(), ga, gb1, 'after', [ga, gb1]) === null
  )

  // 移动集合：选中一群时整群一起走，父子同时入选只留父级
  const groupMove = resolveDragMove(root(), gb, [gb, gb1])
  eq('整群被拖：抓的那个在里面', groupMove.ids.includes(gb), true)
  eq('整群被拖：它的后代跟着走（不重复记录）', groupMove.ids.sort(), subtreeIds(root(), gb).sort())
  eq('只写最上面那个父级的位置', moveRootsOf(groupMove), [gb])

  const twoBranches = resolveDragMove(root(), ga, [ga, gb, ga1])
  eq(
    '父子同时入选时去冗余',
    twoBranches.ids.sort(),
    [...subtreeIds(root(), ga), ...subtreeIds(root(), gb)].sort()
  )
  eq('两处自由位置都要写', moveRootsOf(twoBranches).sort(), [ga, gb].sort())

  // 抓在没被选中的主题上 → 只走它自己（不会"顺手"把别人也带走）
  const soloMove = resolveDragMove(root(), gb1, [ga, gb])
  eq('抓未被选中的主题只走它自己', soloMove.ids, [gb1])
  eq(
    '单选时也不会去动别人',
    resolveDragMove(root(), ga, [ga]).ids.sort(),
    subtreeIds(root(), ga).sort()
  )

  group('拖拽落点：单选拖动时「成为子主题」不能被多选规则误禁（真缺陷回归）')

  // 画布传给 resolveDrop 的「其它被拖主题」必须是**顶层**被拖主题里除锚点之外的那些，
  // 而不是「锚点 + 它整棵子树」。传错的话这个列表永远非空，
  // 于是「多选才该禁用」的 child 会连单选一起禁掉——拖到主题上什么都不发生。
  const soloAlso = alsoDraggedOf(resolveDragMove(root(), ga, [ga]), ga)
  eq('单选拖动时「其它被拖主题」为空（哪怕它自己有子节点）', soloAlso, [])
  check(
    '单选拖到别的主题上 → 可以成为它的子主题',
    resolveDrop(root(), ga, gb, 'child', soloAlso) !== null
  )

  const groupAlso = alsoDraggedOf(resolveDragMove(root(), ga, [ga, gb]), ga)
  eq('多选拖动时「其它被拖主题」是其余顶层主题', groupAlso, [gb])
  check(
    '多选拖到别的主题上 → 仍然禁止成为子主题（预览才不会骗人）',
    resolveDrop(root(), ga, gb1, 'child', groupAlso) === null
  )

  group('拖拽落点：非法落点要给得出「为什么」')

  eq(
    '落在自己的父级身上 → 已是它的子主题',
    blockReasonOf(root(), ga1, ga, 'child'),
    '它已经是这个主题的子主题了'
  )
  eq(
    '多选落成子主题 → 只能插到同级之间',
    blockReasonOf(root(), ga, gb, 'child', [gb]),
    '多选拖拽只能插到同级之间'
  )
  eq('落回自己身上', blockReasonOf(root(), ga, ga, 'child'), '不能落回自己身上')
  eq(
    '同级插入类的非法落点 → 说清规则（不是笼统的「这里不能落」）',
    blockReasonOf(root(), ga, gb, 'before'),
    '只能插到相邻的同级主题之间'
  )
  /**
   * 多选 + 非 child 落点：约束最具体的那条要**优先**说出来。
   * 以前 `zone !== 'child'` 判在前面，这里拿到的是笼统的"这里不能落"。
   */
  eq(
    '多选 + 同级插入类落点 → 仍然说「只能插到同级之间」',
    blockReasonOf(root(), ga, gb, 'after', [gb]),
    '多选拖拽只能插到同级之间'
  )

  group('折叠状态：拖拽时要能把落点展开')

  reset()
  const colRoot = root()
  const colParent = addChildOf(colRoot.id, '折叠的')
  addChildOf(colParent, '藏起来的')
  store().setCollapsed(colParent, true)
  check('能直接折叠', find(colParent)?.collapsed === true)
  store().setCollapsed(colParent, false)
  check('能直接展开（拖拽落点上要用它，否则看不见新子主题落在哪）', !find(colParent)?.collapsed)
  const collapseHistory = store().undoStack.length
  store().setCollapsed(colParent, false)
  eq('已经是展开态时不再产生撤销记录', store().undoStack.length, collapseHistory)
  store().setCollapsed(colParent, true)
  eq('再折叠回去也是一步', store().undoStack.length, collapseHistory + 1)

  group('拖拽落点裁决：节点分区（Xmind / 亿图脑图同款）')

  const wide = { x: 0, y: 0, width: 100, height: 40 }
  const tall = { x: 0, y: 0, width: 40, height: 100 }
  const rightward: DropAxis = { axis: 'x', forward: true }
  const leftward: DropAxis = { axis: 'x', forward: false }
  const downward: DropAxis = { axis: 'y', forward: true }
  const upward: DropAxis = { axis: 'y', forward: false }

  eq('朝右：贴右缘 → 插到后面', zoneOf(wide, { x: 95, y: 20 }, rightward), 'after')
  eq('朝右：贴左缘 → 插到前面', zoneOf(wide, { x: 5, y: 20 }, rightward), 'before')
  eq('朝右：中间 → 成为子主题', zoneOf(wide, { x: 50, y: 20 }, rightward), 'child')
  eq('朝左：贴左缘才是"后面"', zoneOf(wide, { x: 5, y: 20 }, leftward), 'after')
  eq('朝左：贴右缘是"前面"', zoneOf(wide, { x: 95, y: 20 }, leftward), 'before')
  eq('朝左：中间 → 成为子主题', zoneOf(wide, { x: 50, y: 20 }, leftward), 'child')

  // 平衡导图里同级是竖着排的，所以分区落在节点的上/下缘
  eq('朝下：贴下缘 → 插到后面', zoneOf(tall, { x: 20, y: 95 }, downward), 'after')
  eq('朝下：贴上缘 → 插到前面', zoneOf(tall, { x: 20, y: 5 }, downward), 'before')
  eq('朝下：中间 → 成为子主题', zoneOf(tall, { x: 20, y: 50 }, downward), 'child')
  eq('朝上：贴上缘才是"后面"', zoneOf(tall, { x: 20, y: 5 }, upward), 'after')
  eq('朝上：贴下缘是"前面"', zoneOf(tall, { x: 20, y: 95 }, upward), 'before')

  eq('拿不到方向时一律按子主题处理', zoneOf(wide, { x: 95, y: 20 }, null), 'child')
  eq(
    '零尺寸矩形不会除零',
    zoneOf({ x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0 }, rightward),
    'child'
  )

  group('拖拽落点裁决：同级排列方向')

  const box = (x: number, y: number): DropRect => ({ x, y, width: 100, height: 30 })
  // 平衡思维导图的子节点其实是**竖着**排的。这一点以前是按「父 → 子」去猜的，
  // 结果把"插到下面那个兄弟后面"画到了右边，看着就像要连回根节点。
  eq(
    '竖排（平衡导图）：轴为 y、朝下',
    JSON.stringify(stackDirection(box(0, 0), box(0, 60))),
    JSON.stringify({ axis: 'y', forward: true })
  )
  eq(
    '竖排且反序：朝上',
    JSON.stringify(stackDirection(box(0, 60), box(0, 0))),
    JSON.stringify({ axis: 'y', forward: false })
  )
  eq(
    '横排（组织架构图）：轴为 x、朝右',
    JSON.stringify(stackDirection(box(0, 0), box(140, 0))),
    JSON.stringify({ axis: 'x', forward: true })
  )
  eq(
    '横排且反序：朝左',
    JSON.stringify(stackDirection(box(140, 0), box(0, 0))),
    JSON.stringify({ axis: 'x', forward: false })
  )
  eq(
    '斜向但以横为主：判为 x',
    JSON.stringify(stackDirection(box(0, 0), box(100, 40))),
    JSON.stringify({ axis: 'x', forward: true })
  )
  /**
   * 中心完全重合（退化）：没有方向可言，契约是"水平、向后"。
   * 钉住它是为了让这条**显式规则**不被实现细节的微小改动悄悄换掉。
   */
  eq(
    '中心重合的退化情形 → 按契约判为「水平、向后」',
    JSON.stringify(stackDirection(box(0, 0), box(0, 0))),
    JSON.stringify({ axis: 'x', forward: true })
  )
  eq(
    '垂直于 y 轴得到 x 轴',
    JSON.stringify(perpendicularOf({ axis: 'y', forward: true })),
    JSON.stringify({ axis: 'x', forward: true })
  )

  group('快捷键移动主题（亿图脑图同款）')

  reset()
  const kRoot = root()
  const m1 = addChildOf(kRoot.id, '一')
  const m2 = addChildOf(kRoot.id, '二')
  const m3 = addChildOf(kRoot.id, '三')
  const m1a = addChildOf(m1, '一-1')
  const kNamed = new Set([m1, m2, m3, m1a])
  // 同样只看本用例自己造的节点，避免受默认子节点干扰
  const kOrder = (): string[] =>
    (find(kRoot.id)?.children ?? [])
      .filter((topic) => kNamed.has(topic.id))
      .map((topic) => topic.title)

  store().select(m2)
  check('↑ 把第二个上移一位', store().moveSelectionByKey('ArrowUp') === true)
  eq('顺序变成「二、一、三」', kOrder().join(','), '二,一,三')
  check('↓ 再下移回来', store().moveSelectionByKey('ArrowDown') === true)
  eq('回到「一、二、三」', kOrder().join(','), '一,二,三')

  store().select(m1)
  store().moveSelectionByKey('Home')
  check('已在最前时 ↑ 不做改动', store().moveSelectionByKey('ArrowUp') === false)
  store().select(m3)
  store().moveSelectionByKey('End')
  check('已在最后时 ↓ 不做改动', store().moveSelectionByKey('ArrowDown') === false)

  store().select(m3)
  check('Home 移到同级最前', store().moveSelectionByKey('Home') === true)
  eq('三跑到最前面', kOrder().join(','), '三,一,二')
  check('End 移到同级最后', store().moveSelectionByKey('End') === true)
  eq('三回到最后面', kOrder().join(','), '一,二,三')

  store().select(m1a)
  check('← 升级成功', store().moveSelectionByKey('ArrowLeft') === true)
  eq('一-1 变成中心主题的子节点', findParent(root(), m1a)?.id, kRoot.id)
  eq('并且紧跟在「一」后面', kOrder().join(','), '一,一-1,二,三')

  store().select(m1a)
  check('→ 降级成功', store().moveSelectionByKey('ArrowRight') === true)
  eq('一-1 又回到「一」下面', findParent(root(), m1a)?.id, m1)

  store().select(kRoot.id)
  check('中心主题不能被移动', store().moveSelectionByKey('ArrowUp') === false)

  store().select(m1)
  store().moveSelectionByKey('Home')
  check('已是第一个时没有可降级的目标', store().moveSelectionByKey('ArrowRight') === false)
  check('升级也做不了，因为父级就是中心主题', store().moveSelectionByKey('ArrowLeft') === false)

  group('拖拽落点裁决：同级空隙（在任意两个节点之间插入）')

  const gapStack: SiblingStack = {
    parentId: 'p',
    children: [
      { id: 'c1', rect: { x: 0, y: 0, width: 100, height: 30 } },
      { id: 'c2', rect: { x: 0, y: 100, width: 100, height: 30 } },
      { id: 'c3', rect: { x: 0, y: 200, width: 100, height: 30 } }
    ]
  }
  const stacks = [gapStack]
  eq(
    '落在 c1 与 c2 的空隙里 → 插到 c1 后面',
    nearestSiblingGap(stacks, { x: 50, y: 65 })?.targetId,
    'c1'
  )
  eq(
    '落在 c2 与 c3 的空隙里 → 插到 c2 后面',
    nearestSiblingGap(stacks, { x: 50, y: 165 })?.targetId,
    'c2'
  )
  eq('带回正确的父级', nearestSiblingGap(stacks, { x: 50, y: 65 })?.parentId, 'p')
  check('空隙边缘附近也能命中', nearestSiblingGap(stacks, { x: 50, y: 76 }) !== null)
  check('离空隙太远就不算（交给自由摆放）', nearestSiblingGap(stacks, { x: 50, y: 500 }) === null)
  check('横向偏离太远也不算', nearestSiblingGap(stacks, { x: 900, y: 65 }) === null)
  check(
    '只有一个子节点时没有空隙',
    nearestSiblingGap([{ parentId: 'p', children: [gapStack.children[0]] }], { x: 50, y: 15 }) ===
      null
  )
  check('空数组不会崩', nearestSiblingGap([], { x: 0, y: 0 }) === null)

  group('拖拽落点裁决：空白处的吸附（不能随便掉进自由摆放）')

  const snapNodes: DropNode[] = [
    { id: 'n1', rect: { x: 0, y: 0, width: 100, height: 30 } },
    { id: 'n2', rect: { x: 0, y: 200, width: 100, height: 30 } }
  ]
  eq('正落在节点上时距离为 0', closestNodeWithin(snapNodes, { x: 50, y: 15 }, new Set())?.id, 'n1')
  eq(
    '落在节点右侧一点点 → 仍然吸附到这个节点',
    closestNodeWithin(snapNodes, { x: 130, y: 15 }, new Set())?.id,
    'n1'
  )
  eq(
    '落在节点下方一点点 → 仍然吸附到最近的那个',
    closestNodeWithin(snapNodes, { x: 50, y: 120 }, new Set())?.id,
    'n2'
  )
  check(
    '离所有节点都很远 → 才允许自由摆放',
    closestNodeWithin(snapNodes, { x: 900, y: 900 }, new Set()) === null
  )
  check(
    '被拖的子树不参与吸附',
    closestNodeWithin(snapNodes, { x: 50, y: 15 }, new Set(['n1']))?.id === 'n2'
  )
  check('空列表不会崩', closestNodeWithin([], { x: 0, y: 0 }, new Set()) === null)

  /**
   * 吸附半径的**边界**：文档写的是"**超过** maxDistance 就当作空白"，
   * 所以正好等于半径时要吸附。以前起点就是 maxDistance、判断又是严格 `<`，
   * 于是边界上的点被判成空白——与同一份文件里 `nearestSiblingGap` 的 `<=` 也不一致。
   */
  {
    const only: DropNode[] = [{ id: 'n1', rect: { x: 0, y: 0, width: 100, height: 30 } }]
    check(
      '正好在吸附半径边界上 → 仍然吸附',
      closestNodeWithin(only, { x: 50, y: 290 }, new Set(), 260)?.id === 'n1'
    )
    check(
      '超出半径一点点 → 才是"这里真的是空白"',
      closestNodeWithin(only, { x: 50, y: 291 }, new Set(), 260) === null
    )
  }
  eq(
    '贴着矩形内也算 0 距离',
    distanceToRect({ x: 0, y: 0 }, { x: 0, y: 0, width: 10, height: 10 }),
    0
  )

  /**
   * 框选：**拖动中的高亮**与**松手后的选中**共用这一套判定。
   * 它坏掉的方式是"亮了却没选中 / 选中了却没亮"——比完全不高亮更让人不信任，
   * 所以边界情形（只贴边、框比节点小）也要钉住。
   */
  group('框选：命中判定')

  const marqueeBox = { x: 0, y: 0, width: 100, height: 100 }
  eq('完全包含算命中', rectsIntersect({ x: 20, y: 20, width: 10, height: 10 }, marqueeBox), true)
  eq('部分重叠算命中', rectsIntersect({ x: 90, y: 90, width: 40, height: 40 }, marqueeBox), true)
  eq(
    '只贴上边界也算命中（与框选手感一致）',
    rectsIntersect({ x: 100, y: 0, width: 10, height: 10 }, marqueeBox),
    true
  )
  eq('完全不相交不算', rectsIntersect({ x: 101, y: 0, width: 10, height: 10 }, marqueeBox), false)
  eq(
    '框比节点还小时（框在节点内部）也算命中',
    rectsIntersect({ x: -20, y: -20, width: 200, height: 200 }, marqueeBox),
    true
  )

  const marqueeNodes: DropNode[] = [
    { id: 'a', rect: { x: 0, y: 0, width: 10, height: 10 } },
    { id: 'b', rect: { x: 500, y: 500, width: 10, height: 10 } },
    { id: 'c', rect: { x: 50, y: 50, width: 10, height: 10 } }
  ]
  eq('只命中圈到的节点', topicsInBox(marqueeNodes, marqueeBox).join(','), 'a,c')
  eq(
    '返回顺序与入参一致（追加选择要按这个顺序拼）',
    topicsInBox([...marqueeNodes].reverse(), marqueeBox).join(','),
    'c,a'
  )
  eq(
    '零尺寸的框也不会崩',
    topicsInBox(marqueeNodes, { x: -5, y: -5, width: 5, height: 5 }).join(','),
    'a'
  )

  /**
   * 位移的两套语法：**CSS 要单位、SVG 属性不要**。
   *
   * 真踩过：命令式拖拽把 CSS 那套写进 SVG 的 `<g transform>`，属性解析失败
   * （控制台每帧一条 `Expected ')'`），拖拽连线层不动、还白烧帧预算。
   * 数值算得对不对不重要，**谁带单位**才是要钉住的东西。
   */
  group('位移字符串：CSS 与 SVG 两套语法')

  eq('CSS：带单位', cssTranslate(-2.5, -124), 'translate(-2.5px, -124px)')
  eq('SVG：不带单位', attrTranslate(-2.5, -124), 'translate(-2.5, -124)')
  check('SVG 的写法里绝不出现 px', !attrTranslate(10, 20).includes('px'))
  check('CSS 的写法里必须有 px（没单位就不是有效位移）', cssTranslate(10, 20).includes('px'))

  const otherStack: SiblingStack = {
    parentId: 'q',
    children: [
      { id: 'd1', rect: { x: 400, y: 0, width: 100, height: 30 } },
      { id: 'd2', rect: { x: 400, y: 60, width: 100, height: 30 } }
    ]
  }
  eq(
    '多个堆时取最近的那个',
    nearestSiblingGap([gapStack, otherStack], { x: 450, y: 45 })?.targetId,
    'd1'
  )

  group('拖拽落点裁决：分轴「可吸附区域」（生长方向宽、同级方向窄）')

  /**
   * 场景照抄用户截图：在向右长的结构里，一个主题**右侧那片空白**
   * 必须是"可以落到它下面"，而不是被判成自由摆放。
   * 区域的宽度按轴给：右侧（生长方向）外扩 84，上下（同级方向）只各外扩 29。
   */
  const childArea: SnapNode = {
    id: 'orange',
    rect: { x: 640, y: 296, width: 65, height: 34 },
    region: { x: 640 - 29, y: 296 - 29, width: 65 + 29 + 84, height: 34 + 29 + 29 },
    depth: 1
  }
  eq(
    '拖到主题右侧的子节点区 → 命中该主题（而不是自由摆放）',
    nearestInRegion([childArea], { x: 762, y: 312 }, new Set())?.id,
    'orange'
  )
  eq(
    '拖到主题上下方一点点 → 仍命中该主题（那条缝也算）',
    nearestInRegion([childArea], { x: 670, y: 335 }, new Set())?.id,
    'orange'
  )
  eq(
    '拖到主题右侧再远一点（超出生长方向外扩）→ 不命中',
    nearestInRegion([childArea], { x: 830, y: 312 }, new Set()),
    null
  )
  eq(
    '拖到主题上下方太远 → 不命中（交给自由摆放）',
    nearestInRegion([childArea], { x: 670, y: 420 }, new Set()),
    null
  )
  eq(
    '区域边界上也算命中',
    nearestInRegion([childArea], { x: 789, y: 312 }, new Set())?.id,
    'orange'
  )

  const bandA: SnapNode = {
    id: 'A',
    rect: { x: 0, y: 0, width: 100, height: 30 },
    region: { x: -20, y: -20, width: 140, height: 70 },
    depth: 1
  }
  const bandB: SnapNode = {
    id: 'B',
    rect: { x: 0, y: 60, width: 100, height: 30 },
    region: { x: -20, y: 40, width: 140, height: 70 },
    depth: 2
  }
  eq(
    '指针落在本体上时优先本体',
    nearestInRegion([bandA, bandB], { x: 50, y: 20 }, new Set())?.id,
    'A'
  )
  eq(
    '两个区域都命中时取离本体更近的那个',
    nearestInRegion([bandA, bandB], { x: 50, y: 48 }, new Set())?.id,
    'B'
  )
  eq(
    '距离相同时取更深的那个',
    nearestInRegion([bandA, bandB], { x: 50, y: 45 }, new Set())?.id,
    'B'
  )
  check(
    '被拖的子树不参与区域吸附',
    nearestInRegion([bandA], { x: 50, y: 20 }, new Set(['A'])) === null
  )
  check('空候选返回 null', nearestInRegion([], { x: 0, y: 0 }) === null)

  group('拖拽落点裁决：本轮反馈的场景（非根级的同级之间）')

  reset()
  const fbRoot = root()
  const fbParent = addChildOf(fbRoot.id, '分支主题 2')
  const k1 = addChildOf(fbParent, '子 1')
  const k2 = addChildOf(fbParent, '子 2')
  addChildOf(fbParent, '子 3')

  eq(
    '非根级的同级之间：贴外侧 → 插在其后',
    JSON.stringify(resolveDrop(root(), k1, k2, 'after')),
    JSON.stringify({ targetId: k2, mode: 'after', parentId: fbParent })
  )
  eq(
    '非根级的同级之间：停在身上 → 成为其子主题',
    JSON.stringify(resolveDrop(root(), k1, k2, 'child')),
    JSON.stringify({ targetId: k2, mode: 'child', parentId: k2 })
  )
  store().dropNode(k1, k2, 'after')
  eq(
    '落下去之后顺序正确',
    (find(fbParent)?.children ?? []).map((topic) => topic.title).join(','),
    '子 2,子 1,子 3'
  )

  group('拖拽落点裁决：插到前面（before）')

  reset()
  const bRoot = root()
  const b1 = addChildOf(bRoot.id, '甲')
  const b2 = addChildOf(bRoot.id, '乙')
  const b3 = addChildOf(bRoot.id, '丙')
  const bNamed = new Set([b1, b2, b3])
  const bOrder = (): string[] =>
    (find(bRoot.id)?.children ?? [])
      .filter((topic) => bNamed.has(topic.id))
      .map((topic) => topic.title)

  store().dropNode(b3, b1, 'before')
  eq('丙 插到了 甲 的前面', bOrder().join(','), '丙,甲,乙')
  store().undo()
  eq('before 插入可以撤销', bOrder().join(','), '甲,乙,丙')
  store().dropNode(b1, b3, 'after')
  eq('甲 插到了 丙 的后面', bOrder().join(','), '乙,丙,甲')

  group('默认结构与左右对调')

  eq('新建导图默认用逻辑图（向右）', DEFAULT_STRUCTURE, 'org.xmind.ui.logic.right')

  reset()
  const sideRoot = root()
  const sideA = addChildOf(sideRoot.id, '一')
  const sideB = addChildOf(sideRoot.id, '二')
  store().setStructure('org.xmind.ui.map.unbalanced')
  const sideOf = (id: string): string => {
    const lay = layoutSheet(root(), fakeMeasure, {}, store().workbook.sheets[0])
    return lay.nodeMap.get(id)?.side ?? '?'
  }

  eq('交替分配：第一个在右', sideOf(sideA), 'right')
  eq('交替分配：第二个在左', sideOf(sideB), 'left')
  store().setTopicSide(sideA, 'left')
  eq('显式指定后第一个改到左侧', sideOf(sideA), 'left')
  store().undo()
  eq('左右对调可以撤销', sideOf(sideA), 'right')

  group('折叠徽标跟随分支方向（中心主题的 side 恒为 root）')

  reset()
  const badgeRoot = root()
  const badgeA = addChildOf(badgeRoot.id, '一')
  addChildOf(badgeRoot.id, '二')
  const badgeSideOf = (id: string): string => {
    const lay = layoutSheet(root(), fakeMeasure, {}, store().workbook.sheets[0])
    const node = lay.nodeMap.get(id)
    return node ? collapseBadgeSide(node, lay.nodeMap) : '?'
  }

  store().setStructure('org.xmind.ui.logic.right')
  eq('逻辑图（向右）：中心主题徽标在右', badgeSideOf(badgeRoot.id), 'right')
  eq('逻辑图（向右）：子主题徽标在右', badgeSideOf(badgeA), 'right')

  store().setStructure('org.xmind.ui.logic.left')
  eq('逻辑图（向左）：中心主题徽标在左', badgeSideOf(badgeRoot.id), 'left')
  eq('逻辑图（向左）：子主题徽标在左', badgeSideOf(badgeA), 'left')

  store().setStructure('org.xmind.ui.tree.left')
  eq('树形图（向左）：中心主题徽标在左', badgeSideOf(badgeRoot.id), 'left')

  /**
   * 平衡思维导图两侧都有分支：徽标保持右侧，不随分支增删来回跳。
   */
  store().setStructure('org.xmind.ui.map.unbalanced')
  eq('平衡思维导图：两侧都有分支时中心徽标保持右侧', badgeSideOf(badgeRoot.id), 'right')

  /**
   * 折叠后子节点从布局里消失，必须退回**结构方向**——
   * 否则「向左的图」一折叠，徽标就跳到右边、点不到也读不懂。
   */
  store().setStructure('org.xmind.ui.logic.left')
  store().setCollapsed(badgeRoot.id, true)
  eq('逻辑图（向左）折叠中心主题后徽标仍在左', badgeSideOf(badgeRoot.id), 'left')

  /**
   * 上下展开同样要跟（用户截图：组织架构图（向下）的徽标挂在了右边）：
   * 子节点全在下方 → 贴下缘；全在上方 → 贴上缘。
   */
  reset()
  const orgRoot = root()
  const orgA = addChildOf(orgRoot.id, '甲')
  addChildOf(orgRoot.id, '乙')
  addChildOf(orgA, '甲一')

  store().setStructure('org.xmind.ui.org-chart.down')
  eq('组织架构图（向下）：中心主题徽标在下', badgeSideOf(orgRoot.id), 'down')
  eq('组织架构图（向下）：分支主题徽标在下', badgeSideOf(orgA), 'down')

  store().setStructure('org.xmind.ui.org-chart.up')
  eq('组织架构图（向上）：中心主题徽标在上', badgeSideOf(orgRoot.id), 'up')
  eq('组织架构图（向上）：分支主题徽标在上', badgeSideOf(orgA), 'up')

  store().setStructure('org.xmind.ui.org-chart.down')
  store().setCollapsed(orgRoot.id, true)
  eq('组织架构图（向下）折叠中心主题后徽标仍在下', badgeSideOf(orgRoot.id), 'down')

  /**
   * 每个支持的结构都要声明展开方向：中心主题折叠后没有可见子节点，
   * 全靠它定位徽标——漏一个就会退回默认的「向右」。
   */
  const missingGrow = STRUCTURES.filter((item) => item.supported && !item.grows)
  eq('全部结构都声明了展开方向', missingGrow.map((item) => item.label).join(','), '')

  group('平衡思维导图：左右分别收起')

  // 新建文档自带若干种子分支，正好够验证左右两侧（归属按全部子节点的序号交替，不用写死 id）
  reset()
  const foldRootId = root().id
  store().setStructure('org.xmind.ui.map.unbalanced')

  const sideIds = (side: 'left' | 'right'): string[] => {
    const sides = childFoldSides(root())
    return root()
      .children.filter((topic) => sides.get(topic.id) === side)
      .map((topic) => topic.id)
  }
  const leftIds = sideIds('left')
  const rightIds = sideIds('right')
  const allIds = root().children.map((topic) => topic.id)
  check('默认文档两侧都有分支', leftIds.length > 0 && rightIds.length > 0)

  eq('平衡图中心主题提供左右分别收起', splitFoldSidesOf(root(), true).join(','), 'left,right')
  eq('非中心主题不提供（收起就是全收起）', splitFoldSidesOf(root(), false).join(','), '')
  store().setStructure('org.xmind.ui.logic.right')
  eq('单侧结构不提供', splitFoldSidesOf(root(), true).join(','), '')
  store().setStructure('org.xmind.ui.map.unbalanced')

  const visibleIds = (): string =>
    visibleChildren(root())
      .map((topic) => topic.id)
      .join(',')
  eq('默认两侧都可见', visibleIds(), allIds.join(','))

  store().toggleFoldSide(foldRootId, 'left')
  eq('收起左侧后只剩右侧', visibleIds(), rightIds.join(','))
  eq('收起标记写进模型', foldedSidesOf(root()).join(','), 'left')

  // setFoldSide 是**设置值**：AI 重试同一个设置不该再记一步，更不该把刚收起来的翻回去
  const stepsAtFolded = store().undoStack.length
  store().setFoldSide(foldRootId, 'left', true)
  eq('重复设置同一侧同一状态不记步（幂等）', store().undoStack.length, stepsAtFolded)
  eq('幂等设置不改变收起状态', foldedSidesOf(root()).join(','), 'left')

  const foldedLayout = layoutSheet(root(), fakeMeasure, {}, store().workbook.sheets[0])
  check(
    '收起后左侧分支不参与布局',
    leftIds.every((id) => !foldedLayout.nodeMap.has(id))
  )
  check(
    '收起后右侧分支仍在布局里',
    rightIds.every((id) => foldedLayout.nodeMap.has(id))
  )
  /**
   * 关键回归：左右归属必须按**全部**子节点算。若按可见子节点重排序号，
   * 收起左侧后右侧那些会前移、被重新判成左侧，跟着一起消失（收起一侧 = 收起全部）。
   */
  eq(
    '收起一侧不会连带收掉另一侧',
    rightIds.map((id) => foldedLayout.nodeMap.get(id)?.side ?? '?').join(','),
    rightIds.map(() => 'right').join(',')
  )

  store().toggleFoldSide(foldRootId, 'right')
  eq('两侧都收起后没有可见子节点', visibleIds(), '')
  store().toggleFoldSide(foldRootId, 'left')
  eq('展开左侧后只剩左侧可见', visibleIds(), leftIds.join(','))

  store().undo()
  store().undo()
  eq('撤销两步后回到「只收起左侧」', foldedSidesOf(root()).join(','), 'left')

  store().setCollapsed(foldRootId, false)
  eq('整体展开会清掉按侧收起（两种标记互斥）', foldedSidesOf(root()).join(','), '')

  /**
   * 大纲那一行与画布 `Ctrl+/` 走的是 `toggleCollapse`。按侧收起时大纲显示成「展开」
   * （`outlineRows` 的判据是"有子节点但不是全部可见"），所以**按一下必须真的展开**——
   * 不能"提示写展开、动作却是把两侧都收起来"。
   */
  store().setFoldSide(foldRootId, 'left', true)
  const stepsBeforeToggle = store().undoStack.length
  store().toggleCollapse(foldRootId)
  eq('按侧收起时按「折叠/展开」= 展开', foldedSidesOf(root()).join(','), '')
  check('并且没有顺手打开整体折叠（不是折上加折）', !findTopic(root(), foldRootId)?.collapsed)
  eq('这一下记一步', store().undoStack.length, stepsBeforeToggle + 1)
  store().toggleCollapse(foldRootId)
  check('再按一次才是整体折叠', findTopic(root(), foldRootId)?.collapsed === true)
  store().setCollapsed(foldRootId, false)

  store().toggleFoldSide(foldRootId, 'left')
  addChildOf(foldRootId, '新节点')
  eq('新建子主题时自动展开（新节点不会落在收起的侧）', foldedSidesOf(root()).join(','), '')

  /**
   * 「把某个一级分支拖到中心主题另一侧」（`setTopicSide`）不能把它**送进收起的那一侧**——
   * 那样分支会当场消失，用户以为把数据弄丢了。
   */
  store().setFoldSide(foldRootId, 'left', true)
  const movedBranch = root().children.find((topic) => rightIds.includes(topic.id))
  check('找得到待搬的右侧分支', Boolean(movedBranch))
  if (movedBranch) store().setTopicSide(movedBranch.id, 'left')
  eq('拖到收起的一侧会顺手展开那一侧（分支不会当场消失）', foldedSidesOf(root()).join(','), '')

  group('按侧收起：方向分组与布局逐结构一致')

  /**
   * **单一来源的守门断言**（全部 14 个结构铺一遍）：
   * ① `childFoldSides` 声明的方向，必须与布局真正摆出来的方向完全一致——
   *    两边各写一份规则时，这条会立刻变红；
   * ② 收起某一侧之后，**剩下的仍在各自原来那一侧**——按可见子节点重新编号的话，
   *    它们会漂到收起来的那一侧去（收起一侧等于没生效）；
   * ③ 只有**思维导图（平衡 / 顺时针）**提供按侧收起：
   *    单方向的结构与**时间轴 / 鱼骨图**（上下交替只是布局方向）都保持「一个折叠点」。
   */
  for (const def of STRUCTURES.filter((item) => item.supported)) {
    reset()
    const sweepRootId = root().id
    store().setStructure(def.class)
    while (root().children.length < 6) addChildOf(sweepRootId, `补${root().children.length}`)

    const declared = childFoldSides(root())
    const sides = splitFoldSidesOf(root(), true)
    const layout = layoutSheet(root(), fakeMeasure, {}, store().workbook.sheets[0])

    if (declared.size === 0) {
      eq(`结构「${def.label}」：单方向结构不提供按侧收起`, sides.join(','), '')
      continue
    }

    const drifted = root().children.filter((child) => {
      const node = layout.nodeMap.get(child.id)
      return node !== undefined && declared.get(child.id) !== node.side
    })
    eq(
      `结构「${def.label}」：方向分组与布局一致`,
      drifted
        .map(
          (topic) =>
            `${topic.title}=${declared.get(topic.id)}/${layout.nodeMap.get(topic.id)?.side}`
        )
        .join(','),
      ''
    )

    // 时间轴 / 鱼骨图：方向只服务于布局，收起仍是「一个折叠点」（整体折叠）
    if (sides.length < 2) {
      eq(`结构「${def.label}」：不提供按侧收起（保持一个折叠点）`, sides.join(','), '')
      continue
    }
    eq(`结构「${def.label}」：两个方向都能收起`, sides.length, 2)

    const first = sides[0] ?? 'left'
    store().setFoldSide(sweepRootId, first, true)
    const afterFold = layoutSheet(root(), fakeMeasure, {}, store().workbook.sheets[0])
    const hidden = root().children.filter((child) => declared.get(child.id) === first)
    check(
      `结构「${def.label}」：收起的那一侧确实不参与布局`,
      hidden.every((topic) => !afterFold.nodeMap.has(topic.id))
    )
    const afterDrift = root()
      .children.filter((child) => declared.get(child.id) !== first)
      .filter((child) => {
        const node = afterFold.nodeMap.get(child.id)
        return node !== undefined && declared.get(child.id) !== node.side
      })
    eq(
      `结构「${def.label}」：收起「${first}」后其余不漂移`,
      afterDrift.map((topic) => topic.title).join(','),
      ''
    )
  }

  group('AI 读取：统计与骨架会标出「已收起」')

  /**
   * 折叠是**显示**状态：文档里的内容一个没少，但画布上看不到。
   * 模型必须同时拿到这两个数，否则会把收起的分支当成不存在
   * （或反过来，以为它们正显示着，于是去"移动"一个看不见的节点）。
   */
  reset()
  const statRootId = root().id
  store().setStructure('org.xmind.ui.map.unbalanced')
  const statSides = childFoldSides(root())
  const statLeftIds = root()
    .children.filter((topic) => statSides.get(topic.id) === 'left')
    .map((topic) => topic.id)
  const statLeftTotal = statLeftIds.reduce(
    (sum, id) => sum + 1 + countDescendants(findTopic(root(), id)!),
    0
  )
  check('种子文档左右两侧都有分支', statLeftIds.length > 0)

  const statContext = (): ToolContext => ({
    root: root(),
    selectedId: null,
    sheetCount: 1,
    sheet: {
      id: 'sheet-stats',
      title: '画布',
      rootTopic: root(),
      relationships: [],
      boundaries: [],
      summaries: []
    }
  })

  eq('没有折叠时藏着 0 个', countHiddenNodes(root()), 0)
  check('没有折叠时骨架不出现「已收起」', !buildSkeletonDigest(root()).includes('已收起'))
  check(
    '没有折叠时统计不报这一行',
    !runReadTool('getDocStats', '{}', statContext()).content.includes('看不到的节点')
  )

  store().setFoldSide(statRootId, 'left', true)
  eq('按侧收起：藏起来的是这一侧（含子树）', countHiddenNodes(root()), statLeftTotal)
  eq('徽标用的单侧计数与统计口径一致', hiddenCountOfSide(root(), 'left'), statLeftTotal)
  check(
    'getDocStats 报出画布上看不到多少个',
    runReadTool('getDocStats', '{}', statContext()).content.includes(
      `画布上当前看不到的节点：${statLeftTotal}`
    )
  )
  const foldedDigest = buildSkeletonDigest(root())
  check('骨架把收起的分支标出来', foldedDigest.includes('，已收起'), foldedDigest)
  check('骨架给出已收起总数', foldedDigest.includes('已收起、当前不显示'), foldedDigest)

  store().setFoldSide(statRootId, 'left', false)
  eq('展开后回到 0', countHiddenNodes(root()), 0)

  // 嵌套折叠同样要算进去（且只算一次，不能把被祖先收起的部分重复计入）
  const nestedParent = findTopic(root(), statLeftIds[0]!)
  check('找得到用于嵌套折叠的分支', Boolean(nestedParent))
  if (nestedParent) {
    addChildOf(nestedParent.id, '再折一层')
    const beforeNested = countHiddenNodes(root())
    store().setCollapsed(nestedParent.id, true)
    eq(
      '嵌套整体折叠会算进去（且不重复计入）',
      countHiddenNodes(root()),
      countDescendants(findTopic(root(), nestedParent.id)!)
    )
    store().setCollapsed(nestedParent.id, false)
    eq('展开后回到原值', countHiddenNodes(root()), beforeNested)
  }

  group('平衡结构：左右归属不受内容变化影响（回归）')

  reset()
  const qRoot = root()
  const q1 = addChildOf(qRoot.id, '分支 1')
  const q2 = addChildOf(qRoot.id, '分支 2')
  store().setStructure('org.xmind.ui.map.unbalanced')
  const before1 = sideOf(q1)
  const before2 = sideOf(q2)
  check('两个分支分别落在两侧', before1 !== before2, `${before1} / ${before2}`)

  // 给「分支 1」塞一堆子节点，让它远远高于「分支 2」。
  // 旧实现按子树高度做贪心配平，这一步会把左右整体换过来，
  // 表现就是「挪了个子节点，分支主题 1 和 2 莫名其妙换位」。
  for (let i = 0; i < 6; i += 1) addChildOf(q1, `长内容 ${i}`)
  eq('内容变多后分支 1 仍在原来那侧', sideOf(q1), before1)
  eq('内容变多后分支 2 仍在原来那侧', sideOf(q2), before2)
}

export function testCollapseSelection(): void {
  group('折叠：把藏起来的选中项提到折叠节点上')

  reset()
  const rootTopic = root()
  const parent = addChildOf(rootTopic.id, '父')
  const child = addChildOf(parent, '子')
  addChildOf(child, '孙')

  // 折叠会让整棵子树从布局里消失：选中项若留在里面，视角锁定就再也盯不到它，
  // 用户看到的是「锁定突然失效、画面不跟了」
  store().select(child)
  store().setCollapsed(parent, true)
  eq('折叠后选择落到折叠节点自己身上', store().selection[0], parent)

  store().setCollapsed(parent, false)
  eq('展开不改变选择', store().selection[0], parent)

  store().select(rootTopic.id)
  store().setCollapsed(parent, true)
  eq('选中不在这一支里就保持不动', store().selection[0], rootTopic.id)
}

export function testUndoGranularity(): void {
  group('撤销粒度：连续同向的移动合并成一步')

  reset()
  const gRoot = root()
  const a = addChildOf(gRoot.id, '甲')
  const b = addChildOf(gRoot.id, '乙')
  const c = addChildOf(gRoot.id, '丙')
  const named = new Set([a, b, c])
  // 根节点自带默认子节点，只看本用例自己造的
  const order = (): string[] =>
    (find(gRoot.id)?.children ?? []).filter((t) => named.has(t.id)).map((t) => t.title)

  // 移动**刻意不合并成一步**：撤销基于 immer patch，数组重排的 patch 带下标，
  // 把两步的 inverse 合成一个再套到"后来的状态"上会下标错位、改坏 children。
  // 这条断言就是当初抓到该缺陷的地方（合并后出现过 ["甲","乙","甲"] 这种数组）。
  store().select(a)
  const base = store().undoStack.length
  check('下移一次成功', store().moveSelectionByKey('ArrowDown') === true)
  eq('每次方向键移动各记一步', store().undoStack.length, base + 1)
  check('再下移一次成功', store().moveSelectionByKey('ArrowDown') === true)
  eq('第二次再记一步（不合并）', store().undoStack.length, base + 2)
  eq('顺序确实挪到了最后', order(), ['乙', '丙', '甲'])

  store().undo()
  eq('撤销一次回到上一步', order(), ['乙', '甲', '丙'])
  store().undo()
  eq('再撤销一次回到最初', order(), ['甲', '乙', '丙'])

  group('撤销粒度：连续同向的折叠合并成一步')

  reset()
  const cRoot = root()
  const parent = addChildOf(cRoot.id, '有子节点的')
  addChildOf(parent, '子')

  const base3 = store().undoStack.length
  store().setCollapsed(parent, true)
  eq('折叠记一步', store().undoStack.length, base3 + 1)
  store().setCollapsed(parent, true)
  eq('重复同向折叠不再增步（本来就没变化）', store().undoStack.length, base3 + 1)
  store().setCollapsed(parent, false)
  eq('展开是另一个方向，另起一步', store().undoStack.length, base3 + 2)

  group('编辑态：纯文本与富文本不会漂移')

  reset()
  const eRoot = root()
  const subject = addChildOf(eRoot.id, '原文本')

  store().beginEdit(subject)
  eq('进入编辑时纯文本取自节点', store().editingText, '原文本')
  check('进入编辑时富文本也一并备好', store().editingRich !== null)

  store().updateEditingText('改过的')
  eq('文本入口：纯文本立即更新', store().editingText, '改过的')
  check('文本入口：富文本同步存在（不会一边有一边空）', store().editingRich !== null)

  store().commitEdit()
  eq('提交后落到节点上', find(subject)?.title, '改过的')

  const blank = addChildOf(eRoot.id, '待清空')
  store().beginEdit(blank)
  store().updateEditingText('')
  store().commitEdit()
  eq('清空标题也能提交', find(blank)?.title, '')

  store().beginEdit(subject)
  store().cancelEdit()
  eq('取消后 editingId 清空', store().editingId, null)
  eq('取消后 editingText 清空', store().editingText, '')
  eq('取消后 editingRich 清空', store().editingRich, null)
}

export function testStructureIsCanvasLevel(): void {
  group('结构是画布级：子节点声明的结构一律忽略')
  reset()
  const rootId = root().id
  const branch = addChildOf(rootId, '分支')
  const kidA = addChildOf(branch, '子一')
  const kidB = addChildOf(branch, '子二')

  const before = layoutSheet(root(), fakeMeasure)

  /**
   * 模拟「导入的文件里带着分支自己的结构」：直接写数据。
   * 界面与 AI 都已经不能这么写了（结构下拉只作用于中心主题、`setStructure` 没有 target 参数），
   * 但**数据字段必须继续被忽略**——否则打开一个老文件，画面又会变成"主干对、下面那截乱"。
   */
  store().mutate((draft) => {
    const topic = findTopic(activeRoot(draft), branch)
    if (topic) topic.structureClass = 'org.xmind.ui.org-chart.down'
  }, '测试：分支自带结构')

  const after = layoutSheet(root(), fakeMeasure)
  const moved = [rootId, branch, kidA, kidB].filter((id) => {
    const from = before.nodeMap.get(id)
    const to = after.nodeMap.get(id)
    return !from || !to || from.x !== to.x || from.y !== to.y
  })

  /**
   * 这条断言就是「结构只属于整张画布」的**证明**：分支自带结构时，所有坐标必须一字不差。
   * 以前它会真的把那一支改按组织架构图排——子节点跑到下方、与邻居重叠，
   * 用户看到的就是"主干是对的、下面那截乱"。
   */
  check('分支自带结构被忽略：坐标一字不差', moved.length === 0, `被影响的节点：${moved.join('、')}`)

  // 反向确认：写进数据的字段还在（导入保真：另存时原样写回），只是不参与布局
  eq(
    '字段保留（导入保真），只是不参与布局',
    findTopic(root(), branch)?.structureClass,
    'org.xmind.ui.org-chart.down'
  )

  store().setStructure('org.xmind.ui.map.unbalanced')
  eq('setStructure 写在中心主题上', root().structureClass, 'org.xmind.ui.map.unbalanced')
  eq(
    'setStructure 不会动子节点上的结构字段',
    findTopic(root(), branch)?.structureClass,
    'org.xmind.ui.org-chart.down'
  )
}

export function testUndoSelectionAndRelayout(): void {
  group('折叠徽标：数得清折叠了多少节点')
  reset()
  const badgeRoot = root().id
  const badgeA = addChildOf(badgeRoot, '分支甲')
  const badgeB = addChildOf(badgeA, '子一')
  addChildOf(badgeA, '子二')
  addChildOf(badgeB, '孙一')
  eq('后代总数（含各层）', countDescendants(findTopic(root(), badgeA)!), 3)
  eq('叶子没有后代', countDescendants(findTopic(root(), badgeB)!), 1)
  eq('中心主题的后代数 = 全树 - 1', countDescendants(root()), countTopics(root()) - 1)

  group('撤销保留框选 / 恢复自动布局')
  reset()
  const rootId = root().id
  const a = addChildOf(rootId, '甲')
  const b = addChildOf(rootId, '乙')
  const c = addChildOf(rootId, '丙')

  // 框选 [甲, 乙] → 做一次真实修改（选择变成 [丙]）→ 撤销 → 选择应还原成 [甲, 乙]
  store().setSelection([a, b])
  store().offsetPositions([{ id: c, dx: 6, dy: 6 }])
  store().setSelection([c])
  store().undo()
  eq('撤销还原修改前的框选', store().selection, [a, b])
  store().redo()
  eq('重做还原「撤销那一刻」的选择', store().selection, [c])
  store().undo()
  eq('再撤销仍能回到框选', store().selection, [a, b])

  // 恢复自动布局：手动偏移被清空、可撤销、选择保留
  store().setSelection([a])
  store().offsetPositions([{ id: a, dx: 40, dy: 30 }])
  const node = findTopic(root(), a)
  check('偏移已写入', node?.position !== undefined)
  store().restoreAutoLayout()
  check('恢复布局后偏移清空', findTopic(root(), a)?.position === undefined)
  eq('恢复布局不动选择', store().selection, [a])
  store().undo()
  check('恢复布局可撤销（偏移回来了）', findTopic(root(), a)?.position !== undefined)
  eq('撤销恢复布局也不丢选择', store().selection, [a])
}
