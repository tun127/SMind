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
import { defaultTextAlignOf, setDefaultTextAlign } from '../src/renderer/src/render/defaults'
import { pickDocumentArg } from '../src/shared/openfile'
import {
  clearTypedChar,
  stageTypedChar,
  takeTypedChar
} from '../src/renderer/src/editor/typedChar'
import {
  BUILTIN_THEMES,
  DEFAULT_THEME,
  getThemeColors,
  normalizeThemeColors,
  normalizeThemeDefinition
} from '../src/shared/theme'
import { activeRoot, activeSheet, countCharacters, countDescendants, countTopics, findParent, findTopic, subtreeIds } from '../src/shared/model/tree'
import { createSheet, createTopic, createWorkbook } from '../src/shared/model/factory'
import { alsoDraggedOf, moveRootsOf, resolveDragMove } from '../src/shared/model/dragmove'
import {
  blockReasonOf,
  closestNodeWithin,
  distanceToRect,
  nearestInRegion,
  nearestSiblingGap,
  perpendicularOf,
  resolveDrop,
  stackDirection,
  zoneOf,
  type DropAxis,
  type DropNode,
  type DropRect,
  type SiblingStack,
  type SnapNode
} from '../src/shared/model/drop'
import {
  HISTORY_LIMIT,
  clearHistory,
  emptyHistory,
  normalizeHistory,
  recordVisit,
  relativeTime,
  removeEntry,
  sortEntries,
  togglePin
} from '../src/shared/history'
import {
  SNAPSHOT_LIMITS,
  addSnapshot,
  clearDocSnapshots,
  documentKeyOf,
  emptySnapshotIndex,
  formatBytes,
  normalizeSnapshotIndex,
  removeSnapshot,
  shouldAutoSnapshot,
  snapshotLabel,
  snapshotReasonLabel,
  snapshotsOf,
  type SnapshotItem
} from '../src/shared/snapshot'
import {
  buildRange,
  indexTree,
  layoutSheet,
  parseRange,
  readCurveOffset,
  resolveRange,
  sameRange
} from '../src/shared/layout'
import {
  DEFAULT_STRUCTURE,
  MARKER_LABELS,
  RELATIONSHIP_CURVE_KEY,
  STRUCTURES
} from '../src/shared/xmind/constants'
import { buildEmmxWorkbook, extractEmmxTexts, parseEmmxDocument } from '../src/shared/xmind/emmx'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { ALL_PICKABLE_MARKERS, markerVisualOf } from '../src/renderer/src/render/markers'
import { formulaHtml, formulaSize } from '../src/renderer/src/render/formula'
import { buildDrawing } from '../src/renderer/src/export/drawing'
import { drawingToSvg } from '../src/renderer/src/export/svg'
import { KATEX_INLINE_CSS, KATEX_INLINED_FONTS } from '../src/renderer/src/export/katex-assets'
import { buildImagePdf } from '../src/shared/export/pdf'
import {
  IMAGE_EXPORT_FORMATS,
  IMAGE_EXPORT_SCALES,
  imageExportFormatDef,
  type ImageExportFormat
} from '../src/shared/export/types'
import {
  DEFAULT_AI_CONFIG,
  buildExpandMessages,
  buildGenerateMessages,
  buildPolishMessages,
  chatCompletionsUrl,
  cleanPolishedTitle,
  describeAiError,
  extractContent,
  normalizeAiConfig,
  outlineToTopic,
  parseFlatList,
  parseOutline,
  toConfigView
} from '../src/shared/ai'
import { parseMarkdownOutline } from '../src/shared/import/markdown'
import { matchWholeLineMath, normalizeFormulaInput, splitInlineMath } from '../src/shared/formula'
import { estimateOverlayLabelSize, overlayTitleLines } from '../src/shared/layout/overlays'
import { readOverlayFontSize, readOverlayTextStyle, withOverlayTextStyle } from '../src/shared/model/overlay-style'
import { parseOpmlOutline } from '../src/shared/import/opml'
import { defaultDocumentName, defaultFileName, sanitizeFileName } from '../src/shared/model/naming'
import {
  CODE_FONT_SIZE,
  CODE_HEADER,
  CODE_LINE_RATIO,
  CODE_MAX_LINES,
  CODE_PADDING_X,
  CODE_PADDING_Y,
  MARKER_STRIP_GAP,
  markerStripSize,
  codeBoxSize,
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
  OUTLINE_FORMATS,
  buildOutline,
  outlineFormatDef,
  outlineRows,
  toMarkdown,
  toOpml,
  toPlainText,
  type OutlineFormat
} from '../src/shared/outline'
import {
  applyTopicFilter,
  collectLabels,
  countOccurrences,
  countTitleMatches,
  hitTopicIds,
  isFilterActive,
  replaceInText,
  searchWorkbook,
  sheetStats,
  snippetOf
} from '../src/shared/search'
import {
  appendToRich,
  hasFormatting,
  plainTextOf,
  richFromPlain,
  richToTiptap,
  tiptapToRich,
  type TipTapDoc
} from '../src/shared/richtext'
import type { LayoutResult, MeasureResult, NodeLayout } from '../src/shared/layout/types'
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
  check('默认结构为逻辑图（向右）', root().structureClass === 'org.xmind.ui.logic.right', String(root().structureClass))
  // 「新建导图 / 新建画布 / 新增画布」走的是同一套工厂函数，默认结构必须处处一致
  eq('新建工作簿也用默认结构', createWorkbook().sheets[0].rootTopic.structureClass, DEFAULT_STRUCTURE)
  eq('新建画布也用默认结构', createSheet('画布 2').rootTopic.structureClass, DEFAULT_STRUCTURE)
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
  check('删完之后方向键仍然可用（← 能回到父级）', (() => {
    store().navigateSelection('ArrowLeft')
    return store().selection[0] === dRoot.id
  })())

  group('方向键导航：选择失效时兜底回到根，键盘不会"死掉"')

  reset()
  const nRoot = root()
  const n1 = addChildOf(nRoot.id, '一')
  const n2 = addChildOf(nRoot.id, '二')
  addChildOf(n1, '一-1')
  // 根的子节点实际是 [分支主题 1, 分支主题 2, 一, 二]
  const kids = (): string[] => (find(nRoot.id)?.children ?? []).map((c) => c.id)

  check('选择指向不存在的主题时会先收回根', (() => {
    store().select('不存在的-id')
    store().navigateSelection('ArrowDown')
    return store().selection[0] === nRoot.id
  })())

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
/* 7.5 拖拽落点：拖到兄弟上排序、拖到其它节点上成为子主题（Xmind 同款）  */
/* ------------------------------------------------------------------ */

function testNodeDrag(): void {
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
    (find(parentId)?.children ?? []).filter((topic) => mine.has(topic.id)).map((topic) => topic.title)
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
  check(
    '多选拖拽时不能成为目标子主题',
    resolveDrop(root(), ga, gb, 'child', [ga, gb1]) === null
  )
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
  eq('单选时也不会去动别人', resolveDragMove(root(), ga, [ga]).ids.sort(), subtreeIds(root(), ga).sort())

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
  eq('同级插值类的非法落点', blockReasonOf(root(), ga, gb, 'before'), '这里不能落')

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
  eq('零尺寸矩形不会除零', zoneOf({ x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0 }, rightward), 'child')

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
    (find(kRoot.id)?.children ?? []).filter((topic) => kNamed.has(topic.id)).map((topic) => topic.title)

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
  eq('落在 c1 与 c2 的空隙里 → 插到 c1 后面', nearestSiblingGap(stacks, { x: 50, y: 65 })?.targetId, 'c1')
  eq('落在 c2 与 c3 的空隙里 → 插到 c2 后面', nearestSiblingGap(stacks, { x: 50, y: 165 })?.targetId, 'c2')
  eq('带回正确的父级', nearestSiblingGap(stacks, { x: 50, y: 65 })?.parentId, 'p')
  check('空隙边缘附近也能命中', nearestSiblingGap(stacks, { x: 50, y: 76 }) !== null)
  check('离空隙太远就不算（交给自由摆放）', nearestSiblingGap(stacks, { x: 50, y: 500 }) === null)
  check('横向偏离太远也不算', nearestSiblingGap(stacks, { x: 900, y: 65 }) === null)
  check('只有一个子节点时没有空隙', nearestSiblingGap([{ parentId: 'p', children: [gapStack.children[0]] }], { x: 50, y: 15 }) === null)
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
  check('离所有节点都很远 → 才允许自由摆放', closestNodeWithin(snapNodes, { x: 900, y: 900 }, new Set()) === null)
  check('被拖的子树不参与吸附', closestNodeWithin(snapNodes, { x: 50, y: 15 }, new Set(['n1']))?.id === 'n2')
  check('空列表不会崩', closestNodeWithin([], { x: 0, y: 0 }, new Set()) === null)
  eq('贴着矩形内也算 0 距离', distanceToRect({ x: 0, y: 0 }, { x: 0, y: 0, width: 10, height: 10 }), 0)

  const otherStack: SiblingStack = {
    parentId: 'q',
    children: [
      { id: 'd1', rect: { x: 400, y: 0, width: 100, height: 30 } },
      { id: 'd2', rect: { x: 400, y: 60, width: 100, height: 30 } }
    ]
  }
  eq('多个堆时取最近的那个', nearestSiblingGap([gapStack, otherStack], { x: 450, y: 45 })?.targetId, 'd1')

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
  eq('指针落在本体上时优先本体', nearestInRegion([bandA, bandB], { x: 50, y: 20 }, new Set())?.id, 'A')
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
    (find(bRoot.id)?.children ?? []).filter((topic) => bNamed.has(topic.id)).map((topic) => topic.title)

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
  // 把带偏移的主题拖到另一个落点上时，偏移必须清掉：
  // 否则它会落在"自动布局位置 + 偏移"的地方，也就是落点预览画在一处、松手却在另一处。
  const dropHost = addChildOf(rootId, '落点宿主')
  store().dropNode(b1, dropHost, 'child')
  check('落到新父级后清掉自由偏移', find(b1)?.position === undefined, JSON.stringify(find(b1)?.position))
  check('确实换了父级', findParent(root(), b1)?.id === dropHost)
  store().undo()
  eq('撤销后偏移也回来了', find(b1)?.position, { x: 15, y: -15 })

  store().clearPosition(b1)
  check('恢复自动布局清空偏移', find(b1)?.position === undefined)

  // 整张画布一起恢复：自由摆放的主题多了以后，一个个恢复太慢
  store().offsetPosition(b1, 30, 0)
  store().offsetPosition(dropHost, -20, 10)
  eq('统计出 2 个自由摆放的主题', store().clearAllPositions(), 2)
  check('全部放回自动布局', find(b1)?.position === undefined && find(dropHost)?.position === undefined)
  eq('没有自由摆放时返回 0 且不写历史', store().clearAllPositions(), 0)
  store().undo()
  check('整批恢复可以一次撤销', find(b1)?.position !== undefined || find(dropHost)?.position !== undefined)

  // 统计
  check('字数统计可用', countCharacters(root()) > 0, String(countCharacters(root())))
}

/* ------------------------------------------------------------------ */
/* 8.5c 「直接打字即编辑」注入字符的寄存（输入法让位用）                 */
/* ------------------------------------------------------------------ */

function testTypedChar(): void {
  group('直接打字：注入字符的寄存')
  stageTypedChar('n1', 'w')
  eq('同一节点可取回', takeTypedChar('n1'), 'w')
  eq('取走即清空', takeTypedChar('n1'), null)

  stageTypedChar('n1', 'w')
  eq('换了节点就不认', takeTypedChar('n2'), null)
  eq('认错一次即作废，不会再落进别的节点', takeTypedChar('n1'), null)

  stageTypedChar('n1', '字')
  clearTypedChar()
  eq('显式放弃后取不回', takeTypedChar('n1'), null)

  stageTypedChar('a', ' ')
  eq('空格也能原样回放（由上层决定落不落）', takeTypedChar('a'), ' ')
}

/* ------------------------------------------------------------------ */
/* 8.5e 分支级结构：分支自己声明的结构要真正生效                        */
/* ------------------------------------------------------------------ */

function testBranchStructure(): void {
  group('分支级结构')
  reset()
  const rootId = root().id
  const a = addChildOf(rootId, '逻辑分支')
  const b = addChildOf(rootId, '组织分支')
  const c = addChildOf(rootId, '鱼骨分支')
  const a1 = addChildOf(a, '甲')
  const b1 = addChildOf(b, '乙一')
  const b2 = addChildOf(b, '乙二')
  const c1 = addChildOf(c, '丙一')
  const c2 = addChildOf(c, '丙二')

  store().setStructure('org.xmind.ui.logic.right', rootId)
  store().setStructure('org.xmind.ui.org-chart.down', b)
  store().setStructure('org.xmind.ui.fishbone.leftHeaded', c)

  const layout = layoutSheet(root(), fakeMeasure)
  const boxA = layout.nodeMap.get(a)!
  const boxB = layout.nodeMap.get(b)!
  const boxC = layout.nodeMap.get(c)!
  const nodeA1 = layout.nodeMap.get(a1)!
  const nodeB1 = layout.nodeMap.get(b1)!
  const nodeB2 = layout.nodeMap.get(b2)!
  const nodeC1 = layout.nodeMap.get(c1)!
  const nodeC2 = layout.nodeMap.get(c2)!

  const mine = [rootId, a, b, c, a1, b1, b2, c1, c2]
  check(
    '新建的主题都进了布局',
    mine.every((id) => layout.nodeMap.has(id)),
    String(layout.nodes.length) + ' 个节点'
  )
  check('没声明结构的分支：子节点仍在右侧', nodeA1.x > boxA.x + boxA.width - 1)
  check('组织架构分支：子节点排到下方', nodeB1.y > boxB.y + boxB.height - 1)
  check('组织架构分支：两个子节点同排', Math.abs(nodeB1.y - nodeB2.y) < 2)
  check(
    '鱼骨分支：子节点分居主脊上下',
    nodeC1.y < boxC.y && nodeC2.y > boxC.y,
    `${Math.round(nodeC1.y)} / ${Math.round(nodeC2.y)} vs ${Math.round(boxC.y)}`
  )
}

/* ------------------------------------------------------------------ */
/* 8.5f 分支级结构：矩阵 / 括号 / 时间轴 / 树状表格                     */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 8.5g 撤销保留框选 / 恢复自动布局                                    */
/* ------------------------------------------------------------------ */

function testUndoSelectionAndRelayout(): void {
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
  store().relayoutAll()
  check('恢复布局后偏移清空', findTopic(root(), a)?.position === undefined)
  eq('恢复布局不动选择', store().selection, [a])
  store().undo()
  check('恢复布局可撤销（偏移回来了）', findTopic(root(), a)?.position !== undefined)
  eq('撤销恢复布局也不丢选择', store().selection, [a])
}

