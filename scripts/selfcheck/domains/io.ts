/**
 * 自检域：testMarkdownFullFormat / testMarkdownRoundTrip / testExportDrawing / testExportFormats / testMeasureStyles / testDocument / testImport / testOutline / testSearch（由 scripts/selfcheck.ts 按行范围搬出，行为零变化）。
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
import { themeColorsOf } from '../../../src/renderer/src/store/editor'

import { activeRoot, activeSheet, countTopics, findTopic } from '../../../src/shared/model/tree'
import { createTopic, createWorkbook } from '../../../src/shared/model/factory'

import { layoutSheet } from '../../../src/shared/layout'
import { MARKER_LABELS } from '../../../src/shared/xmind/constants'
import { markerVisualOf, type MarkerGlyph } from '../../../src/renderer/src/render/markers'
import {
  ICON_ART,
  INDICATOR_OPACITY,
  INDICATOR_STROKE_WIDTH,
  MARKER_STROKE_WIDTH,
  type IconName
} from '../../../src/shared/marker-art'
import { buildDrawing } from '../../../src/renderer/src/export/drawing'
import { drawingToSvg } from '../../../src/renderer/src/export/svg'
import {
  KATEX_INLINE_CSS,
  KATEX_INLINED_FONTS
} from '../../../src/renderer/src/export/katex-assets'
import { measureTopic } from '../../../src/renderer/src/render/measure'
import { buildImagePdf } from '../../../src/shared/export/pdf'
import {
  IMAGE_EXPORT_FORMATS,
  IMAGE_EXPORT_SCALES,
  imageExportFormatDef,
  type ImageExportFormat
} from '../../../src/shared/export/types'
import {
  buildDocumentChunkMessages,
  buildDocumentMergeMessages,
  buildDocumentOutlineMessages,
  outlineToTopic
} from '../../../src/shared/ai'
import {
  classifyDocument,
  decodeXmlEntities,
  documentStats,
  extractDocumentText,
  extractDocxText,
  extractPptxText,
  extractXlsxText,
  isZipDocument,
  normalizeDocumentText,
  splitDocument,
  zipEntryPrefixesFor
} from '../../../src/shared/document'
import {
  looksLikeMarkdown,
  parseInlineMarkdown,
  parseMarkdownOutline
} from '../../../src/shared/import/markdown'
import { decodeEntity } from '../../../src/shared/import/markdown/inline'
import { decodeEntityBody, decodeEntityReferences } from '../../../src/shared/entities'
import {
  matchWholeLineMath,
  normalizeFormulaInput,
  splitInlineMath
} from '../../../src/shared/formula'

import { parseOpmlOutline } from '../../../src/shared/import/opml'

import { decodeEntities, parseXml } from '../../../src/shared/xmind/xml'
import {
  OUTLINE_FORMATS,
  buildOutline,
  outlineFormatDef,
  outlineRows,
  toMarkdown,
  toOpml,
  toPlainText,
  type OutlineFormat
} from '../../../src/shared/outline'
import {
  applyTopicFilter,
  collectLabels,
  countOccurrences,
  countTitleMatches,
  hitTopicIds,
  isFilterActive,
  replaceInText,
  searchSheet,
  searchWorkbook,
  sheetStats,
  snippetOf
} from '../../../src/shared/search'
import { runsToHtml } from '../../../src/shared/richtext'
import type { RichText, Topic } from '../../../src/shared/model/types'

/* ---- D1 拆分：断言原语搬进 ./selfcheck/harness.ts，按域拆分的其它文件共用它 ---- */
import { check, eq, group } from '../harness'

/* ---- D1 拆分：共享测试助手搬进 ./selfcheck/helpers.ts（域文件也从那里取） ---- */
import {
  store,
  root,
  sheet,
  find,
  reset,
  addChildOf,
  fakeMeasure,
  buildOutlineSample,
  countSelfClosing,
  buildExportScene
} from '../helpers'

/* ---- D1 拆分：域 testInit/testAddAndCommit/testCommitGuard/testCommitAndAdd/testUndoRedo/testDelete/testMove/testMoveMany 搬进 ./selfcheck/domains/edit.ts ---- */

/* ---- D1 拆分：域 testSortAndDedupe/testNodeDrag/testCollapseSelection/testUndoGranularity/testStructureIsCanvasLevel/testUndoSelectionAndRelayout 搬进 ./selfcheck/domains/canvas.ts ---- */

/* ---- D1 拆分：域 testOverlayReserve/testIncrementalLayout/testLayoutNoOverlap/testLayout/testStructures/testOverlays/testOverlayToggles 搬进 ./selfcheck/domains/layout.ts ---- */

/* ---- D1 拆分：域 testAiChatHelpers/testAgentHelpers/testLicenseHelpers 搬进 ./selfcheck/domains/ai.ts ---- */

/* ---- D1 拆分：域 testAgentTools/testAttachmentTools/testWriteToolsAndTurn/testAi 搬进 ./selfcheck/domains/agent.ts ---- */

