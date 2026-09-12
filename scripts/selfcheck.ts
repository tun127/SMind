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
  overlayToggleOf,
  snapshotForSave,
  themeColorsOf,
  useEditor
} from '../src/renderer/src/store/editor'
import { withAlpha } from '../src/renderer/src/render/theme'
import {
  BUILTIN_THEMES,
  DEFAULT_THEME,
  getThemeColors,
  normalizeThemeColors,
  normalizeThemeDefinition
} from '../src/shared/theme'
import { activeRoot, activeSheet, countCharacters, countTopics, findParent, findTopic } from '../src/shared/model/tree'
import {
  buildRange,
  indexTree,
  layoutSheet,
  parseRange,
  readCurveOffset,
  resolveRange,
  sameRange
} from '../src/shared/layout'
import { MARKER_LABELS, RELATIONSHIP_CURVE_KEY, STRUCTURES } from '../src/shared/xmind/constants'
import { ALL_PICKABLE_MARKERS, markerVisualOf } from '../src/renderer/src/render/markers'
import { formulaHtml, formulaSize } from '../src/renderer/src/render/formula'
import {
  IMAGE_FALLBACK,
  IMAGE_MAX_HEIGHT,
  imageBoxSize,
  pureFormulaSize
} from '../src/shared/layout/accessory'
import {
  collectResourceRefs,
  mimeOfPath,
  pruneSessionResources,
  resourcePathFor,
  safeResourceName
} from '../src/shared/model/resources'
import { parseRecoveryMeta, shouldOfferRecovery, type RecoveryMeta } from '../src/shared/recovery'
import JSZip from 'jszip'
import { parseXmind } from '../src/shared/xmind/parse'
import { serializeXmind } from '../src/shared/xmind/serialize'
import { parseLegacyContent } from '../src/shared/xmind/legacy'
import { childOf, childText, childrenOf, parseXml } from '../src/shared/xmind/xml'
import {
  hasFormatting,
  plainTextOf,
  richFromPlain,
  richToTiptap,
  tiptapToRich,
  type TipTapDoc
} from '../src/shared/richtext'
import type { MeasureResult } from '../src/shared/layout/types'
import type { MindPackage, RichText, Topic, Workbook } from '../src/shared/model/types'

/* ------------------------------------------------------------------ */
/* 断言工具                                                            */
/* ------------------------------------------------------------------ */

let passed = 0
const failures: string[] = []
let currentGroup = ''