/* ------------------------------------------------------------------ */
/* 8.5h 布局正确性：自动布局绝不允许节点重叠                            */
/* ------------------------------------------------------------------ */

/** 模拟真实测量的「多行换行」：宽度封顶、行数随标题长度增长 */
const multilineMeasure = (topic: Topic, depth: number): MeasureResult => {
  const base = fakeMeasure(topic, depth)
  const maxTextWidth = depth === 0 ? 320 : 240
  const textWidth = 90 + topic.title.length * 9
  const lines = Math.max(1, Math.ceil(textWidth / maxTextWidth))
  return {
    ...base,
    width: Math.max(Math.min(textWidth, maxTextWidth) + base.paddingX * 2, 76),
    height: (depth === 0 ? 44 : 30) + (lines - 1) * base.lineHeight
  }
}

/** 两个节点盒是否相交（各收缩 1px 容忍取整误差） */
function boxesOverlap(a: NodeLayout, b: NodeLayout): boolean {
  return (
    a.x + 1 < b.x + b.width &&
    b.x + 1 < a.x + a.width &&
    a.y + 1 < b.y + b.height &&
    b.y + 1 < a.y + a.height
  )
}

/** 全树两两检查节点盒，返回第一对相交的节点（无则 null） */
function firstOverlap(layout: LayoutResult): [string, string] | null {
  for (let i = 0; i < layout.nodes.length; i += 1) {
    for (let j = i + 1; j < layout.nodes.length; j += 1) {
      if (boxesOverlap(layout.nodes[i], layout.nodes[j])) {
        return [
          `${layout.nodes[i].topic.title}(${Math.round(layout.nodes[i].x)},${Math.round(layout.nodes[i].y)})`,
          `${layout.nodes[j].topic.title}(${Math.round(layout.nodes[j].x)},${Math.round(layout.nodes[j].y)})`
        ]
      }
    }
  }
  return null
}

function testLayoutNoOverlap(): void {
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

  // 分支级组合：逻辑图根 + 分支各自声明鱼骨 / 组织架构 / 矩阵
  reset()
  const rootId = root().id
  const f = addChildOf(rootId, `鱼骨分支：${titles[0]}`)
  const o = addChildOf(rootId, `组织分支：${titles[3]}`)
  const m = addChildOf(rootId, `矩阵分支：${titles[2]}`)
  for (const [parent, count] of [
    [f, 3],
    [o, 2],
    [m, 3]
  ] as const) {
    for (let i = 1; i <= count; i += 1) addChildOf(parent, `子项 ${i}：${titles[2]}`)
  }
  store().setStructure('org.xmind.ui.logic.right', rootId)
  store().setStructure('org.xmind.ui.fishbone.leftHeaded', f)
  store().setStructure('org.xmind.ui.org-chart.down', o)
  store().setStructure('org.xmind.ui.matrix', m)
  const mixed = layoutSheet(root(), multilineMeasure)
  const mixedHit = firstOverlap(mixed)
  check('分支级组合（鱼骨+组织+矩阵）无节点重叠', mixedHit === null, mixedHit ? mixedHit.join(' ⨯ ') : '')
}

/* ------------------------------------------------------------------ */
/* 8.5i Markdown 导出 → 导入往返                                       */
/* ------------------------------------------------------------------ */

function testMarkdownRoundTrip(): void {
  group('Markdown 导出 → 导入往返')
  reset()
  const rootId = root().id
  const plan = addChildOf(rootId, '计划')
  const codeChild = addChildOf(plan, '示例代码')
  const richChild = addChildOf(plan, '忽略我')

  store().mutate((draft) => {
    const codeTopic = findTopic(activeRoot(draft), codeChild)
    if (codeTopic) codeTopic.code = { language: 'ts', text: 'const a = 1\nconst b = 2' }
    const richTopic = findTopic(activeRoot(draft), richChild)
    if (richTopic) {
      richTopic.title = '重点内容'
      richTopic.titleRich = {
        paragraphs: [{ runs: [{ text: '重点', bold: true }, { text: '内容' }] }]
      }
    }
  }, '造往返测试数据')
  store().setHref(plan, 'https://example.com/doc')
  store().setNotes(plan, '这是备注')
  // 公式也要能往返（导出 $$…$$，导入回节点公式）
  store().mutate((draft) => {
    const topic = findTopic(activeRoot(draft), codeChild)
    if (topic) topic.formula = 'E=mc^2'
  }, '加公式')

  const md = toMarkdown(root())
  check('代码围栏带语言标注', md.includes('```ts'))
  check('公式导出为 $$…$$', md.includes('$$E=mc^2$$'))
  check('链接导出为 Markdown 链接', md.includes('[计划](https://example.com/doc)'))

  const parsed = parseMarkdownOutline(md)
  // 默认文档自带两个分支，按标题定位「计划」而不是按下标
  const importedPlan = parsed.root?.children.find((child) => child.title === '计划')
  eq('往返：根标题一致', parsed.root?.title, root().title)
  eq('往返：链接挂回节点', importedPlan?.href, 'https://example.com/doc')
  eq('往返：备注保留', importedPlan?.notes, '这是备注')
  const importedCode = importedPlan?.children.find((child) => child.code)
  eq('往返：代码块挂回原节点', importedCode?.title, '示例代码')
  eq('往返：代码块语言', importedCode?.code?.language, 'ts')
  eq('往返：代码块内容', importedCode?.code?.text, 'const a = 1\nconst b = 2')
  eq(
    '往返：公式回到节点',
    importedPlan?.children.find((child) => child.formula)?.formula,
    'E=mc^2'
  )
  const importedRich = importedPlan?.children.find((child) => child.rich)
  check('往返：粗体进富文本', importedRich?.rich?.paragraphs[0]?.runs[0]?.bold === true)
  eq('往返：节点数一致', parsed.count, countTopics(root()))
}

function testBranchFamiliesMore(): void {
  group('分支级结构：矩阵 / 括号 / 时间轴 / 树状表格')
  reset()
  const rootId = root().id
  const m = addChildOf(rootId, '矩阵分支')
  const b = addChildOf(rootId, '括号分支')
  const t = addChildOf(rootId, '时间轴分支')
  const s = addChildOf(rootId, '表格分支')
  const m1 = addChildOf(m, '格一')
  const m2 = addChildOf(m, '格二')
  const m3 = addChildOf(m, '格三')
  const b1 = addChildOf(b, '括甲')
  const s1 = addChildOf(s, '列甲')
  const s11 = addChildOf(s1, '甲一')
  const t1 = addChildOf(t, '刻一')
  const t2 = addChildOf(t, '刻二')

  store().setStructure('org.xmind.ui.logic.right', rootId)
  store().setStructure('org.xmind.ui.matrix', m)
  store().setStructure('org.xmind.ui.brace.right', b)
  store().setStructure('org.xmind.ui.timeline.horizontal', t)
  store().setStructure('org.xmind.ui.spreadsheet', s)

  const layout = layoutSheet(root(), fakeMeasure)
  const n = (id: string): NodeLayout => {
    const item = layout.nodeMap.get(id)
    if (!item) throw new Error(`节点 ${id} 不在布局里`)
    return item
  }

  check('全部进布局', [m, b, t, s, m1, m2, m3, b1, s1, s11, t1, t2].every((id) => layout.nodeMap.has(id)))
  // 矩阵：两列网格——三个格子里恰有两个同列（x 相同、y 不同），第三个在更右的一列
  {
    const xs = [n(m1).x, n(m2).x, n(m3).x]
    const left = Math.min(...xs)
    const sameColumn = xs.filter((x) => Math.abs(x - left) < 2)
    check(
      '矩阵：两列网格',
      new Set(xs.map((x) => Math.round(x))).size === 2 && sameColumn.length === 2,
      JSON.stringify(xs.map((x, i) => ({ x, y: [n(m1).y, n(m2).y, n(m3).y][i] })))
    )
  }
  // 括号：父子边被括号取代，括号是结构装饰线
  check('括号：不再画父子边', !layout.edges.some((edge) => edge.toId === b1))
  check('括号：有括号装饰线', layout.decorations.some((d) => d.branchId === b))
  // 时间轴：刻目沿主脊上下交替
  check('时间轴：刻目分居主脊上下', n(t1).y < n(t).y && n(t2).y > n(t).y)
  // 树状表格：列头行在分支下方，后代沿缩进列往下
  check('表格：列头在分支下方', n(s1).y > n(s).y + n(s).height - 1)
  check('表格：后代在列头下方', n(s11).y > n(s1).y + n(s1).height - 1)
}

/* ------------------------------------------------------------------ */
/* 8.5d 「从文件管理器打开」：命令行参数识别                             */
/* ------------------------------------------------------------------ */

function testPickDocumentArg(): void {
  group('从文件管理器打开：命令行参数识别')
  const exists = (path: string): boolean =>
    path === 'D:\\A\\plan.xmind' || path === 'D:\\B\\灵感.emmx'

  eq('认出 .xmind', pickDocumentArg(['Mind.exe', 'D:\\A\\plan.xmind'], exists), 'D:\\A\\plan.xmind')
  eq('也认 .emmx', pickDocumentArg(['Mind.exe', 'D:\\B\\灵感.emmx'], exists), 'D:\\B\\灵感.emmx')
  eq('文件不存在就不认', pickDocumentArg(['Mind.exe', 'D:\\A\\missing.xmind'], exists), null)
  eq('没有文档参数时返回 null', pickDocumentArg(['electron.exe', '.'], exists), null)
  eq(
    '跳过开关参数',
    pickDocumentArg(['-r', '--inspect', 'D:\\A\\plan.xmind'], exists),
    'D:\\A\\plan.xmind'
  )
  eq('exe 自己不会被当作文档', pickDocumentArg(['D:\\Mind\\Mind.exe'], exists), null)
  eq('别的格式不认', pickDocumentArg(['D:\\A\\notes.txt'], exists), null)
  eq(
    '同时给了多个就取最后一个（用户双击的那个）',
    pickDocumentArg(['Mind.exe', 'D:\\A\\plan.xmind', 'D:\\B\\灵感.emmx'], exists),
    'D:\\B\\灵感.emmx'
  )
}

/* ------------------------------------------------------------------ */
/* 8.5b 视角锁定（视图状态，与文档内容无关）                            */
/* ------------------------------------------------------------------ */

