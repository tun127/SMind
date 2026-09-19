/**
 * 自检域：testInit / testAddAndCommit / testCommitGuard / testCommitAndAdd / testUndoRedo / testDelete / testMove / testMoveMany（由 scripts/selfcheck.ts 按行范围搬出，行为零变化）。
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

import { countTopics, findParent } from '../../../src/shared/model/tree'
import { createSheet, createWorkbook } from '../../../src/shared/model/factory'

import { DEFAULT_STRUCTURE } from '../../../src/shared/xmind/constants'

/* ---- D1 拆分：断言原语搬进 ./selfcheck/harness.ts，按域拆分的其它文件共用它 ---- */
import { check, eq, group, normalize } from '../harness'

/* ---- D1 拆分：共享测试助手搬进 ./selfcheck/helpers.ts（域文件也从那里取） ---- */
import { store, root, find, reset, addChildOf, addSiblingOf } from '../helpers'

export function testInit(): void {
  group('初始化')
  reset()
  const state = store()
  check('只有一个画布', state.workbook.sheets.length === 1)
  check('根主题标题正确', root().title === '中心主题', root().title)
  check('根主题默认带 2 个分支', root().children.length === 2, String(root().children.length))
  check(
    '默认结构为逻辑图（向右）',
    root().structureClass === 'org.xmind.ui.logic.right',
    String(root().structureClass)
  )
  // 「新建导图 / 新建画布 / 新增画布」走的是同一套工厂函数，默认结构必须处处一致
  eq(
    '新建工作簿也用默认结构',
    createWorkbook().sheets[0].rootTopic.structureClass,
    DEFAULT_STRUCTURE
  )
  eq('新建画布也用默认结构', createSheet('画布 2').rootTopic.structureClass, DEFAULT_STRUCTURE)
  check('初始不脏', state.dirty === false)
  check('初始无历史', state.undoStack.length === 0 && state.redoStack.length === 0)
  check('初始无选中', state.selection.length === 0 && state.editingId === null)
  check('节点统计正确', countTopics(root()) === 3, String(countTopics(root())))
}

export function testAddAndCommit(): void {
  group('新建子主题与提交')
  reset()
  const rootId = root().id
  const newId = store().addChild(rootId)

  check('新节点已挂到根下', root().children.length === 3)
  check('新节点被选中', store().selection[0] === newId)
  check('新节点进入编辑态', store().editingId === newId)
  check('编辑初始文本为空', store().editingText === '')

  store().updateEditingText('新想法')
  check('编辑文本已同步', store().editingText === '新想法')

  store().commitEdit(newId)
  check('提交后退出编辑态', store().editingId === null)
  check('标题已写入', find(newId)?.title === '新想法', String(find(newId)?.title))
  check('提交后标记为脏', store().dirty === true)
  // 新建节点 + 修改文本 = 两条历史
  check('产生了 2 条历史', store().undoStack.length === 2, String(store().undoStack.length))

  // 空标题提交不应产生多余历史
  const emptyId = store().addChild(rootId)
  const historyBefore = store().undoStack.length
  store().commitEdit(emptyId)
  check(
    '空标题提交不产生历史',
    store().undoStack.length === historyBefore,
    String(store().undoStack.length - historyBefore)
  )
}

export function testCommitGuard(): void {
  group('commitEdit 归属校验')
  reset()
  const rootId = root().id
  const a = store().addChild(rootId)
  check('A 处于编辑态', store().editingId === a)

  // 模拟「旧输入框失焦」：传入别的节点 id
  store().commitEdit(rootId)
  check('传入不匹配的 id 时不清空编辑态', store().editingId === a, String(store().editingId))

  store().commitEdit(a)
  check('传入匹配的 id 时正常提交', store().editingId === null)

  // 模拟真实场景：新节点自动聚焦，旧节点 blur 晚到
  const b = store().addChild(rootId)
  const c = store().addChild(rootId)
  check('新节点 C 处于编辑态', store().editingId === c)
  store().commitEdit(b)
  check('旧节点 B 的失焦不会打断 C 的编辑', store().editingId === c, String(store().editingId))
}