export function testMarkdownFullFormat(): void {
  group('Markdown：Typora 全格式行内语法')

  // 高亮 / 上下标
  const highlight = parseInlineMarkdown('这是 ==重点== 内容')
  eq('高亮：文字保留（标记不显示）', highlight.text, '这是 重点 内容')
  check(
    '高亮：标记成 highlight',
    highlight.runs.some((run) => run.highlight === true && run.text === '重点')
  )

  const sup = parseInlineMarkdown('E=mc^2^')
  eq('上标：文字正确', sup.text, 'E=mc2')
  check(
    '上标：script=super',
    sup.runs.some((run) => run.script === 'super' && run.text === '2')
  )

  const sub = parseInlineMarkdown('H~2~O')
  check(
    '下标：script=sub',
    sub.runs.some((run) => run.script === 'sub' && run.text === '2')
  )
  check(
    '删除线仍走 ~~',
    parseInlineMarkdown('~~删掉~~').runs.some((run) => run.strike === true)
  )
  check(
    '加粗/斜体/行内代码仍生效',
    (() => {
      const runs = parseInlineMarkdown('**粗** *斜* `码`').runs
      return (
        runs.some((run) => run.bold) &&
        runs.some((run) => run.italic) &&
        runs.some((run) => run.mono === true)
      )
    })()
  )

  // 孤立的符号不能被当成格式开关（否则 `2 * 3` 之后的文字会整段变斜）
  eq('孤立的 * 保持原样', parseInlineMarkdown('2 * 3 = 6').text, '2 * 3 = 6')
  check('孤立的 * 不产生斜体', !parseInlineMarkdown('2 * 3 = 6').runs.some((run) => run.italic))

  // 转义与实体
  eq('反斜杠转义', parseInlineMarkdown('\\*不是斜体\\*').text, '*不是斜体*')
  eq('HTML 实体解码', parseInlineMarkdown('A &amp; B &lt;C&gt;').text, 'A & B <C>')
  eq('数值实体解码', parseInlineMarkdown('&#65;').text, 'A')

  /*
   * 实体解码：**原语唯一，名字表与查表口径按调用点各自保留**（2026-09-19 收敛最后一份重复）。
   *
   * 以前三处（XML 读取 / XML→纯文本 / Markdown 行内）各写一遍「扫描 + 数字优先 +
   * 解不出保留原文」，现在只有 `shared/entities.ts` 一份；三处的名字表差异是**有意**的
   * （`&nbsp;` 在 XML 里是 U+00A0，在「XML → 纯文本」和 Markdown 里当普通空格；
   * XML 读取不折叠大小写、另两处折叠），这里逐条钉住，免得以后被"顺手统一"。
   */
  group('实体解码：原语唯一，名字表与口径各自保留')

  eq(
    '原语：不认识的命名实体原样还原',
    decodeEntityBody('unknown', () => null),
    '&unknown;'
  )
  eq(
    '原语：数字引用优先于名字表',
    decodeEntityBody('#65', () => 'X'),
    'A'
  )
  eq(
    '原语：扫描整段、不认识的原样留着',
    decodeEntityReferences('A &amp; B &#65; C', () => null),
    'A &amp; B A C'
  )

  eq('XML 读取：&nbsp; → U+00A0', decodeEntities('&nbsp;'), '\u00a0')
  eq('XML→纯文本：&nbsp; → 普通空格', decodeXmlEntities('&nbsp;'), ' ')
  eq('Markdown：&nbsp; → 普通空格', decodeEntity('nbsp'), ' ')

  eq('XML 读取不折叠大小写（&AMP; 原样保留）', decodeEntities('&AMP;'), '&AMP;')
  eq('XML→纯文本折叠大小写（&AMP; → &）', decodeXmlEntities('&AMP;'), '&')
  eq('Markdown 同样折叠', decodeEntity('AMP'), '&')

  eq('三处共同的底线：越界码点原样保留', decodeEntities('&#x110000;'), '&#x110000;')
  eq('三处共同的底线：合成十六进制写法不当十进制', decodeXmlEntities('&#12ab;'), '&#12ab;')
  eq('三处共同的底线：NUL 引用原样保留', parseInlineMarkdown('&#0;').text, '&#0;')

  // 行内 HTML
  check(
    '行内 <u> → 下划线',
    parseInlineMarkdown('<u>下划线</u>').runs.some(
      (run) => run.underline === true && run.text === '下划线'
    )
  )
  check(
    '行内 <sup> → 上标',
    parseInlineMarkdown('x<sup>2</sup>').runs.some(
      (run) => run.script === 'super' && run.text === '2'
    )
  )
  check(
    '行内 <mark> → 高亮',
    parseInlineMarkdown('a<mark>亮</mark>b').runs.some(
      (run) => run.highlight === true && run.text === '亮'
    )
  )
  eq('不认识的标签被剥掉', parseInlineMarkdown('a<span class="x">b</span>').text, 'ab')

  // 脚注
  const footnote = parseInlineMarkdown('结论[^1]')
  eq('脚注引用：进入脚注列表', footnote.usedFootnotes, ['1'])
  check(
    '脚注引用：渲染成上标',
    footnote.runs.some((run) => run.script === 'super' && run.text === '[^1]')
  )

  // 整篇：脚注定义进备注、[TOC] 跳过、引用式链接解析
  const doc = [
    '# 标题',
    '',
    '[TOC]',
    '',
    '- 正文引用[^note]',
    '- 也支持 [引用式链接][ref]',
    '',
    '[^note]: 脚注的说明文字',
    '[ref]: https://example.com/ref'
  ].join('\n')
  const parsed = parseMarkdownOutline(doc)
  eq('三个节点（[TOC] 与定义行不生成节点）', parsed.count, 3)
  const footnoteItem = parsed.root?.children.find((child) => child.title.includes('正文引用'))
  check(
    '脚注定义补进该节点备注',
    Boolean(footnoteItem?.notes?.includes('脚注的说明文字')),
    footnoteItem?.notes
  )
  const refItem = parsed.root?.children.find((child) => child.title.includes('引用式链接'))
  eq('引用式链接挂到节点超链接', refItem?.href, 'https://example.com/ref')

  // 段落（非标题/列表）里的脚注，也要把定义带进备注
  const bodyDoc = parseMarkdownOutline('# 标题\n\n正文里提到一句[^a]\n\n[^a]: 段落脚注说明')
  check(
    '段落里的脚注也把定义带进备注',
    Boolean(bodyDoc.root?.notes?.includes('段落脚注说明')),
    bodyDoc.root?.notes
  )

  // 导出 → 导入往返：高亮与上下标都不能丢
  const richTopic: Topic = {
    id: 't-chem',
    title: '化学式 H2O',
    titleRich: {
      paragraphs: [
        {
          runs: [
            { text: '化学式 H' },
            { text: '2', script: 'sub' },
            { text: 'O 与 ' },
            { text: '重点', highlight: true },
            { text: ' 与 x' },
            { text: '2', script: 'super' }
          ]
        }
      ]
    },
    children: [],
    detachedChildren: [],
    labels: [],
    markers: [],
    attachments: []
  }
  const md = toMarkdown(richTopic)
  check('下标导出为 ~2~', md.includes('~2~'), md)
  check('上标导出为 ^2^', md.includes('^2^'), md)
  check('高亮导出为 ==重点==', md.includes('==重点=='), md)
  const back = parseMarkdownOutline(md)
  const backRuns = back.root?.rich?.paragraphs[0]?.runs ?? []
  check(
    '往返：下标回到富文本',
    backRuns.some((run) => run.script === 'sub' && run.text === '2')
  )
  check(
    '往返：上标回到富文本',
    backRuns.some((run) => run.script === 'super' && run.text === '2')
  )
  check(
    '往返：高亮回到富文本',
    backRuns.some((run) => run.highlight === true && run.text === '重点')
  )

  // 粘贴 Markdown 片段：run → HTML（编辑器按自己的 schema 解析成带 mark 的文本）
  const html = runsToHtml(parseInlineMarkdown('==高亮== 与 ^上标^ 与 ~~删~~ 与 <b>粗</b>').runs)
  check('HTML：高亮转 <mark>', html.includes('<mark>高亮</mark>'), html)
  check('HTML：上标转 <sup>', html.includes('<sup>上标</sup>'), html)
  check('HTML：删除线转 <s>', html.includes('<s>删</s>'), html)
  check('HTML：加粗转 <strong>', html.includes('<strong>粗</strong>'), html)
  check(
    'HTML：内容被转义（不能逃出标签）',
    runsToHtml([{ text: '<script>x</script>' }]) === '&lt;script&gt;x&lt;/script&gt;',
    runsToHtml([{ text: '<script>x</script>' }])
  )
  check('HTML：换行转 <br>', runsToHtml([{ text: 'a\nb' }]) === 'a<br>b')

  // 粘贴时"要不要按语法解析"的判定
  check('识别：==高亮==', looksLikeMarkdown('这是 ==高亮=='))
  check('识别：A[^1] 脚注', looksLikeMarkdown('结论 A[^1]'))
  check('识别：H~2~O 下标', looksLikeMarkdown('H~2~O'))
  check('识别：x^2^ 上标', looksLikeMarkdown('E=mc^2^'))
  check('识别：**粗体** 与 `代码`', looksLikeMarkdown('**粗** 和 `code`'))
  check('识别：普通算式不算', !looksLikeMarkdown('2 * 3 = 6'))
  check('识别：单独的波浪线不算', !looksLikeMarkdown('路径 ~/docs'))
  check('识别：普通句子不算', !looksLikeMarkdown('今天天气不错'))
}