function testViewLock(): void {
  group('视角锁定')
  reset()
  check('默认不锁定', store().viewLock === false)
  eq('打开时返回新状态', store().toggleViewLock(), true)
  check('已锁定', store().viewLock === true)
  eq('再切一次即关掉', store().toggleViewLock(), false)
  check('已解锁', store().viewLock === false)

  // 它是"视图状态"：只影响看，不该污染文档
  const dirty = store().dirty
  const undo = store().undoStack.length
  store().setViewLock(true)
  check('锁定不写撤销栈', store().undoStack.length === undo)
  check('锁定不影响「未保存」标记', store().dirty === dirty)

  // 新建 / 打开文档按「设置 → 默认视角锁定」起手
  store().newDocument()
  check('新建文档按设置里的默认值起手', store().viewLock === store().appSettings.defaultViewLock)
  store().setAppSettings({ ...store().appSettings, defaultViewLock: true })
  store().newDocument()
  check('默认开启时新文档直接锁定', store().viewLock === true, String(store().viewLock))
  store().setAppSettings({ ...store().appSettings, defaultViewLock: false })
  store().newDocument()
  check('默认关闭时新文档不锁定', store().viewLock === false)
  store().setViewLock(false)
  check('可以显式关掉', store().viewLock === false)
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

  group('富文本：末尾追加（选中主题后直接打字的入口）')
  eq('追加到单段落末尾', plainTextOf(appendToRich(richFromPlain('abc'), ' ')), 'abc ')
  eq('多段落时追加到最后一段', plainTextOf(appendToRich(richFromPlain('a\nb'), 'x')), 'a\nbx')
  eq('空文本也能追加', plainTextOf(appendToRich(richFromPlain(''), '字')), '字')
  check(
    '追加不会覆盖原有文字（误按键不会把标题冲掉）',
    plainTextOf(appendToRich(richFromPlain('别删我'), 'x')).startsWith('别删我')
  )
  check(
    '追加的 run 不继承上一段格式',
    appendToRich({ paragraphs: [{ runs: [{ text: 'a', bold: true }] }] }, 'b').paragraphs[0].runs[1]
      ?.bold === undefined
  )

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

  const markerIds = topic.markers.map((marker) => marker.markerId).filter((id) => id.length > 0)
  const markerStrip = markerStripSize(markerIds.length)
  const stripWidth = markerStrip.width > 0 ? markerStrip.width + MARKER_STRIP_GAP : 0

  // 手动拉伸的语义与 measure.ts 一致：宽度取给定值（有下限），高度只作下限；
  // 图片也按同一套边界等比缩放
  const override = topic.sizeOverride
  const paddingX = depth === 0 ? 24 : 14
  const paddingY = depth === 0 ? 15 : 9
  const imageBounds = override
    ? {
        width: Math.max(24, override.width - paddingX * 2 - stripWidth),
        height: Math.max(24, override.height - paddingY * 2 - 24)
      }
    : undefined
  const imageBox = imageBoxSize(topic.image, imageBounds)

  // 标记条挂在盒外，不占节点宽度
  const autoWidth = Math.max(90 + topic.title.length * 9, imageBox.width)
  const autoHeight = Math.max(
    (depth === 0 ? 44 : 30) + accessory.height + labelRow.height + imageBox.height,
    markerStrip.height + paddingY * 2
  )

  return {
    imageBox,
    width: override ? Math.max(override.width, stripWidth + paddingX * 2 + 40) : autoWidth,
    height: override ? Math.max(override.height, autoHeight) : autoHeight,
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
    markerStrip: { markerIds, width: markerStrip.width, height: markerStrip.height },
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

  // 新建导图默认是「逻辑图（向右）」这种单侧结构；本组要验证的是**平衡图**的左右分配，
  // 所以这里显式把结构切回思维导图（平衡）。
  store().setStructure('org.xmind.ui.map.unbalanced')

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
    // 手动拉伸的尺寸覆盖也要能往返（P7）
    target.sizeOverride = { width: 260, height: 96 }

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

  group('代码块：尺寸规则')

  eq('没有代码时尺寸为 0', codeBoxSize(undefined), { width: 0, height: 0 })
  const oneLine = codeBoxSize({ language: 'ts', text: 'const a = 1' })
  const lineH = Math.round(CODE_FONT_SIZE * CODE_LINE_RATIO)
  eq(
    '单行高度 = 语言标签 + 上下内边距 + 一行',
    oneLine.height,
    CODE_HEADER + CODE_PADDING_Y * 2 + lineH
  )
  eq(
    '宽度按等宽字符数估算',
    oneLine.width,
    Math.round(11 * CODE_FONT_SIZE * 0.6) + CODE_PADDING_X * 2
  )
  const many = codeBoxSize({
    language: '',
    text: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
  })
  check(
    '行数封顶，节点不会无限变高',
    many.height === CODE_HEADER + CODE_PADDING_Y * 2 + CODE_MAX_LINES * lineH,
    JSON.stringify(many)
  )
  const longLine = codeBoxSize({ language: '', text: 'x'.repeat(200) })
  check('超宽行受宽度上限约束', longLine.width <= 320, JSON.stringify(longLine))
  const cjk = codeBoxSize({ language: '', text: '中文变量名测试' })
  const ascii = codeBoxSize({ language: '', text: 'abcdefgabcdefg' })
  check(
    'CJK 记双宽：7 个中文字符 == 14 个 ASCII 字符',
    cjk.width === ascii.width && cjk.width > 96,
    `${cjk.width} vs ${ascii.width}`
  )
  const empty = codeBoxSize({ language: 'text', text: '' })
  check('空文本也保留一行的最小框', empty.height === CODE_HEADER + CODE_PADDING_Y * 2 + lineH, JSON.stringify(empty))

  group('手动拉伸：尺寸覆盖只作下限、可撤销、往返保真')

  reset()
  const sizeRoot = root().id
  const resized = addChildOf(sizeRoot, '被拉伸的节点')
  const autoBox = layoutSheet(root(), fakeMeasure).nodeMap.get(resized)!
  store().setSizeOverride(resized, { width: 320, height: 140 })
  const resizedBox = layoutSheet(root(), fakeMeasure).nodeMap.get(resized)!
  eq('宽度按给定值', resizedBox.width, 320)
  eq('高度按给定值（高于内容时）', resizedBox.height, 140)
  check('比自动尺寸更大', resizedBox.width > autoBox.width && resizedBox.height > autoBox.height)
  store().setSizeOverride(resized, { width: 320, height: 20 })
  const floorBox = layoutSheet(root(), fakeMeasure).nodeMap.get(resized)!
  check(
    '高度只作下限：给太小也不会裁掉内容',
    floorBox.height >= autoBox.height,
    `${floorBox.height} vs ${autoBox.height}`
  )
  store().setSizeOverride(resized, null)
  const restored = layoutSheet(root(), fakeMeasure).nodeMap.get(resized)!
  eq('恢复自动尺寸', restored.width, autoBox.width)
  store().undo()
  check('恢复自动尺寸可撤销', findTopic(root(), resized)?.sizeOverride !== undefined)

  group('手动拉伸：图片跟着等比缩放')

  reset()
  const imgRoot = root().id
  const imgNode = addChildOf(imgRoot, '带图节点')
  store().mutate((draft) => {
    const topic = findTopic(activeRoot(draft), imgNode)
    if (topic) topic.image = { path: 'resources/a.png', width: 400, height: 300 }
  }, '加图片')
  const autoImage = layoutSheet(root(), fakeMeasure).nodeMap.get(imgNode)!.imageBox!
  eq('默认不放大（按上限缩到 220×165）', autoImage, { width: 220, height: 165 })

  store().setSizeOverride(imgNode, { width: 560, height: 320 })
  const grown = layoutSheet(root(), fakeMeasure).nodeMap.get(imgNode)!.imageBox!
  check('拉伸后图片变大', grown.width > autoImage.width && grown.height > autoImage.height, JSON.stringify(grown))
  check(
    '仍然保持 4:3 比例',
    Math.abs(grown.width / grown.height - 4 / 3) < 0.05,
    `${grown.width}×${grown.height}`
  )
  check('不会超出节点可用宽度', grown.width <= 560 - 14 * 2, String(grown.width))

  store().setSizeOverride(imgNode, { width: 180, height: 180 })
  const shrunk = layoutSheet(root(), fakeMeasure).nodeMap.get(imgNode)!.imageBox!
  check('缩小节点时图片跟着变小', shrunk.width < autoImage.width, JSON.stringify(shrunk))

  group('默认对齐：渲染兜底值')

  eq('初始默认是居中', defaultTextAlignOf(), 'center')
  setDefaultTextAlign('left')
  eq('设置后立即生效', defaultTextAlignOf(), 'left')
  setDefaultTextAlign('right')
  eq('可以改成右对齐', defaultTextAlignOf(), 'right')
  setDefaultTextAlign('center')
  eq('改回居中', defaultTextAlignOf(), 'center')

  group('概要：可选中、可改字体、空文字仍可点（一等公民）')

  {
    // 纯函数：标题样式读写往返
    const styled = withOverlayTextStyle(undefined, {
      fontSize: 18,
      bold: false,
      italic: true,
      color: '#EB5757'
    })
    const read = readOverlayTextStyle(styled, { fontSize: 13, bold: true })
    eq('字号写进去读得回来', read.fontSize, 18)
    eq('显式取消加粗', read.bold, false)
    eq('斜体', read.italic, true)
    eq('颜色', read.color, '#EB5757')
    eq('Xmind 风格的 14px 也能读', readOverlayFontSize({ properties: { 'fo:font-size': '14px' } }, 13), 14)
    eq(
      '恢复默认后样式被清空',
      withOverlayTextStyle(styled, { fontSize: 0, bold: undefined, italic: false, color: '' }),
      undefined
    )
    eq('没写过样式就用元素默认值', readOverlayTextStyle(undefined, { fontSize: 13, bold: true }).bold, true)

    // 空标题也要有可点区域（否则删空文字就再也点不到概要）
    const emptySize = estimateOverlayLabelSize('', 13)
    check('空标题也给一块命中区', emptySize.width > 0 && emptySize.height > 0, JSON.stringify(emptySize))
    check(
      '多行标题的命中区更高',
      estimateOverlayLabelSize('一行\n两行', 13).height > emptySize.height
    )

    // 布局 + 选中 + 改样式 + 撤销 + 删除
    reset()
    const ovRoot = root().id
    const ovA = addChildOf(ovRoot, '甲')
    const ovB = addChildOf(ovRoot, '乙')
    store().select(ovA)
    store().select(ovB, true)
    const ovSummary = store().addSummary()
    check('概要创建成功', typeof ovSummary === 'string', String(ovSummary))
    // 注意：画布元素（概要/边界/关系线）要**把 sheet 传进去**才参与布局
    const ovLayout = layoutSheet(root(), fakeMeasure, {}, store().workbook.sheets[0])
    if (!ovSummary) return
    const ovNode = ovLayout.summaries.find((item) => item.id === ovSummary)!
    if (!ovNode) return
    check('概要带包围盒（命中与选中框用）', Boolean(ovNode.bounds && ovNode.bounds.width > 0))
    check('概要带文字块尺寸', Boolean(ovNode.labelSize && ovNode.labelSize.height > 0))

    store().selectOverlay('summary', ovSummary)
    eq('画布元素可被选中', store().selectedOverlay?.kind, 'summary')
    eq('选中的是这条概要', store().selectedOverlay?.id, ovSummary)

    store().setOverlayStyle('summary', ovSummary, { fontSize: 20 })
    const styledSummary = activeSheet(store().workbook).summaries.find((item) => item.id === ovSummary)!
    eq('字号写进了概要样式', readOverlayFontSize(styledSummary.style, 13), 20)
    store().undo()
    const undone = activeSheet(store().workbook).summaries.find((item) => item.id === ovSummary)!
    eq('改字体可撤销', readOverlayFontSize(undone.style, 13), 13)

    store().select(ovA)
    eq('选中主题会取消画布元素的选中', store().selectedOverlay === null, true)

    store().selectOverlay('summary', ovSummary)
    store().deleteSelection()
    eq('选中后 Delete 删除这条概要', activeSheet(store().workbook).summaries.length, 0)
    eq('删除后清掉选中态', store().selectedOverlay === null, true)
  }

  group('概要标题：支持换行')

  eq('单行标题就是一行', overlayTitleLines('概要').length, 1)
  eq('显式换行拆成多行', overlayTitleLines('第一行\n第二行').length, 2)
  eq('空行也保留（不影响对齐）', overlayTitleLines('甲\n\n乙').length, 3)
  eq('空标题没有行', overlayTitleLines(undefined).length, 0)
  {
    // 多行标题要把占据高度算进画布边界，否则换行文字会跑出边界
    reset()
    const wrapRoot = root().id
    const wrapA = addChildOf(wrapRoot, '甲')
    addChildOf(wrapRoot, '乙')
    store().select(wrapA)
    store().select(findTopic(root(), wrapRoot)!.children[1].id, true)
    const summaryId = store().addSummary()
    store().setSummaryTitle(summaryId!, '第一行\n第二行\n第三行')
    // 传 sheet，概要才会真正参与布局（否则这里等于空跑）
    const single = layoutSheet(root(), fakeMeasure, {}, store().workbook.sheets[0])
    const summary = single.summaries.find((item) => item.id === summaryId)!
    check('换行断言用的概要确实在布局里', Boolean(summary), String(single.summaries.length))
    store().setSummaryTitle(summaryId!, '第一行')
    const oneLine = layoutSheet(root(), fakeMeasure, {}, store().workbook.sheets[0])
    check(
      '多行概要会撑高画布边界',
      single.bounds.height >= oneLine.bounds.height,
      `${single.bounds.height} vs ${oneLine.bounds.height}`
    )
  }

  group('标记条：标记竖排在节点左侧（不再占顶部图标行）')

  reset()
  const stripRoot = root().id
  const marked = addChildOf(stripRoot, '带标记的节点')
  const plain = addChildOf(stripRoot, '没有标记的节点')
  store().mutate((draft) => {
    const topic = findTopic(activeRoot(draft), marked)
    if (!topic) return
    topic.markers = [{ markerId: 'priority-1' }, { markerId: 'priority-2' }]
  }, '加标记')
  const stripLayout = layoutSheet(root(), fakeMeasure)
  const markedBox = stripLayout.nodeMap.get(marked)!
  const plainBox = stripLayout.nodeMap.get(plain)!
  eq('标记条列出全部标记', markedBox.markerStrip?.markerIds.length, 2)
  eq('标记条挂在盒外：节点宽度不被撑宽', markedBox.width, 90 + '带标记的节点'.length * 9)
  check('标记不再出现在顶部图标行', markedBox.accessory.items.every((item) => item.kind !== 'marker'))
  check('无标记的节点没有标记条', (plainBox.markerStrip?.markerIds.length ?? 0) === 0)
  eq('标记条尺寸与分列规则一致', markedBox.markerStrip?.width, markerStripSize(2).width)
  check(
    '标记很多时最多两列（不会盖到隔壁）',
    markerStripSize(10).width <= 2 * 16 + 3,
    JSON.stringify(markerStripSize(10))
  )
  check('标记很多时往高度涨', markerStripSize(10).height > markerStripSize(4).height)

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
  check('空包给出可读错误', message.includes('既没有 content.json、content.xml'), message)
}

/* ------------------------------------------------------------------ */
/* 12.8 大纲：摊平与导出                                               */
/* ------------------------------------------------------------------ */

function buildOutlineSample(): Workbook {
  const workbook = createWorkbook({ rootTitle: '产品规划', seedBranches: [] })
  const root = workbook.sheets[0].rootTopic
  const mk = (title: string): Topic => createTopic(title)
  const market = mk('市场分析')
  market.children = [mk('目标用户'), mk('竞品对比')]
  market.notes = '第一行\n第二行'
  const design = mk('产品设计')
  design.labels = ['重点']
  design.markers = [{ markerId: 'priority-1' }]
  design.href = 'https://example.com'
  design.collapsed = true
  design.children = [mk('信息架构')]
  const launch = mk('上线运营')
  launch.attachments = [{ id: 'att-1', path: 'resources/a.pdf', name: 'a.pdf' }]
  launch.image = { path: 'resources/b.png', width: 100, height: 60 }
  launch.formula = 'E = mc^2'
  market.children[0].children = [mk('画像')]
  root.children = [market, design, launch]
  root.detachedChildren = [mk('浮动想法')]
  return workbook
}

function testOutline(): void {
  group('大纲：摊平')

  const workbook = buildOutlineSample()
  const root = activeRoot(workbook)
  const rows = outlineRows(root, { skipCollapsed: true })

  eq('第一行是根主题', rows[0].title, '产品规划')
  eq('第一行深度为 0', rows[0].depth, 0)
  eq('折叠分支的子节点被跳过', rows.some((row) => row.title === '信息架构'), false)
  check('折叠分支自身仍在', rows.some((row) => row.title === '产品设计' && row.collapsed))
  check('有子节点标记正确', rows.find((r) => r.title === '产品设计')?.hasChildren === true)
  check('没有子节点的行不带标记', rows.find((r) => r.title === '竞品对比')?.hasChildren === false)
  check('中间层节点也算有子节点', rows.find((r) => r.title === '目标用户')?.hasChildren === true)
  eq('深度正确', rows.find((r) => r.title === '目标用户')?.depth, 2)
  eq('浮动主题也出现在大纲里', rows.some((row) => row.title === '浮动想法'), true)
  eq('顺序与树一致', rows.map((row) => row.title).slice(0, 6), [
    '产品规划',
    '市场分析',
    '目标用户',
    '画像',
    '竞品对比',
    '产品设计'
  ])

  const all = outlineRows(root)
  eq('不跳过折叠时能看到全部节点', all.some((row) => row.title === '信息架构'), true)
  check('完整行数更多', all.length > rows.length)

  const designRow = rows.find((row) => row.title === '产品设计')
  check('行上带标记数量', designRow?.markerCount === 1)
  check('行上带标签数量', designRow?.labelCount === 1)
  check('行上带超链接标记', designRow?.hasLink === true)
  const launchRow = rows.find((row) => row.title === '上线运营')
  check('行上带附件标记', launchRow?.hasAttachment === true)
  check('行上带图片标记', launchRow?.hasImage === true)
  check('行上带公式标记', launchRow?.hasFormula === true)
  check('行上带备注标记', rows.find((row) => row.title === '市场分析')?.hasNotes === true)

  group('大纲：导出 TXT')

  const txt = toPlainText(root)
  check('TXT 以 BOM 开头（Windows 记事本不乱码）', buildOutline(workbook, 'txt').startsWith('\ufeff'))
  check('TXT 按层级缩进', txt.includes('\r\n  市场分析\r\n    目标用户'), JSON.stringify(txt.slice(0, 80)))
  check('TXT 每行一个主题', txt.trim().split('\r\n').length === all.length)
  check('TXT 包含折叠分支里的节点', txt.includes('信息架构'))
  check('TXT 以换行结尾', txt.endsWith('\r\n'))

  group('大纲：导出 Markdown')

  const md = toMarkdown(root)
  check('Markdown 根主题是一级标题', md.startsWith('# 产品规划\n'))
  check('Markdown 子主题用列表', md.includes('\n- 市场分析'))
  check('Markdown 二级缩进两个空格', md.includes('\n  - 目标用户'))
  check('Markdown 三级缩进四个空格', md.includes('\n    - 画像'))
  check('Markdown 备注写成引用块', md.includes('  > 第一行') && md.includes('  > 第二行'))
  check('Markdown 以换行结尾', md.endsWith('\n'))

  group('大纲：导出 OPML')

  const opml = toOpml(activeSheet(workbook))
  check('OPML 声明版本', opml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">'))
  check('OPML 头部带画布标题', opml.includes('<title>画布 1</title>'))
  check('OPML 用 outline 元素', opml.includes('<outline text="产品规划">'))
  check('OPML 备注写成 _note', opml.includes('_note="第一行 第二行"'))
  check('OPML 超链接写成 _link', opml.includes('_link="https://example.com"'))
  check('OPML 自闭合标签用于叶子节点', opml.includes('<outline text="竞品对比"/>'))
  check('OPML 叶子节点不会被写成带子元素的标签', !opml.includes('<outline text="竞品对比">'))
  check('OPML 结构闭合', (opml.match(/<outline/g) ?? []).length === (opml.match(/<\/outline>/g) ?? []).length + countSelfClosing(opml))

  const special = createTopic('A & B <C> "D"')
  special.children = [createTopic("it's fine")]
  const specialWorkbook = createWorkbook({ rootTitle: '特殊字符' })
  activeRoot(specialWorkbook).children = [special]
  const specialOpml = toOpml(activeSheet(specialWorkbook))
  check('OPML 转义 & < > "', specialOpml.includes('A &amp; B &lt;C&gt; &quot;D&quot;'))
  check('OPML 转义单引号', specialOpml.includes('it&apos;s fine'))

  group('大纲：格式注册与错误处理')

  eq('支持三种格式', OUTLINE_FORMATS.map((item) => item.id), ['txt', 'md', 'opml'])
  eq('扩展名正确', OUTLINE_FORMATS.map((item) => item.ext), ['txt', 'md', 'opml'])
  eq('取格式定义', outlineFormatDef('md').label, 'Markdown')

  let badFormat = ''
  try {
    buildOutline(workbook, 'docx' as OutlineFormat)
  } catch (error) {
    badFormat = (error as Error).message
  }
  check('不支持的格式给出可读错误', badFormat.includes('不支持的导出格式'), badFormat)

  const emptyWorkbook = createWorkbook()
  emptyWorkbook.sheets = []
  let noSheet = ''
  try {
    buildOutline(emptyWorkbook, 'txt')
  } catch (error) {
    noSheet = (error as Error).message
  }
  check('没有画布时给出可读错误', noSheet.includes('没有可导出'), noSheet)
}

/** 统计 OPML 里自闭合的 outline 数量（用于校验标签配对） */
function countSelfClosing(opml: string): number {
  return (opml.match(/<outline [^>]*\/>/g) ?? []).length
}

/* ------------------------------------------------------------------ */
/* 12.9 检索 / 替换 / 筛选 / 统计 / 多画布                             */
/* ------------------------------------------------------------------ */

function testSearch(): void {
  group('搜索：计数与片段')

  eq('统计出现次数', countOccurrences('abcabc', 'abc'), 2)
  eq('默认不区分大小写', countOccurrences('AbC', 'abc'), 1)
  eq('区分大小写时大小写不同就不算命中', countOccurrences('AbC', 'abc', true), 0)
  eq('空关键词返回 0', countOccurrences('abc', ''), 0)
  eq('重叠不算两次（不重叠前进）', countOccurrences('aaaa', 'aa'), 2)
  check('片段带省略号', snippetOf('前面很长的一段文字关键词后面还有很长的一段文字', '关键词', false, 4).includes('关键词'))

  group('搜索：替换')

  eq('替换全部', replaceInText('a-b-a', 'a', 'X').text, 'X-b-X')
  eq('替换次数', replaceInText('a-b-a', 'a', 'X').count, 2)
  eq('替换为空串等于删除', replaceInText('abc', 'b', '').text, 'ac')
  eq('没有命中时原样返回', replaceInText('abc', 'z', 'X').text, 'abc')
  eq('没有命中时次数为 0', replaceInText('abc', 'z', 'X').count, 0)
  eq('替换内容含特殊字符不被当成模式', replaceInText('a.a', '.', '$1').text, 'a$1a')
  eq('空关键词不动文本', replaceInText('abc', '', 'X').text, 'abc')

  group('搜索：在工作簿里查')

  reset()
  const sRoot = root().id
  const a = addChildOf(sRoot, '设计评审')
  const b = addChildOf(sRoot, '评审记录')
  const c = addChildOf(sRoot, '无关主题')
  store().setNotes(a, '评审要点：先看交互')
  store().addLabel(b, '评审')
  store().setTitle(c, '设计草稿')

  const byTitle = searchWorkbook(store().workbook, '评审')
  eq('标题命中两个节点', byTitle.filter((hit) => hit.field === 'title').map((hit) => hit.title), ['设计评审', '评审记录'])
  eq('默认不搜备注', byTitle.some((hit) => hit.field === 'notes'), false)
  eq('默认不搜标签', byTitle.some((hit) => hit.field === 'label'), false)

  const withNotes = searchWorkbook(store().workbook, '要点', { inNotes: true })
  eq('打开备注后能命中备注', withNotes.map((hit) => hit.field), ['notes'])
  eq('备注命中的节点正确', withNotes[0].topicId, a)

  const withLabels = searchWorkbook(store().workbook, '评审', { inLabels: true })
  check('打开标签后能命中标签', withLabels.some((hit) => hit.field === 'label'))
  eq('命中集合去重', hitTopicIds(withLabels).size, 2)

  eq('空关键词不返回命中', searchWorkbook(store().workbook, '').length, 0)
  eq('命中带层级', searchWorkbook(store().workbook, '设计评审')[0].depth, 1)

  group('搜索：替换落库')

  store().setSearchQuery('评审')
  store().setSearchReplacement('X')
  eq('替换前的命中处数', countTitleMatches(store().workbook, '评审'), 2)
  const replaced = store().replaceAllInTitles()
  eq('替换全部返回处数', replaced, 2)
  eq('标题已被替换', findTopic(activeRoot(store().workbook), a)?.title, '设计X')
  eq('第二个也被替换', findTopic(activeRoot(store().workbook), b)?.title, 'X记录')
  eq('无关主题没被改', findTopic(activeRoot(store().workbook), c)?.title, '设计草稿')
  store().undo()
  eq('Ctrl+Z 能撤销替换', findTopic(activeRoot(store().workbook), a)?.title, '设计评审')

  const oneCount = store().replaceInTopic(c)
  eq('单条替换：没有命中时返回 0', oneCount, 0)
  store().setTitle(c, '设计草稿评审')
  const oneCount2 = store().replaceInTopic(c)
  eq('单条替换：命中时返回处数', oneCount2, 1)
  eq('单条替换结果', findTopic(activeRoot(store().workbook), c)?.title, '设计草稿X')

  group('筛选：按标记与标签')

  reset()
  const fRoot = root().id
  const m1 = addChildOf(fRoot, '高优先级')
  store().toggleMarker(m1, 'priority-1')
  const m2 = addChildOf(fRoot, '低优先级')
  store().toggleMarker(m2, 'priority-5')
  const m3 = addChildOf(fRoot, '带标签的高优先级')
  store().toggleMarker(m3, 'priority-1')
  store().addLabel(m3, '重要')
  const m4 = addChildOf(fRoot, '既无标记也无标签')

  eq('空筛选不算激活', isFilterActive({ markers: [], labels: [] }), false)
  eq('空筛选时全部算命中', applyTopicFilter(activeRoot(store().workbook), { markers: [], labels: [] }).hits.size, 0)

  const byMarker = applyTopicFilter(activeRoot(store().workbook), { markers: ['priority-1'], labels: [] })
  eq('按标记筛选命中两个', byMarker.hits.size, 2)
  check('按标记命中包含 m1', byMarker.hits.has(m1))
  check('按标记命中包含 m3', byMarker.hits.has(m3))
  check('未命中的节点不在保留集合里', !byMarker.keep.has(m4))
  check('根节点被保留（命中节点的祖先）', byMarker.keep.has(fRoot))

  const byTwoMarkers = applyTopicFilter(activeRoot(store().workbook), {
    markers: ['priority-1', 'priority-5'],
    labels: []
  })
  eq('多个标记之间是「或」', byTwoMarkers.hits.size, 3)

  const byMarkerAndLabel = applyTopicFilter(activeRoot(store().workbook), {
    markers: ['priority-1'],
    labels: ['重要']
  })
  eq('标记与标签之间是「且」', byMarkerAndLabel.hits.size, 1)
  check('且关系命中 m3', byMarkerAndLabel.hits.has(m3))

  const byLabel = applyTopicFilter(activeRoot(store().workbook), { markers: [], labels: ['重要'] })
  eq('只按标签筛选', byLabel.hits.size, 1)

  const labels = collectLabels(store().workbook)
  eq('收集到的标签', labels.map((item) => [item.label, item.count]), [['重要', 1]])

  group('统计')

  reset()
  const stRoot = root().id
  const s1 = addChildOf(stRoot, '一级甲')
  const s2 = addChildOf(s1, '二级乙')
  addChildOf(s2, '三级丙')
  store().setNotes(s1, '有备注')
  store().addLabel(s2, '标签甲')
  store().toggleMarker(s1, 'priority-1')
  store().toggleMarker(s2, 'priority-1')
  store().toggleMarker(s2, 'star-red')

  const stats = sheetStats(sheet())
  // reset() 建的新文档带「中心主题 + 两个示例分支」，所以这里共 6 个节点
  eq('统计：节点总数', stats.topics, 6)
  eq('统计：与树上的节点数一致', stats.topics, countTopics(activeRoot(store().workbook)))
  eq('统计：最大深度（0 基）', stats.maxDepth, 3)
  eq('统计：叶子数（两个示例分支 + 最深节点）', stats.leaves, 3)
  eq('统计：标题字数', stats.characters, 23)
  eq('统计：含备注节点数', stats.withNotes, 1)
  eq('统计：标记分布', stats.markers, [
    { markerId: 'priority-1', count: 2 },
    { markerId: 'star-red', count: 1 }
  ])
  eq('统计：标签分布', stats.labels.map((item) => [item.label, item.count]), [['标签甲', 1]])
  eq('统计：无附件时计数为 0', stats.withAttachments, 0)

  group('多画布')

  reset()
  eq('默认只有一张画布', store().workbook.sheets.length, 1)
  const newSheetId = store().addSheet()
  eq('新建后有两张画布', store().workbook.sheets.length, 2)
  eq('新建后自动切到新画布', store().workbook.activeSheetId, newSheetId)
  eq('新画布标题', store().workbook.sheets[1].title, '画布 2')
  check('新画布有根主题', Boolean(activeRoot(store().workbook).id))

  const firstId = store().workbook.sheets[0].id
  // 先假装刚保存过，才能验证「切换画布」本身不会把文档标脏
  store().markSaved('D:/tmp/切换测试.xmind')
  eq('切换前不脏', store().dirty, false)
  // 此时的撤销栈里还有前面「新建/改名画布」留下的记录，切换不应再往上加
  const undoBefore = store().undoStack.length
  store().setActiveSheet(firstId)
  eq('切换画布', store().workbook.activeSheetId, firstId)
  eq('切换画布不标记未保存', store().dirty, false)
  eq('切换画布不写入撤销栈', store().undoStack.length, undoBefore)

  store().renameSheet(firstId, '改名后的画布')
  eq('重命名画布', store().workbook.sheets[0].title, '改名后的画布')

  store().removeSheet(firstId)
  eq('删除画布后只剩一张', store().workbook.sheets.length, 1)
  eq('删除当前画布后自动切到另一张', store().workbook.activeSheetId, newSheetId)
  store().removeSheet(newSheetId)
  eq('最后一张画布不允许删除', store().workbook.sheets.length, 1)
}

/* ------------------------------------------------------------------ */
/* 12.10 导出：绘图指令 / SVG / PDF                                     */
/* ------------------------------------------------------------------ */

/** 造一张覆盖各种元素的画布，供导出测试用 */
function buildExportScene(): { layout: ReturnType<typeof layoutSheet>; colors: ReturnType<typeof themeColorsOf> } {
  reset()
  const rootId = root().id
  store().setTitle(rootId, '导出测试')

  const a = addChildOf(rootId, '带标记与标签')
  store().toggleMarker(a, 'priority-1')
  store().toggleMarker(a, 'task-quarter')
  store().addLabel(a, '标签甲')
  store().setNotes(a, '有备注')

  const b = addChildOf(rootId, '带图片与公式')
  store().setImage(b, { path: 'resources/pic.png', width: 120, height: 80 })
  store().setFormula(b, '\\frac{a}{b}')

  const c = addChildOf(b, '子主题')
  store().setTitle(c, '子主题 & <特殊>')

  store().select(a)
  store().toggleMarker(c, 'star-red')

  // 关系线需要按住 Ctrl 选中两个主题，这里直接调动作
  store().select(a)
  const sheetCurrent = sheet()
  void sheetCurrent

  const layout = layoutSheet(root(), fakeMeasure, {}, sheet())
  return { layout, colors: themeColorsOf(store().workbook) }
}

function testExportDrawing(): void {
  group('导出：绘图指令')

  const { layout, colors } = buildExportScene()
  const drawing = buildDrawing({ layout, colors, background: colors.canvas })

  check('画布尺寸来自布局边界', drawing.width === layout.bounds.width && drawing.height === layout.bounds.height)
  eq('背景色透传', drawing.background, colors.canvas)

  const rects = drawing.ops.filter((op) => op.kind === 'rect')
  const paths = drawing.ops.filter((op) => op.kind === 'path')
  const texts = drawing.ops.filter((op) => op.kind === 'lineText')
  const labels = drawing.ops.filter((op) => op.kind === 'text')
  const badges = drawing.ops.filter((op) => op.kind === 'badge')
  const pies = drawing.ops.filter((op) => op.kind === 'pie')
  const glyphs = drawing.ops.filter((op) => op.kind === 'glyph')

  check('每个节点都有一条文字行', texts.length >= layout.nodes.length, `${texts.length} vs ${layout.nodes.length}`)
  check('根节点画成圆角矩形', rects.some((op) => op.kind === 'rect' && op.shadow === true))
  check('一级主题的矩形带边框', rects.some((op) => op.kind === 'rect' && op.stroke !== undefined))
  check('深层节点画下划线（不是矩形）', paths.some((op) => op.kind === 'path' && op.strokeWidth === 2))
  check('连线按分支着色', paths.some((op) => op.kind === 'path' && colors.branches.includes(String(op.stroke))))

  check('优先级标记画成数字徽标', badges.length >= 1)
  eq('徽标文字是优先级数字', badges[0]?.kind === 'badge' ? badges[0].text : '', '1')
  check('进度标记画成饼形', pies.length >= 1)
  check('星标画成图形', glyphs.length >= 1)
  check('标签画成底部胶囊', labels.some((op) => op.kind === 'text' && op.text === '标签甲'))

  const textOf = drawing.ops.find((op) => op.kind === 'lineText' && op.segments.some((s) => s.text.includes('特殊')))
  check('特殊字符原样进入指令（转义交给后端）', Boolean(textOf))

  const formulaOp = drawing.ops.find((op) => op.kind === 'formula')
  check('公式节点生成公式指令', Boolean(formulaOp))
  check('没有位图时公式退回源码', formulaOp?.kind === 'formula' && formulaOp.href === undefined && formulaOp.fallbackText === '\\frac{a}{b}')

  // 有图片资源时使用图片指令，没有时画占位框
  const withoutImage = drawing.ops.filter((op) => op.kind === 'image').length
  eq('没有图片资源时不生成 image 指令', withoutImage, 0)
  const withImage = buildDrawing({
    layout,
    colors,
    background: colors.canvas,
    images: new Map([['resources/pic.png', 'data:image/png;base64,AAAA']])
  })
  check('有图片资源时生成 image 指令', withImage.ops.some((op) => op.kind === 'image'))

  // 透明背景
  const transparent = buildDrawing({ layout, colors, background: null })
  eq('透明背景记为 null', transparent.background, null)

  group('导出：SVG')

  const svg = drawingToSvg(drawing)
  check('SVG 有 XML 声明与命名空间', svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>'))
  check('SVG 带 viewBox', svg.includes(`viewBox="0 0 ${drawing.width} ${drawing.height}"`))
  check('SVG 画了背景矩形', svg.includes(`fill="${colors.canvas}"`))
  check('SVG 含文字元素', svg.includes('<text'))
  check('SVG 含路径元素', svg.includes('<path'))
  check('SVG 定义了投影滤镜', svg.includes('id="node-shadow"'))

  // 用我们自己的 XML 解析器反向校验：生成的 SVG 必须是结构合法的 XML，
  // 否则浏览器/其它软件打开就是一片报错
  const parsedSvg = parseXml(svg)
  check('导出的 SVG 是合法 XML', parsedSvg !== null && parsedSvg.local === 'svg', parsedSvg?.name ?? 'null')
  eq('SVG 根节点的子元素数量大于 0', (parsedSvg?.children.length ?? 0) > 0, true)
  check(
    'SVG 里带特殊字符的文字没有被截断',
    (svg.match(/<text/g) ?? []).length === (svg.match(/<\/text>/g) ?? []).length
  )
  const titleNode = [...(parsedSvg?.children ?? [])].find((child) => child.local === 'text')
  check('解析回来的文字节点带内容', Boolean(titleNode && titleNode.text.length >= 0))

  const transparentSvg = drawingToSvg(transparent)
  check('透明背景的 SVG 不画背景矩形', !transparentSvg.includes('<rect x="0" y="0" width='))

  // 转义：标题里的 & < > 必须变成实体，否则 SVG 直接坏掉
  const escapeScene = buildDrawing({ layout, colors, background: null })
  const escapeSvg = drawingToSvg({
    ...escapeScene,
    ops: [
      {
        kind: 'text',
        x: 0,
        y: 0,
        text: '<a & b> "引号"',
        fontSize: 12,
        fontWeight: 400,
        fill: '#000',
        anchor: 'start',
        baseline: 'middle'
      }
    ]
  })
  check('SVG 转义 & < >（文本内容）', escapeSvg.includes('&lt;a &amp; b&gt;'), escapeSvg.slice(escapeSvg.indexOf('<text'), escapeSvg.indexOf('<text') + 160))
  check('文本内容里的引号保持原样（XML 文本里不需要转义）', escapeSvg.includes('"引号"'))

  // 属性里的 & 必须转义，否则属性被截断
  const attrSvg = drawingToSvg({
    ...escapeScene,
    ops: [
      {
        kind: 'image',
        x: 0,
        y: 0,
        w: 10,
        h: 10,
        href: 'mind-resource://local/a.png?x=1&y=2'
      }
    ]
  })
  check('SVG 转义属性里的 &', attrSvg.includes('href="mind-resource://local/a.png?x=1&amp;y=2"'), attrSvg.match(/href="[^"]*"/)?.[0] ?? '')

  const fallbackSvg = drawingToSvg({
    ...escapeScene,
    ops: [
      {
        kind: 'formula',
        x: 0,
        y: 0,
        w: 40,
        h: 20,
        source: 'x^2',
        fallbackText: 'x^2',
        fontSize: 14,
        color: '#333'
      }
    ]
  })
  check('公式没有位图时在 SVG 里输出源码', fallbackSvg.includes('x^2') && !fallbackSvg.includes('<image'))

  group('导出：PDF')

  // 4x2 像素的假位图：RGB 共 24 字节
  const rgb = new Uint8Array(4 * 2 * 3).fill(128)
  const fakeCompressed = new Uint8Array([1, 2, 3, 4, 5])
  const pdf = buildImagePdf({
    pixelWidth: 4,
    pixelHeight: 2,
    rgb,
    compressed: fakeCompressed,
    rasterScale: 2,
    title: '导出测试'
  })
  const pdfText = new TextDecoder('latin1').decode(pdf)

  check('PDF 以 %PDF- 开头', pdfText.startsWith('%PDF-1.4'))
  check('PDF 以 %%EOF 结尾', pdfText.trimEnd().endsWith('%%EOF'))
  check('PDF 声明图像对象', pdfText.includes('/Subtype /Image'))
  check('PDF 图像尺寸正确', pdfText.includes('/Width 4') && pdfText.includes('/Height 2'))
  check('PDF 使用 FlateDecode', pdfText.includes('/Filter /FlateDecode'))
  check('PDF 的 Length 与实际压缩数据一致', pdfText.includes(`/Length ${fakeCompressed.length}`))
  // 4 像素 / 2 倍率 × 0.75 = 1.5pt；2 像素 → 0.75pt
  check('PDF 页面按倍率换算尺寸', pdfText.includes('/MediaBox [0 0 1.5 0.75]'), pdfText.match(/MediaBox[^\]]*\]/)?.[0] ?? '')
  check('PDF 内容流把图铺满整页', pdfText.includes('q 1.5 0 0 0.75 0 0 cm /Im0 Do Q'))
  check(
    'PDF 中文标题按 UTF-16BE 十六进制写入（不会被截断成乱码）',
    pdfText.includes('/Title <FEFF5BFC51FA6D4B8BD5>'),
    pdfText.match(/\/Title [^/]*/)?.[0] ?? ''
  )
  const asciiPdf = new TextDecoder('latin1').decode(
    buildImagePdf({ pixelWidth: 2, pixelHeight: 2, rgb: new Uint8Array(12), compressed: new Uint8Array(1), title: 'demo' })
  )
  check('PDF 纯 ASCII 标题用字面量写法', asciiPdf.includes('/Title (demo)'))
  check('PDF 标题里的括号会被转义', new TextDecoder('latin1').decode(
    buildImagePdf({ pixelWidth: 2, pixelHeight: 2, rgb: new Uint8Array(12), compressed: new Uint8Array(1), title: 'a(b)c' })
  ).includes('/Title (a\\(b\\)c)'))

  // xref 偏移必须能对上对象起始位置，否则 PDF 阅读器会报错
  const xrefAt = pdfText.indexOf('xref')
  const startxref = Number(pdfText.slice(pdfText.lastIndexOf('startxref') + 9).trim().split(/\s/)[0])
  eq('startxref 指向 xref 表', startxref, xrefAt)
  const offsets = [...pdfText.slice(xrefAt).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]))
  eq('xref 里对象数量正确', offsets.length, 6)
  check(
    '每个对象的偏移都指向 "N 0 obj"',
    offsets.every((offset, index) => pdfText.slice(offset, offset + 12).startsWith(`${index + 1} 0 obj`)),
    offsets.map((offset, index) => `${index + 1}@${offset}:${pdfText.slice(offset, offset + 8)}`).join(' | ')
  )

  let pdfError = ''
  try {
    buildImagePdf({ pixelWidth: 4, pixelHeight: 2, rgb: new Uint8Array(5), compressed: fakeCompressed })
  } catch (error) {
    pdfError = (error as Error).message
  }
  check('PDF：RGB 长度不对时报错', pdfError.includes('长度与尺寸不匹配'), pdfError)

  let pdfZero = ''
  try {
    buildImagePdf({ pixelWidth: 0, pixelHeight: 0, rgb: new Uint8Array(0), compressed: fakeCompressed })
  } catch (error) {
    pdfZero = (error as Error).message
  }
  check('PDF：尺寸为 0 时报错', pdfZero.includes('尺寸非法'), pdfZero)

  group('导出：KaTeX 资源（公式位图用）')

  check('内联字体齐全（20 个 woff2）', KATEX_INLINED_FONTS.length === 20, String(KATEX_INLINED_FONTS.length))
  check('KaTeX 样式里没有未处理的字体路径', !KATEX_INLINE_CSS.includes('url(fonts/'))
  check('KaTeX 样式里字体已内联', KATEX_INLINE_CSS.includes('url(data:font/woff2;base64,'))
  check('KaTeX 样式含关键类名', KATEX_INLINE_CSS.includes('.katex'))
}

