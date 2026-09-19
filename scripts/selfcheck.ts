/**
 * 编辑器内核自检。
 *
 * 这里不测 UI，只测「不依赖浏览器」的核心逻辑：
 * 状态操作、撤销重做、节点移动与循环保护、复制粘贴、折叠、
 * .xmind 往返保真、布局引擎、以及各种边界情况。
 *
 * 运行：npm run selfcheck
 */
import { defaultTextAlignOf, setDefaultTextAlign } from '../src/renderer/src/render/defaults'

import { activeRoot, activeSheet, countTopics, findTopic } from '../src/shared/model/tree'

import { AGENT_WRITE_TOOLS } from '../src/shared/agent'

import { layoutSheet } from '../src/shared/layout'
import {
  ALL_PICKABLE_MARKERS,
  MARKER_GROUPS,
  MARKER_LABELS,
  markerGroupOf,
  reconcileMarkers,
  withMarkerToggled
} from '../src/shared/xmind/constants'
import { buildEmmxWorkbook, extractEmmxTexts, parseEmmxDocument } from '../src/shared/xmind/emmx'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { markerVisualOf } from '../src/renderer/src/render/markers'

import { formulaHtml, formulaSize } from '../src/renderer/src/render/formula'

import { estimateOverlayLabelSize, overlayTitleLines } from '../src/shared/layout/overlays'
import { LABEL_ELLIPSIS, fitLabelText } from '../src/shared/layout/label-fit'
import { CODE_TOKEN_COLORS, highlightCode } from '../src/shared/code/highlight'
import { ALIASES, DEFS } from '../src/shared/code/lang-defs'
import { CODE_LANGUAGES } from '../src/shared/code-language'
import {
  readOverlayFontSize,
  readOverlayTextStyle,
  withOverlayTextStyle
} from '../src/shared/model/overlay-style'
import {
  CODE_FONT_SIZE,
  CODE_HEADER,
  codeBlockMetrics,
  codeFontSize,
  codeMinNodeSize,
  setCodeFontSizeBase,
  CODE_LINE_RATIO,
  CODE_PADDING_X,
  CODE_PADDING_Y,
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
import JSZip from 'jszip'
import { parseXmind } from '../src/shared/xmind/parse'
import { serializeXmind } from '../src/shared/xmind/serialize'
import { parseLegacyContent } from '../src/shared/xmind/legacy'
import { childOf, childText, childrenOf, parseXml } from '../src/shared/xmind/xml'

import type { MindPackage, Topic, Workbook } from '../src/shared/model/types'

/* ---- D1 拆分：断言原语搬进 ./selfcheck/harness.ts，按域拆分的其它文件共用它 ---- */
import { check, eq, firstDiff, group, normalize, stats } from './selfcheck/harness'

/* ---- D1 拆分：共享测试助手搬进 ./selfcheck/helpers.ts（域文件也从那里取） ---- */
import {
  store,
  root,
  find,
  reset,
  addChildOf,
  fakeMeasure,
  LEGACY_XML,
  VER2_DOC
} from './selfcheck/helpers'

/* ---- D1 拆分：域 testInit/testAddAndCommit/testCommitGuard/testCommitAndAdd/testUndoRedo/testDelete/testMove/testMoveMany 搬进 ./selfcheck/domains/edit.ts ---- */
import {
  testInit,
  testAddAndCommit,
  testCommitGuard,
  testCommitAndAdd,
  testUndoRedo,
  testDelete,
  testMove,
  testMoveMany
} from './selfcheck/domains/edit'

/* ---- D1 拆分：域 testSortAndDedupe/testNodeDrag/testCollapseSelection/testUndoGranularity/testStructureIsCanvasLevel/testUndoSelectionAndRelayout 搬进 ./selfcheck/domains/canvas.ts ---- */
import {
  testSortAndDedupe,
  testNodeDrag,
  testCollapseSelection,
  testUndoGranularity,
  testStructureIsCanvasLevel,
  testUndoSelectionAndRelayout
} from './selfcheck/domains/canvas'

/* ---- D1 拆分：域 testOverlayReserve/testIncrementalLayout/testLayoutNoOverlap/testLayout/testStructures/testOverlays/testOverlayToggles 搬进 ./selfcheck/domains/layout.ts ---- */
import {
  testOverlayReserve,
  testIncrementalLayout,
  testLayoutNoOverlap,
  testLayout,
  testOverlays,
  testOverlayToggles,
  testStructures
} from './selfcheck/domains/layout'

/* ---- D1 拆分：域 testAiChatHelpers/testAgentHelpers/testLicenseHelpers 搬进 ./selfcheck/domains/ai.ts ---- */
import { testAiChatHelpers, testAgentHelpers, testLicenseHelpers } from './selfcheck/domains/ai'

/* ---- D1 拆分：域 testAgentTools/testAttachmentTools/testWriteToolsAndTurn/testAi 搬进 ./selfcheck/domains/agent.ts ---- */
import {
  testAgentTools,
  testAttachmentTools,
  testWriteToolsAndTurn,
  testAi
} from './selfcheck/domains/agent'

/* ---- D1 拆分：域 testMarkdownFullFormat/testMarkdownRoundTrip/testExportDrawing/testExportFormats/testMeasureStyles/testDocument/testImport/testOutline/testSearch 搬进 ./selfcheck/domains/io.ts ---- */
import {
  testMarkdownFullFormat,
  testMarkdownRoundTrip,
  testOutline,
  testSearch,
  testExportDrawing,
  testExportFormats,
  testMeasureStyles,
  testDocument,
  testImport
} from './selfcheck/domains/io'

/* ---- D1 拆分：域 testMisc/testTypedChar/testDefaultStyles/testTabs/testMultiWindow/testPickDocumentArg/testViewLock/testSnapshot/testSnapshots/testRichText/testTheme/testDefaultTheme/testThemeRoundTrip/testSafetyHelpers/testRecovery/testRoundTrip/testFoldSidesRoundTrip/testUnknownPassthrough/testNaming/testHistory 搬进 ./selfcheck/domains/ui.ts ---- */
import {
  testSafetyHelpers,
  testMisc,
  testTypedChar,
  testDefaultStyles,
  testTabs,
  testMultiWindow,
  testPickDocumentArg,
  testViewLock,
  testSnapshot,
  testRichText,
  testTheme,
  testDefaultTheme,
  testThemeRoundTrip,
  testRoundTrip,
  testFoldSidesRoundTrip,
  testUnknownPassthrough,
  testRecovery,
  testNaming,
  testHistory,
  testSnapshots
} from './selfcheck/domains/ui'

/* ------------------------------------------------------------------ */
/* 便捷访问                                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 1. 初始化                                                           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 2. 新建 + 编辑 + 提交                                               */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 3. commitEdit 归属校验（上一轮修过的关键缺陷）                       */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 4. 编辑中按 Enter / Tab                                             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 5. 撤销 / 重做                                                      */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 6. 删除与恢复                                                       */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 7. 移动与循环保护                                                   */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 7.2 批量移动（AI 的 moveTopics 走这里）                             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 7.3 同级排序与合并同名（AI 的 sortSiblings / mergeDuplicates 走这里） */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 7.5 拖拽落点：拖到兄弟上排序、拖到其它节点上成为子主题（Xmind 同款）  */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 7.5b 折叠与选择：藏在折叠子树里的选中项要提到折叠节点上              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 7.6 撤销粒度统一 + 编辑态同源                                        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 7.7 安全与健壮性的纯逻辑：原子写 / 外部数据收敛 / IPC 入参            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 7.8 AI 聊天面板的纯逻辑：骨架摘要 / 系统提示词 / 流式解析            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 7.9 Agent 纯逻辑：节点引用切分 / 聊天记录校验                        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 7.10 许可与试用：格式 / 签名 / 闸门（商业化基建）                    */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 7.10 Agent 工具层：分片累积 / 线格式 / 寻址 / 只读工具 / 循环上限     */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 7.11 写工具与「一次命令 = 一步撤销」的事务                            */
/* ------------------------------------------------------------------ */

/**
 * 第二批写工具映射到的 store 动作。
 *
 * 规划里的纪律是「每个工具必须映射到**已验证**的 store 动作」——这一组就是那个"已验证"。
 * 重点盯两件对模型至关重要的事：**幂等**（重试不会增删）与**整体替换**（不是 toggle）。
 */

/* ------------------------------------------------------------------ */
/* 8. 复制粘贴 / 折叠 / 结构 / 自由定位                                 */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 8.5c 「直接打字即编辑」注入字符的寄存（输入法让位用）                 */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 8.5e 结构是画布级：子节点自己声明的结构一律忽略                      */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 8.5f 分支级结构：矩阵 / 括号 / 时间轴 / 树状表格                     */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 8.5g 撤销保留框选 / 恢复自动布局                                    */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 8.5h 布局正确性：自动布局绝不允许节点重叠                            */
/* ------------------------------------------------------------------ */

/** 模拟真实测量的「多行换行」：宽度封顶、行数随标题长度增长 */

/* ------------------------------------------------------------------ */
/* 全结构 × 全形态审计：连线不许穿过节点                                */
/* ------------------------------------------------------------------ */

/**
 * 连线路径里的正交直线段。
 *
 * 只取 M/L/H/V：结构里的父子连线是直线或折线；曲线（逻辑图 / 思维导图的贝塞尔）
 * 走的是父子之间的空档，不参与这套检查。
 */

/* ------------------------------------------------------------------ */
/* 增量布局                                                            */
/* ------------------------------------------------------------------ */

/**
 * 布局结果的**逐字段摘要**。
 *
 * 「增量 == 全量」必须比到每一个数字上：坐标、尺寸、层数、左右归属、换行后的文字、
 * 每一条连线的 path、每一根装饰线、边界/概要/关系线的几何、画布尺寸、分支配色。
 * 只比"节点数一样"是抓不出"某一支停在上一次的位置"这类问题的。
 */

/* ------------------------------------------------------------------ */
/* 8.5h Markdown：Typora 全格式行内语法                                 */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 8.5i Markdown 导出 → 导入往返                                       */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 8.5i 默认文字样式：新建节点套用 / 应用到全部                          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 8.5h 多文档标签：快照切换 / 隔离 / 去重 / 排序                        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 8.5g 多窗口：路径判定与自动存档槽位                                  */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 8.5d 「从文件管理器打开」：命令行参数识别                             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 8.5b 视角锁定（视图状态，与文档内容无关）                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 8.5 落盘快照：正在输入的文本不能丢                                   */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 8.6 富文本数据层                                                    */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 8.7 主题系统                                                        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 默认主题：新建文档要能套用                                          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 9. 布局引擎                                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 10. .xmind 往返保真                                                 */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 10b. 平衡图「左右分别收起」的 .xmind 往返                            */
/* ------------------------------------------------------------------ */

/**
 * 收起标记存在 `topic.style.properties` 的私有键里（与 `TOPIC_SIDE_KEY` 同一套做法：
 * Xmind 忽略不认识的键、我们原样往返），所以它必须跟着 style 一起保存/打开——
 * 这里真跑一遍，确认收起状态不丢、被收起的节点数据也还在。
 */

/* ------------------------------------------------------------------ */
/* 11. 未知字段透传                                                    */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 12. 崩溃恢复判定                                                    */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 12.5 节点附加元素                                                   */
/* ------------------------------------------------------------------ */

async function testNodeElements(): Promise<void> {
  group('节点元素：标记图标映射')

  const priority1 = markerVisualOf('priority-1')
  check(
    '优先级渲染成数字徽标',
    priority1.kind === 'priority' && priority1.text === '1',
    JSON.stringify(priority1)
  )
  eq('优先级 1 用红色', priority1.kind === 'priority' ? priority1.color : '', '#EB5757')
  const priority5 = markerVisualOf('priority-5')
  check(
    '不同优先级颜色不同',
    priority5.kind === 'priority' &&
      priority1.kind === 'priority' &&
      priority5.color !== priority1.color
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

  group('标记：同一行（同一类别）只能有一个')

  check(
    '分组表里的标记都有中文名',
    ALL_PICKABLE_MARKERS.every((id) => typeof MARKER_LABELS[id] === 'string'),
    ALL_PICKABLE_MARKERS.filter((id) => typeof MARKER_LABELS[id] !== 'string').join(',')
  )
  eq('同一个标记不会出现在两行里', ALL_PICKABLE_MARKERS.length, new Set(ALL_PICKABLE_MARKERS).size)
  check(
    '分组表每一行都不空',
    MARKER_GROUPS.every((item) => item.title.length > 0 && item.markers.length > 0)
  )
  eq('优先级属于「优先级」这一行', markerGroupOf('priority-3'), '优先级')
  eq('表外的标记自成一族（不误伤，也不会被抹掉）', markerGroupOf('自定义标记'), null)

  eq('同组互斥：选了 3，之前选的 1 就该消失', withMarkerToggled(['priority-1'], 'priority-3'), [
    'priority-3'
  ])
  eq('再点一次是取消', withMarkerToggled(['priority-3'], 'priority-3'), [])
  eq(
    '不同类别互相独立（优先级 + 进度 + 星标可以并存）',
    withMarkerToggled(withMarkerToggled(['priority-1'], 'task-done'), 'star-red'),
    ['priority-1', 'task-done', 'star-red']
  )
  eq('自定义标记不会顶掉表里的标记', withMarkerToggled(['priority-1', '自定义'], '自定义'), [
    'priority-1'
  ])
  eq(
    '整体替换时同组只留第一个',
    reconcileMarkers(['priority-1', 'task-done', 'priority-3', 'priority-1']),
    ['priority-1', 'task-done']
  )
  eq('空白 id 被丢掉', reconcileMarkers([' ', 'crown']), ['crown'])

  group('节点元素：编辑操作')

  reset()
  const rootId = root().id
  const id = addChildOf(rootId, '测试节点')

  store().toggleMarker(id, 'priority-1')
  store().toggleMarker(id, 'star-red')
  eq(
    '添加了两个标记',
    find(id)?.markers.map((marker) => marker.markerId),
    ['priority-1', 'star-red']
  )
  store().toggleMarker(id, 'priority-1')
  eq(
    '再次点击移除标记',
    find(id)?.markers.map((marker) => marker.markerId),
    ['star-red']
  )
  // 同一行只能有一个：点同组的另一个是**替换**
  store().toggleMarker(id, 'priority-3')
  eq(
    '点同组的另一个 = 替换（优先级不会同时亮两个）',
    find(id)?.markers.map((marker) => marker.markerId),
    ['star-red', 'priority-3']
  )
  store().toggleMarker(id, 'priority-3')
  eq(
    '再点一次取消，状态回到原样',
    find(id)?.markers.map((marker) => marker.markerId),
    ['star-red']
  )

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
  check(
    '备注同时派生出 HTML',
    (find(id)?.notesHtml ?? '').includes('<br/>'),
    String(find(id)?.notesHtml)
  )
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
  eq(
    '撤销能去掉标记',
    find(id)?.markers.map((marker) => marker.markerId),
    ['star-red']
  )
  store().redo()
  eq(
    '重做能恢复标记',
    find(id)?.markers.map((marker) => marker.markerId),
    ['star-red', 'flag-blue']
  )

  store().addLabel(id, '已确认')
  store().setNotes(id, '备注内容')

  const before = normalize(store().workbook)
  const parsed = await parseXmind(
    await serializeXmind({ workbook: store().workbook, resources: {} } as MindPackage)
  )
  check(
    '带附加元素的文档往返一致',
    normalize(parsed.workbook) === before,
    firstDiff(normalize(store().workbook, 2), normalize(parsed.workbook, 2))
  )

  const roundTopic = findTopic(activeRoot(parsed.workbook), id)
  eq(
    '往返保留标记',
    roundTopic?.markers.map((marker) => marker.markerId),
    ['star-red', 'flag-blue']
  )
  eq('往返保留标签', roundTopic?.labels, ['待办', '已确认'])
  eq('往返保留备注', roundTopic?.notes, '备注内容')
  check(
    '往返保留备注 HTML',
    typeof roundTopic?.notesHtml === 'string' && roundTopic.notesHtml.length > 0
  )
}

/* ------------------------------------------------------------------ */
/* 12.5b 节点内图片 / 附件 / 公式                                       */
/* ------------------------------------------------------------------ */

async function testMediaElements(): Promise<void> {
  group('图片与公式：尺寸规则')

  eq('没有图片时尺寸为 0', imageBoxSize(undefined), { width: 0, height: 0 })
  eq(
    '超大图片按最大宽度等比缩小',
    imageBoxSize({ path: 'resources/a.png', width: 400, height: 300 }),
    {
      width: 220,
      height: 165
    }
  )
  const tall = imageBoxSize({ path: 'resources/a.png', width: 100, height: 1000 })
  check('超高图片受最大高度限制', tall.height === IMAGE_MAX_HEIGHT, JSON.stringify(tall))
  check(
    '缩放后仍然小于等于上限',
    tall.width <= 220 && tall.height <= IMAGE_MAX_HEIGHT,
    JSON.stringify(tall)
  )

  const onlyWidth = imageBoxSize({ path: 'resources/a.png', width: 200 })
  eq('只给宽度时按 4:3 补高度', onlyWidth, { width: 200, height: 150 })
  const onlyHeight = imageBoxSize({ path: 'resources/a.png', height: 150 })
  eq('只给高度时按 4:3 补宽度', onlyHeight, { width: 200, height: 150 })
  eq('尺寸完全未知时用兜底框', imageBoxSize({ path: 'resources/a.png' }), { ...IMAGE_FALLBACK })
  eq('0 尺寸视为未知', imageBoxSize({ path: 'resources/a.png', width: 0, height: 0 }), {
    ...IMAGE_FALLBACK
  })

  const smallFormula = pureFormulaSize('x', 14)
  const longFormula = pureFormulaSize('\\sum_{i=1}^{n} \\frac{a_i}{b_i} \\cdot \\sqrt{x^2+y^2}', 14)
  check(
    '公式估算宽度为正',
    smallFormula.width > 0 && smallFormula.height > 0,
    JSON.stringify(smallFormula)
  )
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
    '行数不封顶：30 行就按 30 行算高（完整展示，不滚动）',
    many.height === CODE_HEADER + CODE_PADDING_Y * 2 + 30 * lineH,
    JSON.stringify(many)
  )
  const longLine = codeBoxSize({ language: '', text: 'x'.repeat(200) })
  check(
    '超宽行按内容铺开（不截断、不省略）',
    longLine.width === Math.round(200 * CODE_FONT_SIZE * 0.6) + CODE_PADDING_X * 2,
    JSON.stringify(longLine)
  )
  const cjk = codeBoxSize({ language: '', text: '中文变量名测试' })
  const ascii = codeBoxSize({ language: '', text: 'abcdefgabcdefg' })
  check(
    'CJK 记双宽：7 个中文字符 == 14 个 ASCII 字符',
    cjk.width === ascii.width && cjk.width > 96,
    `${cjk.width} vs ${ascii.width}`
  )
  const empty = codeBoxSize({ language: 'text', text: '' })
  check(
    '空文本也保留一行的最小框',
    empty.height === CODE_HEADER + CODE_PADDING_Y * 2 + lineH,
    JSON.stringify(empty)
  )

  // 手动拉伸节点：代码块要像图片一样等比缩放（字号/行高/内边距一起缩），
  // 缩完必须**待在给定空间里**——否则就是用户报的"拉伸后代码块跑到节点外面去了"
  {
    const block = {
      language: 'python',
      text: Array.from({ length: 12 }, () => 'print("hello world")').join('\n')
    }
    const natural = codeBlockMetrics(block)!
    eq('不给空间时保持自然尺寸', natural.scale, 1)

    // 空间比自然尺寸小 → 缩小；缩完要落在给定空间里
    const tight = codeBlockMetrics(block, { width: 150, height: 300 })!
    check('空间不够时缩小', tight.scale < 1, String(tight.scale))
    check('缩完落在给定宽度内', tight.width <= 150, `${tight.width} > 150`)
    check('缩完落在给定高度内', tight.height <= 300, `${tight.height} > 300`)
    check(
      '字号/行高/内边距一起缩（不是只改尺寸）',
      tight.fontSize < natural.fontSize &&
        tight.paddingX < natural.paddingX &&
        tight.header < natural.header,
      JSON.stringify(tight)
    )

    const roomy = codeBlockMetrics(block, { width: 4000, height: 4000 })!
    check('空间很大时最多放大到上限', roomy.scale <= 2 && roomy.scale > 1, String(roomy.scale))
    check(
      '放大后字号跟着变大',
      roomy.fontSize > natural.fontSize,
      `${roomy.fontSize} vs ${natural.fontSize}`
    )

    const tiny = codeBlockMetrics(block, { width: 10, height: 10 })!
    check('再挤也不会缩到看不清（下限 0.5）', tiny.scale >= 0.5, String(tiny.scale))
    check('没有代码时没有指标', codeBlockMetrics(undefined) === null)

    // 节点框不能比代码块还小（否则代码块会溢出到框外）
    const min = codeMinNodeSize({ language: 'python', text: 'print("hi")' }, { x: 14, y: 9 })!
    const floor = codeBlockMetrics(
      { language: 'python', text: 'print("hi")' },
      { width: 1, height: 1 }
    )!
    eq('最小宽度 = 代码块下限宽 + 内边距', min.width, floor.width + 14 * 2)
    eq('最小高度 = 代码块下限高 + 内边距', min.height, floor.height + 9 * 2)
    check('最小尺寸确实小于自然尺寸（只是兜底）', min.width < natural.width)
    check('没有代码时没有最小尺寸', codeMinNodeSize(undefined, { x: 14, y: 9 }) === null)
  }

  // 「默认样式」面板的代码块基准字号：改基准后整套指标（字号/行高/框宽）都要跟着走
  group('代码块：基准字号（默认样式）')

  eq('默认等于内置字号', codeFontSize(), CODE_FONT_SIZE)
  setCodeFontSizeBase(16)
  eq('设置后生效', codeFontSize(), 16)
  const bigger = codeBlockMetrics({ language: 'ts', text: 'const a = 1' })!
  eq('自然尺寸的字号用基准', bigger.fontSize, 16)
  check('框宽随字号变大', bigger.width > oneLine.width, `${bigger.width} vs ${oneLine.width}`)
  setCodeFontSizeBase(null)
  eq('null 回到内置', codeFontSize(), CODE_FONT_SIZE)
  eq(
    '恢复后指标复原',
    codeBlockMetrics({ language: 'ts', text: 'const a = 1' })!.width,
    oneLine.width
  )

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
  check(
    '拉伸后图片变大',
    grown.width > autoImage.width && grown.height > autoImage.height,
    JSON.stringify(grown)
  )
  check(
    '仍然保持 4:3 比例',
    Math.abs(grown.width / grown.height - 4 / 3) < 0.05,
    `${grown.width}×${grown.height}`
  )
  check('不会超出节点可用宽度', grown.width <= 560 - 14 * 2, String(grown.width))

  store().setSizeOverride(imgNode, { width: 180, height: 180 })
  const shrunk = layoutSheet(root(), fakeMeasure).nodeMap.get(imgNode)!.imageBox!
  check('缩小节点时图片跟着变小', shrunk.width < autoImage.width, JSON.stringify(shrunk))

  group('手动拉伸：公式节点的外框不会小于公式')

  reset()
  const fxRoot = root().id
  const fxNode = addChildOf(fxRoot, '公式节点')
  const FX_SOURCE = '\\theta_{i+1} = \\theta_i - \\alpha\\sum_{j=0}^{m}'
  store().mutate((draft) => {
    const topic = findTopic(activeRoot(draft), fxNode)
    if (topic) topic.formula = FX_SOURCE
  }, '加公式')

  // 自检环境没有 DOM（公式用 pureFormulaSize 估算、fakeMeasure 用 16px 占位），
  // 这里验证 store 的钳制：疯狂往小拖时，外框会被抬到「公式框 + 内边距」以上
  const fxBox = pureFormulaSize(FX_SOURCE, 15) // depth=1 → 基准字号 15
  store().setSizeOverride(fxNode, { width: 40, height: 30 })
  const override = findTopic(root(), fxNode)?.sizeOverride
  check(
    '宽度被钳到不小于公式宽 + 内边距',
    (override?.width ?? 0) >= fxBox.width + 28,
    String(override?.width)
  )
  check(
    '高度被钳到不小于「公式高 + 一行标题 + 间隔 + 内边距」',
    (override?.height ?? 0) >= fxBox.height + 24 + 6 + 18,
    String(override?.height)
  )
  store().setSizeOverride(fxNode, null)
  eq('恢复自动尺寸', findTopic(root(), fxNode)?.sizeOverride, undefined)

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
    eq(
      'Xmind 风格的 14px 也能读',
      readOverlayFontSize({ properties: { 'fo:font-size': '14px' } }, 13),
      14
    )
    eq(
      '恢复默认后样式被清空',
      withOverlayTextStyle(styled, { fontSize: 0, bold: undefined, italic: false, color: '' }),
      undefined
    )
    eq(
      '没写过样式就用元素默认值',
      readOverlayTextStyle(undefined, { fontSize: 13, bold: true }).bold,
      true
    )

    // 空标题也要有可点区域（否则删空文字就再也点不到概要）
    const emptySize = estimateOverlayLabelSize('', 13)
    check(
      '空标题也给一块命中区',
      emptySize.width > 0 && emptySize.height > 0,
      JSON.stringify(emptySize)
    )
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
    const styledSummary = activeSheet(store().workbook).summaries.find(
      (item) => item.id === ovSummary
    )!
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
  check(
    '标记不再出现在顶部图标行',
    markedBox.accessory.items.every((item) => item.kind !== 'marker')
  )
  check('无标记的节点没有标记条', (plainBox.markerStrip?.markerIds.length ?? 0) === 0)
  eq('标记条尺寸与分列规则一致', markedBox.markerStrip?.width, markerStripSize(2).width)
  check(
    '标记很多时最多两列（不会盖到隔壁）',
    markerStripSize(10).width <= 2 * 16 + 3,
    JSON.stringify(markerStripSize(10))
  )
  check('标记很多时往高度涨', markerStripSize(10).height > markerStripSize(4).height)

  group('代码块：语法高亮')

  // 铁律：分词首尾拼回去必须与原文逐字节相同（否则画出来和源码不一致）
  const samples: Array<[string, string]> = [
    ['python', 'def add(a, b):\n    # 求和\n    return a + b  # 注释\n\nprint("结果:", add(1, 2))'],
    [
      'typescript',
      'const sum = (a: number, b: number): number => a + b\nexport default class Foo {}\n/* 块注释\n   跨行 */'
    ],
    ['javascript', '// hi\nconst x = "文本"\nlet n = 1e3 + 0x1f'],
    ['json', '{\n  "name": "小明",\n  "age": 18,\n  "ok": true\n}'],
    ['yaml', '# 配置\nname: 小明\nitems:\n  - a\n  - b\nenabled: true'],
    ['sql', 'SELECT id, name FROM users WHERE age > 18 -- 注释'],
    ['html', '<div class="box" id="a">文本</div>\n<!-- 注释 -->'],
    ['css', '.box { color: #fff; margin: 0 auto; /* x */ }'],
    ['bash', '#!/bin/bash\necho "hi" # 注释'],
    ['go', 'func main() {\n\tfmt.Println("hi")\n}'],
    ['rust', 'fn main() {\n    let x: i32 = 1;\n}'],
    ['java', 'public class Main { public static void main(String[] args) {} }'],
    ['csharp', 'public class A { public int X() { return 1; } }'],
    ['cpp', '#include <iostream>\nint main() { return 0; }'],
    ['c', 'int main(void) { return 0; }'],
    ['text', '任何内容\n都不高亮'],
    ['', '未知语言也不高亮'],
    /**
     * 回归：`@` 与 `\` 曾让分词器**原地打转**（`IDENT_START` 认它们、`IDENT_PART` 不认），
     * 表现是渲染进程 100% CPU、界面永久冻死，而且只在「那块代码第一次进入视口」时才炸
     * ——AI 批量补全 Python 代码块（装饰器 `@functools.wraps`）时固定触发。
     * 这几条用例既防卡死，也钉住「拼回去逐字节一致」（不许吞字符）。
     */
    ['python', '@functools.wraps(func)\ndef f(): pass'],
    ['python', '装饰器：@语法糖修改函数行为'],
    ['python', 'x = a @ b  # 矩阵乘'],
    ['python', 'C:\\Users\\somebody\\file.txt'],
    ['typescript', 'class A { @decorator prop = 1 }'],
    ['yaml', '@bad: 1'],
    ['json', '{ "a": "b@c" }']
  ]
  for (const [lang, text] of samples) {
    const lines = highlightCode(text, lang)
    const name = lang.length > 0 ? lang : '(空)'
    eq(`${name}：行数一致`, lines.length, text.split('\n').length)
    eq(
      `${name}：分词拼回原文逐字节一致`,
      lines.map((line) => line.tokens.map((token) => token.text).join('')).join('\n'),
      text
    )
  }

  const pyTokens = highlightCode('def add(a, b):  # 求和\n    return a + b', 'python')
  check(
    'python：def 是关键字',
    pyTokens[0].tokens.some((t) => t.text === 'def' && t.kind === 'keyword')
  )
  check(
    'python：函数名被标出',
    pyTokens[0].tokens.some((t) => t.text === 'add' && t.kind === 'function')
  )
  check(
    'python：# 起的是注释',
    pyTokens[0].tokens.some((t) => t.kind === 'comment' && t.text.startsWith('#'))
  )
  check(
    'python：return 是关键字',
    pyTokens[1].tokens.some((t) => t.text === 'return' && t.kind === 'keyword')
  )
  check(
    'python：字符串上色',
    highlightCode('print("hi")', 'python')[0].tokens.some(
      (t) => t.kind === 'string' && t.text === '"hi"'
    )
  )
  check(
    'python：三引号跨行仍是字符串',
    highlightCode('"""文档\n第二行"""', 'python')
      .flatMap((line) => line.tokens)
      .every((token) => token.kind === 'string')
  )
  check(
    'py 别名同样生效',
    highlightCode('def f(): pass', 'py')[0].tokens.some(
      (t) => t.text === 'def' && t.kind === 'keyword'
    )
  )

  const tsTokens = highlightCode(
    'const f = (x: string) => new Map<string, number>()',
    'typescript'
  )[0].tokens
  check(
    'ts：const 是关键字',
    tsTokens.some((t) => t.text === 'const' && t.kind === 'keyword')
  )
  check(
    'ts：内建类名上色（Map）',
    tsTokens.some((t) => t.text === 'Map' && t.kind === 'builtin')
  )
  check(
    'ts：自定义类名按类型上色',
    highlightCode('const f = (x: Foo) => 1', 'typescript')[0].tokens.some(
      (t) => t.text === 'Foo' && t.kind === 'type'
    )
  )
  check(
    'json：键是 property',
    highlightCode('{"a": 1}', 'json')[0].tokens.some(
      (t) => t.text === '"a"' && t.kind === 'property'
    )
  )
  check(
    'yaml：键是 property、true 是字面量',
    (() => {
      const tokens = highlightCode('enabled: true', 'yaml')[0].tokens
      return (
        tokens.some((t) => t.text === 'enabled' && t.kind === 'property') &&
        tokens.some((t) => t.text === 'true' && t.kind === 'literal')
      )
    })()
  )
  check(
    'sql：关键字不区分大小写',
    highlightCode('SELECT * FROM t', 'sql')[0].tokens.some((t) => t.kind === 'keyword')
  )
  check(
    'html：标签与属性分开上色',
    (() => {
      const tokens = highlightCode('<div class="box">', 'html')[0].tokens
      return (
        tokens.some((t) => t.text === 'div' && t.kind === 'tag') &&
        tokens.some((t) => t.text === 'class' && t.kind === 'attr')
      )
    })()
  )
  check(
    '不认识的语言＝整行不分词',
    highlightCode('const a = 1', 'klingon')[0].tokens.every((t) => t.kind === 'plain')
  )
  check(
    '空语言＝不高亮',
    highlightCode('const a = 1', '')[0].tokens.every((t) => t.kind === 'plain')
  )
  check(
    '每种 token 都有颜色',
    (Object.keys(CODE_TOKEN_COLORS) as Array<keyof typeof CODE_TOKEN_COLORS>).every((kind) =>
      /^#[0-9a-f]{6}$/i.test(CODE_TOKEN_COLORS[kind])
    )
  )
  check('空行不产生 token', highlightCode('a\n\nb', 'javascript')[1].tokens.length === 0)

  /**
   * CSS 字符串里的**转义**：`content: "a\"b"` 的 `\"` 不是字符串结尾。
   * 以前 CSS 扫描器只用 `indexOf` 找下一个同类引号，字符串被腰斩在转义引号处，
   * 后半截跟着串色（同族的 data / markup 扫描器都认转义，只有这份漏了）。
   * 顺带钉住"token 首尾相接、原样覆盖整行"这条不变量——串色一旦发生它就会破。
   */
  {
    const cssLine = 'content: "a\\"b"; color: red'
    const tokens = highlightCode(cssLine, 'css')[0]?.tokens ?? []
    const strings = tokens.filter((token) => token.kind === 'string').map((token) => token.text)
    eq('转义引号不断串：整段算一个字符串', strings.length, 1)
    eq('字符串内容完整', strings[0], '"a\\"b"')
    eq(
      'token 首尾相接、覆盖整行（串色的报警器）',
      tokens.map((token) => token.text).join(''),
      cssLine
    )
  }

  /**
   * 语言清单与高亮定义表必须同步。`CODE_LANGUAGES`（UI 下拉 + AI 工具描述的唯一来源）
   * 里每一个都得有 `DEFS` 定义，否则会出现"下拉里能选、高亮却按纯文本处理"。
   * 三处清单以前各写一份、没人保证一致，这条断言把口径钉住。
   *
   * 两个**有意**的例外：`text` 不在 `DEFS` 里（纯文本＝不高亮，是兜底而不是一种语言），
   * `ALIASES` 里 `text / plain / plaintext` 也刻意映射到空串走同一条兜底路径。
   * 这两条是本轮写断言时实测出来的——第一版断言把"全部都要有定义"当契约，直接红了。
   */
  const definedLanguages = CODE_LANGUAGES.filter((language) => language !== 'text')
  check(
    '每种可选语言都有高亮定义（清单不会漂移）',
    definedLanguages.every((language) => Object.hasOwn(DEFS, language)),
    definedLanguages.filter((language) => !Object.hasOwn(DEFS, language)).join(',')
  )
  check(
    '简写别名要么指向已定义的语言、要么指向纯文本兜底（空串）',
    Object.values(ALIASES).every((target) => target === '' || Object.hasOwn(DEFS, target)),
    Object.entries(ALIASES)
      .filter(([, target]) => target !== '' && !Object.hasOwn(DEFS, target))
      .map(([alias]) => alias)
      .join(',')
  )
  check(
    'AI 写代码块的工具描述用的是同一份清单（不是手写散文）',
    (AGENT_WRITE_TOOLS.find((tool) => tool.name === 'setCode')?.description ?? '').includes(
      CODE_LANGUAGES.join(' / ')
    )
  )

  group('标签：过长按测量宽度截断（不切半个字）')

  {
    // 注入字宽：ASCII 6px、CJK 12px、省略号 6px
    const w = (ch: string): number => (ch.charCodeAt(0) > 0xff ? 12 : 6)
    const short = fitLabelText('短标签', w, 100)
    eq('放得下就不动它', short.text, '短标签')
    eq('放得下不标记截断', short.truncated, false)

    const long = fitLabelText('一二三四五六七八九十', w, 61)
    check('过长时截断并补省略号', long.text.endsWith(LABEL_ELLIPSIS), long.text)
    check('截断后宽度不超过上限', long.width <= 61, String(long.width))
    check('标记为已截断', long.truncated)
    eq(
      '宽度与画出来的文字一致',
      long.width,
      [...long.text].reduce((sum, ch) => sum + w(ch), 0)
    )

    const ascii = fitLabelText('abcdefghijklmnop', w, 60)
    check(
      'ASCII 长标签同样截断',
      ascii.truncated && ascii.text.endsWith(LABEL_ELLIPSIS),
      ascii.text
    )

    const tiny = fitLabelText('一二三', w, 10)
    eq('极窄时至少留下省略号', tiny.text, LABEL_ELLIPSIS)
  }

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
  check(
    '分数渲染出分子分母两层',
    rendered.includes('frac-line') || rendered.includes('mfrac'),
    rendered.slice(0, 200)
  )
  check('常用符号能渲染', formulaHtml('\\sqrt{x^2+y^2}').includes('katex'))
  check('求和公式能渲染', formulaHtml('\\sum_{i=1}^{n} i').includes('katex'))
  check(
    '中文混排不报错',
    formulaHtml('\\text{总分} = a + b').includes('katex'),
    formulaHtml('\\text{总分} = a + b').slice(0, 160)
  )

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
  check(
    '无 DOM 时公式尺寸退化为估算值',
    fallbackSize.width > 0 && fallbackSize.height > 0,
    JSON.stringify(fallbackSize)
  )
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

  store().addAttachment(mid, {
    id: 'att-a',
    path: 'resources/att-a-d.docx',
    name: 'd.docx',
    size: 88
  })
  eq(
    '附件写入',
    find(mid)?.attachments.map((a) => a.name),
    ['d.docx']
  )
  store().addAttachment(mid, {
    id: 'att-a2',
    path: 'resources/att-a-d.docx',
    name: 'd.docx',
    size: 88
  })
  eq('同一个资源不会被重复添加', find(mid)?.attachments.length, 1)

  // 重复添加是空操作：撤销应该回到「添加之前」，而不是把附件删掉
  store().undo()
  eq('撤销回到添加附件之前', find(mid)?.attachments.length, 0)
  store().redo()
  eq(
    '重做恢复附件',
    find(mid)?.attachments.map((a) => a.name),
    ['d.docx']
  )

  store().removeAttachment(mid, 'att-a')
  eq('删除附件', find(mid)?.attachments.length, 0)
  store().undo()
  eq(
    '撤销能恢复附件',
    find(mid)?.attachments.map((a) => a.name),
    ['d.docx']
  )

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

  check(
    '带媒体资源的文档往返一致',
    normalize(parsedMedia.workbook) === beforeMedia,
    firstDiff(beforeMedia, normalize(parsedMedia.workbook))
  )
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
  eq(
    '往返保留附件',
    roundMedia?.attachments.map((a) => [a.path, a.name, a.size, a.mime]),
    [['resources/att-z-report.pdf', 'report.pdf', 2048, 'application/pdf']]
  )

  const second = await parseXmind(
    await serializeXmind({ workbook: parsedMedia.workbook, resources: parsedMedia.resources })
  )
  check(
    '二次往返仍然稳定',
    normalize(second.workbook) === beforeMedia,
    firstDiff(beforeMedia, normalize(second.workbook))
  )

  group('图片 / 附件：字段级写法（对齐真实 Xmind）')

  // 直接看生成的 content.json：包内资源引用必须带 xap: 前缀，Xmind 才认得
  const rawZip = await JSZip.loadAsync(zipped)
  const rawJson = JSON.parse(
    (await rawZip.file('content.json')!.async('string')) as string
  ) as Array<{
    rootTopic: { children: { attached: Array<Record<string, unknown>> } }
  }>
  const rawTopics = rawJson[0].rootTopic.children.attached
  const mediaTopic = rawTopics.find((t) => t.image !== undefined) as
    { image: { src: string }; attachments?: Array<{ path: string }> } | undefined
  check(
    '生成的 content.json 里图片用 xap: 前缀',
    mediaTopic?.image.src?.startsWith('xap:resources/') ?? false,
    String(mediaTopic?.image?.src)
  )

  const attachTopic = rawTopics.find((t) => t.attachments !== undefined) as
    { attachments: Array<{ path: string; name: string }> } | undefined
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
  const urlJson = JSON.parse(
    (await urlZip.file('content.json')!.async('string')) as string
  ) as Array<{
    rootTopic: { children: { attached: Array<{ image?: { src: string } }> } }
  }>
  const urlSrc = urlJson[0].rootTopic.children.attached.find((t) => t.image)?.image?.src
  eq('外部 URL 不加 xap: 前缀', urlSrc, 'https://example.com/a.png')
}

/* ------------------------------------------------------------------ */
/* 12.6 画布级元素（关系线 / 边界 / 概要）                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 12.7 开关式创建、线身拖动、框选                                      */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 13. 全部结构的布局不变量                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 12.7 Xmind 8 旧版（content.xml）                                    */
/* ------------------------------------------------------------------ */

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
  check(
    'CDATA 原样保留',
    (childText(notesNode, 'html') ?? '').includes('<b>加粗</b>'),
    childText(notesNode, 'html')
  )

  const markerRefs = childOf(childOf(sheetNode, 'topic'), 'marker-refs')!
  eq('自闭合标签解析成子元素', childrenOf(markerRefs, 'marker-ref').length, 2)
  eq(
    '自闭合标签的属性可读',
    childrenOf(markerRefs, 'marker-ref')[0].attrs['marker-id'],
    'priority-1'
  )
  eq('注释被忽略', parseXml('<a><!-- 注释 --><b/></a>')!.children.length, 1)
  eq('单引号属性也能解析', parseXml(`<a x='1'/>`)!.attrs['x'], '1')
  eq('数字实体', parseXml('<a>&#65;&#x42;</a>')!.text, 'AB')
  check('非 XML 文本返回 null', parseXml('这不是 XML') === null)

  /*
   * 数字字符引用的越界与非法写法（三处解码器以前各写一遍，其中两处会崩）。
   * 这里的口径：**解不出来就原样保留**，绝不抛异常、绝不静默换成别的字符。
   */
  eq('越界码点原样保留（不抛 RangeError）', parseXml('<a>&#x110000;</a>')!.text, '&#x110000;')
  eq('超大十进制引用原样保留', parseXml('<a>&#99999999;</a>')!.text, '&#99999999;')
  eq('NUL 引用原样保留', parseXml('<a>&#0;</a>')!.text, '&#0;')
  eq('合法的非 BMP 字符照常解码', parseXml('<a>&#x1F600;</a>')!.text, '\u{1f600}')
  eq('合成的十六进制写法不被当十进制', parseXml('<a>&#12ab;</a>')!.text, '&#12ab;')
  eq(
    '大写 X 的十六进制引用按 XML 规范原样保留（只认小写 x）',
    parseXml('<a>&#X41;</a>')!.text,
    '&#X41;'
  )
  eq('未知命名实体原样保留', parseXml('<a>&unknown;</a>')!.text, '&unknown;')
  check('只有声明时返回 null', parseXml('<?xml version="1.0"?>') === null)

  /**
   * 闭标签必须**对名字**弹栈。
   * 以前是无条件 `stack.pop()`：错位嵌套时栈顶被误当成"刚闭合的那个"，
   * 后续节点就挂到错误的父级上（导入出来"层级不对"，很难复现）。
   * 用例 `<r><x><y></x><z/></r>`：`</x>` 该闭掉的是 x（y 是它没闭合的子节点），
   * 修复前 `z` 会挂到 x 下，修复后挂到 r 下。
   */
  {
    const malformed = parseXml('<r><x><y></x><z/></r>')!
    eq('错位嵌套：根仍是 r', malformed.local, 'r')
    eq('x 还在 r 下', childOf(malformed, 'x')?.local, 'x')
    eq('y 在 x 下（没被误闭合）', childOf(childOf(malformed, 'x')!, 'y')?.local, 'y')
    eq('z 挂在 r 下（不是错挂到 x 下）', childOf(malformed, 'z')?.local, 'z')
    check('z 不该出现在 x 的孩子里', childOf(childOf(malformed, 'x')!, 'z') === null)
  }
  check('野闭标签被忽略（不破坏已有层级）', parseXml('<r><a/></b></r>')!.children.length === 1)

  group('Xmind 8 旧版：读取')

  const legacy = parseLegacyContent(tree)
  eq('画布数量', legacy.workbook.sheets.length, 1)
  eq('画布标题', legacy.workbook.sheets[0].title, '旧版画布')
  check(
    '给出了旧版兼容提示',
    legacy.warnings.some((w) => w.includes('Xmind 8')),
    legacy.warnings.join(' | ')
  )
  check(
    '提示说明了样式不解析',
    legacy.warnings.some((w) => w.includes('styles.xml')),
    legacy.warnings.join(' | ')
  )

  const legacyRoot = legacy.workbook.sheets[0].rootTopic
  eq('结构类型', legacyRoot.structureClass, 'org.xmind.ui.logic.right')
  eq('标题', legacyRoot.title, '中心 & 主题')
  eq('备注纯文本', legacyRoot.notes, '纯文本备注')
  check(
    '备注 HTML 保留',
    (legacyRoot.notesHtml ?? '').includes('<b>加粗</b>'),
    String(legacyRoot.notesHtml)
  )
  eq('标签', legacyRoot.labels, ['标签A', '标签B'])
  eq(
    '标记',
    legacyRoot.markers.map((m) => m.markerId),
    ['priority-1', 'star-red']
  )
  eq('超链接', legacyRoot.href, 'https://example.com/legacy')
  eq('图片路径剥掉 xap:', legacyRoot.image?.path, 'resources/pic.png')
  eq('图片尺寸', [legacyRoot.image?.width, legacyRoot.image?.height], [120, 80])
  eq(
    '附件',
    legacyRoot.attachments.map((a) => [a.path, a.name, a.size, a.mime]),
    [['attachments/doc.pdf', 'doc.pdf', 2048, 'application/pdf']]
  )
  eq(
    '子主题标题',
    legacyRoot.children.map((c) => c.title),
    ['子主题', '带未知元素']
  )
  check('折叠状态', legacyRoot.children[0].collapsed === true)
  eq(
    '孙主题',
    legacyRoot.children[0].children.map((c) => c.title),
    ['孙主题']
  )
  eq(
    '浮动主题',
    legacyRoot.detachedChildren.map((c) => c.title),
    ['浮动主题']
  )
  eq('svg:x / svg:y 被识别', legacyRoot.detachedChildren[0].position, { x: 30, y: -40 })

  const unknownExt = legacyRoot.children[1].extensions
  check(
    '未知元素被原样保留',
    Array.isArray(unknownExt) && unknownExt.length === 1,
    JSON.stringify(unknownExt)
  )
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
  eq(
    '关系线',
    legacySheet.relationships.map((r) => [r.end1Id, r.end2Id, r.title]),
    [['child-1', 'child-2', '关联']]
  )
  eq(
    '边界',
    legacySheet.boundaries.map((b) => [b.range, b.title]),
    [['(child-1,child-2)', '边界']]
  )
  eq(
    '概要',
    legacySheet.summaries.map((s) => [s.topicId, s.range, s.title]),
    [['child-1', '(child-1,child-2)', '阶段总结']]
  )
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
  eq(
    '升级后附件路径保留',
    upgradedRoot.attachments.map((a) => a.path),
    ['attachments/doc.pdf']
  )
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
  eq(
    '升级保存后：附件字段完整',
    activeRoot(upgradedPkg.workbook).attachments.map((a) => [a.path, a.name]),
    [['attachments/doc.pdf', 'doc.pdf']]
  )
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

/* ------------------------------------------------------------------ */
/* 12.9 检索 / 替换 / 筛选 / 统计 / 多画布                             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 12.10 导出：绘图指令 / SVG / PDF                                     */
/* ------------------------------------------------------------------ */

/** 造一张覆盖各种元素的画布，供导出测试用 */

/* ------------------------------------------------------------------ */
/* 12.11 AI：配置 / 提示词 / 解析 / 错误翻译                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 12.12 画布测量：富文本样式必须带进 segments                            */
/* ------------------------------------------------------------------ */

/**
 * 「编辑态里有颜色、Enter 一提交就恢复黑色」的回归防线。
 *
 * 画布不是画 tiptap 的 DOM，而是按 `node.lines[].segments` 自己渲染，
 * 颜色只能来自测量结果 `segment.color`。`resolveRun` 以前漏了这一项，
 * 于是编辑器里（tiptap 自己渲染）看得见颜色、提交后画布与导出全是主题默认色。
 *
 * 测量要 canvas，这里给个**最小替身**（只验证样式传递，不验证真实字宽），
 * 用完立刻还原，免得全局 document 影响后面的断言。
 */

/* ------------------------------------------------------------------ */
/* 文档 → 导图：格式识别、抽文本、分段                                  */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 12.12 导入：Markdown / OPML 一键生成导图                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 12.13 默认文件名：优先用中心主题的名字                               */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 历史记录 / 常用（纯函数）                                           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 版本快照（纯函数）                                                   */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 亿图脑图（.emmx）                                                   */
/* ------------------------------------------------------------------ */

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
  eq('关系线两端', [sheet.relationships[0].end1Id, sheet.relationships[0].end2Id], ['a1', 'a11'])
  eq('关系线标题去掉换行', sheet.relationships[0].title, '等价')
  eq(
    '富文本颜色被保留',
    sheet.rootTopic.children[1].titleRich?.paragraphs[0]?.runs?.[1]?.color,
    '#f44f3b'
  )
  check(
    '纯文字节点不产生富文本（不写冗余数据）',
    sheet.rootTopic.children[0].titleRich === undefined
  )
  check(
    '有告知兼容性处理',
    parsed.warnings.some((line) => line.includes('亿图脑图'))
  )

  group('亿图脑图：格式识别')

  check(
    'Xmind 的 content.json 不会被误判',
    parseEmmxDocument([{ id: 'x', rootTopic: {} }]) === null
  )
  check('空对象返回 null', parseEmmxDocument({}) === null)
  check(
    'contents 里没有 root 时返回 null',
    parseEmmxDocument({ ver: 2, contents: [{ id: 'a' }] }) === null
  )
  check('非对象返回 null', parseEmmxDocument('nope') === null)
  check('内容项为空数组返回 null', parseEmmxDocument({ ver: 2, contents: [] }) === null)

  group('亿图脑图：专有二进制的文字提取')

  const header = new Uint8Array(600).fill(0x01)
  const body = Buffer.from(
    [
      '这里是正文内容',
      'Vw0E',
      'Tool',
      'XtD',
      'DataFrame',
      'fhj',
      'coze',
      'Python3',
      'self-Host'
    ].join('\u0000'),
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
      check(
        `${name}：中心主题有名字`,
        sheet.rootTopic.title.trim().length > 0,
        sheet.rootTopic.title
      )
      // 打开之后必须还能存回去，否则只是"看起来能开"
      const again = await parseXmind(
        await serializeXmind({ workbook: result.workbook, resources: result.resources })
      )
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
  testMoveMany()
  testSortAndDedupe()
  testNodeDrag()
  testUndoGranularity()
  testCollapseSelection()
  testAiChatHelpers()
  testAgentHelpers()
  testAgentTools()
  testWriteToolsAndTurn()
  testAttachmentTools()
  testLicenseHelpers()
  await testSafetyHelpers()
  testMisc()
  testTypedChar()
  testStructureIsCanvasLevel()
  testMultiWindow()
  testTabs()
  testDefaultStyles()
  testMarkdownFullFormat()
  testUndoSelectionAndRelayout()
  testLayoutNoOverlap()
  testMarkdownRoundTrip()
  testPickDocumentArg()
  testViewLock()
  testSnapshot()
  testRichText()
  testTheme()
  testDefaultTheme()
  testLayout()
  testOverlayReserve()
  testIncrementalLayout()
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
  testMeasureStyles()
  testAi()
  testDocument()
  testImport()
  testNaming()
  testHistory()
  testSnapshots()
  testEmmx()
  await testEmmxSamples()
  await testLegacyPackage()
  await testRoundTrip()
  await testThemeRoundTrip()
  await testFoldSidesRoundTrip()
  await testUnknownPassthrough()

  console.log('\n' + '='.repeat(56))
  const { passed, failures } = stats()
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