export function testMarkdownRoundTrip(): void {
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
  eq('往返：公式回到节点', importedPlan?.children.find((child) => child.formula)?.formula, 'E=mc^2')
  const importedRich = importedPlan?.children.find((child) => child.rich)
  check('往返：粗体进富文本', importedRich?.rich?.paragraphs[0]?.runs[0]?.bold === true)
  eq('往返：节点数一致', parsed.count, countTopics(root()))

  /*
   * 标题里的 Markdown 记号必须转义，否则往返一趟文字就变了：
   * `3*4` 会被读成斜体、`[草稿]` 会被读成链接。
   */
  group('Markdown 导出：正文里的记号要转义')

  const escapeRoot = createTopic('中心')
  escapeRoot.children = [
    createTopic('3*4=12'),
    createTopic('a_b 与 [草稿]'),
    createTopic('井号 # 与竖线 |')
  ]
  const escapeMd = toMarkdown(escapeRoot)
  const back = parseMarkdownOutline(escapeMd)
  eq(
    '转义后往返：记号原样保留',
    back.root?.children.map((topic) => topic.title),
    ['3*4=12', 'a_b 与 [草稿]', '井号 # 与竖线 |']
  )

  // 富文本正文里的记号同样要转义（否则会被周围的文字当成格式标记）
  const richEscape = createTopic('中心')
  const starry = createTopic('x')
  starry.titleRich = { paragraphs: [{ runs: [{ text: '2*3 星号', bold: true }] }] }
  richEscape.children = [starry]
  const richBack = parseMarkdownOutline(toMarkdown(richEscape))
  eq('富文本正文里的星号不被当成标记', richBack.root?.children[0]?.title, '2*3 星号')
  check(
    '富文本的粗体照样往返',
    richBack.root?.children[0]?.rich?.paragraphs[0]?.runs[0]?.bold === true
  )

  /*
   * 删除线与下标冲突（`~~x~~` 与 `~x~` 共用同一个字符，行内扫描器是平的）：
   * 这是**方言限制**，不是可以"两个都留"的地方——这里把取舍钉死，
   * 免得以后有人以为漏了分支。
   */
  group('Markdown 导出：删除线与下标冲突时保删除线')

  const conflict = createTopic('中心')
  const both = createTopic('x')
  both.titleRich = {
    paragraphs: [{ runs: [{ text: '下标删除线', strike: true, script: 'sub' }] }]
  }
  conflict.children = [both]
  const conflictMd = toMarkdown(conflict)
  check('删除线优先（写成 ~~…~~）', conflictMd.includes('~~下标删除线~~'), conflictMd)
}