export function testCommitAndAdd(): void {
  group('编辑中 Enter / Tab')
  reset()
  const rootId = root().id
  const a = addChildOf(rootId, 'A')

  store().beginEdit(a)
  store().updateEditingText('A 改过')
  store().commitAndAddSibling()

  check('同级：标题已提交', find(a)?.title === 'A 改过', String(find(a)?.title))
  // 交互之后必须重新取父节点：immer 会产生新树，旧引用只是历史快照
  const parent = findParent(root(), a)!
  const ai = parent.children.findIndex((c) => c.id === a)
  check(
    '同级：新节点紧跟其后',
    parent.children.length === ai + 2,
    `index=${ai} len=${parent.children.length}`
  )
  const sibling = parent.children[ai + 1]
  check('同级：新节点是新 id', sibling.id !== a)
  check('同级：新节点进入编辑态', store().editingId === sibling.id)
  check('同级：编辑文本被清空', store().editingText === '')
  check('同级：新节点被选中', store().selection[0] === sibling.id)

  store().beginEdit(a)
  store().updateEditingText('A 再改')
  store().commitAndAddChild()
  check('子级：标题已提交', find(a)?.title === 'A 再改', String(find(a)?.title))
  check('子级：新节点挂在 A 下', find(a)?.children.length === 1, String(find(a)?.children.length))
  check('子级：新节点进入编辑态', store().editingId === find(a)?.children[0].id)

  // 根主题上按 Enter 应退化为新建子主题（根不能有同级）
  store().beginEdit(rootId)
  store().updateEditingText('中心主题')
  const before = root().children.length
  store().commitAndAddSibling()
  check(
    '根主题上 Enter 新建的是子主题',
    root().children.length === before + 1,
    String(root().children.length)
  )
}

export function testUndoRedo(): void {
  group('撤销 / 重做')
  reset()
  const baseline = normalize(store().workbook)
  const rootId = root().id

  const steps: Array<() => void> = [
    () => void addChildOf(rootId, '一层 A'),
    () => void addChildOf(rootId, '一层 B'),
    () => {
      const first = root().children[0].id
      void addChildOf(first, '二层 A1')
    },
    () => {
      const first = root().children[0].id
      void addSiblingOf(first, '一层 A2')
    },
    () => store().deleteSelection()
  ]

  // 逐步执行并记录每一步之后的快照
  const snapshots: string[] = [baseline]
  for (const step of steps) {
    step()
    snapshots.push(normalize(store().workbook))
  }

  const historyDepth = store().undoStack.length
  check('产生了历史记录', historyDepth > 0, String(historyDepth))

  // 全部撤销
  for (let i = 0; i < historyDepth; i += 1) store().undo()
  check(
    `撤销 ${historyDepth} 步后回到初始状态`,
    normalize(store().workbook) === baseline,
    normalize(store().workbook).slice(0, 160)
  )
  check(
    '撤销后重做栈有内容',
    store().redoStack.length === historyDepth,
    String(store().redoStack.length)
  )

  // 全部重做
  for (let i = 0; i < historyDepth; i += 1) store().redo()
  check(
    '全部重做后回到最终状态',
    normalize(store().workbook) === snapshots[snapshots.length - 1],
    normalize(store().workbook).slice(0, 160)
  )
  check('重做后重做栈清空', store().redoStack.length === 0)

  // 撤销后再做新操作，应清空重做栈
  store().select(root().children[0].id)
  store().deleteSelection()
  check('删除产生了历史', store().undoStack.length > 0, String(store().undoStack.length))
  store().undo()
  check('撤销后重做栈可用', store().redoStack.length === 1, String(store().redoStack.length))
  store().addChild(root().id)
  check('新操作清空重做栈', store().redoStack.length === 0, String(store().redoStack.length))
}