/** 导出格式表与倍率 */
function testExportFormats(): void {
  group('导出：格式与选项')

  eq('三种格式', IMAGE_EXPORT_FORMATS.map((item) => item.id), ['png', 'svg', 'pdf'])
  eq('扩展名正确', IMAGE_EXPORT_FORMATS.map((item) => item.ext), ['png', 'svg', 'pdf'])
  check('只有 SVG 不需要倍率', IMAGE_EXPORT_FORMATS.filter((item) => !item.scalable).map((item) => item.id).join(',') === 'svg')
  eq('倍率选项', IMAGE_EXPORT_SCALES, [1, 2, 3, 4])
  eq('取格式定义', imageExportFormatDef('pdf').label, 'PDF 文档')

  let bad = ''
  try {
    imageExportFormatDef('docx' as ImageExportFormat)
  } catch (error) {
    bad = (error as Error).message
  }
  check('未知格式给出可读错误', bad.includes('不支持的导出格式'), bad)
}

/* ------------------------------------------------------------------ */
/* 12.11 AI：配置 / 提示词 / 解析 / 错误翻译                            */
/* ------------------------------------------------------------------ */

function testAi(): void {
  group('AI：配置')

  const defaults = normalizeAiConfig(undefined)
  eq('空配置用默认 BaseURL', defaults.config.baseUrl, DEFAULT_AI_CONFIG.baseUrl)
  eq('空配置用默认模型', defaults.config.model, DEFAULT_AI_CONFIG.model)
  eq('空配置没有 Key', defaults.config.apiKey, '')
  eq('空配置无告警（默认值可用）', defaults.warnings.length, 0)

  const bad = normalizeAiConfig({ baseUrl: 'api.deepseek.com', model: '  ', temperature: 9 })
  eq('缺协议的 BaseURL 回退默认', bad.config.baseUrl, DEFAULT_AI_CONFIG.baseUrl)
  check('缺协议时给出提示', bad.warnings.length === 1, bad.warnings.join('|'))
  eq('空模型名回退默认', bad.config.model, DEFAULT_AI_CONFIG.model)
  eq('温度被夹到上限', bad.config.temperature, 2)
  eq('负温度被夹到 0', normalizeAiConfig({ temperature: -3 }).config.temperature, 0)
  eq('非法温度回退默认', normalizeAiConfig({ temperature: Number.NaN }).config.temperature, DEFAULT_AI_CONFIG.temperature)

  const view = toConfigView({ baseUrl: 'https://x/v1', model: 'm', temperature: 0.5, apiKey: 'sk-abcdef123456' })
  eq('掩码保留前缀与后四位', view.keyPreview, 'sk-…3456')
  check('界面上不出现完整 Key', !JSON.stringify(view).includes('sk-abcdef123456'))
  eq('没 Key 时掩码为 null', toConfigView({ ...DEFAULT_AI_CONFIG }).keyPreview, null)
  eq('短 Key 只显示星号', toConfigView({ ...DEFAULT_AI_CONFIG, apiKey: 'abc' }).keyPreview, '****')

  group('AI：接口地址拼装')

  eq('裸域名补 /v1/chat/completions', chatCompletionsUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions')
  eq('带 /v1 不重复补', chatCompletionsUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions')
  eq('末尾斜杠会被去掉', chatCompletionsUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1/chat/completions')
  eq('完整地址原样使用', chatCompletionsUrl('https://x.com/v1/chat/completions'), 'https://x.com/v1/chat/completions')
  eq('本地端口 + /v1', chatCompletionsUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1/chat/completions')
  eq('智谱 v4 形态', chatCompletionsUrl('https://open.bigmodel.cn/api/paas/v4'), 'https://open.bigmodel.cn/api/paas/v4/chat/completions')
  eq('空串返回空', chatCompletionsUrl('   '), '')

  group('AI：提示词')

  const generate = buildGenerateMessages({ topic: '学会做菜', depth: 4, extra: '面向零基础' })
  eq('生成提示词两条消息', generate.length, 2)
  eq('系统消息要求缩进大纲', generate[0].role, 'system')
  check('系统消息说明只输出大纲', generate[0].content.includes('缩进大纲'))
  check('用户消息带主题', generate[1].content.includes('学会做菜'))
  check('用户消息带层级', generate[1].content.includes('最多 4 层'))
  check('用户消息带补充要求', generate[1].content.includes('面向零基础'))
  check('没写层级时给默认值', buildGenerateMessages({ topic: 'x' })[1].content.includes('最多 3 层'))

  const expand = buildExpandMessages({ title: '市场分析', existing: ['目标用户'], count: 4, notes: '看竞品', path: ['规划', '市场分析'] })
  check('扩写提示词带当前主题', expand[1].content.includes('市场分析'))
  check('扩写提示词带已有子主题（避免重复）', expand[1].content.includes('目标用户'))
  check('扩写提示词带备注', expand[1].content.includes('看竞品'))
  check('扩写提示词带所在分支', expand[1].content.includes('规划 → 市场分析'))
  check('扩写提示词带数量', expand[1].content.includes('补 4 个'))

  const polish = buildPolishMessages({ title: '我们做了一个测试' })
  check('润色提示词要求只返回文本', polish[0].content.includes('只返回改写后的那一句'))
  check('润色提示词带原文', polish[1].content.includes('我们做了一个测试'))
  check('润色可指定风格', buildPolishMessages({ title: 'x', style: '口语化' })[1].content.includes('口语化'))

  group('AI：解析模型输出')

  const parsed = parseOutline(`好的，这是大纲：
- 产品规划
  - 市场分析
    - 目标用户
  - 产品设计
  - 研发计划`)
  eq('解析出根节点', parsed.root?.title, '产品规划')
  eq('解析出节点总数', parsed.count, 5)
  eq('一级子节点', parsed.root?.children.map((c) => c.title), ['市场分析', '产品设计', '研发计划'])
  eq('二级子节点', parsed.root?.children[0].children.map((c) => c.title), ['目标用户'])
  check('开场白那行被跳过', !JSON.stringify(parsed.root).includes('好的'))

  // 模型给出多个并列顶层节点时，套一个根，不散着
  const multiRoot = parseOutline('- 甲\n- 乙')
  eq('并列顶层套根', multiRoot.root?.children.map((c) => c.title), ['甲', '乙'])
  check('并列顶层给出提示', multiRoot.warnings.some((w) => w.includes('并列')), multiRoot.warnings.join('|'))

  // 模型常见的几种「不听话」写法都要能处理
  check('代码块包裹能剥掉', parseOutline('```\n- A\n  - B\n```').count === 2)
  check('星号列表也能解析', parseOutline('* A\n  * B').count === 2)
  check('数字列表也能解析', parseOutline('1. A\n  1. B').count === 2)
  check(
    'Markdown 标题也能解析（并列时套一个根）',
    parseOutline('# A\n## B').root?.children.length === 2,
    JSON.stringify(parseOutline('# A\n## B').root)
  )
  check('制表符缩进也能解析', parseOutline('- A\n\t- B').root?.children.length === 1)
  eq('多余空行不影响', parseOutline('- A\n\n\n  - B').count, 2)
  check('加粗标题去掉星号', parseOutline('- **重要**').root?.title === '重要', parseOutline('- **重要**').root?.title)
  check(
    '开场白不进入大纲（关键）',
    parseOutline('好的，这是大纲：\n- 甲\n  - 乙').root?.title === '甲',
    JSON.stringify(parseOutline('好的，这是大纲：\n- 甲\n  - 乙').root)
  )
  eq('开场白被跳过后节点数正确', parseOutline('好的，这是大纲：\n- 甲\n  - 乙').count, 2)

  const flatRoots = parseOutline('- 甲\n- 乙\n- 丙', '我的主题')
  eq('多个顶层节点套一个根', flatRoots.root?.title, '我的主题')
  eq('同级的都挂在根下', flatRoots.root?.children.length, 3)
  check('多顶层时给出提示', flatRoots.warnings.length === 1, flatRoots.warnings.join('|'))

  const shifted = parseOutline('    - 根\n      - 子')
  eq('整体缩进的层级被归一化', shifted.root?.title, '根')
  eq('归一化后子节点关系正确', shifted.root?.children.length, 1)

  const deepJump = parseOutline('- 根\n      - 跳级子节点')
  check('层级跳跃不会崩（按最近父级挂）', (deepJump.root?.children.length ?? 0) >= 1)

  const empty = parseOutline('很抱歉，我无法完成这个请求。')
  eq('只有说明文字时根为 null', empty.root, null)
  eq('只有说明文字时给提示', empty.warnings.length, 1)
  check('提示说明了原因', empty.warnings[0].includes('说明文字'), empty.warnings[0])

  const bare = parseOutline('甲\n乙\n丙')
  eq('没有列表符号时按一行一个主题解析', bare.root?.children.map((c) => c.title), ['甲', '乙', '丙'])
  check('并给出格式提示', bare.warnings.some((w) => w.includes('一行一个主题')), bare.warnings.join('|'))

  eq('平铺列表解析', parseFlatList('- 甲\n- 乙\n- 丙'), ['甲', '乙', '丙'])
  eq('平铺列表忽略空行与解释', parseFlatList('这是结果：\n\n- 甲\n\n- 乙'), ['这是结果：', '甲', '乙'])
  eq('平铺列表剥掉缩进', parseFlatList('  - 甲\n    - 乙'), ['甲', '乙'])

  group('AI：润色结果清洗')

  eq('去掉包裹的引号', cleanPolishedTitle('"优化后的标题"'), '优化后的标题')
  eq('去掉中文引号', cleanPolishedTitle('「优化后的标题」'), '优化后的标题')
  eq('去掉编号前缀', cleanPolishedTitle('1. 优化后的标题'), '优化后的标题')
  eq('只取第一行', cleanPolishedTitle('优化后的标题\n解释：我改了用词'), '优化后的标题')
  eq('去掉列表符号', cleanPolishedTitle('- 优化后的标题'), '优化后的标题')
  eq('空输入返回空', cleanPolishedTitle('   '), '')
  eq('不误删内容里的引号', cleanPolishedTitle('他说"你好"'), '他说"你好"')

  group('AI：响应解析与错误翻译')

  eq(
    '取 message.content',
    extractContent({ choices: [{ message: { content: '结果' } }] }),
    '结果'
  )
  eq('兼容 text 字段', extractContent({ choices: [{ text: '旧格式' }] }), '旧格式')

  let noChoices = ''
  try {
    extractContent({ choices: [] })
  } catch (error) {
    noChoices = (error as Error).message
  }
  check('choices 为空给出可读错误', noChoices.includes('choices 为空'), noChoices)

  let apiError = ''
  try {
    extractContent({ error: { message: '额度不足' } })
  } catch (error) {
    apiError = (error as Error).message
  }
  check('响应里带 error 时透出服务端信息', apiError.includes('额度不足'), apiError)

  let notObject = ''
  try {
    extractContent('不是对象')
  } catch (error) {
    notObject = (error as Error).message
  }
  check('非对象给出可读错误', notObject.includes('不是合法的 JSON 对象'), notObject)

  check('401 提示检查 Key', describeAiError(401, '{"error":{"message":"invalid api key"}}').includes('API Key'))
  check('401 带上服务端信息', describeAiError(401, '{"error":{"message":"invalid api key"}}').includes('invalid api key'))
  check('404 提示 BaseURL/模型名', describeAiError(404, '').includes('/v1'))
  check('429 提示限流', describeAiError(429, '').includes('限流'))
  check('400 提示模型名或长度', describeAiError(400, '').includes('模型名'))
  check('5xx 说明不是用户的问题', describeAiError(503, '').includes('不是你的问题'))
  check('其它状态码也给状态码', describeAiError(418, '').includes('418'))
  check('超长响应体被截断', describeAiError(400, 'x'.repeat(500)).length < 400)

  group('AI：大纲落到模型')

  const toTopic = outlineToTopic({ title: '根', children: [{ title: '子', children: [] }] })
  eq('转成主题树', toTopic.title, '根')
  eq('子节点也转了', toTopic.children.map((c) => c.title), ['子'])
  check('生成了 id', toTopic.id.length > 0 && toTopic.children[0].id.length > 0)
  check('id 互不相同', toTopic.id !== toTopic.children[0].id)
  eq('默认字段齐全', [toTopic.labels.length, toTopic.markers.length, toTopic.attachments.length], [0, 0, 0])

  group('AI：结果写入画布（一步撤销）')

  reset()
  const aiRootId = root().id
  const aiTarget = addChildOf(aiRootId, '待扩写')
  const before = store().undoStack.length
  const added = store().addChildTitles(aiTarget, ['甲', '乙', '  ', '丙'])
  eq('空白标题被忽略', added, 3)
  eq('子主题真写进去了', find(aiTarget)?.children.map((c) => c.title), ['甲', '乙', '丙'])
  eq('整批只占一步撤销', store().undoStack.length, before + 1)
  store().undo()
  eq('一次撤销整批回退', find(aiTarget)?.children.length, 0)

  const sheetsBefore = store().workbook.sheets.length
  const applied = store().applyOutlineTree({ kind: 'newSheet' }, {
    title: 'AI 主题',
    children: [{ title: '分支一', children: [{ title: '细节点', children: [] }] }]
  })
  eq('生成的节点数正确', applied, 3)
  eq('新画布已创建', store().workbook.sheets.length, sheetsBefore + 1)
  eq('当前画布切到新画布', activeRoot(store().workbook).title, 'AI 主题')
  eq('层级被正确写入', activeRoot(store().workbook).children[0].children[0].title, '细节点')
  store().undo()
  eq('撤销后回到原来的画布数', store().workbook.sheets.length, sheetsBefore)

  reset()
  const hostId = addChildOf(root().id, '宿主主题')
  const childApplied = store().applyOutlineTree({ kind: 'childOf', id: hostId }, {
    title: '生成的分支',
    children: []
  })
  eq('挂到已有主题下：节点数', childApplied, 1)
  eq('挂载结果正确', find(hostId)?.children.map((c) => c.title), ['生成的分支'])

  const unknownTarget = store().applyOutlineTree({ kind: 'childOf', id: '不存在的主题' }, {
    title: 'x',
    children: []
  })
  eq('目标主题不存在时不会崩（返回计数但什么都没写）', unknownTarget, 1)
  eq('确实没有写进任何地方', find(hostId)?.children.length, 1)
}

/* ------------------------------------------------------------------ */
/* 12.12 导入：Markdown / OPML 一键生成导图                            */
/* ------------------------------------------------------------------ */

function testImport(): void {
  group('导入 Markdown：结构与容错')

  const nested = parseMarkdownOutline('# 产品规划\n## 市场分析\n### 目标用户\n## 产品设计')
  eq('标题按级别嵌套', nested.root?.title, '产品规划')
  eq('二级标题是子节点', nested.root?.children.map((c) => c.title), ['市场分析', '产品设计'])
  eq('三级标题挂到二级下', nested.root?.children[0].children.map((c) => c.title), ['目标用户'])
  eq('节点总数', nested.count, 4)

  const withList = parseMarkdownOutline('# 计划\n- 甲\n  - 甲一\n- 乙')
  eq('列表挂在标题下', withList.root?.children.map((c) => c.title), ['甲', '乙'])
  eq('列表按缩进嵌套', withList.root?.children[0].children.map((c) => c.title), ['甲一'])
  eq('标题+列表总数', withList.count, 4)

  const twoSections = parseMarkdownOutline('# 甲\n- x\n# 乙\n- y')
  eq('同级标题不嵌套', twoSections.root?.children.map((c) => c.title), ['甲', '乙'])
  check('并列顶层套一个根', twoSections.warnings.length === 1, twoSections.warnings.join('|'))

  const noHeading = parseMarkdownOutline('- 根\n  - 子\n    - 孙')
  eq('没有标题时第一个列表项当根', noHeading.root?.title, '根')
  eq('没有标题也能嵌套', noHeading.root?.children[0].children.map((c) => c.title), ['孙'])

  const fenced = parseMarkdownOutline('# 标题\n```ts\n- 代码里的不算\n```\n- 真正的项')
  eq('代码块挂到所属标题', fenced.root?.code?.text, '- 代码里的不算')
  eq('代码块的语言标注也带上', fenced.root?.code?.language, 'ts')
  eq('代码块外的列表正常', fenced.count, 2)

  const frontMatter = parseMarkdownOutline('---\ntitle: x\n tags: [a]\n---\n# 真标题\n- 项')
  eq('front-matter 被跳过', frontMatter.root?.title, '真标题')
  eq('front-matter 后节点数正确', frontMatter.count, 2)

  const noisy = parseMarkdownOutline('# 标题\n> 引用不是节点\n| a | b |\n| - | - |\n---\n- 项')
  eq('表格数据行变成子主题', noisy.root?.children.map((c) => c.title), ['a / b', '项'])
  eq('引用块进备注', noisy.root?.notes, '引用不是节点')
  eq('引用/表格/水平线处理后的节点数', noisy.count, 3)

  const codeFallback = parseMarkdownOutline('# T\n```\na\n```\n```\nb\n```')
  eq('第二个代码块生成「代码」子主题', codeFallback.root?.children.map((c) => c.title), ['代码'])
  eq('「代码」子主题带内容', codeFallback.root?.children[0].code?.text, 'b')

  const taskList = parseMarkdownOutline('# 任务\n- [x] 已完成\n- [ ] 待办')
  eq('任务列表剥掉勾选框', taskList.root?.children.map((c) => c.title), ['已完成', '待办'])

  const richList = parseMarkdownOutline('- **重点**内容\n- *斜*体\n- `code` 说明')
  eq('粗体进富文本', richList.root?.children[0].rich?.paragraphs[0]?.runs[0]?.bold, true)
  eq('斜体进富文本', richList.root?.children[1].rich?.paragraphs[0]?.runs[0]?.italic, true)
  eq('行内代码用等宽字体', typeof richList.root?.children[2].rich?.paragraphs[0]?.runs[0]?.fontFamily, 'string')
  eq('纯文本标题不受影响', richList.root?.children[0].title, '重点内容')

  group('公式：Markdown 数学写法')

  eq('行内 $…$ 剥成纯 LaTeX', normalizeFormulaInput('$x^2$'), 'x^2')
  eq('块级 $$…$$ 剥成纯 LaTeX', normalizeFormulaInput('$$E=mc^2$$'), 'E=mc^2')
  eq('LaTeX 定界符 \\(…\\) 也剥掉', normalizeFormulaInput('\\(a+b\\)'), 'a+b')
  eq('\\[…\\] 同样支持', normalizeFormulaInput('\\[\\frac{a}{b}\\]'), '\\frac{a}{b}')
  eq('纯 LaTeX 原样保留', normalizeFormulaInput('\\sum_{i=1}^{n} i'), '\\sum_{i=1}^{n} i')
  eq('只有定界符时不剥成空', normalizeFormulaInput('$$'), '$$')
  eq('整句数学识别', matchWholeLineMath('$$x^2$$'), 'x^2')
  // 标题内行内公式（$…$）的切分
  {
    const mixed = splitInlineMath('面积 $S=\\pi r^2$ 的公式')
    eq('行内公式切成三段', mixed.length, 3)
    eq('公式段拿到源码', mixed[1].formula, 'S=\\pi r^2')
    eq('前后文字保留', `${mixed[0].text}|${mixed[2].text}`, '面积 | 的公式')
    eq('没有公式时原样一段', splitInlineMath('纯文字').length, 1)
    eq('两个公式各自成段', splitInlineMath('$a$$b$').filter((item) => item.formula).length, 2)
  }
  eq('普通文字不是数学', matchWholeLineMath('这是普通文字'), null)

  const mathImport = parseMarkdownOutline('# 公式\n- $E=mc^2$\n- 普通项')
  eq('Markdown 行内数学变成节点公式', mathImport.root?.children[0]?.formula, 'E=mc^2')
  eq('公式节点标题留空', mathImport.root?.children[0]?.title, '')
  eq('同级的普通项不受影响', mathImport.root?.children[1]?.title, '普通项')

  const linked = parseMarkdownOutline('# 链接\n- [文档](https://example.com) 首页')
  eq('链接 url 挂到节点超链接', linked.root?.children[0]?.href, 'https://example.com')
  check('链接文字带下划线样式', linked.root?.children[0]?.rich?.paragraphs[0]?.runs[0]?.underline === true)

  const numbered = parseMarkdownOutline('# 步骤\n1. 第一\n2. 第二\n   1. 第二点一')
  eq('数字列表可解析', numbered.root?.children.map((c) => c.title), ['第一', '第二'])
  eq('数字列表缩进嵌套', numbered.root?.children[1].children.map((c) => c.title), ['第二点一'])

  eq('粗体标记被清理', parseMarkdownOutline('- **重点**内容').root?.title, '重点内容')
  eq('斜体标记被清理', parseMarkdownOutline('- *斜*体').root?.title, '斜体')
  eq('行内代码被清理', parseMarkdownOutline('- `code` 说明').root?.title, 'code 说明')
  eq('链接只留文字', parseMarkdownOutline('- [文档](https://example.com) 说明').root?.title, '文档 说明')
  eq('图片只留替代文字', parseMarkdownOutline('- ![架构图](a.png)').root?.title, '架构图')
  eq('行尾锚点被清理', parseMarkdownOutline('## 标题 ##').root?.title, '标题')

  const emptyMd = parseMarkdownOutline('')
  eq('空文件不产出节点', emptyMd.root, null)
  check('空文件给出提示', emptyMd.warnings.length === 1, emptyMd.warnings.join('|'))

  const paragraphs = parseMarkdownOutline('这是第一段\n这是第二段')
  eq('只有段落时按一行一主题导入', paragraphs.root?.children.map((c) => c.title), ['这是第一段', '这是第二段'])
  check('并给出格式提示', paragraphs.warnings.some((w) => w.includes('一行一个主题')), paragraphs.warnings.join('|'))

  const longParagraph = parseMarkdownOutline('x'.repeat(80))
  eq('超长段落不当作主题', longParagraph.root, null)

  const bom = parseMarkdownOutline('\ufeff# 标题')
  eq('BOM 不影响解析', bom.root?.title, '标题')

  group('导入 OPML')

  const opml = parseOpmlOutline(`<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>我的导图</title></head>
  <body>
    <outline text="中心主题">
      <outline text="分支一" _note="这是备注"/>
      <outline text="分支二">
        <outline text="细节点"/>
      </outline>
    </outline>
  </body>
</opml>`)
  eq('OPML 根节点', opml.root?.title, '中心主题')
  eq('OPML 子节点', opml.root?.children.map((c) => c.title), ['分支一', '分支二'])
  eq('OPML 三级节点', opml.root?.children[1].children.map((c) => c.title), ['细节点'])
  eq('OPML 节点总数', opml.count, 4)
  eq('_note 被导入为备注', opml.root?.children[0].notes, '这是备注')

  const opmlMulti = parseOpmlOutline(`<opml version="2.0"><head><title>文件标题</title></head><body>
    <outline text="甲"/><outline text="乙"/>
  </body></opml>`)
  eq('并列节点用文件标题套根', opmlMulti.root?.title, '文件标题')
  eq('并列节点都在根下', opmlMulti.root?.children.map((c) => c.title), ['甲', '乙'])

  const container = parseOpmlOutline(`<opml version="2.0"><body>
    <outline>
      <outline text="甲"/><outline text="乙"/>
    </outline>
  </body></opml>`)
  eq('没有 text 的容器节点被展开（不丢数据）', container.root?.children.map((c) => c.title), ['甲', '乙'])

  const noBody = parseOpmlOutline('<opml version="2.0"><outline text="甲"/></opml>')
  eq('没有 body 时兜底解析', noBody.root?.title, '甲')

  const noOutline = parseOpmlOutline('<opml version="2.0"><body></body></opml>')
  eq('没有 outline 时返回 null', noOutline.root, null)
  check('没有 outline 时给出提示', noOutline.warnings.length === 1)

  let opmlError = ''
  try {
    parseOpmlOutline('这不是 XML')
  } catch (error) {
    opmlError = (error as Error).message
  }
  check('非法 OPML 抛出可读错误', opmlError.includes('不是合法的 XML'), opmlError)

  group('导入：备注一并带进模型')

  const noteTopic = outlineToTopic({
    title: '节点',
    notes: '备注 <b>内容</b>',
    children: [{ title: '子', children: [] }]
  })
  eq('备注写入模型', noteTopic.notes, '备注 <b>内容</b>')
  check('备注 HTML 被转义', (noteTopic.notesHtml ?? '').includes('&lt;b&gt;'), String(noteTopic.notesHtml))
  eq('子节点没有备注', noteTopic.children[0].notes, undefined)

  group('导入：落地到画布')

  reset()
  const markdownText = '# 学习计划\n- 前端\n  - React\n- 后端'
  const parsedMd = parseMarkdownOutline(markdownText, '学习计划')
  const beforeSheets = store().workbook.sheets.length
  const imported = store().applyOutlineTree({ kind: 'newSheet' }, parsedMd.root!, parsedMd.root!.title)
  eq('导入节点数', imported, 4)
  eq('导入后新增一张画布', store().workbook.sheets.length, beforeSheets + 1)
  eq('画布中心主题正确', activeRoot(store().workbook).title, '学习计划')
  eq('导入层级正确', activeRoot(store().workbook).children[0].children.map((c) => c.title), ['React'])
  store().undo()
  eq('一次撤销回到导入前', store().workbook.sheets.length, beforeSheets)
}

/* ------------------------------------------------------------------ */
/* 12.13 默认文件名：优先用中心主题的名字                               */
/* ------------------------------------------------------------------ */

function testNaming(): void {
  group('默认文件名取中心主题')

  reset()
  store().setTitle(root().id, '产品规划')
  eq('用中心主题的文字', defaultDocumentName(store().workbook), '产品规划')
  eq('带扩展名', defaultFileName(store().workbook, 'xmind'), '产品规划.xmind')
  eq('扩展名重复带点也正常', defaultFileName(store().workbook, '.png'), '产品规划.png')

  store().setTitle(root().id, '   周末计划   ')
  eq('去掉首尾空格', defaultDocumentName(store().workbook), '周末计划')

  store().setTitle(root().id, '')
  eq('中心主题为空时退回画布名', defaultDocumentName(store().workbook), '画布 1')

  store().renameSheet(sheet().id, '我的画布')
  eq('画布名也参与兜底', defaultDocumentName(store().workbook), '我的画布')

  store().renameSheet(sheet().id, '   ')
  eq('画布名也没有时用未命名导图', defaultDocumentName(store().workbook), '未命名导图')

  group('默认文件名：非法字符与保留名')

  reset()
  store().setTitle(root().id, 'a/b\\c:d*e?f"g<h>i|j')
  eq('非法字符换成下划线', defaultDocumentName(store().workbook), 'a_b_c_d_e_f_g_h_i_j')

  store().setTitle(root().id, '报告.')
  eq('结尾的点被去掉（Windows 会吃掉）', defaultDocumentName(store().workbook), '报告')

  store().setTitle(root().id, '项目：季度复盘')
  eq('中文全角符号不受影响', defaultDocumentName(store().workbook), '项目：季度复盘')

  store().setTitle(root().id, 'CON')
  eq('Windows 保留名加下划线', defaultDocumentName(store().workbook), 'CON_')

  store().setTitle(root().id, 'x'.repeat(120))
  eq('超长名字被截断', defaultDocumentName(store().workbook).length, 60)

  eq('纯空白的名字返回空串', sanitizeFileName('   '), '')
  eq('有内容的正常通过', sanitizeFileName('正常名字'), '正常名字')

  group('默认文件名：多画布时取当前画布')

  reset()
  const firstSheetId = sheet().id
  store().setTitle(root().id, '第一张')
  const secondId = store().addSheet()
  eq('新画布用的是新画布的中心主题', defaultDocumentName(store().workbook), '中心主题')
  store().renameSheet(secondId, '第二张画布')
  eq('改画布名不影响取名（仍看中心主题）', defaultDocumentName(store().workbook), '中心主题')
  store().setActiveSheet(firstSheetId)
  eq('切回第一张后跟着变', defaultDocumentName(store().workbook), '第一张')
}

/* ------------------------------------------------------------------ */
/* 历史记录 / 常用（纯函数）                                           */
/* ------------------------------------------------------------------ */

function testHistory(): void {
  group('历史记录：结构校验与兜底')

  const blank = emptyHistory()
  eq('空历史版本号', blank.version, 1)
  eq('空历史没有条目', blank.entries.length, 0)
  check('空历史没有默认目录', blank.saveDir === null)

  eq('null 输入返回空历史', normalizeHistory(null).entries.length, 0)
  eq('字符串输入返回空历史', normalizeHistory('not-an-object').entries.length, 0)
  eq('数组输入返回空历史', normalizeHistory([1, 2, 3]).entries.length, 0)
  eq('无 entries 字段返回空历史', normalizeHistory({ version: 1 }).entries.length, 0)

  const mixed = normalizeHistory({
    version: 99,
    saveDir: '   D:\\图   ',
    entries: [
      null,
      'string',
      { name: '没有路径' },
      { path: '   ' },
      { path: 'D:\\a.xmind', name: 'a.xmind', title: '甲', openedAt: 100, openCount: 2, pinned: true },
      { path: 'd:\\A.XMIND', name: '重复项', openedAt: 200 },
      { path: 'D:\\b.xmind', openedAt: 'bad', openCount: -3, pinned: 'yes' }
    ]
  })
  eq('坏条目被丢弃、重复被合并', mixed.entries.length, 2)
  eq('默认目录去掉首尾空格', mixed.saveDir, 'D:\\图')
  eq('路径大小写不同视为同一个文件', mixed.entries.filter((e) => e.pinned).length, 1)
  eq('先出现的那条胜出', mixed.entries.find((e) => e.pinned)?.title, '甲')

  const odd = mixed.entries.find((entry) => entry.path === 'D:\\b.xmind')!
  eq('非法时间归零', odd.openedAt, 0)
  eq('非法次数回到 1', odd.openCount, 1)
  eq('非布尔值不算常用', odd.pinned, false)
  eq('缺名字时用路径末段兜底', odd.name, 'b.xmind')

  group('历史记录：排序与数量上限')

  const sorted = sortEntries([
    { path: 'a', name: 'a', title: '', openedAt: 1, openCount: 1, pinned: false },
    { path: 'b', name: 'b', title: '', openedAt: 5, openCount: 1, pinned: false },
    { path: 'c', name: 'c', title: '', openedAt: 2, openCount: 1, pinned: true }
  ])
  eq('排序：常用优先，其余按时间倒序', sorted.map((entry) => entry.path), ['c', 'b', 'a'])

  const before = [
    { path: 'x', name: 'x', title: '', openedAt: 1, openCount: 1, pinned: false },
    { path: 'y', name: 'y', title: '', openedAt: 9, openCount: 1, pinned: false }
  ]
  sortEntries(before)
  eq('排序不修改传入的数组', before.map((entry) => entry.path), ['x', 'y'])

  const many = normalizeHistory({
    entries: Array.from({ length: 40 }, (_, index) => ({
      path: `D:\\f${index}.xmind`,
      openedAt: index,
      // 故意让最旧的一条是常用：它必须活下来
      pinned: index === 0
    }))
  })
  eq('非常用条目被裁到上限', many.entries.filter((entry) => !entry.pinned).length, HISTORY_LIMIT)
  eq('常用条目不受上限影响', many.entries.filter((entry) => entry.pinned).length, 1)
  eq('常用永远排在第一位', many.entries[0].pinned, true)

  const times = many.entries.filter((entry) => !entry.pinned).map((entry) => entry.openedAt)
  check(
    '其余按最近打开倒序',
    times.every((value, index) => index === 0 || times[index - 1] >= value),
    times.slice(0, 5).join(',')
  )

  group('历史记录：记录一次打开')

  let file = emptyHistory()
  file = recordVisit(file, { path: 'D:\\a.xmind', name: 'a.xmind', title: '甲', at: 1000 })
  eq('新记录进入历史', file.entries.length, 1)
  eq('首次打开次数为 1', file.entries[0].openCount, 1)
  eq('新记录默认不是常用', file.entries[0].pinned, false)
  eq('记录了中心主题名', file.entries[0].title, '甲')

  file = recordVisit(file, { path: 'd:\\A.XMIND', title: '甲改', at: 2000 })
  eq('同一文件重复打开只留一条', file.entries.length, 1)
  eq('打开次数累加', file.entries[0].openCount, 2)
  eq('最近打开时间被刷新', file.entries[0].openedAt, 2000)
  eq('标题被更新', file.entries[0].title, '甲改')

  file = recordVisit(file, { path: 'D:\\a.xmind', title: '   ', at: 3000 })
  eq('空标题不会覆盖已有标题', file.entries[0].title, '甲改')
  eq('次数继续累加', file.entries[0].openCount, 3)

  eq('空白路径被忽略', recordVisit(file, { path: '   ' }).entries.length, 1)

  const twoPaths = recordVisit(file, { path: 'D:\\c.xmind', title: '丙', at: 4000 })
  eq('最近打开的排在最前', twoPaths.entries[0].path, 'D:\\c.xmind')

  group('历史记录：常用 / 移除 / 清空')

  let pinnedFile = emptyHistory()
  pinnedFile = recordVisit(pinnedFile, { path: 'D:\\x.xmind', at: 1 })
  pinnedFile = recordVisit(pinnedFile, { path: 'D:\\y.xmind', at: 2 })
  eq('最新的在最前', pinnedFile.entries[0].path, 'D:\\y.xmind')

  pinnedFile = togglePin(pinnedFile, 'd:\\X.XMIND')
  eq('切成常用', pinnedFile.entries.filter((entry) => entry.pinned).length, 1)
  eq('常用被排到最前', pinnedFile.entries[0].path, 'D:\\x.xmind')

  pinnedFile = togglePin(pinnedFile, 'D:\\x.xmind')
  eq('再点一次取消常用', pinnedFile.entries.filter((entry) => entry.pinned).length, 0)

  pinnedFile = removeEntry(pinnedFile, 'd:\\y.XMIND')
  eq('移除不区分大小写', pinnedFile.entries.length, 1)
  eq('剩下的是另一条', pinnedFile.entries[0].path, 'D:\\x.xmind')

  const cleared = clearHistory({ ...pinnedFile, saveDir: 'D:\\保存位置' })
  eq('清空后没有条目', cleared.entries.length, 0)
  eq('清空不影响默认保存目录', cleared.saveDir, 'D:\\保存位置')

  group('历史记录：相对时间')

  const now = 1_700_000_000_000
  eq('刚刚', relativeTime(now - 5_000, now), '刚刚')
  eq('N 分钟前', relativeTime(now - 5 * 60_000, now), '5 分钟前')
  eq('N 小时前', relativeTime(now - 3 * 3_600_000, now), '3 小时前')
  eq('昨天', relativeTime(now - 30 * 3_600_000, now), '昨天')
  eq('N 天前', relativeTime(now - 5 * 86_400_000, now), '5 天前')
  eq('未来时间显示刚刚', relativeTime(now + 10_000, now), '刚刚')
  eq('非法时间返回空串', relativeTime(Number.NaN, now), '')
  eq('零值返回空串', relativeTime(0, now), '')

  const longAgo = relativeTime(now - 40 * 86_400_000, now)
  check('超过 30 天显示具体日期', /^\d{4}-\d{2}-\d{2}$/.test(longAgo), longAgo)
}

/* ------------------------------------------------------------------ */
/* 版本快照（纯函数）                                                   */
/* ------------------------------------------------------------------ */

const DOC_A = 'file:d:\\a.xmind'
const DOC_B = 'file:d:\\b.xmind'

function snap(over: Partial<SnapshotItem> & { id: string }): SnapshotItem {
  return {
    docKey: DOC_A,
    title: '甲',
    path: 'D:\\a.xmind',
    at: 1000,
    size: 2048,
    reason: 'auto',
    hash: `hash-${over.id}`,
    ...over
  }
}

function testSnapshots(): void {
  group('版本快照：文档键')

  eq('已保存文档按路径归并（大小写与斜杠都不敏感）', documentKeyOf('D:\\图\\a.xmind'), documentKeyOf('d:/图/a.xmind'))
  check('不同文件是不同的键', documentKeyOf('D:\\a.xmind') !== documentKeyOf('D:\\b.xmind'))
  check('没有路径时返回 null（不记录版本）', documentKeyOf(null) === null)
  check('空白路径也返回 null', documentKeyOf('   ') === null)
  check('undefined 返回 null', documentKeyOf(undefined) === null)
  check('首尾空格不影响归并', documentKeyOf('  D:\\a.xmind  ') === documentKeyOf('D:\\a.xmind'))

  group('版本快照：索引校验')

  eq('空索引没有条目', emptySnapshotIndex().items.length, 0)
  eq('null 输入返回空索引', normalizeSnapshotIndex(null).index.items.length, 0)
  eq('数组输入返回空索引', normalizeSnapshotIndex([1, 2]).index.items.length, 0)

  const dirty = normalizeSnapshotIndex({
    version: 9,
    items: [
      null,
      'string',
      { id: 'no-doc-key' },
      { id: 'ok', docKey: DOC_A },
      { id: 'ok', docKey: DOC_B }
    ]
  })
  eq('坏条目被丢弃、重复 id 只留一条', dirty.index.items.length, 1)
  eq('缺字段时来源回退为自动', dirty.index.items[0].reason, 'auto')
  eq('非法时间归零', dirty.index.items[0].at, 0)
  eq('缺标题时为空串', dirty.index.items[0].title, '')

  const orphaned = normalizeSnapshotIndex({
    items: [{ id: 'orphan1' }, { id: 'unsafe/../x' }, { name: '没有 id' }]
  })
  eq('缺字段的条目被丢弃', orphaned.index.items.length, 0)
  eq('丢弃的条目会上报要删的文件（不安全的 id 除外）', orphaned.dropped, ['orphan1'])

  const duplicated = normalizeSnapshotIndex({
    items: [
      { id: 'keep1', docKey: DOC_A, at: 5, reason: 'manual' },
      { id: 'keep1', docKey: DOC_B, at: 6 }
    ]
  })
  eq('重复 id 只留一条', duplicated.index.items.length, 1)
  eq('重复 id 不会被误当成垃圾删文件', duplicated.dropped.filter((id) => id === 'keep1').length, 0)

  group('版本快照：数量上限与裁剪')

  const many = normalizeSnapshotIndex({
    items: Array.from({ length: 40 }, (_, index) => ({
      id: `s${index}`,
      docKey: DOC_A,
      at: 1000 + index,
      // 偶数下标是自动版本，奇数是手动版本
      reason: index % 2 === 0 ? 'auto' : 'manual'
    }))
  })
  const kept = many.index.items
  eq('单文档被裁到上限', kept.length, SNAPSHOT_LIMITS.perDoc)
  eq('手动版本全部保留', kept.filter((item) => item.reason === 'manual').length, 20)
  eq('自动版本只留最新的一部分', kept.filter((item) => item.reason === 'auto').length, 10)
  eq('被裁掉的数量正确', many.dropped.length, 10)

  const keptIds = new Set(kept.map((item) => item.id))
  check('被裁的 id 不在保留名单里', many.dropped.every((id) => !keptIds.has(id)))
  check(
    '留下的是最新的自动版本',
    kept.filter((item) => item.reason === 'auto').every((item) => Number(item.id.slice(1)) >= 20),
    kept
      .filter((item) => item.reason === 'auto')
      .map((item) => item.id)
      .join(',')
  )

  const twoDocs = normalizeSnapshotIndex({
    items: [
      ...Array.from({ length: 40 }, (_, index) => ({ id: `a${index}`, docKey: DOC_A, at: 1000 + index })),
      { id: 'b1', docKey: DOC_B, at: 1 }
    ]
  })
  check('另一个文档的版本不受影响', twoDocs.index.items.some((item) => item.id === 'b1'))

  group('版本快照：增删与查询')

  let result = addSnapshot(emptySnapshotIndex(), snap({ id: 'v1', at: 100 }))
  eq('新增一个版本', result.index.items.length, 1)
  eq('没有需要删的文件', result.dropped.length, 0)

  result = addSnapshot(result.index, snap({ id: 'v2', at: 200 }))
  eq('再新增一个', result.index.items.length, 2)

  eq('按时间倒序查询', snapshotsOf(result.index, DOC_A).map((item) => item.id), ['v2', 'v1'])
  eq('查别的文档为空', snapshotsOf(result.index, DOC_B).length, 0)

  result = addSnapshot(result.index, snap({ id: 'v2', at: 300 }))
  eq('同 id 覆盖而不是重复', result.index.items.length, 2)

  const afterRemove = removeSnapshot(result.index, 'v2')
  eq('删除生效', snapshotsOf(afterRemove.index, DOC_A).map((item) => item.id), ['v1'])
  eq('删除会同时上报要删的文件', afterRemove.dropped, ['v2'])
  eq('删除不存在的 id 不报错', removeSnapshot(result.index, 'not-exist').index.items.length, 2)

  const both = addSnapshot(addSnapshot(emptySnapshotIndex(), snap({ id: 'x1' })).index, snap({ id: 'y1', docKey: DOC_B })).index
  const cleared = clearDocSnapshots(both, DOC_A)
  eq('只清指定文档的版本', cleared.index.items.map((item) => item.id), ['y1'])
  eq('清掉的 id 会一并上报（否则文件永远留在磁盘上）', cleared.dropped, ['x1'])

  group('版本快照：自动快照的判定')

  check('没有版本时先存一个', shouldAutoSnapshot([], 'h1', 1000))

  const base = [snap({ id: 'v1', at: 10_000, hash: 'same' })]
  check('内容没变就不重复存', !shouldAutoSnapshot(base, 'same', 10_000 + 60 * 60_000))
  check('内容变了但间隔太近也先不存', !shouldAutoSnapshot(base, 'other', 10_000 + 60_000))
  check('内容变了且间隔足够才存', shouldAutoSnapshot(base, 'other', 10_000 + SNAPSHOT_LIMITS.minGap))
  check(
    '间隔按最新一条算',
    !shouldAutoSnapshot(
      [...base, snap({ id: 'v2', at: 10_000 + 4 * 60_000, hash: 'mid' })],
      'new',
      10_000 + 5 * 60_000
    )
  )

  group('版本快照：展示文案')

  eq('字节（B）', formatBytes(512), '512 B')
  eq('字节（KB）', formatBytes(2048), '2.0 KB')
  eq('字节（MB）', formatBytes(3 * 1024 * 1024), '3.0 MB')
  eq('字节（零）', formatBytes(0), '0 B')
  eq('手动来源标签', snapshotReasonLabel('manual'), '手动')
  eq('恢复前来源标签', snapshotReasonLabel('before-restore'), '恢复前')
  eq('有备注时优先显示备注', snapshotLabel(snap({ id: 'n1', note: '发布前' })), '发布前')
  eq('没备注时用来源加文档名', snapshotLabel(snap({ id: 'n2', title: '甲' })), '自动 · 甲')
  eq('没有标题也能给出文案', snapshotLabel(snap({ id: 'n3', title: '' })), '自动版本')
}

/* ------------------------------------------------------------------ */
/* 亿图脑图（.emmx）                                                   */
/* ------------------------------------------------------------------ */

const VER2_DOC = {
  ver: 2,
  contents: [
    {
      id: 'sheet-1',
      title: '',
      type: 'mind',
      config: { template: 'right' },
      root: {
        id: 'r1',
        data: { text: 'Pandas进阶\n', richText: { ops: [{ insert: 'Pandas进阶\n' }] } },
        children: {
          normal: [
            {
              id: 'a1',
              data: { text: '文件读取\n', background: '#ffcc00' },
              children: { normal: [{ id: 'a11', data: { text: 'csv文件' } }] }
            },
            {
              id: 'a2',
              data: {
                text: '颜色示例',
                richText: { ops: [{ insert: '普通' }, { insert: '红色', attributes: { color: '#f44f3b' } }] }
              }
            }
          ],
          summary: [{ id: 's1', data: { text: '不常用', type: 'summary', startId: 'a1', endId: 'a2' } }]
        }
      },
      relativeLinks: [{ id: 'l1', text: '等价\n', start: { nodeId: 'a1' }, end: { nodeId: 'a11' } }]
    }
  ]
}

function testEmmx(): void {
  group('亿图脑图：ver:2 结构化格式')

  const parsed = parseEmmxDocument(VER2_DOC, 'Pandas进阶.emmx')
  check('能识别 ver:2 文档', parsed !== null)
  if (!parsed) return

  const sheet = parsed.workbook.sheets[0]
  eq('中心主题去掉结尾换行', sheet.rootTopic.title, 'Pandas进阶')
  eq('画布名回退到中心主题', sheet.title, 'Pandas进阶')
  eq('结构按模板映射', sheet.rootTopic.structureClass, 'org.xmind.ui.logic.right')
  eq('一级子节点数', sheet.rootTopic.children.length, 2)
  eq('二级节点也接上了', sheet.rootTopic.children[0].children[0].title, 'csv文件')
  eq('节点底色进到 style', sheet.rootTopic.children[0].style?.properties?.['svg:fill'], '#ffcc00')
  eq('概要登记成区间', sheet.summaries[0].range, '(a1,a2)')
  eq('概要标题', sheet.summaries[0].title, '不常用')
  check(
    '概要不再作为普通子节点（避免被画两次）',
    !sheet.rootTopic.children.some((child) => child.id === 's1')
  )
  eq(
    '关系线两端',
    [sheet.relationships[0].end1Id, sheet.relationships[0].end2Id],
    ['a1', 'a11']
  )
  eq('关系线标题去掉换行', sheet.relationships[0].title, '等价')
  eq(
    '富文本颜色被保留',
    sheet.rootTopic.children[1].titleRich?.paragraphs[0]?.runs?.[1]?.color,
    '#f44f3b'
  )
  check('纯文字节点不产生富文本（不写冗余数据）', sheet.rootTopic.children[0].titleRich === undefined)
  check('有告知兼容性处理', parsed.warnings.some((line) => line.includes('亿图脑图')))

  group('亿图脑图：格式识别')

  check('Xmind 的 content.json 不会被误判', parseEmmxDocument([{ id: 'x', rootTopic: {} }]) === null)
  check('空对象返回 null', parseEmmxDocument({}) === null)
  check('contents 里没有 root 时返回 null', parseEmmxDocument({ ver: 2, contents: [{ id: 'a' }] }) === null)
  check('非对象返回 null', parseEmmxDocument('nope') === null)
  check('内容项为空数组返回 null', parseEmmxDocument({ ver: 2, contents: [] }) === null)

  group('亿图脑图：专有二进制的文字提取')

  const header = new Uint8Array(600).fill(0x01)
  const body = Buffer.from(
    ['这里是正文内容', 'Vw0E', 'Tool', 'XtD', 'DataFrame', 'fhj', 'coze', 'Python3', 'self-Host'].join('\u0000'),
    'utf8'
  )
  const bin = new Uint8Array([...header, ...body])
  const texts = extractEmmxTexts(bin)

  check('提取到中文正文', texts.includes('这里是正文内容'), texts.join('|'))
  check('提取到真实英文词', texts.includes('Tool') && texts.includes('DataFrame'), texts.join('|'))
  check('带数字的真实词没被误伤', texts.includes('Python3'), texts.join('|'))
  check('保留带连字符的词', texts.includes('self-Host'), texts.join('|'))
  check('滤掉只有一个小写字母的噪音', !texts.includes('Vw0E'), texts.join('|'))
  check('滤掉没有元音的短噪音', !texts.includes('XtD') && !texts.includes('fhj'), texts.join('|'))

  const flat = buildEmmxWorkbook(texts, '我的图.emmx')
  const flatSheet = flat.workbook.sheets[0]
  eq('兜底导入的中心主题取文件名', flatSheet.rootTopic.title, '我的图')
  eq('提取结果全部挂成子节点', flatSheet.rootTopic.children.length, texts.length)
  check(
    '明确告知层级无法还原',
    flat.warnings.some((line) => line.includes('层级结构无法还原')),
    flat.warnings.join(' / ')
  )
}

/** 用仓库里真实的 .emmx 样本验证（样本不存在时自动跳过） */
async function testEmmxSamples(): Promise<void> {
  group('亿图脑图：真实样本')

  if (!existsSync('samples')) {
    check('样本目录不存在，跳过', true)
    return
  }
  const files = readdirSync('samples').filter((name) => name.toLowerCase().endsWith('.emmx'))
  if (files.length === 0) {
    check('没有 .emmx 样本，跳过', true)
    return
  }

  for (const name of files) {
    const bytes = new Uint8Array(readFileSync(`samples/${name}`))
    try {
      const result = await parseXmind(bytes, { fileName: name })
      const sheet = result.workbook.sheets[0]
      let total = 0
      const walk = (topic: Topic): void => {
        total += 1
        for (const child of topic.children) walk(child)
      }
      walk(sheet.rootTopic)
      check(`${name}：能打开且有内容`, total >= 2, String(total))
      check(`${name}：中心主题有名字`, sheet.rootTopic.title.trim().length > 0, sheet.rootTopic.title)
      // 打开之后必须还能存回去，否则只是"看起来能开"
      const again = await parseXmind(await serializeXmind({ workbook: result.workbook, resources: result.resources }))
      let roundTrip = 0
      const count = (topic: Topic): void => {
        roundTrip += 1
        for (const child of topic.children) count(child)
      }
      count(again.workbook.sheets[0].rootTopic)
      check(`${name}：再保存后节点数一致`, roundTrip === total, `${roundTrip} vs ${total}`)
    } catch (error) {
      check(`${name}：能打开`, false, (error as Error).message)
    }
  }
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
  testNodeDrag()
  testMisc()
  testTypedChar()
  testBranchStructure()
  testBranchFamiliesMore()
  testUndoSelectionAndRelayout()
  testLayoutNoOverlap()
  testMarkdownRoundTrip()
  testPickDocumentArg()
  testViewLock()
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
  testOutline()
  testSearch()
  testExportDrawing()
  testExportFormats()
  testAi()
  testImport()
  testNaming()
  testHistory()
  testSnapshots()
  testEmmx()
  await testEmmxSamples()
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