export function testOutline(): void {
  group('大纲：摊平')

  const workbook = buildOutlineSample()
  const root = activeRoot(workbook)
  const rows = outlineRows(root, { skipCollapsed: true })

  eq('第一行是根主题', rows[0].title, '产品规划')
  eq('第一行深度为 0', rows[0].depth, 0)
  eq(
    '折叠分支的子节点被跳过',
    rows.some((row) => row.title === '信息架构'),
    false
  )
  check(
    '折叠分支自身仍在',
    rows.some((row) => row.title === '产品设计' && row.collapsed)
  )
  check('有子节点标记正确', rows.find((r) => r.title === '产品设计')?.hasChildren === true)
  check('没有子节点的行不带标记', rows.find((r) => r.title === '竞品对比')?.hasChildren === false)
  check('中间层节点也算有子节点', rows.find((r) => r.title === '目标用户')?.hasChildren === true)
  eq('深度正确', rows.find((r) => r.title === '目标用户')?.depth, 2)
  eq(
    '浮动主题也出现在大纲里',
    rows.some((row) => row.title === '浮动想法'),
    true
  )
  eq('顺序与树一致', rows.map((row) => row.title).slice(0, 6), [
    '产品规划',
    '市场分析',
    '目标用户',
    '画像',
    '竞品对比',
    '产品设计'
  ])

  const all = outlineRows(root)
  eq(
    '不跳过折叠时能看到全部节点',
    all.some((row) => row.title === '信息架构'),
    true
  )
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
  check(
    'TXT 以 BOM 开头（Windows 记事本不乱码）',
    buildOutline(workbook, 'txt').startsWith('\ufeff')
  )
  check(
    'TXT 按层级缩进',
    txt.includes('\r\n  市场分析\r\n    目标用户'),
    JSON.stringify(txt.slice(0, 80))
  )
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
  check(
    'OPML 声明版本',
    opml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">')
  )
  check('OPML 头部带画布标题', opml.includes('<title>画布 1</title>'))
  check('OPML 用 outline 元素', opml.includes('<outline text="产品规划">'))
  check('OPML 备注写成 _note', opml.includes('_note="第一行 第二行"'))
  check('OPML 超链接写成 _link', opml.includes('_link="https://example.com"'))
  check('OPML 自闭合标签用于叶子节点', opml.includes('<outline text="竞品对比"/>'))
  check('OPML 叶子节点不会被写成带子元素的标签', !opml.includes('<outline text="竞品对比">'))
  check(
    'OPML 结构闭合',
    (opml.match(/<outline/g) ?? []).length ===
      (opml.match(/<\/outline>/g) ?? []).length + countSelfClosing(opml)
  )

  const special = createTopic('A & B <C> "D"')
  special.children = [createTopic("it's fine")]
  const specialWorkbook = createWorkbook({ rootTitle: '特殊字符' })
  activeRoot(specialWorkbook).children = [special]
  const specialOpml = toOpml(activeSheet(specialWorkbook))
  check('OPML 转义 & < > "', specialOpml.includes('A &amp; B &lt;C&gt; &quot;D&quot;'))
  check('OPML 转义单引号', specialOpml.includes('it&apos;s fine'))

  group('大纲：格式注册与错误处理')

  eq(
    '支持三种格式',
    OUTLINE_FORMATS.map((item) => item.id),
    ['txt', 'md', 'opml']
  )
  eq(
    '扩展名正确',
    OUTLINE_FORMATS.map((item) => item.ext),
    ['txt', 'md', 'opml']
  )
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

export function testSearch(): void {
  group('搜索：计数与片段')

  eq('统计出现次数', countOccurrences('abcabc', 'abc'), 2)
  eq('默认不区分大小写', countOccurrences('AbC', 'abc'), 1)
  eq('区分大小写时大小写不同就不算命中', countOccurrences('AbC', 'abc', true), 0)
  eq('空关键词返回 0', countOccurrences('abc', ''), 0)
  eq('重叠不算两次（不重叠前进）', countOccurrences('aaaa', 'aa'), 2)
  check(
    '片段带省略号',
    snippetOf('前面很长的一段文字关键词后面还有很长的一段文字', '关键词', false, 4).includes(
      '关键词'
    )
  )

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
  eq(
    '标题命中两个节点',
    byTitle.filter((hit) => hit.field === 'title').map((hit) => hit.title),
    ['设计评审', '评审记录']
  )
  eq(
    '默认不搜备注',
    byTitle.some((hit) => hit.field === 'notes'),
    false
  )
  eq(
    '默认不搜标签',
    byTitle.some((hit) => hit.field === 'label'),
    false
  )

  const withNotes = searchWorkbook(store().workbook, '要点', { inNotes: true })
  eq(
    '打开备注后能命中备注',
    withNotes.map((hit) => hit.field),
    ['notes']
  )
  eq('备注命中的节点正确', withNotes[0].topicId, a)

  const withLabels = searchWorkbook(store().workbook, '评审', { inLabels: true })
  check(
    '打开标签后能命中标签',
    withLabels.some((hit) => hit.field === 'label')
  )
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

  /*
   * 大小写不敏感的匹配**不能再靠 `text.toLowerCase()` + `indexOf`**：
   * `toLowerCase()` 会改变字符串长度（`'İ'` → 两个码元），
   * 小写串上的下标落回原文本就错位（`İstanbul` 里的 `stan` 会被从第 2 位切开）。
   */
  group('搜索：大小写不敏感的下标必须落在原文本上')

  const turkish = replaceInText('İstanbul', 'stan', 'X')
  eq('İ 不再让替换错位', turkish.text, 'İXbul')
  eq('İ 场景的替换次数', turkish.count, 1)
  eq('İ 场景的命中次数', countOccurrences('İstanbul', 'stan'), 1)
  check(
    '命中片段取自原文本（位置不偏）',
    snippetOf('İstanbul 是城市', '城市').includes('城市'),
    snippetOf('İstanbul 是城市', '城市')
  )
  check(
    '片段截取窗口跟着命中走',
    snippetOf('前前后后İstanbul后后后后', 'stan', false, 3).includes('stan'),
    snippetOf('前前后后İstanbul后后后后', 'stan', false, 3)
  )

  // 关键词按**字面**匹配：`a.b` 不能命中 `axb`
  eq('正则元字符按字面处理（计数）', countOccurrences('axb a.b', 'a.b'), 1)
  eq('正则元字符按字面处理（替换）', replaceInText('axb a.b', 'a.b', '-').text, 'axb -')
  eq('替换文本里的 $& 原样写入（不当占位符展开）', replaceInText('ab', 'b', '$&$1').text, 'a$&$1')

  group('搜索：关键词两端空白归一（搜索/计数/替换同一口径）')

  reset()
  const tRoot = addChildOf(root().id, '甲')
  const spaceTitle = addChildOf(tRoot, '成本 控制')
  store().setSearchQuery('成本 ')
  store().setSearchReplacement('X')
  eq('带尾随空格的搜索能命中', searchSheet(activeSheet(store().workbook), '成本 ').length, 1)
  eq('计数与搜索同口径', countTitleMatches(store().workbook, '成本 '), 1)
  const trimmedReplace = store().replaceAllInTitles()
  eq('替换与搜索同口径（不再报 0 处）', trimmedReplace, 1)
  eq(
    '替换确实落库（关键词本身被替换）',
    findTopic(activeRoot(store().workbook), spaceTitle)?.title,
    'X 控制'
  )
  eq('只有空白的关键词不算关键词', searchSheet(activeSheet(store().workbook), '   ').length, 0)

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
  eq(
    '空筛选时全部算命中',
    applyTopicFilter(activeRoot(store().workbook), { markers: [], labels: [] }).hits.size,
    0
  )

  const byMarker = applyTopicFilter(activeRoot(store().workbook), {
    markers: ['priority-1'],
    labels: []
  })
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
  eq(
    '收集到的标签',
    labels.map((item) => [item.label, item.count]),
    [['重要', 1]]
  )

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
  eq(
    '统计：标签分布',
    stats.labels.map((item) => [item.label, item.count]),
    [['标签甲', 1]]
  )
  eq('统计：无附件时计数为 0', stats.withAttachments, 0)

  // 多画布功能已移除：界面只显示第一张画布，多文档由「标签页」承接（见 store/tabs 的测试）
}

export function testExportDrawing(): void {
  group('导出：绘图指令')

  const { layout, colors } = buildExportScene()
  const drawing = buildDrawing({ layout, colors, background: colors.canvas })

  check(
    '画布尺寸来自布局边界',
    drawing.width === layout.bounds.width && drawing.height === layout.bounds.height
  )
  eq('背景色透传', drawing.background, colors.canvas)

  const rects = drawing.ops.filter((op) => op.kind === 'rect')
  const paths = drawing.ops.filter((op) => op.kind === 'path')
  const texts = drawing.ops.filter((op) => op.kind === 'lineText')
  const labels = drawing.ops.filter((op) => op.kind === 'text')
  const badges = drawing.ops.filter((op) => op.kind === 'badge')
  const pies = drawing.ops.filter((op) => op.kind === 'pie')
  const glyphs = drawing.ops.filter((op) => op.kind === 'glyph')

  check(
    '每个节点都有一条文字行',
    texts.length >= layout.nodes.length,
    `${texts.length} vs ${layout.nodes.length}`
  )
  check(
    '根节点画成圆角矩形',
    rects.some((op) => op.kind === 'rect' && op.shadow === true)
  )
  check(
    '一级主题的矩形带边框',
    rects.some((op) => op.kind === 'rect' && op.stroke !== undefined)
  )
  check(
    '深层节点画下划线（不是矩形）',
    paths.some((op) => op.kind === 'path' && op.strokeWidth === 2)
  )
  check(
    '连线按分支着色',
    paths.some((op) => op.kind === 'path' && colors.branches.includes(String(op.stroke)))
  )

  check('优先级标记画成数字徽标', badges.length >= 1)
  eq('徽标文字是优先级数字', badges[0]?.kind === 'badge' ? badges[0].text : '', '1')
  check('进度标记画成饼形', pies.length >= 1)
  check('星标画成图形', glyphs.length >= 1)

  group('导出：标记图标是真实图形（不再是同色圆点）')

  /**
   * 画布上能用到的每个图形都必须在矢量数据里；缺一个，导出就会退回一个圆点——
   * 而"退回"是静默的（图还在、只是形状没了），只有断言能钉住。
   */
  const usedGlyphs = new Set<MarkerGlyph>()
  for (const markerId of Object.keys(MARKER_LABELS)) {
    const visual = markerVisualOf(markerId)
    if (visual.kind === 'glyph') usedGlyphs.add(visual.glyph)
  }
  const missingArt = [...usedGlyphs].filter((glyph) => (ICON_ART[glyph]?.length ?? 0) === 0)
  eq('内置标记用到的图形都有矢量数据', missingArt.join(','), '')
  check(
    '矢量数据覆盖全部图形',
    Object.keys(ICON_ART).length >= usedGlyphs.size,
    `${Object.keys(ICON_ART).length} vs ${usedGlyphs.size}`
  )
  check(
    '图标表 = 17 个标记图形 + 3 个指示图标',
    Object.keys(ICON_ART).length === 20,
    `${Object.keys(ICON_ART).length} 个（标记表用到的 ${usedGlyphs.size} + 兜底的 award + 3 个指示图标）`
  )
  check('兜底图形（award）也有数据', (ICON_ART.award?.length ?? 0) > 0)

  const svgOfGlyph = (glyph: MarkerGlyph): string =>
    drawingToSvg({
      width: 32,
      height: 32,
      background: null,
      ops: [{ kind: 'glyph', x: 4, y: 4, size: 24, color: '#123456', glyph }]
    })
  const shapePattern = /<(path|circle|line|polyline|polygon|rect)\b/
  const shapeless = [...usedGlyphs].filter((glyph) => !shapePattern.test(svgOfGlyph(glyph)))
  eq('每个图形的 SVG 里都有真实图元', shapeless.join(','), '')

  const plusSvg = svgOfGlyph('plus')
  check(
    '按 24×24 视图盒缩放并平移到目标位置',
    plusSvg.includes('translate(4 4)') && plusSvg.includes('scale(1)'),
    plusSvg.slice(0, 160)
  )
  check(
    '线宽与画布上的标记图标一致（不会粗一圈）',
    plusSvg.includes(`stroke-width="${MARKER_STROKE_WIDTH}"`)
  )
  check('只描边、不填充（lucide 的默认画法）', plusSvg.includes('fill="none"'))
  check('图形之间不重样', svgOfGlyph('plus') !== svgOfGlyph('minus'))
  check(
    '完全没有数据的图形仍然有兜底（不会画成空白）',
    svgOfGlyph('made-up-glyph' as MarkerGlyph).includes('<circle')
  )

  group('导出：节点顶部的指示图标（备注 / 链接 / 附件）')

  /**
   * 一个"有备注 + 有超链接"的节点：画布上它顶部会有一排小图标。
   *
   * 这一行以前导出层**完全没有画**，而且正文也没为它让出高度——
   * 于是有备注/链接/附件的节点在导出图里正文偏上、底部空一块（用户看不出来是"少画了图标"，
   * 只看到"文字没对齐"）。这里把两件事都钉住。
   */
  const indicatorId = addChildOf(root().id, '带指示图标的节点')
  store().setNotes(indicatorId, '一段备注')
  store().setHref(indicatorId, 'https://example.com')

  const indicatorLayout = layoutSheet(root(), fakeMeasure, {}, sheet())
  const indicatorDrawing = buildDrawing({
    layout: indicatorLayout,
    colors: themeColorsOf(store().workbook),
    background: null
  })
  const indicatorNode = indicatorLayout.nodeMap.get(indicatorId)
  /** 只看**这个节点**框内画出来的图标（场景里还有别的带备注的节点） */
  const insideIndicatorNode = (op: { x: number; y: number }): boolean =>
    Boolean(
      indicatorNode &&
      op.x >= indicatorNode.x &&
      op.x <= indicatorNode.x + indicatorNode.width &&
      op.y >= indicatorNode.y &&
      op.y <= indicatorNode.y + indicatorNode.accessory.height + 4
    )
  const indicatorGlyphOps = indicatorDrawing.ops.filter(
    (op) =>
      op.kind === 'glyph' &&
      (op.glyph === 'notes' || op.glyph === 'link') &&
      insideIndicatorNode(op)
  )
  eq('备注与链接各画出一个图标', indicatorGlyphOps.length, 2)
  check(
    '指示图标的线宽比标记图标细一档',
    indicatorGlyphOps.every(
      (op) => op.kind === 'glyph' && op.strokeWidth === INDICATOR_STROKE_WIDTH
    )
  )
  check(
    '指示图标带 0.72 的透明度（与画布一致）',
    indicatorGlyphOps.every((op) => op.kind === 'glyph' && op.opacity === INDICATOR_OPACITY)
  )
  check(
    '三种指示图标都有矢量数据',
    (['notes', 'link', 'attachment'] as IconName[]).every(
      (kind) => (ICON_ART[kind]?.length ?? 0) > 0
    )
  )

  const indicatorText = indicatorDrawing.ops.find(
    (op) => op.kind === 'lineText' && op.segments.some((seg) => seg.text.includes('带指示图标'))
  )
  check(
    '正文被让到图标行下方（不再与图标重叠）',
    Boolean(
      indicatorNode &&
      indicatorText &&
      indicatorText.kind === 'lineText' &&
      indicatorText.y >= indicatorNode.y + indicatorNode.paddingY + indicatorNode.accessory.height
    )
  )

  const indicatorSvg = drawingToSvg({ ...indicatorDrawing, ops: indicatorGlyphOps })
  check(
    '指示图标在 SVG 里也是真实图形',
    indicatorSvg.includes('<path') || indicatorSvg.includes('<circle')
  )
  check('指示图标在 SVG 里带透明度', indicatorSvg.includes(`opacity="${INDICATOR_OPACITY}"`))
  check(
    '标签画成底部胶囊',
    labels.some((op) => op.kind === 'text' && op.text === '标签甲')
  )

  const textOf = drawing.ops.find(
    (op) => op.kind === 'lineText' && op.segments.some((s) => s.text.includes('特殊'))
  )
  check('特殊字符原样进入指令（转义交给后端）', Boolean(textOf))

  const formulaOp = drawing.ops.find((op) => op.kind === 'formula')
  check('公式节点生成公式指令', Boolean(formulaOp))
  check(
    '没有位图时公式退回源码',
    formulaOp?.kind === 'formula' &&
      formulaOp.href === undefined &&
      formulaOp.fallbackText === '\\frac{a}{b}'
  )

  // 有图片资源时使用图片指令，没有时画占位框
  const withoutImage = drawing.ops.filter((op) => op.kind === 'image').length
  eq('没有图片资源时不生成 image 指令', withoutImage, 0)
  const withImage = buildDrawing({
    layout,
    colors,
    background: colors.canvas,
    images: new Map([['resources/pic.png', 'data:image/png;base64,AAAA']])
  })
  check(
    '有图片资源时生成 image 指令',
    withImage.ops.some((op) => op.kind === 'image')
  )

  // 资源缺失时的占位：画布上是 `.topic__image-missing`（虚线框 + 「图片缺失」），
  // 导出必须长得一样——以前这里只有一个实心浅灰块、还没有文字
  const placeholder = drawing.ops.find((op) => op.kind === 'rect' && op.dash === '4 3')
  check('图片资源缺失时画的是虚线占位框', placeholder !== undefined)
  check(
    '占位框带「图片缺失」提示文字',
    drawing.ops.some((op) => op.kind === 'text' && op.text === '图片缺失'),
    drawing.ops
      .filter((op) => op.kind === 'text')
      .map((op) => (op.kind === 'text' ? op.text : ''))
      .join('|')
  )

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
  check(
    '导出的 SVG 是合法 XML',
    parsedSvg !== null && parsedSvg.local === 'svg',
    parsedSvg?.name ?? 'null'
  )
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
  check(
    'SVG 转义 & < >（文本内容）',
    escapeSvg.includes('&lt;a &amp; b&gt;'),
    escapeSvg.slice(escapeSvg.indexOf('<text'), escapeSvg.indexOf('<text') + 160)
  )
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
  check(
    'SVG 转义属性里的 &',
    attrSvg.includes('href="mind-resource://local/a.png?x=1&amp;y=2"'),
    attrSvg.match(/href="[^"]*"/)?.[0] ?? ''
  )

  /*
   * 下划线与删除线是**两种**装饰。
   *
   * 以前这里写的是 `underline || strike ? 'underline' : undefined`：画布上明明是删除线，
   * 导出成 SVG / 矢量 PDF 就成了下划线。三种组合各钉一条断言，防止再次被合并成一态。
   */
  const decoSvg = drawingToSvg({
    ...escapeScene,
    ops: [
      {
        kind: 'lineText',
        x: 0,
        y: 0,
        align: 'left',
        baseline: 20,
        color: '#333',
        segments: [
          { text: '下', fontSize: 14, x: 0, width: 14, underline: true },
          { text: '删', fontSize: 14, x: 14, width: 14, strike: true },
          { text: '都', fontSize: 14, x: 28, width: 14, underline: true, strike: true }
        ]
      }
    ]
  })
  const decorations = decoSvg.match(/text-decoration="[^"]*"/g) ?? []
  eq('SVG：三种装饰组合各输出一次', decorations.length, 3)
  eq('SVG：下划线 → underline，删除线 → line-through，同时存在则两个都给', decorations, [
    'text-decoration="underline"',
    'text-decoration="line-through"',
    'text-decoration="underline line-through"'
  ])

  const dashSvg = svg
  check('SVG：虚线占位框输出 stroke-dasharray', dashSvg.includes('stroke-dasharray="4 3"'))
  check('SVG：占位框里的提示文字被画出来', dashSvg.includes('图片缺失'))

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
  check(
    '公式没有位图时在 SVG 里输出源码',
    fallbackSvg.includes('x^2') && !fallbackSvg.includes('<image')
  )

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
  check(
    'PDF 页面按倍率换算尺寸',
    pdfText.includes('/MediaBox [0 0 1.5 0.75]'),
    pdfText.match(/MediaBox[^\]]*\]/)?.[0] ?? ''
  )
  check('PDF 内容流把图铺满整页', pdfText.includes('q 1.5 0 0 0.75 0 0 cm /Im0 Do Q'))
  check(
    'PDF 中文标题按 UTF-16BE 十六进制写入（不会被截断成乱码）',
    pdfText.includes('/Title <FEFF5BFC51FA6D4B8BD5>'),
    pdfText.match(/\/Title [^/]*/)?.[0] ?? ''
  )
  const asciiPdf = new TextDecoder('latin1').decode(
    buildImagePdf({
      pixelWidth: 2,
      pixelHeight: 2,
      rgb: new Uint8Array(12),
      compressed: new Uint8Array(1),
      title: 'demo'
    })
  )
  check('PDF 纯 ASCII 标题用字面量写法', asciiPdf.includes('/Title (demo)'))
  check(
    'PDF 标题里的括号会被转义',
    new TextDecoder('latin1')
      .decode(
        buildImagePdf({
          pixelWidth: 2,
          pixelHeight: 2,
          rgb: new Uint8Array(12),
          compressed: new Uint8Array(1),
          title: 'a(b)c'
        })
      )
      .includes('/Title (a\\(b\\)c)')
  )

  // xref 偏移必须能对上对象起始位置，否则 PDF 阅读器会报错
  const xrefAt = pdfText.indexOf('xref')
  const startxref = Number(
    pdfText
      .slice(pdfText.lastIndexOf('startxref') + 9)
      .trim()
      .split(/\s/)[0]
  )
  eq('startxref 指向 xref 表', startxref, xrefAt)
  const offsets = [...pdfText.slice(xrefAt).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]))
  eq('xref 里对象数量正确', offsets.length, 6)
  check(
    '每个对象的偏移都指向 "N 0 obj"',
    offsets.every((offset, index) =>
      pdfText.slice(offset, offset + 12).startsWith(`${index + 1} 0 obj`)
    ),
    offsets
      .map((offset, index) => `${index + 1}@${offset}:${pdfText.slice(offset, offset + 8)}`)
      .join(' | ')
  )

  let pdfError = ''
  try {
    buildImagePdf({
      pixelWidth: 4,
      pixelHeight: 2,
      rgb: new Uint8Array(5),
      compressed: fakeCompressed
    })
  } catch (error) {
    pdfError = (error as Error).message
  }
  check('PDF：RGB 长度不对时报错', pdfError.includes('长度与尺寸不匹配'), pdfError)

  let pdfZero = ''
  try {
    buildImagePdf({
      pixelWidth: 0,
      pixelHeight: 0,
      rgb: new Uint8Array(0),
      compressed: fakeCompressed
    })
  } catch (error) {
    pdfZero = (error as Error).message
  }
  check('PDF：尺寸为 0 时报错', pdfZero.includes('尺寸非法'), pdfZero)

  group('导出：KaTeX 资源（公式位图用）')

  check(
    '内联字体齐全（20 个 woff2）',
    KATEX_INLINED_FONTS.length === 20,
    String(KATEX_INLINED_FONTS.length)
  )
  check('KaTeX 样式里没有未处理的字体路径', !KATEX_INLINE_CSS.includes('url(fonts/'))
  check('KaTeX 样式里字体已内联', KATEX_INLINE_CSS.includes('url(data:font/woff2;base64,'))
  check('KaTeX 样式含关键类名', KATEX_INLINE_CSS.includes('.katex'))
}