export function testDelete(): void {
  group('删除与撤销恢复')
  reset()
  const rootId = root().id
  const target = root().children[0].id
  addChildOf(target, '子 1')
  addChildOf(target, '子 2')

  const totalBefore = countTopics(root())
  store().select(target)
  store().deleteSelection()

  check('被删节点已移除', find(target) === null)
  check(
    '整棵子树一起移除',
    countTopics(root()) === totalBefore - 3,
    `${countTopics(root())} vs ${totalBefore - 3}`
  )

  store().undo()
  check('撤销后被删节点回来', find(target) !== null)
  check('子树完整恢复', countTopics(root()) === totalBefore, String(countTopics(root())))
  check(
    '子节点顺序保持',
    find(target)
      ?.children.map((c) => c.title)
      .join(',') === '子 1,子 2'
  )

  // 根主题不可删
  store().select(rootId)
  const before = countTopics(root())
  store().deleteSelection()
  check('根主题不可被删除', countTopics(root()) === before)

  group('删除后必须把选择落到还在的主题上（否则方向键/Delete 全体失灵）')

  // 注意：默认工作簿自带「分支主题 1 / 2」两个子节点，断言要按真实结构来
  reset()
  const dRoot = root()
  const d1 = addChildOf(dRoot.id, '甲')
  const d2 = addChildOf(dRoot.id, '乙')
  const d3 = addChildOf(dRoot.id, '丙')

  store().select(d2)
  store().deleteSelection()
  eq('删中间那个 → 选择落到它后面的兄弟', store().selection, [d3])

  store().select(d3)
  store().deleteSelection()
  eq('删最后一个 → 选择落到前一个兄弟', store().selection, [d1])

  store().select(d1)
  store().deleteSelection()
  check(
    '同级自己造的都删光了 → 选择落到其它兄弟上，绝不留下空选择',
    store().selection.length === 1 && find(store().selection[0]) !== null,
    JSON.stringify(store().selection)
  )
  check(
    '删完之后方向键仍然可用（← 能回到父级）',
    (() => {
      store().navigateSelection('ArrowLeft')
      return store().selection[0] === dRoot.id
    })()
  )

  group('方向键导航：选择失效时兜底回到根，键盘不会"死掉"')

  reset()
  const nRoot = root()
  const n1 = addChildOf(nRoot.id, '一')
  const n2 = addChildOf(nRoot.id, '二')
  addChildOf(n1, '一-1')
  // 根的子节点实际是 [分支主题 1, 分支主题 2, 一, 二]
  const kids = (): string[] => (find(nRoot.id)?.children ?? []).map((c) => c.id)

  check(
    '选择指向不存在的主题时会先收回根',
    (() => {
      store().select('不存在的-id')
      store().navigateSelection('ArrowDown')
      return store().selection[0] === nRoot.id
    })()
  )

  store().select(nRoot.id)
  store().navigateSelection('ArrowRight')
  eq('→ 进入第一个子级', store().selection, [kids()[0]])

  store().navigateSelection('ArrowDown')
  eq('↓ 走到下一个同级', store().selection, [kids()[1]])

  store().select(n1)
  store().navigateSelection('ArrowDown')
  eq('↓ 走到自己后面的兄弟', store().selection, [n2])

  store().navigateSelection('ArrowUp')
  eq('↑ 走回上一个同级', store().selection, [n1])

  store().navigateSelection('ArrowLeft')
  eq('← 回到父级', store().selection, [nRoot.id])

  store().navigateSelection('ArrowUp')
  eq('同级到头就不再动（不会跑到别处）', store().selection, [nRoot.id])
}

export function testMove(): void {
  group('移动主题与循环保护')
  reset()
  const rootId = root().id
  const b1 = addChildOf(rootId, 'B1')
  const b2 = addChildOf(rootId, 'B2')
  const gc = addChildOf(b1, 'B1-1')

  check('不能移动到自己的后代下', store().moveNode(b1, gc) === false)
  check('被拒绝后 B1 仍在根下', findParent(root(), b1)?.id === rootId)
  check('被拒绝后 B1-1 仍在 B1 下', findParent(root(), gc)?.id === b1)

  check('不能移动到自身下', store().moveNode(b1, b1) === false)
  check('根主题不能被移动', store().moveNode(rootId, b2) === false)

  check('正常移动到兄弟下', store().moveNode(b1, b2) === true)
  check('B1 现在挂在 B2 下', findParent(root(), b1)?.id === b2)
  check('B1 的子树跟着走', find(b1)?.children.length === 1, String(find(b1)?.children.length))

  store().undo()
  check('撤销移动后回到根下', findParent(root(), b1)?.id === rootId)

  // 移动到同一父级下应被忽略
  check('移动到原父级不做改动', store().moveNode(b1, rootId) === false)
}