function group(name: string): void {
  currentGroup = name
  console.log(`\n【${name}】`)
}

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${currentGroup} > ${name}${detail ? ` —— ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

/** 深比较：对象键排序后比较，避免键顺序造成误判 */
function normalize(value: unknown, indent = 0): string {
  return JSON.stringify(
    value,
    (_key, val) => {
      if (val === undefined) return undefined
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        const sorted: Record<string, unknown> = {}
        for (const key of Object.keys(val as Record<string, unknown>).sort()) {
          sorted[key] = (val as Record<string, unknown>)[key]
        }
        return sorted
      }
      return val
    },
    indent
  )
}

/** 逐行找出首个差异，方便定位「哪个字段丢了」 */
function firstDiff(before: string, after: string): string {
  const linesA = before.split('\n')
  const linesB = after.split('\n')
  for (let i = 0; i < Math.max(linesA.length, linesB.length); i += 1) {
    if (linesA[i] !== linesB[i]) {
      return `首个差异在第 ${i + 1} 行\n      前: ${String(linesA[i]).trim()}\n      后: ${String(linesB[i]).trim()}`
    }
  }
  return '无差异'
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const same = normalize(actual) === normalize(expected)
  check(name, same, same ? '' : `实际=${normalize(actual)} 期望=${normalize(expected)}`)
}

/* ------------------------------------------------------------------ */
/* 便捷访问                                                            */
/* ------------------------------------------------------------------ */

const store = (): ReturnType<typeof useEditor.getState> => useEditor.getState()
const root = (): Topic => activeRoot(store().workbook)
const sheet = (): ReturnType<typeof activeSheet> => activeSheet(store().workbook)
const find = (id: string): Topic | null => findTopic(root(), id)

function reset(): void {
  store().newDocument()
}

/** 新建子主题并写入标题 */
function addChildOf(parentId: string, title: string): string {
  const id = store().addChild(parentId)
  if (!id) throw new Error('addChild 返回空 id')
  store().updateEditingText(title)
  store().commitEdit(id)
  return id
}

/** 新建同级主题并写入标题 */
function addSiblingOf(siblingId: string, title: string): string {
  const id = store().addSibling(siblingId)
  if (!id) throw new Error('addSibling 返回空 id')
  store().updateEditingText(title)
  store().commitEdit(id)
  return id
}

/* ------------------------------------------------------------------ */
/* 1. 初始化                                                           */
/* ------------------------------------------------------------------ */

function testInit(): void {
  group('初始化')
  reset()
  const state = store()
  check('只有一个画布', state.workbook.sheets.length === 1)
  check('根主题标题正确', root().title === '中心主题', root().title)
  check('根主题默认带 2 个分支', root().children.length === 2, String(root().children.length))
  check('默认结构为思维导图', root().structureClass === 'org.xmind.ui.map.unbalanced')
  check('初始不脏', state.dirty === false)
  check('初始无历史', state.undoStack.length === 0 && state.redoStack.length === 0)
  check('初始无选中', state.selection.length === 0 && state.editingId === null)
  check('节点统计正确', countTopics(root()) === 3, String(countTopics(root())))
}

/* ------------------------------------------------------------------ */
/* 2. 新建 + 编辑 + 提交                                               */
/* ------------------------------------------------------------------ */

function testAddAndCommit(): void {
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
  check('空标题提交不产生历史', store().undoStack.length === historyBefore, String(store().undoStack.length - historyBefore))
}

/* ------------------------------------------------------------------ */
/* 3. commitEdit 归属校验（上一轮修过的关键缺陷）                       */
/* ------------------------------------------------------------------ */

function testCommitGuard(): void {
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

/* ------------------------------------------------------------------ */
/* 4. 编辑中按 Enter / Tab                                             */
/* ------------------------------------------------------------------ */

function testCommitAndAdd(): void {
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
  check('同级：新节点紧跟其后', parent.children.length === ai + 2, `index=${ai} len=${parent.children.length}`)
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
  check('根主题上 Enter 新建的是子主题', root().children.length === before + 1, String(root().children.length))
}

/* ------------------------------------------------------------------ */
/* 5. 撤销 / 重做                                                      */
/* ------------------------------------------------------------------ */

function testUndoRedo(): void {
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
  check('撤销后重做栈有内容', store().redoStack.length === historyDepth, String(store().redoStack.length))

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

/* ------------------------------------------------------------------ */
/* 6. 删除与恢复                                                       */
/* ------------------------------------------------------------------ */

function testDelete(): void {
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
  check('整棵子树一起移除', countTopics(root()) === totalBefore - 3, `${countTopics(root())} vs ${totalBefore - 3}`)

  store().undo()
  check('撤销后被删节点回来', find(target) !== null)
  check('子树完整恢复', countTopics(root()) === totalBefore, String(countTopics(root())))
  check('子节点顺序保持', find(target)?.children.map((c) => c.title).join(',') === '子 1,子 2')

  // 根主题不可删
  store().select(rootId)
  const before = countTopics(root())
  store().deleteSelection()
  check('根主题不可被删除', countTopics(root()) === before)
}

/* ------------------------------------------------------------------ */
/* 7. 移动与循环保护                                                   */
/* ------------------------------------------------------------------ */

function testMove(): void {
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

/* ------------------------------------------------------------------ */
/* 8. 复制粘贴 / 折叠 / 结构 / 自由定位                                 */
/* ------------------------------------------------------------------ */

function testMisc(): void {
  group('复制粘贴、折叠、结构、自由定位')
  reset()
  const rootId = root().id
  const b1 = addChildOf(rootId, '源节点')
  addChildOf(b1, '源节点-子')

  store().select(b1)
  store().copySelection()
  store().select(rootId)
  store().paste()

  const pasted = root().children[root().children.length - 1]
  check('粘贴出新节点', pasted.id !== b1)
  check('粘贴保留标题', pasted.title === '源节点', pasted.title)
  check('粘贴保留子树且换了新 id', pasted.children.length === 1 && pasted.children[0].id !== find(b1)?.children[0].id)
  check('源节点未受影响', find(b1)?.children.length === 1)

  // 折叠
  store().toggleCollapse(b1)
  check('折叠生效', find(b1)?.collapsed === true)
  store().toggleCollapse(b1)
  check('再次折叠取消', !find(b1)?.collapsed)
  const leaf = addChildOf(rootId, '叶子')
  store().toggleCollapse(leaf)
  check('无子节点的主题不可折叠', !find(leaf)?.collapsed)

  // 结构
  store().setStructure('org.xmind.ui.logic.right', rootId)
  check('根结构已切换', root().structureClass === 'org.xmind.ui.logic.right', String(root().structureClass))
  store().setStructure('org.xmind.ui.map.unbalanced', b1)
  check('分支可单独设置结构', find(b1)?.structureClass === 'org.xmind.ui.map.unbalanced')

  // 自由定位
  store().offsetPosition(b1, 10, -20)
  eq('自由定位累加正确', find(b1)?.position, { x: 10, y: -20 })
  store().offsetPosition(b1, 5, 5)
  eq('自由定位二次累加正确', find(b1)?.position, { x: 15, y: -15 })
  store().clearPosition(b1)
  check('恢复自动布局清空偏移', find(b1)?.position === undefined)

  // 统计
  check('字数统计可用', countCharacters(root()) > 0, String(countCharacters(root())))
}

/* ------------------------------------------------------------------ */
/* 8.5 落盘快照：正在输入的文本不能丢                                   */
/* ------------------------------------------------------------------ */

function testSnapshot(): void {
  group('落盘快照')
  reset()
  const rootId = root().id
  const id = store().addChild(rootId)
  store().updateEditingText('还没按回车的文字')

  const snapshot = snapshotForSave(store())
  const snapTopic = findTopic(activeRoot(snapshot), id)
  check('快照包含正在输入的文本', snapTopic?.title === '还没按回车的文字', String(snapTopic?.title))
  check('快照不影响编辑态', store().editingId === id, String(store().editingId))
  check('快照不改动当前文档', find(id)?.title === '', `"${String(find(id)?.title)}"`)
  check('快照不影响脏标记', store().dirty === true)

  store().cancelEdit()
  check('未编辑时快照直接复用原文档', snapshotForSave(store()) === store().workbook)
}

/* ------------------------------------------------------------------ */
/* 8.6 富文本数据层                                                    */
/* ------------------------------------------------------------------ */

function testRichText(): void {
  group('富文本：纯文本互转')

  eq(
    '纯文本按行切段落',
    richFromPlain('第一行\n第二行').paragraphs.map((p) => p.runs.map((r) => r.text).join('')),
    ['第一行', '第二行']
  )
  eq('富文本转纯文本', plainTextOf(richFromPlain('a\nb')), 'a\nb')
  eq('空文本得到一个空段落', richFromPlain('').paragraphs.length, 1)
  eq(
    '项目符号降级为 • 前缀',
    plainTextOf({ paragraphs: [{ bullet: true, runs: [{ text: '条目' }] }] }),
    '• 条目'
  )
  eq('格式不影响纯文本', plainTextOf({ paragraphs: [{ runs: [{ text: 'abc', bold: true, color: '#f00' }] }] }), 'abc')

  group('富文本：格式判定')
  check('无格式不判为富文本', hasFormatting(richFromPlain('普通文本')) === false)
  check('加粗判为富文本', hasFormatting({ paragraphs: [{ runs: [{ text: 'x', bold: true }] }] }) === true)
  check('颜色判为富文本', hasFormatting({ paragraphs: [{ runs: [{ text: 'x', color: '#f00' }] }] }) === true)
  check('多段落判为富文本', hasFormatting(richFromPlain('a\nb')) === true)
  check('居中是默认值不算格式', hasFormatting({ paragraphs: [{ align: 'center', runs: [{ text: 'x' }] }] }) === false)
  check('左对齐算格式', hasFormatting({ paragraphs: [{ align: 'left', runs: [{ text: 'x' }] }] }) === true)
  check('项目符号算格式', hasFormatting({ paragraphs: [{ bullet: true, runs: [{ text: 'x' }] }] }) === true)

  group('富文本：模型 <-> TipTap 往返')
  const rich: RichText = {
    paragraphs: [
      { runs: [{ text: '标题', bold: true, color: '#2F6BFF', fontSize: 18 }] },
      { align: 'center', runs: [{ text: '普通', italic: true, strike: true }, { text: '混排', underline: true }] }
    ]
  }
  const doc = richToTiptap(rich)
  check('生成 doc 且段落数正确', doc.type === 'doc' && doc.content.length === 2, String(doc.content.length))
  check(
    '加粗生成 bold mark',
    Boolean(doc.content[0].content?.[0].marks?.some((m) => m.type === 'bold'))
  )
  check(
    '颜色与字号进入 textStyle',
    Boolean(
      doc.content[0].content?.[0].marks?.some(
        (m) => m.type === 'textStyle' && m.attrs?.color === '#2F6BFF' && m.attrs?.fontSize === '18px'
      )
    )
  )

  const round = tiptapToRich(doc)
  eq('往返后纯文本一致', plainTextOf(round), plainTextOf(rich))
  check('往返保留加粗', round.paragraphs[0].runs[0].bold === true)
  check('往返保留颜色', round.paragraphs[0].runs[0].color === '#2F6BFF')
  check('往返保留字号', round.paragraphs[0].runs[0].fontSize === 18)
  check('往返保留斜体', round.paragraphs[1].runs[0].italic === true)
  check('往返保留删除线', round.paragraphs[1].runs[0].strike === true)
  check('往返保留下划线', round.paragraphs[1].runs[1].underline === true)

  const explicitLeft = tiptapToRich({
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { textAlign: 'left' }, content: [{ type: 'text', text: '靠左' }] }]
  })
  check('显式左对齐被保留', explicitLeft.paragraphs[0].align === 'left', String(explicitLeft.paragraphs[0].align))

  const explicitCenter = tiptapToRich({
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { textAlign: 'center' }, content: [{ type: 'text', text: '居中' }] }]
  })
  check('居中被视为默认值丢弃', explicitCenter.paragraphs[0].align === undefined)

  group('富文本：项目符号与段内换行')
  const bulletDoc = richToTiptap({
    paragraphs: [
      { bullet: true, runs: [{ text: '一' }] },
      { bullet: true, runs: [{ text: '二' }] }
    ]
  })
  check(
    '连续项目符号合并为一个 bulletList',
    bulletDoc.content.length === 1 &&
      bulletDoc.content[0].type === 'bulletList' &&
      bulletDoc.content[0].content?.length === 2,
    String(bulletDoc.content.length)
  )
  const bulletBack = tiptapToRich(bulletDoc)
  check('项目符号往返保留', bulletBack.paragraphs.every((p) => p.bullet === true))
  eq('项目符号往返文本', plainTextOf(bulletBack), '• 一\n• 二')

  const hardBreakDoc: TipTapDoc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: '上' }, { type: 'hardBreak' }, { type: 'text', text: '下' }]
      }
    ]
  }
  eq(
    '段内换行拆成两个段落',
    tiptapToRich(hardBreakDoc).paragraphs.map((p) => p.runs.map((r) => r.text).join('')),
    ['上', '下']
  )

  const emptyBack = tiptapToRich({ type: 'doc', content: [{ type: 'paragraph' }] })
  check('空文档得到单个空段落', emptyBack.paragraphs.length === 1 && plainTextOf(emptyBack) === '')

  group('富文本：与编辑状态联动')
  reset()
  const rootId = root().id
  const id = store().addChild(rootId)
  store().updateEditingRich({ paragraphs: [{ runs: [{ text: '加粗标题', bold: true }] }] })
  check('编辑态纯文本镜像同步', store().editingText === '加粗标题', store().editingText)
  store().commitEdit(id)
  check('提交后写入 title', find(id)?.title === '加粗标题', String(find(id)?.title))
  check('提交后写入 titleRich', find(id)?.titleRich?.paragraphs[0].runs[0].bold === true)

  const plainId = store().addChild(rootId)
  store().updateEditingRich(richFromPlain('普通文字'))
  store().commitEdit(plainId)
  check('无格式不写入 titleRich', find(plainId)?.titleRich === undefined, String(find(plainId)?.titleRich))
  check('无格式仍写入 title', find(plainId)?.title === '普通文字', String(find(plainId)?.title))

  store().setRichText(id, { paragraphs: [{ runs: [{ text: '改过的', italic: true }] }] })
  check('setRichText 更新标题', find(id)?.title === '改过的', String(find(id)?.title))
  check('setRichText 更新格式', find(id)?.titleRich?.paragraphs[0].runs[0].italic === true)
  store().setRichText(id, null)
  check('setRichText 传 null 清空格式', find(id)?.titleRich === undefined)
  store().undo()
  check('撤销能回退格式修改', find(id)?.titleRich?.paragraphs[0].runs[0].italic === true)

  const snapId = store().addChild(rootId)
  store().updateEditingRich({ paragraphs: [{ runs: [{ text: '未提交的富文本', color: '#EB5757' }] }] })
  const snapshot = snapshotForSave(store())
  const snapTopic = findTopic(activeRoot(snapshot), snapId)
  check('快照包含未提交的富文本格式', snapTopic?.titleRich?.paragraphs[0].runs[0].color === '#EB5757')
  check('快照同时写入纯文本', snapTopic?.title === '未提交的富文本')
}

/* ------------------------------------------------------------------ */
/* 8.7 主题系统                                                        */
/* ------------------------------------------------------------------ */

function testTheme(): void {
  group('主题：内置主题库')
  check('内置主题不少于 6 套', BUILTIN_THEMES.length >= 6, String(BUILTIN_THEMES.length))
  check('主题 id 唯一', new Set(BUILTIN_THEMES.map((t) => t.id)).size === BUILTIN_THEMES.length)
  check('内置主题都标记为 builtin', BUILTIN_THEMES.every((t) => t.builtin))
  check('内置配色都能通过校验', BUILTIN_THEMES.every((t) => normalizeThemeColors(t.colors) !== null))
  check('每套主题至少有 4 个分支配色', BUILTIN_THEMES.every((t) => t.colors.branches.length >= 4))
  check('默认主题就是第一套', DEFAULT_THEME.id === BUILTIN_THEMES[0].id)

  group('主题：配色校验')
  eq('完整配色原样通过', normalizeThemeColors(DEFAULT_THEME.colors), DEFAULT_THEME.colors)
  check('空对象视为无效', normalizeThemeColors({}) === null)
  check('非对象视为无效', normalizeThemeColors('abc') === null)
  eq('缺失字段补默认值', normalizeThemeColors({ canvas: '#123456' })?.canvas, '#123456')
  eq('非法颜色替换为默认值', normalizeThemeColors({ canvas: 'red' })?.canvas, DEFAULT_THEME.colors.canvas)
  eq('非法分支配色被过滤', normalizeThemeColors({ branches: ['#fff', 'bad', '#112233'] })?.branches, ['#fff', '#112233'])
  check('分支配色为空时回填默认', (normalizeThemeColors({ branches: [] })?.branches.length ?? 0) > 0)
  eq('连线过粗被截断到上限', normalizeThemeColors({ canvas: '#ffffff', edgeWidth: 999 })?.edgeWidth, 8)
  eq('透明度越界被截断到下限', normalizeThemeColors({ canvas: '#ffffff', edgeOpacity: -1 })?.edgeOpacity, 0.1)

  group('主题：主题定义校验')
  const definition = normalizeThemeDefinition({ id: 'my', name: '我的主题', colors: DEFAULT_THEME.colors })
  check('定义校验通过', definition?.id === 'my' && definition?.name === '我的主题' && definition?.builtin === false)
  check(
    '缺 id 时自动生成',
    typeof normalizeThemeDefinition({ name: 'a', colors: DEFAULT_THEME.colors })?.id === 'string'
  )
  eq('缺名称时给默认名', normalizeThemeDefinition({ colors: DEFAULT_THEME.colors })?.name, '未命名主题')
  check('配色无效时整体无效', normalizeThemeDefinition({ name: 'a', colors: {} }) === null)
  check('传入裸配色也能识别', normalizeThemeDefinition(DEFAULT_THEME.colors) !== null)

  group('主题：颜色工具')
  eq('三位 hex 转 rgba', withAlpha('#fff', 0.5), 'rgba(255, 255, 255, 0.5)')
  eq('六位 hex 转 rgba', withAlpha('#2F6BFF', 0.28), 'rgba(47, 107, 255, 0.28)')
  // 注意 'bad' 是合法的三位十六进制（b/a/d 都是十六进制字符），所以不算非法
  eq('恰为十六进制字符的三位串按颜色处理', withAlpha('bad', 0.5), 'rgba(187, 170, 221, 0.5)')
  eq('含非十六进制字符时原样返回', withAlpha('zzz', 0.5), 'zzz')
  eq('长度不合法时原样返回', withAlpha('#12345', 0.5), '#12345')

  group('主题：取值优先级')
  eq(
    '自定义配色优先于内置',
    getThemeColors({ id: 'builtin-minimal', colors: { ...DEFAULT_THEME.colors, canvas: '#000000' } }).canvas,
    '#000000'
  )
  eq(
    '按 id 命中内置主题',
    getThemeColors({ id: 'builtin-dark' }).canvas,
    BUILTIN_THEMES.find((t) => t.id === 'builtin-dark')!.colors.canvas
  )
  eq('未知 id 回落到默认主题', getThemeColors({ id: 'nope' }).canvas, DEFAULT_THEME.colors.canvas)
  eq('没有主题时用默认', getThemeColors(undefined).canvas, DEFAULT_THEME.colors.canvas)

  group('主题：与编辑状态联动')
  reset()
  const dark = BUILTIN_THEMES.find((t) => t.id === 'builtin-dark')!
  store().applyTheme(dark)
  eq('主题已写入画布', themeColorsOf(store().workbook).canvas, dark.colors.canvas)
  eq('主题名称已写入', activeSheet(store().workbook).theme?.name, dark.name)

  store().undo()
  check('撤销能回到无主题', activeSheet(store().workbook).theme === undefined)

  store().applyTheme(BUILTIN_THEMES[0])
  const historyBefore = store().undoStack.length
  store().updateThemeColors({ canvas: '#101010' }, 'theme-canvas')
  store().updateThemeColors({ canvas: '#202020' }, 'theme-canvas')
  store().updateThemeColors({ canvas: '#303030' }, 'theme-canvas')
  check(
    '连续调色合并为一步撤销',
    store().undoStack.length === historyBefore + 1,
    `${store().undoStack.length - historyBefore} 条`
  )
  eq('合并后取最新值', themeColorsOf(store().workbook).canvas, '#303030')
  store().undo()
  eq('一步撤销回到调色之前', themeColorsOf(store().workbook).canvas, BUILTIN_THEMES[0].colors.canvas)
  store().redo()
  eq('重做回到调色之后', themeColorsOf(store().workbook).canvas, '#303030')

  store().updateThemeColors({ branches: ['#111111', '#222222'] })
  eq('可整体替换分支配色', themeColorsOf(store().workbook).branches, ['#111111', '#222222'])
}

async function testThemeRoundTrip(): Promise<void> {
  group('主题：.xmind 往返')

  reset()
  store().applyTheme(BUILTIN_THEMES[4])
  store().updateThemeColors({ edgeWidth: 3.2 })
  const workbook = store().workbook
  const before = normalize(workbook)

  const parsed = await parseXmind(await serializeXmind({ workbook, resources: {} } as MindPackage))
  check(
    '带主题的文档往返结构一致',
    normalize(parsed.workbook) === before,
    firstDiff(normalize(workbook, 2), normalize(parsed.workbook, 2))
  )
  const theme = parsed.workbook.sheets[0].theme
  eq('主题 id 保留', theme?.id, BUILTIN_THEMES[4].id)
  eq('主题名称保留', theme?.name, BUILTIN_THEMES[4].name)
  eq('主题配色完整保留', theme?.colors, { ...BUILTIN_THEMES[4].colors, edgeWidth: 3.2 })

  // 带 Xmind 原生主题结构的文件也应原样保留且稳定
  reset()
  store().mutate((draft) => {
    draft.sheets[0].theme = {
      id: 'xmind-theme',
      name: 'Xmind 主题',
      raw: { class: 'theme', importedId: 'abc', properties: { 'svg:fill': '#ffffff' } }
    }
  }, '构造 Xmind 原生主题')

  const native = store().workbook
  const first = await parseXmind(await serializeXmind({ workbook: native, resources: {} } as MindPackage))
  check('Xmind 原生主题结构被保留', first.workbook.sheets[0].theme?.raw !== undefined)
  eq(
    '原生主题属性逐字段保留',
    first.workbook.sheets[0].theme?.raw?.properties,
    { 'svg:fill': '#ffffff' }
  )
  const second = await parseXmind(await serializeXmind({ workbook: first.workbook, resources: {} } as MindPackage))
  check(
    '原生主题二次往返稳定',
    normalize(second.workbook) === normalize(first.workbook),
    firstDiff(normalize(first.workbook, 2), normalize(second.workbook, 2))
  )
}

/* ------------------------------------------------------------------ */
/* 9. 布局引擎                                                         */
/* ------------------------------------------------------------------ */

const fakeMeasure = (topic: Topic, depth: number): MeasureResult => {
  const fontSize = depth === 0 ? 19 : 14
  const lineHeight = Math.round(fontSize * 1.5)

  const items = [
    ...topic.markers.map((marker) => ({ kind: 'marker' as const, markerId: marker.markerId, width: 16 })),
    ...(topic.notes ? [{ kind: 'notes' as const, width: 16 }] : []),
    ...(topic.href ? [{ kind: 'link' as const, width: 16 }] : []),
    ...(topic.attachments.length > 0 ? [{ kind: 'attachment' as const, width: 16 }] : []),
    ...(topic.formula ? [{ kind: 'formula' as const, width: 16 }] : [])
  ]

  const accessory = {
    items,
    height: items.length > 0 ? 21 : 0,
    width: items.length > 0 ? items.length * 16 + (items.length - 1) * 3 : 0
  }
  const labelRow = {
    items: topic.labels.map((text) => ({ text, width: 30 + text.length * 7 })),
    height: topic.labels.length > 0 ? 23 : 0,
    width: topic.labels.reduce((sum, text) => sum + 30 + text.length * 7, 0)
  }

  return {
    width: 90 + topic.title.length * 9,
    height: (depth === 0 ? 44 : 30) + accessory.height + labelRow.height,
    lines: [
      {
        segments:
          topic.title.length > 0
            ? [{ text: topic.title, fontSize, weight: depth === 0 ? 700 : 500 }]
            : [],
        width: 90 + topic.title.length * 9,
        height: lineHeight,
        align: 'center'
      }
    ],
    fontSize,
    lineHeight,
    paddingX: depth === 0 ? 24 : 14,
    paddingY: depth === 0 ? 15 : 9,
    accessory,
    labelRow
  }
}

function testLayout(): void {
  group('布局引擎')
  reset()
  const rootId = root().id
  const b1 = addChildOf(rootId, '分支一')
  const b2 = addChildOf(rootId, '分支二')
  const b3 = addChildOf(rootId, '分支三')
  addChildOf(b1, '一甲')
  addChildOf(b1, '一乙')
  addChildOf(b2, '二甲')

  const result = layoutSheet(root(), fakeMeasure)
  const total = countTopics(root())

  check('每个节点都有布局', result.nodes.length === total, `${result.nodes.length} vs ${total}`)
  check('连线数 = 节点数 - 1', result.edges.length === total - 1, `${result.edges.length} vs ${total - 1}`)
  check('根节点 side 为 root', result.nodeMap.get(rootId)?.side === 'root')
  check('根节点 depth 为 0', result.nodeMap.get(rootId)?.depth === 0)

  const allFinite = result.nodes.every(
    (n) => Number.isFinite(n.x) && Number.isFinite(n.y) && n.width > 0 && n.height > 0
  )
  check('所有坐标与尺寸均为有效正数', allFinite)

  const inBounds = result.nodes.every(
    (n) => n.x >= 0 && n.y >= 0 && n.x + n.width <= result.bounds.width + 1 && n.y + n.height <= result.bounds.height + 1
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
  check('折叠后子节点不再布局', hidden.every((id) => !collapsed.nodeMap.has(id)))
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
  check('超长标题不会产生 NaN', extreme.nodes.every((n) => Number.isFinite(n.width) && n.width > 0))
}

/* ------------------------------------------------------------------ */
/* 10. .xmind 往返保真                                                 */
/* ------------------------------------------------------------------ */

function buildFeatureRichWorkbook(): Workbook {
  reset()
  const rootId = root().id
  store().setTitle(rootId, '总目标')
  const a = addChildOf(rootId, '第一分支')
  const b = addChildOf(rootId, '第二分支')
  const a1 = addChildOf(a, '子项 1')
  addChildOf(a, '子项 2')
  addChildOf(b, '另一个子项')
  store().toggleCollapse(b)
  store().offsetPosition(a1, 60, -30)

  store().mutate((draft) => {
    const topics = draft.sheets[0].rootTopic
    const findIn = (node: Topic, id: string): Topic | null => {
      if (node.id === id) return node
      for (const c of node.children) {
        const hit = findIn(c, id)
        if (hit) return hit
      }
      return null
    }
    const target = findIn(topics, a)!
    target.labels = ['核心', 'P1']
    target.markers = [{ markerId: 'priority-1' }, { markerId: 'task-done' }]
    target.notes = '这是备注\n第二行'
    target.notesHtml = '<p>这是备注</p>'
    target.href = 'https://example.com'
    target.titleRich = { paragraphs: [{ align: 'center', runs: [{ text: '第一分支', bold: true, color: '#ff0000' }] }] }

    const rootTopic = draft.sheets[0].rootTopic
    rootTopic.style = { properties: { 'svg:fill': '#FF8A65', 'fo:color': '#FFFFFF' } }

    draft.sheets[0].relationships.push({ id: 'rel-1', end1Id: a, end2Id: b, title: '相关' })
    draft.sheets[0].boundaries.push({ id: 'bd-1', range: `(${a1},${b})`, title: '范围' })
    draft.sheets[0].summaries.push({ id: 'sm-1', topicId: a1, range: `(${a1},${b})`, title: '概要' })
    draft.sheets[0].topicPositioning = 'fixed'

    // 第二个画布
    draft.sheets.push({
      id: 'sheet-2',
      title: '第二画布',
      rootTopic: {
        id: 'topic-2',
        title: '第二个根',
        children: [{ id: 'topic-2-1', title: '二-1', children: [], detachedChildren: [], labels: [], markers: [], attachments: [] }],
        detachedChildren: [],
        labels: [],
        markers: [],
        attachments: []
      },
      relationships: [],
      boundaries: [],
      summaries: []
    })
  }, '构造测试数据')

  return store().workbook
}

async function testRoundTrip(): Promise<void> {
  group('.xmind 往返保真')
  const workbook = buildFeatureRichWorkbook()
  const before = normalize(workbook)
  const beforeSheets = workbook.sheets.length

  const bytes = await serializeXmind({ workbook, resources: {} } as MindPackage)
  check('序列化产出非空字节', bytes.length > 0, String(bytes.length))

  const parsed = await parseXmind(bytes)
  check('画布数量保持', parsed.workbook.sheets.length === beforeSheets, String(parsed.workbook.sheets.length))
  check('解析无 warning', parsed.warnings.length === 0, parsed.warnings.join(' '))
  check(
    '往返后结构完全一致',
    normalize(parsed.workbook) === before,
    firstDiff(normalize(workbook, 2), normalize(parsed.workbook, 2))
  )

  // 具体字段抽查
  const pRoot = parsed.workbook.sheets[0].rootTopic
  const pA = pRoot.children.find((c) => c.title === '第一分支')!
  const pB = pRoot.children.find((c) => c.title === '第二分支')!
  eq('标签保留', pA.labels, ['核心', 'P1'])
  eq('标记保留', pA.markers, [{ markerId: 'priority-1' }, { markerId: 'task-done' }])
  eq('备注保留', pA.notes, '这是备注\n第二行')
  eq('备注 HTML 保留', pA.notesHtml, '<p>这是备注</p>')
  eq('超链接保留', pA.href, 'https://example.com')
  check('富文本扩展保留', pA.titleRich?.paragraphs[0].runs[0].text === '第一分支')
  check('节点样式保留', pRoot.style?.properties['svg:fill'] === '#FF8A65')
  check('折叠状态保留', pB.collapsed === true)
  eq('自由定位保留', pA.children[0].position, { x: 60, y: -30 })
  check('自由定位模式保留', parsed.workbook.sheets[0].topicPositioning === 'fixed')
  check('关系线保留', parsed.workbook.sheets[0].relationships.length === 1)
  check('边界保留', parsed.workbook.sheets[0].boundaries[0]?.title === '范围')
  check('概要保留', parsed.workbook.sheets[0].summaries[0]?.title === '概要')
  check('第二画布保留', parsed.workbook.sheets[1]?.title === '第二画布')

  // 二次往返（多次另存不应持续退化）
  const again = await parseXmind(await serializeXmind({ workbook: parsed.workbook, resources: {} } as MindPackage))
  check(
    '二次往返仍然一致',
    normalize(again.workbook) === before,
    firstDiff(normalize(parsed.workbook, 2), normalize(again.workbook, 2))
  )
}

/* ------------------------------------------------------------------ */
/* 11. 未知字段透传                                                    */
/* ------------------------------------------------------------------ */

async function testUnknownPassthrough(): Promise<void> {
  group('未知字段透传（兼容性兜底）')
  const zipContent = JSON.stringify([
    {
      id: 'sheet-x',
      class: 'sheet',
      title: '外部文件',
      rootTopic: {
        id: 'topic-x',
        class: 'topic',
        title: '外部根',
        structureClass: 'org.xmind.ui.something.unknown',
        extensions: [{ provider: 'org.xmind.ui.someFeature', content: { foo: 'bar' } }],
        children: {
          attached: [
            {
              id: 'topic-x-1',
              class: 'topic',
              title: '外部子节点',
              markers: [{ markerId: 'star-red' }],
              extensions: [{ provider: 'org.xmind.ui.other', content: [1, 2, 3] }]
            }
          ],
          detached: []
        }
      },
      unknownSheetField: { keep: true }
    }
  ])

  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  zip.file('content.json', zipContent)
  zip.file('metadata.json', JSON.stringify({ creator: { name: 'Xmind', version: '1.0' }, activeSheetId: 'sheet-x' }))
  const bytes = await zip.generateAsync({ type: 'uint8array' })

  const parsed = await parseXmind(bytes)
  check('未识别的结构给出提示', parsed.warnings.length === 1, parsed.warnings.join(' '))
  check(
    '未识别的结构类型被原样读入',
    parsed.workbook.sheets[0].rootTopic.structureClass === 'org.xmind.ui.something.unknown'
  )
  check('节点级未知扩展被保留', parsed.workbook.sheets[0].rootTopic.extensions?.length === 1)
  check('子节点未知扩展被保留', parsed.workbook.sheets[0].rootTopic.children[0].extensions?.length === 1)
  check('未实现的布局不阻塞解析', parsed.workbook.sheets[0].rootTopic.children.length === 1)

  // 另存后未知字段仍在
  const out = await parseXmind(await serializeXmind({ workbook: parsed.workbook, resources: {} } as MindPackage))
  check('另存后未知扩展仍然保留', out.workbook.sheets[0].rootTopic.extensions?.length === 1)
  check('另存后子节点未知扩展仍然保留', out.workbook.sheets[0].rootTopic.children[0].extensions?.length === 1)
  check('另存不会丢掉标记', out.workbook.sheets[0].rootTopic.children[0].markers[0]?.markerId === 'star-red')

  // 损坏文件应给出可读错误
  const badZip = new JSZip()
  badZip.file('content.json', '{ this is not json')
  const badBytes = await badZip.generateAsync({ type: 'uint8array' })
  let message = ''
  try {
    await parseXmind(badBytes)
  } catch (error) {
    message = (error as Error).message
  }
  check('损坏文件抛出可读错误', message.includes('损坏') || message.includes('解析失败'), message)

  const notXmind = new JSZip()
  notXmind.file('readme.txt', 'hello')
  const notBytes = await notXmind.generateAsync({ type: 'uint8array' })
  let message2 = ''
  try {
    await parseXmind(notBytes)
  } catch (error) {
    message2 = (error as Error).message
  }
  check('非 xmind 文件抛出可读错误', message2.includes('content.json'), message2)

  // 已知结构（哪怕是比较冷门的鱼骨图）不应再产生任何提示
  const knownZip = new JSZip()
  knownZip.file(
    'content.json',
    JSON.stringify([
      {
        id: 'sheet-k',
        class: 'sheet',
        title: '已知结构',
        rootTopic: {
          id: 'topic-k',
          class: 'topic',
          title: '根',
          structureClass: 'org.xmind.ui.fishbone.leftHeaded',
          children: { attached: [{ id: 'topic-k-1', class: 'topic', title: '子' }], detached: [] }
        }
      }
    ])
  )
  const knownParsed = await parseXmind(await knownZip.generateAsync({ type: 'uint8array' }))
  check('已知结构不再产生提示', knownParsed.warnings.length === 0, knownParsed.warnings.join(' '))
}

/* ------------------------------------------------------------------ */
/* 12. 崩溃恢复判定                                                    */
/* ------------------------------------------------------------------ */

function testRecovery(): void {
  group('崩溃恢复：该不该弹提示')

  check('没有存档时不提示', shouldOfferRecovery(null, null) === false)

  const fresh: RecoveryMeta = { originalPath: null, title: '未命名导图', savedAt: 1000 }
  check('全新未保存的文档有存档时提示', shouldOfferRecovery(fresh, null) === true)

  const saved: RecoveryMeta = { originalPath: 'D:/a.xmind', title: 'a', savedAt: 2000 }
  check('原文件比存档旧时需要提示', shouldOfferRecovery(saved, 1500) === true)
  check('原文件在存档之后被保存过则不提示', shouldOfferRecovery(saved, 2500) === false)
  check('时间戳相同时按「不需要恢复」处理', shouldOfferRecovery(saved, 2000) === false)
  check('原文件不存在时仍提示', shouldOfferRecovery(saved, null) === true)

  group('崩溃恢复：元信息校验')
  check('非对象视为无效', parseRecoveryMeta('abc') === null)
  check('缺时间戳视为无效', parseRecoveryMeta({ originalPath: 'a' }) === null)
  check('时间戳非法视为无效', parseRecoveryMeta({ savedAt: Number.NaN }) === null)
  check('时间戳为 0 视为无效', parseRecoveryMeta({ savedAt: 0 }) === null)
  eq('合法元信息被正确解析', parseRecoveryMeta({ originalPath: 'D:/a.xmind', title: '标题', savedAt: 123 }), {
    originalPath: 'D:/a.xmind',
    title: '标题',
    savedAt: 123
  })
  eq('缺标题时给默认标题', parseRecoveryMeta({ savedAt: 123, originalPath: null })?.title, '未命名导图')
  eq('空路径规整为 null', parseRecoveryMeta({ savedAt: 123, originalPath: '' })?.originalPath, null)
  check('多余字段被忽略且不影响解析', parseRecoveryMeta({ savedAt: 123, junk: 1 }) !== null)
}

/* ------------------------------------------------------------------ */
/* 12.5 节点附加元素                                                   */
/* ------------------------------------------------------------------ */

async function testNodeElements(): Promise<void> {
  group('节点元素：标记图标映射')

  const priority1 = markerVisualOf('priority-1')
  check('优先级渲染成数字徽标', priority1.kind === 'priority' && priority1.text === '1', JSON.stringify(priority1))
  eq('优先级 1 用红色', priority1.kind === 'priority' ? priority1.color : '', '#EB5757')
  const priority5 = markerVisualOf('priority-5')
  check(
    '不同优先级颜色不同',
    priority5.kind === 'priority' && priority1.kind === 'priority' && priority5.color !== priority1.color
  )

  const quarter = markerVisualOf('task-quarter')
  check('任务进度渲染成饼形', quarter.kind === 'progress', JSON.stringify(quarter))
  eq('进度 1/2 的比例', quarter.kind === 'progress' ? quarter.ratio : -1, 0.5)
  const done = markerVisualOf('task-done')
  eq('已完成是整圆', done.kind === 'progress' ? done.ratio : -1, 1)

  const starRed = markerVisualOf('star-red')
  const starYellow = markerVisualOf('star-yellow')
  check('星标按颜色区分', starRed.kind === 'glyph' && starYellow.kind === 'glyph')
  check(
    '红星与黄星颜色不同',
    starRed.kind === 'glyph' && starYellow.kind === 'glyph' && starRed.color !== starYellow.color
  )

  check('未知标记有兜底图形', markerVisualOf('brand-new-marker-xyz').kind === 'glyph')
  check('空标记 id 不会崩', markerVisualOf('').kind === 'glyph')
  check(
    '可选项都取到了中文名',
    ALL_PICKABLE_MARKERS.every((id) => markerVisualOf(id).label !== id),
    ALL_PICKABLE_MARKERS.filter((id) => markerVisualOf(id).label === id).join(',')
  )
  check(
    '可选项数量与内置标记表一致',
    ALL_PICKABLE_MARKERS.length === Object.keys(MARKER_LABELS).length,
    `${ALL_PICKABLE_MARKERS.length} vs ${Object.keys(MARKER_LABELS).length}`
  )
  check(
    '可选项都在内置标记表里',
    ALL_PICKABLE_MARKERS.every((id) => id in MARKER_LABELS)
  )
  check(
    '所有标记颜色都是合法十六进制',
    ALL_PICKABLE_MARKERS.every((id) => /^#[0-9a-fA-F]{6}$/.test(markerVisualOf(id).color))
  )

  group('节点元素：编辑操作')

  reset()
  const rootId = root().id
  const id = addChildOf(rootId, '测试节点')

  store().toggleMarker(id, 'priority-1')
  store().toggleMarker(id, 'star-red')
  eq('添加了两个标记', find(id)?.markers.map((marker) => marker.markerId), ['priority-1', 'star-red'])
  store().toggleMarker(id, 'priority-1')
  eq('再次点击移除标记', find(id)?.markers.map((marker) => marker.markerId), ['star-red'])

  store().addLabel(id, '重要')
  store().addLabel(id, '重要')
  store().addLabel(id, '  待办  ')
  eq('标签去重且去掉首尾空格', find(id)?.labels, ['重要', '待办'])
  store().addLabel(id, '    ')
  eq('纯空白标签不会被添加', find(id)?.labels.length, 2)
  store().removeLabel(id, '重要')
  eq('删除标签生效', find(id)?.labels, ['待办'])

  store().setNotes(id, '第一行\n第二行')
  eq('备注已写入', find(id)?.notes, '第一行\n第二行')
  check('备注同时派生出 HTML', (find(id)?.notesHtml ?? '').includes('<br/>'), String(find(id)?.notesHtml))
  check('备注 HTML 转义了特殊字符', !(find(id)?.notesHtml ?? '').includes('<script'))
  store().setNotes(id, '   ')
  check('清空备注', find(id)?.notes === undefined && find(id)?.notesHtml === undefined)

  store().setHref(id, 'https://example.com')
  eq('超链接已写入', find(id)?.href, 'https://example.com')
  store().setHref(id, '   ')
  check('清空超链接', find(id)?.href === undefined)

  const notesHtml = (): string => {
    store().setNotes(id, '<b>粗体</b>')
    return find(id)?.notesHtml ?? ''
  }
  check('备注里的尖括号被转义', notesHtml().includes('&lt;b&gt;'), notesHtml())

  group('节点元素：撤销与落盘')

  store().toggleMarker(id, 'flag-blue')
  store().undo()
  eq('撤销能去掉标记', find(id)?.markers.map((marker) => marker.markerId), ['star-red'])
  store().redo()
  eq('重做能恢复标记', find(id)?.markers.map((marker) => marker.markerId), ['star-red', 'flag-blue'])

  store().addLabel(id, '已确认')
  store().setNotes(id, '备注内容')

  const before = normalize(store().workbook)
  const parsed = await parseXmind(await serializeXmind({ workbook: store().workbook, resources: {} } as MindPackage))
  check(
    '带附加元素的文档往返一致',
    normalize(parsed.workbook) === before,
    firstDiff(normalize(store().workbook, 2), normalize(parsed.workbook, 2))
  )

  const roundTopic = findTopic(activeRoot(parsed.workbook), id)
  eq('往返保留标记', roundTopic?.markers.map((marker) => marker.markerId), ['star-red', 'flag-blue'])
  eq('往返保留标签', roundTopic?.labels, ['待办', '已确认'])
  eq('往返保留备注', roundTopic?.notes, '备注内容')
  check('往返保留备注 HTML', typeof roundTopic?.notesHtml === 'string' && roundTopic.notesHtml.length > 0)
}

/* ------------------------------------------------------------------ */
/* 12.5b 节点内图片 / 附件 / 公式                                       */
/* ------------------------------------------------------------------ */

async function testMediaElements(): Promise<void> {
  group('图片与公式：尺寸规则')

  eq('没有图片时尺寸为 0', imageBoxSize(undefined), { width: 0, height: 0 })
  eq('超大图片按最大宽度等比缩小', imageBoxSize({ path: 'resources/a.png', width: 400, height: 300 }), {
    width: 220,
    height: 165
  })
  const tall = imageBoxSize({ path: 'resources/a.png', width: 100, height: 1000 })
  check('超高图片受最大高度限制', tall.height === IMAGE_MAX_HEIGHT, JSON.stringify(tall))
  check('缩放后仍然小于等于上限', tall.width <= 220 && tall.height <= IMAGE_MAX_HEIGHT, JSON.stringify(tall))

  const onlyWidth = imageBoxSize({ path: 'resources/a.png', width: 200 })
  eq('只给宽度时按 4:3 补高度', onlyWidth, { width: 200, height: 150 })
  const onlyHeight = imageBoxSize({ path: 'resources/a.png', height: 150 })
  eq('只给高度时按 4:3 补宽度', onlyHeight, { width: 200, height: 150 })
  eq('尺寸完全未知时用兜底框', imageBoxSize({ path: 'resources/a.png' }), { ...IMAGE_FALLBACK })
  eq('0 尺寸视为未知', imageBoxSize({ path: 'resources/a.png', width: 0, height: 0 }), { ...IMAGE_FALLBACK })

  const smallFormula = pureFormulaSize('x', 14)
  const longFormula = pureFormulaSize('\\sum_{i=1}^{n} \\frac{a_i}{b_i} \\cdot \\sqrt{x^2+y^2}', 14)
  check('公式估算宽度为正', smallFormula.width > 0 && smallFormula.height > 0, JSON.stringify(smallFormula))
  check('公式估算高度与字号相关', pureFormulaSize('x', 28).height > pureFormulaSize('x', 14).height)
  check('长公式不超过宽度上限', longFormula.width <= 260, JSON.stringify(longFormula))
  eq('空公式按最小宽度处理', pureFormulaSize('', 14).width, 36)

  group('资源：路径与 MIME')

  eq('去掉目录只留文件名', safeResourceName('C:\\Users\\me\\图片\\照片.png'), '照片.png')
  eq('去掉正斜杠路径', safeResourceName('a/b/c.pdf'), 'c.pdf')
  eq('非法字符替换成下划线', safeResourceName('a<b>c:d?.txt'), 'a_b_c_d_.txt')
  eq('空名字有兜底', safeResourceName('   '), 'file')
  eq('去掉开头的点，避免隐藏文件', safeResourceName('.env'), 'env')

  eq('png 的 MIME', mimeOfPath('resources/a.PNG'), 'image/png')
  eq('jpg 的 MIME', mimeOfPath('resources/a.jpeg'), 'image/jpeg')
  eq('未知扩展名给通用类型', mimeOfPath('resources/a.zzz'), 'application/octet-stream')
  eq('无扩展名给通用类型', mimeOfPath('resources/abc'), 'application/octet-stream')

  const packPath = resourcePathFor('img-abc', '照片.png')
  check('资源路径带 id 前缀并落在 resources/', packPath === 'resources/img-abc-照片.png', packPath)

  group('资源：引用收集与清理')

  reset()
  const mediaRoot = root().id
  const mediaId = addChildOf(mediaRoot, '带图片的节点')
  store().setImage(mediaId, { path: 'resources/img-1-a.png', width: 300, height: 200 })
  store().addAttachment(mediaId, {
    id: 'att-1',
    path: 'resources/att-1-b.pdf',
    name: 'b.pdf',
    size: 1234,
    mime: 'application/pdf'
  })

  const refs = collectResourceRefs(store().workbook)
  check('引用里包含图片路径', refs.has('resources/img-1-a.png'))
  check('引用里包含附件路径', refs.has('resources/att-1-b.pdf'))
  eq('引用数量正确', refs.size, 2)

  const bytesOf = (n: number): Uint8Array => new Uint8Array([n, n, n])
  const pool = {
    'resources/img-1-a.png': bytesOf(1),
    'resources/att-1-b.pdf': bytesOf(2),
    // 会话内新增但已被删掉的资源
    'resources/img-9-gone.png': bytesOf(3),
    // 文件里原本带着的资源：即使没被引用也必须保留
    'resources/legacy-unused.png': bytesOf(4)
  }
  const pruned = pruneSessionResources(
    pool,
    ['resources/img-1-a.png', 'resources/img-9-gone.png'],
    store().workbook
  )
  eq('只清理会话内新增且已无引用的资源', pruned.removed, ['resources/img-9-gone.png'])
  check('被引用的资源保留', Boolean(pruned.resources['resources/img-1-a.png']))
  check('文件原有资源一律保留', Boolean(pruned.resources['resources/legacy-unused.png']))

  group('公式：KaTeX 渲染（无 DOM 环境）')

  const rendered = formulaHtml('\\frac{a}{b}')
  check('渲染结果带 KaTeX 标记', rendered.includes('katex'), rendered.slice(0, 120))
  check('分数渲染出分子分母两层', rendered.includes('frac-line') || rendered.includes('mfrac'), rendered.slice(0, 200))
  check('常用符号能渲染', formulaHtml('\\sqrt{x^2+y^2}').includes('katex'))
  check('求和公式能渲染', formulaHtml('\\sum_{i=1}^{n} i').includes('katex'))
  check('中文混排不报错', formulaHtml('\\text{总分} = a + b').includes('katex'), formulaHtml('\\text{总分} = a + b').slice(0, 160))

  let brokenThrew = false
  let brokenHtml = ''
  try {
    brokenHtml = formulaHtml('\\frac{')
  } catch {
    brokenThrew = true
  }
  check('写坏的公式不会抛异常', !brokenThrew)
  check('写坏的公式仍然给出可渲染内容', brokenHtml.length > 0)

  const fallbackSize = formulaSize('\\frac{a}{b}', 15)
  check('无 DOM 时公式尺寸退化为估算值', fallbackSize.width > 0 && fallbackSize.height > 0, JSON.stringify(fallbackSize))
  eq('同一公式的估算值稳定', formulaSize('\\frac{a}{b}', 15), fallbackSize)

  group('图片 / 附件 / 公式：编辑操作')

  reset()
  const mid = addChildOf(root().id, '媒体节点')

  store().setFormula(mid, '  \\frac{a}{b}  ')
  eq('公式写入并去掉首尾空白', find(mid)?.formula, '\\frac{a}{b}')
  store().setFormula(mid, '   ')
  check('清空公式', find(mid)?.formula === undefined)

  store().setImage(mid, { path: 'resources/img-2-c.png', width: 120, height: 90 })
  eq('图片写入', find(mid)?.image, { path: 'resources/img-2-c.png', width: 120, height: 90 })
  store().setImage(mid, null)
  check('移除图片', find(mid)?.image === undefined)

  store().addAttachment(mid, { id: 'att-a', path: 'resources/att-a-d.docx', name: 'd.docx', size: 88 })
  eq('附件写入', find(mid)?.attachments.map((a) => a.name), ['d.docx'])
  store().addAttachment(mid, { id: 'att-a2', path: 'resources/att-a-d.docx', name: 'd.docx', size: 88 })
  eq('同一个资源不会被重复添加', find(mid)?.attachments.length, 1)

  // 重复添加是空操作：撤销应该回到「添加之前」，而不是把附件删掉
  store().undo()
  eq('撤销回到添加附件之前', find(mid)?.attachments.length, 0)
  store().redo()
  eq('重做恢复附件', find(mid)?.attachments.map((a) => a.name), ['d.docx'])

  store().removeAttachment(mid, 'att-a')
  eq('删除附件', find(mid)?.attachments.length, 0)
  store().undo()
  eq('撤销能恢复附件', find(mid)?.attachments.map((a) => a.name), ['d.docx'])

  group('图片 / 附件 / 公式：.xmind 往返')

  reset()
  const rid = addChildOf(root().id, '带媒体资源的节点')
  store().setFormula(rid, '\\sqrt{x^2+y^2}')
  store().setImage(rid, { path: 'resources/img-3-pic.png', width: 320, height: 240 })
  store().addAttachment(rid, {
    id: 'att-z',
    path: 'resources/att-z-report.pdf',
    name: 'report.pdf',
    size: 2048,
    mime: 'application/pdf'
  })

  const mediaResources: Record<string, Uint8Array> = {
    'resources/img-3-pic.png': new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
    'resources/att-z-report.pdf': new Uint8Array([37, 80, 68, 70, 9, 9])
  }

  const beforeMedia = normalize(store().workbook)
  const zipped = await serializeXmind({ workbook: store().workbook, resources: mediaResources })
  const parsedMedia = await parseXmind(zipped)

  check('带媒体资源的文档往返一致', normalize(parsedMedia.workbook) === beforeMedia, firstDiff(beforeMedia, normalize(parsedMedia.workbook)))
  eq('往返保留资源数量', Object.keys(parsedMedia.resources).length, 2)
  eq(
    '图片字节原样保留',
    Array.from(parsedMedia.resources['resources/img-3-pic.png'] ?? []),
    [137, 80, 78, 71, 1, 2, 3]
  )

  const roundMedia = findTopic(activeRoot(parsedMedia.workbook), rid)
  eq('往返保留公式', roundMedia?.formula, '\\sqrt{x^2+y^2}')
  eq('往返保留图片路径与尺寸', roundMedia?.image, {
    path: 'resources/img-3-pic.png',
    width: 320,
    height: 240
  })
  eq('往返保留附件', roundMedia?.attachments.map((a) => [a.path, a.name, a.size, a.mime]), [
    ['resources/att-z-report.pdf', 'report.pdf', 2048, 'application/pdf']
  ])

  const second = await parseXmind(
    await serializeXmind({ workbook: parsedMedia.workbook, resources: parsedMedia.resources })
  )
  check('二次往返仍然稳定', normalize(second.workbook) === beforeMedia, firstDiff(beforeMedia, normalize(second.workbook)))

  group('图片 / 附件：字段级写法（对齐真实 Xmind）')

  // 直接看生成的 content.json：包内资源引用必须带 xap: 前缀，Xmind 才认得
  const rawZip = await JSZip.loadAsync(zipped)
  const rawJson = JSON.parse((await rawZip.file('content.json')!.async('string')) as string) as Array<{
    rootTopic: { children: { attached: Array<Record<string, unknown>> } }
  }>
  const rawTopics = rawJson[0].rootTopic.children.attached
  const mediaTopic = rawTopics.find((t) => t.image !== undefined) as
    | { image: { src: string }; attachments?: Array<{ path: string }> }
    | undefined
  check('生成的 content.json 里图片用 xap: 前缀', mediaTopic?.image.src?.startsWith('xap:resources/') ?? false, String(mediaTopic?.image?.src))

  const attachTopic = rawTopics.find((t) => t.attachments !== undefined) as
    | { attachments: Array<{ path: string; name: string }> }
    | undefined
  check(
    '生成的 content.json 里附件用 xap: 前缀',
    attachTopic?.attachments?.[0]?.path?.startsWith('xap:resources/') ?? false,
    String(attachTopic?.attachments?.[0]?.path)
  )
  check('附件保留了原始文件名', (attachTopic?.attachments?.[0]?.name ?? '').length > 0)
  check('包内确实带上了资源字节', Boolean(parsedMedia.resources['resources/img-3-pic.png']))

  // 已带协议的路径不会被重复加前缀
  reset()
  const urlId = addChildOf(root().id, '外链图片')
  store().setImage(urlId, { path: 'https://example.com/a.png', width: 10, height: 10 })
  const urlZip = await JSZip.loadAsync(
    await serializeXmind({ workbook: store().workbook, resources: {} })
  )
  const urlJson = JSON.parse((await urlZip.file('content.json')!.async('string')) as string) as Array<{
    rootTopic: { children: { attached: Array<{ image?: { src: string } }> } }
  }>
  const urlSrc = urlJson[0].rootTopic.children.attached.find((t) => t.image)?.image?.src
  eq('外部 URL 不加 xap: 前缀', urlSrc, 'https://example.com/a.png')
}

/* ------------------------------------------------------------------ */
/* 12.6 画布级元素（关系线 / 边界 / 概要）                              */
/* ------------------------------------------------------------------ */

async function testOverlays(): Promise<void> {
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

  eq('连续兄弟被完整展开', resolveRange(index, `(${a},${b})`).map((topic) => topic.id), [a, b])
  eq('反向区间自动纠正顺序', resolveRange(index, `(${c},${a})`).map((topic) => topic.id), [a, b, c])
  eq('跨父级退化成单个主题', resolveRange(index, `(${a},${deep})`).map((topic) => topic.id), [a])
  eq('单节点区间', resolveRange(index, `(${c})`).map((topic) => topic.id), [c])
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
  check('关系线是二次贝塞尔曲线', relationship.d.startsWith('M ') && relationship.d.includes(' Q '), relationship.d)
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

  const storedRel = (): { end1Id: string; end2Id: string } => store().workbook.sheets[0].relationships[0]
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
  check('起点落在起点节点边框上', onBorder(rel4.start, layout4.nodeMap.get(n1)!), JSON.stringify(rel4.start))
  check('终点落在终点节点边框上', onBorder(rel4.arrow, layout4.nodeMap.get(n3)!), JSON.stringify(rel4.arrow))

  group('画布元素：概要括号方向')

  reset()
  const sRoot = root()
  const s1 = addChildOf(sRoot.id, '甲')
  const s2 = addChildOf(sRoot.id, '乙')
  store().select(s1)
  store().select(s2, true)
  store().addSummary()

  store().setStructure('org.xmind.ui.logic.right', sRoot.id)
  const rightLayout = layoutSheet(root(), fakeMeasure, {}, store().workbook.sheets[0])
  const rightSummary = rightLayout.summaries[0]
  const rightNode = rightLayout.nodeMap.get(s1)!
  eq('向右结构：文字接在括号右侧', rightSummary.anchor, 'start')
  check(
    '向右结构：括号在节点右边',
    rightSummary.label.x >= rightNode.x + rightNode.width,
    `${rightSummary.label.x} vs ${rightNode.x + rightNode.width}`
  )

  store().setStructure('org.xmind.ui.logic.left', sRoot.id)
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
  const parsed = await parseXmind(await serializeXmind({ workbook: store().workbook, resources: {} } as MindPackage))
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

/* ------------------------------------------------------------------ */
/* 12.7 开关式创建、线身拖动、框选                                      */
/* ------------------------------------------------------------------ */

async function testOverlayToggles(): Promise<void> {
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
  eq('弯度偏移读回相同', readCurveOffset(parsedCurve.workbook.sheets[0].relationships[0].style), { x: 33, y: 22 })

  group('画布元素：边界的可合并路径')

  const boundaryLayout = layoutSheet(root(), fakeMeasure, {}, sheetNow())
  const firstBoundary = boundaryLayout.boundaries[0]
  check(
    '边界给出圆角矩形路径',
    firstBoundary.d.startsWith('M ') && firstBoundary.d.endsWith('Z') && firstBoundary.d.includes('A '),
    firstBoundary.d
  )
  check('边界路径包含四段圆角', firstBoundary.d.split('A ').length - 1 === 4, String(firstBoundary.d.split('A ').length - 1))

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
    emptyToggle.relationshipId === null && emptyToggle.boundaryId === null && emptyToggle.summaryId === null
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

/* ------------------------------------------------------------------ */
/* 13. 全部结构的布局不变量                                            */
/* ------------------------------------------------------------------ */

function buildStructureSample(): void {
  reset()
  const rootId = root().id
  const b1 = addChildOf(rootId, '分支一')
  const b2 = addChildOf(rootId, '分支二')
  const b3 = addChildOf(rootId, '分支三')
  addChildOf(b1, '一甲')
  addChildOf(b1, '一乙')
  const deep = addChildOf(b1, '一丙')
  addChildOf(deep, '一丙子')
  addChildOf(b2, '二甲')
  addChildOf(b2, '二乙')
  addChildOf(b3, '三甲')
  void deep
}

function overlapReport(nodes: ReturnType<typeof layoutSheet>['nodes']): string[] {
  const overlaps: string[] = []
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]
      const b = nodes[j]
      const separated =
        a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y
      if (!separated) overlaps.push(`${a.topic.title} × ${b.topic.title}`)
    }
  }
  return overlaps
}

function testStructures(): void {
  group('结构：全部结构的布局不变量')

  check('结构清单覆盖 14 种', STRUCTURES.length === 14, String(STRUCTURES.length))
  check('全部结构都已实现布局', STRUCTURES.every((item) => item.supported))

  for (const structure of STRUCTURES) {
    const issues: string[] = []

    buildStructureSample()
    store().setStructure(structure.class)
    const layout = layoutSheet(root(), fakeMeasure)
    const total = countTopics(root())

    if (layout.nodes.length !== total) issues.push(`节点数 ${layout.nodes.length}≠${total}`)
    if (layout.edges.length !== total - 1) issues.push(`连线数 ${layout.edges.length}≠${total - 1}`)

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
    if (overlaps.length > 0) issues.push(`${overlaps.length} 处重叠（${overlaps.slice(0, 3).join('、')}）`)

    const missingEdge = layout.nodes.filter(
      (n) => n.id !== root().id && !layout.edges.some((e) => e.toId === n.id)
    )
    if (missingEdge.length > 0) issues.push(`${missingEdge.length} 个节点没有入边`)

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
  const alignedColumns = [...byDepth.values()].every((xs) => new Set(xs.map((x) => Math.round(x))).size === 1)
  check('树状表格：同一层左边缘对齐', alignedColumns)

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
  check('鱼骨图：骨刺上下交替', boneSides.every((side, index) => side === (index % 2 === 0 ? -1 : 1)), boneSides.join(','))
  check('鱼骨图：绘制了主脊', bone.decorations.length > 0)

  // 括号图：每组子节点都配了括号装饰
  buildStructureSample()
  store().setStructure('org.xmind.ui.brace.right')
  const brace = layoutSheet(root(), fakeMeasure)
  check('括号图：绘制了括号', brace.decorations.length >= root().children.length)
  const braceNodes = brace.nodes.slice().sort((a, b) => a.x - b.x)
  check('括号图：子节点整体在父节点右侧', braceNodes[0].depth < braceNodes[braceNodes.length - 1].depth)

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
}

/* ------------------------------------------------------------------ */
/* 12.7 Xmind 8 旧版（content.xml）                                    */
/* ------------------------------------------------------------------ */

const LEGACY_XML = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:svg="http://www.w3.org/2000/svg" version="2.0">
  <sheet id="sheet-1" theme="theme-1">
    <title>旧版画布</title>
    <topic id="root-1" structure-class="org.xmind.ui.logic.right" style-id="style-root">
      <title>中心 &amp; 主题</title>
      <notes>
        <plain>纯文本备注</plain>
        <html><![CDATA[<p>HTML 备注 <b>加粗</b></p>]]></html>
      </notes>
      <labels><label>标签A</label><label>标签B</label></labels>
      <marker-refs><marker-ref marker-id="priority-1"/><marker-ref marker-id="star-red"/></marker-refs>
      <href>https://example.com/legacy</href>
      <image src="xap:resources/pic.png" width="120" height="80"/>
      <attachments>
        <attachment id="att-1" path="xap:attachments/doc.pdf" name="doc.pdf" size="2048" mime="application/pdf"/>
      </attachments>
      <children>
        <topics type="attached">
          <topic id="child-1">
            <title>子主题</title>
            <branch>folded</branch>
            <children>
              <topics type="attached">
                <topic id="grand-1"><title>孙主题</title></topic>
              </topics>
            </children>
          </topic>
          <topic id="child-2">
            <title>带未知元素</title>
            <extensions><extension provider="org.example" content="不认识的扩展"/></extensions>
          </topic>
        </topics>
        <topics type="detached">
          <topic id="float-1">
            <title>浮动主题</title>
            <position svg:x="30" svg:y="-40"/>
          </topic>
        </topics>
      </children>
    </topic>
    <relationships>
      <relationship id="rel-1" end1="child-1" end2="child-2"><title>关联</title></relationship>
    </relationships>
    <summaries>
      <summary id="sum-1" topic-id="child-1" range="(child-1,child-2)"><title>阶段总结</title></summary>
    </summaries>
    <boundaries>
      <boundary id="bnd-1" range="(child-1,child-2)"><title>边界</title></boundary>
    </boundaries>
  </sheet>
</xmap-content>`

async function testLegacy(): Promise<void> {
  group('XML 解析器')
  const tree = parseXml(LEGACY_XML)!
  check('解析出根节点', tree !== null && tree.local === 'xmap-content', tree?.name)
  eq('子节点数量', childrenOf(tree, 'sheet').length, 1)

  const sheetNode = childOf(tree, 'sheet')!
  eq('读到属性', sheetNode.attrs['id'], 'sheet-1')
  eq('读到子元素文本', childText(sheetNode, 'title'), '旧版画布')
  eq('实体被解码', childText(childOf(sheetNode, 'topic'), 'title'), '中心 & 主题')

  const notesNode = childOf(childOf(sheetNode, 'topic'), 'notes')!
  eq('plain 文本', childText(notesNode, 'plain'), '纯文本备注')
  check('CDATA 原样保留', (childText(notesNode, 'html') ?? '').includes('<b>加粗</b>'), childText(notesNode, 'html'))

  const markerRefs = childOf(childOf(sheetNode, 'topic'), 'marker-refs')!
  eq('自闭合标签解析成子元素', childrenOf(markerRefs, 'marker-ref').length, 2)
  eq('自闭合标签的属性可读', childrenOf(markerRefs, 'marker-ref')[0].attrs['marker-id'], 'priority-1')
  eq('注释被忽略', parseXml('<a><!-- 注释 --><b/></a>')!.children.length, 1)
  eq('单引号属性也能解析', parseXml(`<a x='1'/>`)!.attrs['x'], '1')
  eq('数字实体', parseXml('<a>&#65;&#x42;</a>')!.text, 'AB')
  check('非 XML 文本返回 null', parseXml('这不是 XML') === null)
  check('只有声明时返回 null', parseXml('<?xml version="1.0"?>') === null)

  group('Xmind 8 旧版：读取')

  const legacy = parseLegacyContent(tree)
  eq('画布数量', legacy.workbook.sheets.length, 1)
  eq('画布标题', legacy.workbook.sheets[0].title, '旧版画布')
  check('给出了旧版兼容提示', legacy.warnings.some((w) => w.includes('Xmind 8')), legacy.warnings.join(' | '))
  check(
    '提示说明了样式不解析',
    legacy.warnings.some((w) => w.includes('styles.xml')),
    legacy.warnings.join(' | ')
  )

  const legacyRoot = legacy.workbook.sheets[0].rootTopic
  eq('结构类型', legacyRoot.structureClass, 'org.xmind.ui.logic.right')
  eq('标题', legacyRoot.title, '中心 & 主题')
  eq('备注纯文本', legacyRoot.notes, '纯文本备注')
  check('备注 HTML 保留', (legacyRoot.notesHtml ?? '').includes('<b>加粗</b>'), String(legacyRoot.notesHtml))
  eq('标签', legacyRoot.labels, ['标签A', '标签B'])
  eq('标记', legacyRoot.markers.map((m) => m.markerId), ['priority-1', 'star-red'])
  eq('超链接', legacyRoot.href, 'https://example.com/legacy')
  eq('图片路径剥掉 xap:', legacyRoot.image?.path, 'resources/pic.png')
  eq('图片尺寸', [legacyRoot.image?.width, legacyRoot.image?.height], [120, 80])
  eq('附件', legacyRoot.attachments.map((a) => [a.path, a.name, a.size, a.mime]), [
    ['attachments/doc.pdf', 'doc.pdf', 2048, 'application/pdf']
  ])
  eq('子主题标题', legacyRoot.children.map((c) => c.title), ['子主题', '带未知元素'])
  check('折叠状态', legacyRoot.children[0].collapsed === true)
  eq('孙主题', legacyRoot.children[0].children.map((c) => c.title), ['孙主题'])
  eq('浮动主题', legacyRoot.detachedChildren.map((c) => c.title), ['浮动主题'])
  eq('svg:x / svg:y 被识别', legacyRoot.detachedChildren[0].position, { x: 30, y: -40 })

  const unknownExt = legacyRoot.children[1].extensions
  check('未知元素被原样保留', Array.isArray(unknownExt) && unknownExt.length === 1, JSON.stringify(unknownExt))
  check(
    '保留的扩展带上原始 provider 与内容',
    Boolean(
      unknownExt &&
        (unknownExt[0] as { provider?: string }).provider === 'org.example' &&
        String((unknownExt[0] as { content?: string }).content).includes('不认识的扩展')
    ),
    JSON.stringify(unknownExt)
  )

  const legacySheet = legacy.workbook.sheets[0]
  eq('关系线', legacySheet.relationships.map((r) => [r.end1Id, r.end2Id, r.title]), [['child-1', 'child-2', '关联']])
  eq('边界', legacySheet.boundaries.map((b) => [b.range, b.title]), [['(child-1,child-2)', '边界']])
  eq('概要', legacySheet.summaries.map((s) => [s.topicId, s.range, s.title]), [
    ['child-1', '(child-1,child-2)', '阶段总结']
  ])
  eq('节点总数', countTopics(legacyRoot), 5)

  group('Xmind 8 旧版：损坏文件与升级路径')

  let badMessage = ''
  try {
    parseLegacyContent(parseXml('<xmap-content><sheet/></xmap-content>')!)
  } catch (error) {
    badMessage = (error as Error).message
  }
  check('没有画布的文件给出可读错误', badMessage.includes('没有找到任何画布'), badMessage)

  // 旧版读进来之后按新版格式序列化，再读回来结构必须一致
  const upgraded = JSON.parse(JSON.stringify(legacy.workbook)) as Workbook
  const upgradedRoot = activeRoot(upgraded)
  eq('升级到新版格式后节点数不变', countTopics(upgradedRoot), countTopics(legacyRoot))
  eq('升级后 id 保留', upgradedRoot.id, legacyRoot.id)
  eq('升级后附件路径保留', upgradedRoot.attachments.map((a) => a.path), ['attachments/doc.pdf'])
  check('升级后未知扩展仍在', Array.isArray(upgradedRoot.children[1].extensions))
}

/** 整包走一遍：从 zip 到模型，再到新版格式 */
async function testLegacyPackage(): Promise<void> {
  group('Xmind 8 旧版：整包读取与升级保存')

  const zip = new JSZip()
  zip.file('content.xml', LEGACY_XML)
  zip.file('styles.xml', '<xmap-styles/>')
  zip.file('resources/pic.png', new Uint8Array([1, 2, 3]))
  zip.file('attachments/doc.pdf', new Uint8Array([4, 5, 6]))
  const pkg = await parseXmind(await zip.generateAsync({ type: 'uint8array' }))

  eq('整包读取：画布数量', pkg.workbook.sheets.length, 1)
  eq('整包读取：资源同时收了 resources/ 与 attachments/', Object.keys(pkg.resources).sort(), [
    'attachments/doc.pdf',
    'resources/pic.png'
  ])
  check(
    '整包读取：给出旧版兼容提示',
    pkg.warnings.some((w) => w.includes('Xmind 8')),
    pkg.warnings.join(' | ')
  )
  eq('整包读取：标题正确', activeRoot(pkg.workbook).title, '中心 & 主题')

  const upgradedBytes = await serializeXmind({ workbook: pkg.workbook, resources: pkg.resources })
  const upgradedPkg = await parseXmind(upgradedBytes)
  eq('升级保存后：标题不变', activeRoot(upgradedPkg.workbook).title, '中心 & 主题')
  eq('升级保存后：资源不丢', Object.keys(upgradedPkg.resources).sort(), [
    'attachments/doc.pdf',
    'resources/pic.png'
  ])
  eq('升级保存后：附件字段完整', activeRoot(upgradedPkg.workbook).attachments.map((a) => [a.path, a.name]), [
    ['attachments/doc.pdf', 'doc.pdf']
  ])
  eq('升级保存后：图片字段完整', activeRoot(upgradedPkg.workbook).image?.path, 'resources/pic.png')
  check(
    '升级保存后不再提示旧版',
    !upgradedPkg.warnings.some((w) => w.includes('Xmind 8')),
    upgradedPkg.warnings.join(' | ')
  )

  // 既没有 content.json 也没有 content.xml 的包
  let message = ''
  try {
    await parseXmind(await new JSZip().generateAsync({ type: 'uint8array' }))
  } catch (error) {
    message = (error as Error).message
  }
  check('空包给出可读错误', message.includes('既没有 content.json 也没有 content.xml'), message)
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log('编辑器内核自检开始\n' + '='.repeat(56))

  testInit()
  testAddAndCommit()
  testCommitGuard()
  testCommitAndAdd()
  testUndoRedo()
  testDelete()
  testMove()
  testMisc()
  testSnapshot()
  testRichText()
  testTheme()
  testLayout()
  testRecovery()
  await testNodeElements()
  await testMediaElements()
  await testOverlays()
  await testOverlayToggles()
  testStructures()
  testLegacy()
  await testLegacyPackage()
  await testRoundTrip()
  await testThemeRoundTrip()
  await testUnknownPassthrough()

  console.log('\n' + '='.repeat(56))
  if (failures.length === 0) {
    console.log(`全部通过：${passed} 项断言`)
  } else {
    console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`)
    for (const item of failures) console.log(`  - ${item}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('\n自检异常中断：', error)
  process.exitCode = 1
})