/** 导出格式表与倍率 */

export function testExportFormats(): void {
  group('导出：格式与选项')

  eq(
    '三种格式',
    IMAGE_EXPORT_FORMATS.map((item) => item.id),
    ['png', 'svg', 'pdf']
  )
  eq(
    '扩展名正确',
    IMAGE_EXPORT_FORMATS.map((item) => item.ext),
    ['png', 'svg', 'pdf']
  )
  check(
    '只有 SVG 不需要倍率',
    IMAGE_EXPORT_FORMATS.filter((item) => !item.scalable)
      .map((item) => item.id)
      .join(',') === 'svg'
  )
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

export function testMeasureStyles(): void {
  group('画布测量：富文本样式传递')

  const saved = (globalThis as { document?: unknown }).document
  ;(globalThis as { document?: unknown }).document = {
    createElement: () => ({
      getContext: () => ({ font: '', measureText: (text: string) => ({ width: text.length * 8 }) })
    })
  }
  try {
    const rich: RichText = {
      paragraphs: [{ runs: [{ text: '红色', color: '#ff0000' }, { text: '普通' }] }]
    }
    const topic = { id: 't', title: '红色普通', titleRich: rich, children: [] } as unknown as Topic
    const segments = measureTopic(topic, 1).lines[0]?.segments ?? []
    eq('颜色写进 segments（否则画布只剩主题色）', segments[0]?.color, '#ff0000')
    eq('没显式颜色的 run 保持 undefined（好继承主题色）', segments[1]?.color, undefined)
    eq('带颜色的 run 不会与无色 run 合并', segments.length, 2)

    const styled = {
      id: 's',
      title: 'A',
      titleRich: {
        paragraphs: [{ runs: [{ text: 'A', color: '#00ff00', fontSize: 22, fontFamily: 'serif' }] }]
      },
      children: []
    } as unknown as Topic
    const styledSegments = measureTopic(styled, 1).lines[0]?.segments ?? []
    eq('字号一并带进 segments', styledSegments[0]?.fontSize, 22)
    eq('字体一并带进 segments', styledSegments[0]?.fontFamily, 'serif')
    eq('颜色一并带进 segments', styledSegments[0]?.color, '#00ff00')
    const widthTopic = createTopic('abcdeabcde')
    const widthMeasured = measureTopic(widthTopic, 1)
    const maxLineWidth = Math.max(...widthMeasured.lines.map((line) => line.width))
    check(
      '节点宽度给文本留 2px 余量（防末尾空格被折行）',
      widthMeasured.width >= Math.ceil(maxLineWidth) + 2 + widthMeasured.paddingX * 2,
      `width=${widthMeasured.width} line=${maxLineWidth} padding=${widthMeasured.paddingX}`
    )
  } finally {
    if (saved === undefined) delete (globalThis as { document?: unknown }).document
    else (globalThis as { document?: unknown }).document = saved
  }
}

export function testDocument(): void {
  group('文档：格式识别')

  eq('docx 认成 Word 文档', classifyDocument('季度报告.docx').kind, 'docx')
  eq('xlsx 认成表格', classifyDocument('成绩.xlsx').kind, 'xlsx')
  eq('pptx 认成演示', classifyDocument('分享.pptx').kind, 'pptx')
  eq('md 认成文本', classifyDocument('笔记.md').kind, 'text')
  eq('代码文件也当文本', classifyDocument('main.py').kind, 'text')
  eq('大小写不敏感', classifyDocument('REPORT.DOCX').kind, 'docx')
  eq('路径里的扩展名也算', classifyDocument('C:\\Users\\a\\b\\说明.txt').kind, 'text')
  eq('pdf 明确判为不支持', classifyDocument('论文.pdf').kind, 'pdf')
  check(
    'pdf 给的是可操作的替代方案（而不是死路）',
    (classifyDocument('论文.pdf').note ?? '').includes('导出')
  )
  eq('不认识的格式也不崩', classifyDocument('x.bin').kind, 'unsupported')
  eq('无扩展名也不崩', classifyDocument('Makefile').kind, 'unsupported')
  eq('office 三种要先解 zip', isZipDocument('docx'), true)
  eq('文本类不解 zip', isZipDocument('text'), false)
  check('docx 只读正文那几个 entry', zipEntryPrefixesFor('docx').includes('word/document.xml'))
  check('xlsx 要读共享字符串表', zipEntryPrefixesFor('xlsx').includes('xl/sharedStrings.xml'))
  check(
    'pptx 只读 slides',
    zipEntryPrefixesFor('pptx').every((p) => p.startsWith('ppt/'))
  )

  group('文档：Word 抽文本')

  const docxXml =
    '<w:document><w:body>' +
    '<w:p><w:r><w:t>第一章 概述</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>要点&amp;细节</w:t></w:r></w:p>' +
    '<w:tbl><w:tr>' +
    '<w:tc><w:p><w:r><w:t>列一</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>列二</w:t></w:r></w:p></w:tc>' +
    '</w:tr></w:tbl>' +
    '</w:body></w:document>'
  const docxText = normalizeDocumentText(extractDocxText({ 'word/document.xml': docxXml }))
  check('段落文本抽得到', docxText.includes('第一章 概述'), docxText)
  check('XML 实体被还原', docxText.includes('要点&细节'), docxText)
  check(
    '表格单元格也在（不会整段丢）',
    docxText.includes('列一') && docxText.includes('列二'),
    docxText
  )
  check('段落边界保留（不是糊成一坨）', docxText.split('\n').length >= 4, docxText)
  check('标签本身没留下', !docxText.includes('<w:'), docxText)

  group('文档：Excel 抽文本')

  const xlsxFiles = {
    'xl/workbook.xml': '<workbook><sheets><sheet name="成绩单"/></sheets></workbook>',
    'xl/sharedStrings.xml': '<sst><si><t>姓名</t></si><si><t>张三</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>95</v></c></row>' +
      '</sheetData></worksheet>'
  }
  const xlsxText = normalizeDocumentText(extractXlsxText(xlsxFiles))
  check('带上工作表名', xlsxText.includes('【成绩单】'), xlsxText)
  check('共享字符串解析对了', xlsxText.includes('姓名') && xlsxText.includes('张三'), xlsxText)
  check('数字单元格直接取', xlsxText.includes('95'), xlsxText)
  check('同一行的多个单元格用制表符分隔', /张三\t95/.test(xlsxText), JSON.stringify(xlsxText))

  group('文档：PPT 抽文本')

  const pptxText = normalizeDocumentText(
    extractPptxText({
      'ppt/slides/slide1.xml': '<p:sld><a:t>封面标题</a:t><a:t>要点一</a:t></p:sld>',
      'ppt/slides/slide2.xml': '<p:sld><a:t>第二页</a:t></p:sld>'
    })
  )
  check(
    '按页给出页码小标题',
    pptxText.includes('【第 1 页】') && pptxText.includes('【第 2 页】'),
    pptxText
  )
  check('页内文字都在', pptxText.includes('封面标题') && pptxText.includes('要点一'), pptxText)
  check('第二页也对', pptxText.includes('第二页'), pptxText)

  group('文档：入口分派')

  eq('文本类走 rawText', extractDocumentText({ kind: 'text', rawText: '正文' }), '正文')
  eq('pdf 不带内容（由上层报错）', extractDocumentText({ kind: 'pdf', rawText: 'x' }), '')

  group('文档：清洗与统计')

  eq('统一换行、去零宽、压空行', normalizeDocumentText('a\r\n\r\n\r\n\r\nb\u200b'), 'a\n\nb')
  eq('去掉行尾空白', normalizeDocumentText('a   \nb\t'), 'a\nb')
  eq('统计字数与行数', documentStats('第一行\n第二行').chars, 7)
  eq('空文本行数为 0', documentStats('').lines, 0)

  group('文档：分段（长文档细读用）')

  const short = splitDocument('就一段话', 1000, 8)
  eq('短文档不分段', short.chunks.length, 1)
  eq('短文档没有丢弃', short.droppedChars, 0)

  const many = Array.from({ length: 60 }, (_, index) => `第 ${index} 段内容`).join('\n')
  const split = splitDocument(many, 200, 8)
  check('长文档被切成多段', split.chunks.length > 1, String(split.chunks.length))
  check(
    '每段都在上限内',
    split.chunks.every((chunk) => chunk.length <= 200)
  )
  check(
    '没有丢内容（拼接后每段标记都在）',
    many.split('\n').every((line) => split.chunks.some((chunk) => chunk.includes(line)))
  )

  const tooMany = splitDocument(
    Array.from({ length: 200 }, () => 'x'.repeat(50)).join('\n'),
    200,
    3
  )
  eq('超过段数上限就只取前几段', tooMany.chunks.length, 3)
  check('丢弃的字数如实报出', tooMany.droppedChars > 0, String(tooMany.droppedChars))

  const noNewline = splitDocument('y'.repeat(5000), 1000, 3)
  eq('没有换行的巨型文本也能硬切', noNewline.chunks.length, 3)
  check(
    '每一段都不超限',
    noNewline.chunks.every((chunk) => chunk.length <= 1000)
  )

  group('文档：提示词')

  const docOutline = buildDocumentOutlineMessages({ name: '报告.docx', text: '正文内容' })
  check('带上文档正文', docOutline[1].content.includes('正文内容'))
  check('要求覆盖全部章节与要点', docOutline[1].content.includes('全部章节与要点'))
  check('要求引用原文（解释行）', docOutline[1].content.includes('引用原文'))
  check('带上文件名（模型知道在读什么）', docOutline[1].content.includes('报告.docx'))

  const chunkMsg = buildDocumentChunkMessages({
    name: '报告.docx',
    index: 2,
    total: 5,
    text: '本段'
  })
  check('分段提示词标明第几段', chunkMsg[1].content.includes('第 2/5 段'))
  check('分段提示词只依据本段', chunkMsg[1].content.includes('只依据这一段'))

  const mergeMsg = buildDocumentMergeMessages({ name: '报告.docx', parts: ['- A', '- B'] })
  check('合并提示词要求去重', mergeMsg[1].content.includes('合并去重'))
  check(
    '合并提示词带上各段片段',
    mergeMsg[1].content.includes('- A') && mergeMsg[1].content.includes('- B')
  )
  check('合并提示词保留顺序', mergeMsg[1].content.includes('按原文顺序'))
}

export function testImport(): void {
  group('导入 Markdown：结构与容错')

  const nested = parseMarkdownOutline('# 产品规划\n## 市场分析\n### 目标用户\n## 产品设计')
  eq('标题按级别嵌套', nested.root?.title, '产品规划')
  eq(
    '二级标题是子节点',
    nested.root?.children.map((c) => c.title),
    ['市场分析', '产品设计']
  )
  eq(
    '三级标题挂到二级下',
    nested.root?.children[0].children.map((c) => c.title),
    ['目标用户']
  )
  eq('节点总数', nested.count, 4)

  const withList = parseMarkdownOutline('# 计划\n- 甲\n  - 甲一\n- 乙')
  eq(
    '列表挂在标题下',
    withList.root?.children.map((c) => c.title),
    ['甲', '乙']
  )
  eq(
    '列表按缩进嵌套',
    withList.root?.children[0].children.map((c) => c.title),
    ['甲一']
  )
  eq('标题+列表总数', withList.count, 4)

  const twoSections = parseMarkdownOutline('# 甲\n- x\n# 乙\n- y')
  eq(
    '同级标题不嵌套',
    twoSections.root?.children.map((c) => c.title),
    ['甲', '乙']
  )
  check('并列顶层套一个根', twoSections.warnings.length === 1, twoSections.warnings.join('|'))

  const noHeading = parseMarkdownOutline('- 根\n  - 子\n    - 孙')
  eq('没有标题时第一个列表项当根', noHeading.root?.title, '根')
  eq(
    '没有标题也能嵌套',
    noHeading.root?.children[0].children.map((c) => c.title),
    ['孙']
  )

  const fenced = parseMarkdownOutline('# 标题\n```ts\n- 代码里的不算\n```\n- 真正的项')
  eq('代码块挂到所属标题', fenced.root?.code?.text, '- 代码里的不算')
  eq('代码块的语言标注也带上', fenced.root?.code?.language, 'ts')
  eq('代码块外的列表正常', fenced.count, 2)

  const frontMatter = parseMarkdownOutline('---\ntitle: x\n tags: [a]\n---\n# 真标题\n- 项')
  eq('front-matter 被跳过', frontMatter.root?.title, '真标题')
  eq('front-matter 后节点数正确', frontMatter.count, 2)

  /*
   * 开头是水平线、后面再没有第二个 `---`：**不是** front-matter。
   * 以前只判断第一行，于是整篇文档被当 front-matter 吞掉（导入成功但没有内容）。
   */
  const horizontalOnly = parseMarkdownOutline('---\n# 标题\n- 项')
  eq('开头水平线不再吞掉全文', horizontalOnly.root?.title, '标题')
  eq('开头水平线后的节点数', horizontalOnly.count, 2)

  const openFence = parseMarkdownOutline('# 标题\n```ts\nconst a = 1\nconst b = 2')
  eq('未闭合的代码围栏照样算一块代码', openFence.root?.code?.text, 'const a = 1\nconst b = 2')
  eq('未闭合围栏保留语言标注', openFence.root?.code?.language, 'ts')
  eq('未闭合围栏不影响节点数', openFence.count, 1)

  const noisy = parseMarkdownOutline('# 标题\n> 引用不是节点\n| a | b |\n| - | - |\n---\n- 项')
  eq(
    '表格数据行变成子主题',
    noisy.root?.children.map((c) => c.title),
    ['a / b', '项']
  )
  eq('引用块进备注', noisy.root?.notes, '引用不是节点')
  eq('引用/表格/水平线处理后的节点数', noisy.count, 3)

  const codeFallback = parseMarkdownOutline('# T\n```\na\n```\n```\nb\n```')
  eq(
    '第二个代码块生成「代码」子主题',
    codeFallback.root?.children.map((c) => c.title),
    ['代码']
  )
  eq('「代码」子主题带内容', codeFallback.root?.children[0].code?.text, 'b')

  const taskList = parseMarkdownOutline('# 任务\n- [x] 已完成\n- [ ] 待办')
  eq(
    '任务列表剥掉勾选框',
    taskList.root?.children.map((c) => c.title),
    ['已完成', '待办']
  )

  const richList = parseMarkdownOutline('- **重点**内容\n- *斜*体\n- `code` 说明')
  eq('粗体进富文本', richList.root?.children[0].rich?.paragraphs[0]?.runs[0]?.bold, true)
  eq('斜体进富文本', richList.root?.children[1].rich?.paragraphs[0]?.runs[0]?.italic, true)
  eq(
    '行内代码用等宽字体',
    typeof richList.root?.children[2].rich?.paragraphs[0]?.runs[0]?.fontFamily,
    'string'
  )
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
  check(
    '链接文字带下划线样式',
    linked.root?.children[0]?.rich?.paragraphs[0]?.runs[0]?.underline === true
  )

  const numbered = parseMarkdownOutline('# 步骤\n1. 第一\n2. 第二\n   1. 第二点一')
  eq(
    '数字列表可解析',
    numbered.root?.children.map((c) => c.title),
    ['第一', '第二']
  )
  eq(
    '数字列表缩进嵌套',
    numbered.root?.children[1].children.map((c) => c.title),
    ['第二点一']
  )

  eq('粗体标记被清理', parseMarkdownOutline('- **重点**内容').root?.title, '重点内容')
  eq('斜体标记被清理', parseMarkdownOutline('- *斜*体').root?.title, '斜体')
  eq('行内代码被清理', parseMarkdownOutline('- `code` 说明').root?.title, 'code 说明')
  eq(
    '链接只留文字',
    parseMarkdownOutline('- [文档](https://example.com) 说明').root?.title,
    '文档 说明'
  )
  eq('图片只留替代文字', parseMarkdownOutline('- ![架构图](a.png)').root?.title, '架构图')
  eq('行尾锚点被清理', parseMarkdownOutline('## 标题 ##').root?.title, '标题')

  const emptyMd = parseMarkdownOutline('')
  eq('空文件不产出节点', emptyMd.root, null)
  check('空文件给出提示', emptyMd.warnings.length === 1, emptyMd.warnings.join('|'))

  const paragraphs = parseMarkdownOutline('这是第一段\n这是第二段')
  eq(
    '只有段落时按一行一主题导入',
    paragraphs.root?.children.map((c) => c.title),
    ['这是第一段', '这是第二段']
  )
  check(
    '并给出格式提示',
    paragraphs.warnings.some((w) => w.includes('一行一个主题')),
    paragraphs.warnings.join('|')
  )

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
  eq(
    'OPML 子节点',
    opml.root?.children.map((c) => c.title),
    ['分支一', '分支二']
  )
  eq(
    'OPML 三级节点',
    opml.root?.children[1].children.map((c) => c.title),
    ['细节点']
  )
  eq('OPML 节点总数', opml.count, 4)
  eq('_note 被导入为备注', opml.root?.children[0].notes, '这是备注')

  const opmlMulti = parseOpmlOutline(`<opml version="2.0"><head><title>文件标题</title></head><body>
    <outline text="甲"/><outline text="乙"/>
  </body></opml>`)
  eq('并列节点用文件标题套根', opmlMulti.root?.title, '文件标题')
  eq(
    '并列节点都在根下',
    opmlMulti.root?.children.map((c) => c.title),
    ['甲', '乙']
  )

  const container = parseOpmlOutline(`<opml version="2.0"><body>
    <outline>
      <outline text="甲"/><outline text="乙"/>
    </outline>
  </body></opml>`)
  eq(
    '没有 text 的容器节点被展开（不丢数据）',
    container.root?.children.map((c) => c.title),
    ['甲', '乙']
  )

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
  check(
    '备注 HTML 被转义',
    (noteTopic.notesHtml ?? '').includes('&lt;b&gt;'),
    String(noteTopic.notesHtml)
  )
  eq('子节点没有备注', noteTopic.children[0].notes, undefined)

  group('导入：落地到画布')

  reset()
  const markdownText = '# 学习计划\n- 前端\n  - React\n- 后端'
  const parsedMd = parseMarkdownOutline(markdownText, '学习计划')
  const mdHost = addChildOf(root().id, '宿主')
  const imported = store().applyOutlineTree(mdHost, parsedMd.root!)
  eq('导入节点数', imported, 4)
  eq(
    '导入层级正确',
    find(mdHost)?.children[0]?.children[0]?.children.map((c) => c.title),
    ['React']
  )
  store().undo()
  eq('一次撤销回到导入前', find(mdHost)?.children.length, 0)
}