export function testMoveMany(): void {
  group('批量移动：语义与逐条 moveNode 等价，但只清一次覆盖层')

  interface ShapeNode {
    title: string
    children: ShapeNode[]
  }
  const ids = (): { rootId: string; a: string; b: string; c: string; d: string } => {
    reset()
    const rootId = root().id
    const a = addChildOf(rootId, 'A')
    const b = addChildOf(rootId, 'B')
    const c = addChildOf(rootId, 'C')
    const d = addChildOf(c, 'C-1')
    return { rootId, a, b, c, d }
  }
  /** 把整棵树压成一行，用来对比两条路径的终态 */
  const shape = (): string => {
    const out: string[] = []
    const visit = (topic: ShapeNode, prefix: string): void => {
      out.push(`${prefix}>${topic.title}`)
      for (const child of topic.children) visit(child, `${prefix}>${topic.title}`)
    }
    visit(root(), '')
    return out.join('|')
  }
  const plan = (t: { rootId: string; a: string; b: string; c: string; d: string }) => [
    { id: t.a, targetId: t.b, index: null },
    { id: t.d, targetId: t.a, index: null },
    { id: t.c, targetId: t.rootId, index: 0 }
  ]

  // ① 批量入口：条条都成功，且后一条能看到前一条造成的结构变化
  {
    const t = ids()
    const applied = store().moveNodes([
      { id: t.a, targetId: t.b, index: null },
      { id: t.c, targetId: t.a, index: null }
    ])
    eq(
      '两条都执行成功',
      applied.map((move) => move.id),
      [t.a, t.c]
    )
    check('A 挂到 B 下', findParent(root(), t.a)?.id === t.b)
    check('C 挂到 A 下（看得到前一条的结果）', findParent(root(), t.c)?.id === t.a)
    eq('选中落到最后一个成功的', store().selection, [t.c])
  }

  // ② 终态等价：同一棵树、同一串操作，批量与逐条必须得到一模一样的形状
  {
    const viaBatch = ids()
    store().moveNodes(plan(viaBatch))
    const batchShape = shape()

    const viaSequential = ids()
    for (const move of plan(viaSequential)) {
      store().moveNode(move.id, move.targetId, move.index ?? undefined)
    }
    eq('批量与逐条 moveNode 的终态一致', batchShape, shape())
  }

  // ③ 拒绝规则与逐条一致；全部落空时不留下空的撤销记录
  {
    const t = ids()
    const before = store().undoStack.length
    eq(
      '根主题不可移动',
      store().moveNodes([{ id: t.rootId, targetId: t.a, index: null }]).length,
      0
    )
    eq('不能移进自己的后代', store().moveNodes([{ id: t.c, targetId: t.d, index: null }]).length, 0)
    eq(
      '同父级 + 没给位置＝跳过',
      store().moveNodes([{ id: t.a, targetId: t.rootId, index: null }]).length,
      0
    )
    eq('全部落空时不留下撤销记录', store().undoStack.length, before)
    eq(
      '同父级 + 显式位置＝允许',
      store().moveNodes([{ id: t.a, targetId: t.rootId, index: 99 }]).length,
      1
    )
    eq('这次才留下撤销记录', store().undoStack.length, before + 1)
  }

  // ④ 与 settleAfterMove 同理：移动过的手动偏移必须清掉，否则会「预览在这里、松手在别处」
  {
    const t = ids()
    store().offsetPosition(t.a, 40, 25)
    check('偏移已写入', find(t.a)?.position !== undefined)
    store().moveNodes([{ id: t.a, targetId: t.b, index: null }])
    check('批量移动清掉了手动偏移', find(t.a)?.position === undefined)
  }
}
