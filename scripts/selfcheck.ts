/**
 * 编辑器内核自检。
 *
 * 这里不测 UI，只测「不依赖浏览器」的核心逻辑：
 * 状态操作、撤销重做、节点移动与循环保护、复制粘贴、折叠、
 * .xmind 往返保真、布局引擎、以及各种边界情况。
 *
 * 运行：npm run selfcheck
 */
import { snapshotForSave, themeColorsOf } from '../src/renderer/src/store/editor'
import { useTabs } from '../src/renderer/src/store/tabs'
import { withAlpha } from '../src/renderer/src/render/theme'
import { defaultTextAlignOf, setDefaultTextAlign } from '../src/renderer/src/render/defaults'
import { pickDocumentArg } from '../src/shared/openfile'
import { clearTypedChar, stageTypedChar, takeTypedChar } from '../src/renderer/src/editor/typedChar'
import {
  BUILTIN_THEMES,
  DEFAULT_THEME,
  getThemeColors,
  normalizeThemeColors,
  normalizeThemeDefinition
} from '../src/shared/theme'
import {
  activeRoot,
  activeSheet,
  countCharacters,
  countTopics,
  childFoldSides,
  findParent,
  findTopic,
  foldedSidesOf,
  visibleChildren
} from '../src/shared/model/tree'
import { createTopic, createWorkbook } from '../src/shared/model/factory'
import { coerceCode, coerceRichText } from '../src/shared/model/coerce'
import { checkImagePayload, isPlausibleFilePath, MAX_IMAGE_BYTES } from '../src/shared/ipc-args'
import { isInstanceAlive, isSelfNavigation } from '../src/shared/guards'
import { writeFileAtomic, writeJsonAtomic } from '../src/main/atomic-write'

import { AGENT_WRITE_TOOLS } from '../src/shared/agent'

import { evictOldest } from '../src/shared/cache'

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
  snapshotsOf
} from '../src/shared/snapshot'
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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { markerVisualOf, type MarkerGlyph } from '../src/renderer/src/render/markers'
import {
  ICON_ART,
  INDICATOR_OPACITY,
  INDICATOR_STROKE_WIDTH,
  MARKER_STROKE_WIDTH,
  type IconName
} from '../src/shared/marker-art'
import { formulaHtml, formulaSize } from '../src/renderer/src/render/formula'
import { buildDrawing } from '../src/renderer/src/export/drawing'
import { drawingToSvg } from '../src/renderer/src/export/svg'
import { KATEX_INLINE_CSS, KATEX_INLINED_FONTS } from '../src/renderer/src/export/katex-assets'
import { measureTopic } from '../src/renderer/src/render/measure'
import { buildImagePdf } from '../src/shared/export/pdf'
import {
  IMAGE_EXPORT_FORMATS,
  IMAGE_EXPORT_SCALES,
  imageExportFormatDef,
  type ImageExportFormat
} from '../src/shared/export/types'
import {
  buildDocumentChunkMessages,
  buildDocumentMergeMessages,
  buildDocumentOutlineMessages,
  outlineToTopic
} from '../src/shared/ai'
import {
  classifyDocument,
  documentStats,
  extractDocumentText,
  extractDocxText,
  extractPptxText,
  extractXlsxText,
  isZipDocument,
  normalizeDocumentText,
  pathFromFileUrl,
  splitDocument,
  zipEntryPrefixesFor
} from '../src/shared/document'
import {
  looksLikeMarkdown,
  parseInlineMarkdown,
  parseMarkdownOutline
} from '../src/shared/import/markdown'
import { matchWholeLineMath, normalizeFormulaInput, splitInlineMath } from '../src/shared/formula'
import { estimateOverlayLabelSize, overlayTitleLines } from '../src/shared/layout/overlays'
import { LABEL_ELLIPSIS, fitLabelText } from '../src/shared/layout/label-fit'
import { CODE_TOKEN_COLORS, highlightCode } from '../src/shared/code/highlight'
import { ALIASES, DEFS } from '../src/shared/code/lang-defs'
import { CODE_LANGUAGES } from '../src/shared/code-language'
import { autosaveSlotName, findWindowForPath, sameDocPath } from '../src/shared/window'
import {
  readOverlayFontSize,
  readOverlayTextStyle,
  withOverlayTextStyle
} from '../src/shared/model/overlay-style'
import { parseOpmlOutline } from '../src/shared/import/opml'
import { defaultDocumentName, defaultFileName, sanitizeFileName } from '../src/shared/model/naming'
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
  searchSheet,
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
  runsToHtml,
  tiptapToRich,
  type TipTapDoc
} from '../src/shared/richtext'
import type { MindPackage, RichText, Topic, Workbook } from '../src/shared/model/types'

/* ---- D1 拆分：断言原语搬进 ./selfcheck/harness.ts，按域拆分的其它文件共用它 ---- */
import { check, eq, firstDiff, group, normalize, stats } from './selfcheck/harness'

/* ---- D1 拆分：共享测试助手搬进 ./selfcheck/helpers.ts（域文件也从那里取） ---- */
import {
  store,
  root,
  sheet,
  find,
  reset,
  addChildOf,
  fakeMeasure,
  buildFeatureRichWorkbook,
  LEGACY_XML,
  buildOutlineSample,
  countSelfClosing,
  buildExportScene,
  DOC_A,
  DOC_B,
  snap,
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

async function testSafetyHelpers(): Promise<void> {
  /** 对象比较统一转 JSON 串，避免依赖断言器的深比较行为 */
  const json = (value: unknown): string => JSON.stringify(value) ?? 'undefined'

  group('原子写文件')

  const dir = mkdtempSync(`${tmpdir()}/smind-atomic-`)
  const leftover = (): number => readdirSync(dir).filter((name) => name.endsWith('.tmp')).length
  const target = `${dir}/doc.xmind`

  writeFileSync(target, 'old')
  await writeFileAtomic(target, Buffer.from('new'))
  eq('覆盖后是新内容', readFileSync(target, 'utf8'), 'new')
  eq('不留下临时文件', leftover(), 0)

  await writeFileAtomic(`${dir}/fresh.xmind`, Buffer.from('first'))
  eq('目标不存在时直接创建', readFileSync(`${dir}/fresh.xmind`, 'utf8'), 'first')

  // 父目录不存在 → 写入失败，但**不能**留下半截临时文件
  let failed = false
  try {
    await writeFileAtomic(`${dir}/no-such-dir/x.xmind`, Buffer.from('x'))
  } catch {
    failed = true
  }
  check('写入失败会抛错（调用方能据此提示用户）', failed)
  eq('失败也不留下临时文件', leftover(), 0)

  // 原文件不能被破坏：这是原子写存在的唯一理由
  writeFileSync(target, 'keep-me')
  try {
    await writeFileAtomic(`${dir}/no-such-dir/y.xmind`, Buffer.from('y'))
  } catch {
    // 已在上一条断言覆盖
  }
  eq('失败的写入不会碰到别的文件', readFileSync(target, 'utf8'), 'keep-me')

  /**
   * `writeJsonAtomic`：设置 / 自定义主题 / AI 配置 / 打开历史 / 快照索引都改走它。
   * 这些文件被截断就等于用户数据消失，所以要钉住"内容格式不变 + 原子 + 不留残渣"。
   */
  const settingsPath = `${dir}/settings.json`
  writeFileSync(settingsPath, '{"version":1,"stale":true}')
  await writeJsonAtomic(settingsPath, { version: 1, fontFamily: 'serif', toolbarHidden: ['a'] })
  eq(
    'JSON 原子写：内容与既有格式一致（缩进 2 格）',
    readFileSync(settingsPath, 'utf8'),
    JSON.stringify({ version: 1, fontFamily: 'serif', toolbarHidden: ['a'] }, null, 2)
  )
  eq('JSON 原子写：能覆盖旧文件', JSON.parse(readFileSync(settingsPath, 'utf8')).stale, undefined)
  eq('JSON 原子写：不留下临时文件', leftover(), 0)
  await writeJsonAtomic(`${dir}/themes.json`, { version: 1, themes: [] })
  eq(
    'JSON 原子写：目标不存在时直接创建',
    readFileSync(`${dir}/themes.json`, 'utf8'),
    JSON.stringify({ version: 1, themes: [] }, null, 2)
  )
  let jsonFailed = false
  try {
    await writeJsonAtomic(`${dir}/no-such-dir/z.json`, { a: 1 })
  } catch {
    jsonFailed = true
  }
  check('JSON 原子写：失败照样抛错（调用方能据此决定是否提示）', jsonFailed)
  eq('JSON 原子写：失败也不留下临时文件', leftover(), 0)

  group('外部数据收敛：富文本')

  eq('不是对象 → 丢弃', json(coerceRichText('nope')), 'undefined')
  eq('缺 paragraphs → 丢弃', json(coerceRichText({ runs: [] })), 'undefined')
  eq('paragraphs 不是数组 → 丢弃', json(coerceRichText({ paragraphs: 'x' })), 'undefined')
  eq('空数组 → 丢弃（让调用方回退纯文本）', json(coerceRichText({ paragraphs: [] })), 'undefined')
  eq(
    '合法结构被保留',
    json(coerceRichText({ paragraphs: [{ runs: [{ text: '你好', bold: true }] }] })),
    json({ paragraphs: [{ runs: [{ text: '你好', bold: true }] }] })
  )
  eq(
    'text 不是字符串的 run 被丢掉',
    json(coerceRichText({ paragraphs: [{ runs: [{ text: 1 }, { text: 'ok' }] }] })),
    json({ paragraphs: [{ runs: [{ text: 'ok' }] }] })
  )
  eq(
    '布尔字段只认真正的 true',
    json(coerceRichText({ paragraphs: [{ runs: [{ text: 'a', bold: 'true' }] }] })),
    json({ paragraphs: [{ runs: [{ text: 'a' }] }] })
  )
  eq(
    '非法 align / bullet 被丢掉',
    json(
      coerceRichText({ paragraphs: [{ align: 'middle', bullet: 'yes', runs: [{ text: 'a' }] }] })
    ),
    json({ paragraphs: [{ runs: [{ text: 'a' }] }] })
  )
  eq(
    '颜色里的引号与分号被挡掉（导出时不再有逃逸风险）',
    json(coerceRichText({ paragraphs: [{ runs: [{ text: 'a', color: '" onload="x' }] }] })),
    json({ paragraphs: [{ runs: [{ text: 'a' }] }] })
  )
  eq(
    '正常色值保留',
    json(coerceRichText({ paragraphs: [{ runs: [{ text: 'a', color: '#ff0000' }] }] })),
    json({ paragraphs: [{ runs: [{ text: 'a', color: '#ff0000' }] }] })
  )
  eq(
    '离谱字号被丢掉',
    json(coerceRichText({ paragraphs: [{ runs: [{ text: 'a', fontSize: 9999 }] }] })),
    json({ paragraphs: [{ runs: [{ text: 'a' }] }] })
  )
  eq(
    'script 只认 super / sub',
    json(coerceRichText({ paragraphs: [{ runs: [{ text: 'a', script: 'top' }] }] })),
    json({ paragraphs: [{ runs: [{ text: 'a' }] }] })
  )

  group('外部数据收敛：代码块')

  eq('缺 text → 丢弃', json(coerceCode({ language: 'python' })), 'undefined')
  eq('text 不是字符串 → 丢弃', json(coerceCode({ language: 'python', text: 3 })), 'undefined')
  eq(
    '语言缺失时退回 text（不因为少个字段就把整段代码丢掉）',
    json(coerceCode({ text: 'print(1)' })),
    json({ language: 'text', text: 'print(1)' })
  )
  eq(
    '合法代码块原样保留',
    json(coerceCode({ language: 'python', text: 'print(1)' })),
    json({ language: 'python', text: 'print(1)' })
  )

  group('缓存淘汰策略')

  const cache = new Map<number, number>()
  for (let i = 0; i < 100; i += 1) cache.set(i, i)
  evictOldest(cache, 100)
  check('到上限时才开始淘汰', cache.size < 100)
  check('淘汰的是最旧的（保留了后面写入的）', cache.has(99) && cache.has(90))
  check('没有一刀切清空（否则等于缓存全废）', cache.size > 50)

  const small = new Map<number, number>()
  small.set(1, 1)
  evictOldest(small, 100)
  eq('没到上限时不动它', small.size, 1)

  group('自身导航判断（刷新要放行、拖文件要拦）')

  check(
    '同一个 file 页面 → 放行（刷新）',
    isSelfNavigation(
      'file:///D:/Mind/out/renderer/index.html',
      'file:///D:/Mind/out/renderer/index.html'
    )
  )
  check(
    '只有 hash 不同也算同一个页面',
    isSelfNavigation(
      'file:///D:/Mind/out/renderer/index.html#/a',
      'file:///D:/Mind/out/renderer/index.html#/b'
    )
  )
  check(
    '拖进来的图片 → 拦下（否则界面会被替换成图片）',
    !isSelfNavigation('file:///D:/Mind/out/renderer/index.html', 'file:///C:/Users/me/a.png')
  )
  check(
    '开发服务器同源刷新 → 放行',
    isSelfNavigation('http://localhost:5173/', 'http://localhost:5173/')
  )
  check(
    '开发服务器同源资源 → 放行（Vite 整页刷新要用）',
    isSelfNavigation('http://localhost:5173/', 'http://localhost:5173/src/main.tsx')
  )
  check('跳到别的站点 → 拦下', !isSelfNavigation('http://localhost:5173/', 'https://example.com/'))
  check('当前地址为空 → 拦下（保守处理）', !isSelfNavigation('', 'https://example.com/'))

  group('拖入文件的路径还原（file:// → 本机路径）')

  eq('Windows 盘符：砍掉开头斜杠', pathFromFileUrl('file:///D:/a/b.xmind'), 'D:/a/b.xmind')
  eq(
    '中文与空格做百分号解码',
    pathFromFileUrl('file:///D:/%E6%88%90%E6%9C%AC%20a.xmind'),
    'D:/成本 a.xmind'
  )
  /**
   * UNC 共享盘：主机名在 `host`、pathname 只有 `/share/...`，必须拼回 `\\server\share\...`。
   * 以前只取 pathname 再砍斜杠 → 得到相对路径 `share/a.xmind`，被当非法路径丢掉，
   * 用户看到的是"拖共享盘上的文件没反应"。
   */
  {
    const unc = pathFromFileUrl('file://nas/share/成本.xmind')
    eq('UNC：主机名拼回去（反斜杠形式）', unc, '\\\\nas\\share\\成本.xmind')
    check('UNC 还原出来的路径能过合法性校验（拖入链路靠它）', isPlausibleFilePath(unc))
  }
  // POSIX 绝对路径不能被砍成相对路径（只有盘符形式才该砍）
  eq('POSIX 绝对路径原样保留', pathFromFileUrl('file:///home/u/a.xmind'), '/home/u/a.xmind')
  eq('不是 file URL → null', pathFromFileUrl('https://example.com/a.xmind'), null)
  eq('空路径 → null', pathFromFileUrl('file://'), null)

  group('单实例心跳：残留锁与活实例要分得清')

  const heartbeatNow = 1_700_000_000_000
  eq('刚写的心跳算活着', isInstanceAlive({ pid: 1, time: heartbeatNow - 1000 }, heartbeatNow), true)
  eq(
    '过期心跳算死了（可以放心清残留锁）',
    isInstanceAlive({ pid: 1, time: heartbeatNow - 60000 }, heartbeatNow),
    false
  )
  eq(
    '还没超时仍算活着',
    isInstanceAlive({ pid: 1, time: heartbeatNow - 29000 }, heartbeatNow),
    true
  )
  eq('读不到心跳就算死了', isInstanceAlive(null, heartbeatNow), false)
  eq('坏数据算死了', isInstanceAlive({ time: 'x' }, heartbeatNow), false)
  eq(
    '时间戳在未来按活着处理（宁可多等，也不双开）',
    isInstanceAlive({ time: heartbeatNow + 5000 }, heartbeatNow),
    true
  )

  group('IPC 入参校验：路径')

  check('Windows 绝对路径通过', isPlausibleFilePath('D:\\a\\b.xmind'))
  check('POSIX 绝对路径通过', isPlausibleFilePath('/home/u/a.xmind'))
  check('UNC 路径通过', isPlausibleFilePath('\\\\server\\share\\a.xmind'))
  check('相对路径不通过', !isPlausibleFilePath('a.xmind'))
  check('空字符串不通过', !isPlausibleFilePath(''))
  check('非字符串不通过', !isPlausibleFilePath(null))
  check('含 NUL 不通过', !isPlausibleFilePath('D:\\a\0b.xmind'))
  check('超长路径不通过', !isPlausibleFilePath(`D:\\${'a'.repeat(5000)}.xmind`))
  check(
    '任意扩展名都放行（改名后打开应给出业务提示，而不是"路径非法"）',
    isPlausibleFilePath('D:\\a\\b.txt')
  )

  group('IPC 入参校验：图片')

  eq('空字节被拒', checkImagePayload(new Uint8Array(0)) !== null, true)
  eq('正常字节通过', checkImagePayload(new Uint8Array(8)), null)
  eq('非字节数组被拒', checkImagePayload('abc') !== null, true)
  eq('超上限被拒', checkImagePayload(new Uint8Array(MAX_IMAGE_BYTES + 1)) !== null, true)
  eq('刚好到上限通过', checkImagePayload(new Uint8Array(MAX_IMAGE_BYTES)), null)
  eq('名字过长被拒', checkImagePayload(new Uint8Array(4), 'x'.repeat(300)) !== null, true)

  rmSync(dir, { recursive: true, force: true })
}

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
  check(
    '粘贴保留子树且换了新 id',
    pasted.children.length === 1 && pasted.children[0].id !== find(b1)?.children[0].id
  )
  check('源节点未受影响', find(b1)?.children.length === 1)

  // 折叠（规则：**超过 1 个子节点**才允许折叠；已折叠的总是可以展开）
  addChildOf(b1, '第二个子节点')
  store().toggleCollapse(b1)
  check('折叠生效', find(b1)?.collapsed === true)
  store().toggleCollapse(b1)
  check('再次折叠取消', !find(b1)?.collapsed)
  const onlyChild = addChildOf(rootId, '单子节点')
  addChildOf(onlyChild, '它唯一的孩子')
  store().toggleCollapse(onlyChild)
  check('单子节点的主题不可折叠（界面上也不显示折叠徽标）', !find(onlyChild)?.collapsed)
  const leaf = addChildOf(rootId, '叶子')
  store().toggleCollapse(leaf)
  check('无子节点的主题不可折叠', !find(leaf)?.collapsed)

  // 结构（画布级：只写在中心主题上）
  store().setStructure('org.xmind.ui.logic.right')
  check(
    '根结构已切换',
    root().structureClass === 'org.xmind.ui.logic.right',
    String(root().structureClass)
  )
  check(
    '切换结构不碰子节点',
    find(b1)?.structureClass === undefined,
    String(find(b1)?.structureClass)
  )

  // 自由定位
  store().offsetPosition(b1, 10, -20)
  eq('自由定位累加正确', find(b1)?.position, { x: 10, y: -20 })
  store().offsetPosition(b1, 5, 5)
  eq('自由定位二次累加正确', find(b1)?.position, { x: 15, y: -15 })
  // 把带偏移的主题拖到另一个落点上时，偏移必须清掉：
  // 否则它会落在"自动布局位置 + 偏移"的地方，也就是落点预览画在一处、松手却在另一处。
  const dropHost = addChildOf(rootId, '落点宿主')
  store().dropNode(b1, dropHost, 'child')
  check(
    '落到新父级后清掉自由偏移',
    find(b1)?.position === undefined,
    JSON.stringify(find(b1)?.position)
  )
  check('确实换了父级', findParent(root(), b1)?.id === dropHost)
  store().undo()
  eq('撤销后偏移也回来了', find(b1)?.position, { x: 15, y: -15 })

  store().setSelection([b1])
  eq('选中自由摆放的主题时只恢复它', store().restoreAutoLayout(), 1)
  check('恢复自动布局清空偏移', find(b1)?.position === undefined)

  /**
   * 范围规则：选中里只要有自由摆放的主题就只恢复这些，否则整张画布一起恢复。
   * 这条规则是**唯一入口**的前提——三个入口（选中 / 全部 / 又一个全部）刚被合并成一个，
   * 改坏了的表现是"想只恢复一个，结果整张画布都动了"（或者反过来，点了没反应）。
   */
  store().offsetPosition(b1, 30, 0)
  store().offsetPosition(dropHost, -20, 10)
  store().setSelection([])
  eq('没有选中自由摆放的主题时恢复全部（2 个）', store().restoreAutoLayout(), 2)
  check(
    '全部放回自动布局',
    find(b1)?.position === undefined && find(dropHost)?.position === undefined
  )
  eq('没有自由摆放时返回 0 且不写历史', store().restoreAutoLayout(), 0)
  store().undo()
  check(
    '整批恢复可以一次撤销',
    find(b1)?.position !== undefined || find(dropHost)?.position !== undefined
  )

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

function testMarkdownFullFormat(): void {
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

/* ------------------------------------------------------------------ */
/* 8.5i 默认文字样式：新建节点套用 / 应用到全部                          */
/* ------------------------------------------------------------------ */

function testDefaultStyles(): void {
  group('默认文字样式：新建节点套用')

  reset()
  const restore = (): void =>
    store().setAppSettings({
      ...store().appSettings,
      defaultFontFamily: null,
      defaultFontSize: null,
      defaultColor: null
    })

  store().setAppSettings({
    ...store().appSettings,
    defaultFontFamily: '楷体',
    defaultFontSize: 18,
    defaultColor: '#27AE60'
  })

  const dsRoot = root().id
  // 模拟真实新建流程：建空节点 → 输入文字 → 提交（首次命名）
  const fresh = store().addChild(dsRoot)
  store().updateEditingText('普通新建')
  store().commitEdit()
  const dsChild = fresh

  const runOf = (id: string): { fontFamily?: string; fontSize?: number; color?: string } => {
    const rich = find(id)?.titleRich
    return rich?.paragraphs[0]?.runs[0] ?? {}
  }

  eq('首次命名：套用默认字体', runOf(dsChild).fontFamily, '楷体')
  eq('首次命名：套用默认字号', runOf(dsChild).fontSize, 18)
  eq('首次命名：套用默认颜色', runOf(dsChild).color, '#27AE60')

  // 改老节点的文字：绝不能突然被换默认样式
  store().updateEditingText('普通新建（改）')
  store().commitEdit()
  eq('改老节点文字不被重盖默认样式', runOf(dsChild).fontFamily, '楷体')
  eq('（颜色保持用户没动过的默认值即可）', runOf(dsChild).color, '#27AE60')

  const batch = store().addChildTitles(dsChild, ['AI 扩写的'])
  eq('AI 扩写也套用默认字号', batch, 1)

  const richAdded = store().addRichChildren(dsChild, [
    {
      title: '带格式的',
      rich: { paragraphs: [{ runs: [{ text: '带格式的', color: '#EB5757' }] }] }
    }
  ])
  eq('添加成功', richAdded, 1)
  const richKids = find(dsChild)?.children ?? []
  const richNode = richKids[richKids.length - 1]
  eq('显式颜色不被默认覆盖', richNode?.titleRich?.paragraphs[0]?.runs[0]?.color, '#EB5757')
  eq('缺失的字体补上默认值', richNode?.titleRich?.paragraphs[0]?.runs[0]?.fontFamily, '楷体')

  group('默认文字样式：应用到全部现有节点')

  // 先清掉默认再建一个「没被盖章」的节点，然后设置默认 + 应用到全部
  restore()
  const untouched = store().addChild(dsRoot)
  store().updateEditingText('没盖章的')
  store().commitEdit()
  eq('前置：节点还没被盖章', find(untouched)?.titleRich, undefined)
  store().setAppSettings({ ...store().appSettings, defaultColor: '#2F6BFF' })

  store().applyDefaultsToAll()
  eq('应用到全部：节点获得默认颜色', runOf(untouched).color, '#2F6BFF')
  store().undo()
  eq('应用到全部可撤销', find(untouched)?.titleRich, undefined)

  restore()
}

/* ------------------------------------------------------------------ */
/* 8.5h 多文档标签：快照切换 / 隔离 / 去重 / 排序                        */
/* ------------------------------------------------------------------ */

function testTabs(): void {
  group('多文档标签：快照与隔离')

  // 从干净状态开始：reset 之后的编辑器就是「当前激活文档」
  reset()
  const pristineTabs = useTabs.getState()
  const pristineId = pristineTabs.activeId
  eq('初始只有一个标签', pristineTabs.tabs.length, 1)

  // 在当前（唯一）标签里做出内容
  const tab1Root = root().id
  store().setTitle(tab1Root, '第一份文档')
  const tab1Child = addChildOf(tab1Root, '甲')

  // 新建标签：编辑器换成全新文档，第一份原样停在标签里
  useTabs.getState().newTab()
  const state2 = useTabs.getState()
  eq('新建后有两个标签', state2.tabs.length, 2)
  check('激活的是新标签', state2.activeId !== pristineId, state2.activeId)
  eq('新标签是全新文档', activeRoot(store().workbook).title, '中心主题')

  // 新文档里做改动 + 记住撤销栈长度
  const tab2Id = useTabs.getState().activeId
  const tab2Root = root().id
  store().setTitle(tab2Root, '第二份文档')
  const tab2UndoDepth = store().undoStack.length
  check('第二份有撤销记录', tab2UndoDepth > 0, String(tab2UndoDepth))

  // 切回第一份：workbook / 选中内容 / 撤销栈都要原样回来
  useTabs.getState().switchTo(pristineId)
  eq('切回后根主题是第一份的', activeRoot(store().workbook).title, '第一份文档')
  check('第一份的子主题还在', Boolean(find(tab1Child)), '子主题丢了')
  eq('第一份的撤销栈与第二份无关', store().undoStack.length !== tab2UndoDepth, true)
  const tab1UndoDepth = store().undoStack.length
  store().undo()
  eq('第一份的撤销栈可用（undo 走一步）', store().undoStack.length, tab1UndoDepth - 1)

  // 再切回第二份：改动与撤销栈都还在
  useTabs.getState().switchTo(tab2Id)
  eq('第二份的改动还在', activeRoot(store().workbook).title, '第二份文档')
  eq('第二份的撤销栈还在', store().undoStack.length, tab2UndoDepth)

  group('多文档标签：路径去重 / 排序 / 关闭')

  // 路径去重：markSaved 后 findByPath 应能找到（大小写/斜杠归一）
  store().markSaved('D:/Tmp/DocA.xmind')
  eq('按路径找到标签', useTabs.getState().findByPath('d:/tmp/doca.XMIND'), tab2Id)
  eq('没开过的文件找不到', useTabs.getState().findByPath('D:/Tmp/其他.xmind'), null)

  // 排序：把第二个标签拖到最前
  useTabs.getState().moveTab(1, 0)
  eq('拖拽后顺序改变', useTabs.getState().tabs[0].id, tab2Id)
  eq('拖拽不影响激活', useTabs.getState().activeId, tab2Id)

  // 关闭非激活标签：直接移除
  useTabs.getState().closeTab(pristineId)
  eq('关闭后只剩一个标签', useTabs.getState().tabs.length, 1)

  // 关闭激活标签（最后一个）：窗口留下，换成空白文档
  useTabs.getState().closeTab(tab2Id)
  eq('关掉最后一个后仍是单标签', useTabs.getState().tabs.length, 1)
  eq('关掉最后一个后是全新文档', activeRoot(store().workbook).title, '中心主题')
  eq('关掉最后一个后不脏', store().dirty, false)
  eq('路径记录随文档消失', useTabs.getState().findByPath('D:/Tmp/DocA.xmind'), null)
}

/* ------------------------------------------------------------------ */
/* 8.5g 多窗口：路径判定与自动存档槽位                                  */
/* ------------------------------------------------------------------ */

function testMultiWindow(): void {
  group('多窗口：路径判定与存档槽位')

  eq('大小写与斜杠不同 = 同一个文件', sameDocPath('C:\\A\\B.xmind', 'c:/a/b.XMIND'), true)
  eq('不同文件不算同一个', sameDocPath('C:/a/b.xmind', 'C:/a/c.xmind'), false)
  eq('null 不与任何路径相等', sameDocPath(null, 'C:/a/b.xmind'), false)
  eq('两边都 null 不等于同一个', sameDocPath(null, null), false)
  eq('路径末尾斜杠不影响判定', sameDocPath('C:/dir/b.xmind\\', 'C:/dir/b.xmind'), true)

  eq(
    '双击已打开的文件：命中那个窗口',
    findWindowForPath(['C:/a.xmind', null, 'C:/b.xmind'], 'c:/B.xmind'),
    2
  )
  eq('没打开过：-1（开新窗口）', findWindowForPath([null, 'C:/a.xmind'], 'C:/z.xmind'), -1)
  eq('空窗口列表：-1', findWindowForPath([], 'C:/a.xmind'), -1)

  eq('存档槽位名', autosaveSlotName(3), 'slot-3')
  eq('槽位名从 1 起（0/负数兜底）', autosaveSlotName(0), 'slot-1')
}

/* ------------------------------------------------------------------ */
/* 8.5d 「从文件管理器打开」：命令行参数识别                             */
/* ------------------------------------------------------------------ */

function testPickDocumentArg(): void {
  group('从文件管理器打开：命令行参数识别')
  const exists = (path: string): boolean =>
    path === 'D:\\A\\plan.xmind' || path === 'D:\\B\\灵感.emmx'

  eq(
    '认出 .xmind',
    pickDocumentArg(['SMind.exe', 'D:\\A\\plan.xmind'], exists),
    'D:\\A\\plan.xmind'
  )
  eq('也认 .emmx', pickDocumentArg(['SMind.exe', 'D:\\B\\灵感.emmx'], exists), 'D:\\B\\灵感.emmx')
  eq('文件不存在就不认', pickDocumentArg(['SMind.exe', 'D:\\A\\missing.xmind'], exists), null)
  eq('没有文档参数时返回 null', pickDocumentArg(['electron.exe', '.'], exists), null)
  eq(
    '跳过开关参数',
    pickDocumentArg(['-r', '--inspect', 'D:\\A\\plan.xmind'], exists),
    'D:\\A\\plan.xmind'
  )
  eq('exe 自己不会被当作文档', pickDocumentArg(['D:\\SMind\\SMind.exe'], exists), null)
  eq('别的格式不认', pickDocumentArg(['D:\\A\\notes.txt'], exists), null)
  eq(
    '同时给了多个就取最后一个（用户双击的那个）',
    pickDocumentArg(['SMind.exe', 'D:\\A\\plan.xmind', 'D:\\B\\灵感.emmx'], exists),
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
  eq(
    '格式不影响纯文本',
    plainTextOf({ paragraphs: [{ runs: [{ text: 'abc', bold: true, color: '#f00' }] }] }),
    'abc'
  )

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
  check(
    '加粗判为富文本',
    hasFormatting({ paragraphs: [{ runs: [{ text: 'x', bold: true }] }] }) === true
  )
  check(
    '颜色判为富文本',
    hasFormatting({ paragraphs: [{ runs: [{ text: 'x', color: '#f00' }] }] }) === true
  )
  check('多段落判为富文本', hasFormatting(richFromPlain('a\nb')) === true)
  check(
    '居中是默认值不算格式',
    hasFormatting({ paragraphs: [{ align: 'center', runs: [{ text: 'x' }] }] }) === false
  )
  check(
    '左对齐算格式',
    hasFormatting({ paragraphs: [{ align: 'left', runs: [{ text: 'x' }] }] }) === true
  )
  check(
    '项目符号算格式',
    hasFormatting({ paragraphs: [{ bullet: true, runs: [{ text: 'x' }] }] }) === true
  )

  group('富文本：模型 <-> TipTap 往返')
  const rich: RichText = {
    paragraphs: [
      { runs: [{ text: '标题', bold: true, color: '#2F6BFF', fontSize: 18 }] },
      {
        align: 'center',
        runs: [
          { text: '普通', italic: true, strike: true },
          { text: '混排', underline: true }
        ]
      }
    ]
  }
  const doc = richToTiptap(rich)
  check(
    '生成 doc 且段落数正确',
    doc.type === 'doc' && doc.content.length === 2,
    String(doc.content.length)
  )
  check(
    '加粗生成 bold mark',
    Boolean(doc.content[0].content?.[0].marks?.some((m) => m.type === 'bold'))
  )
  check(
    '颜色与字号进入 textStyle',
    Boolean(
      doc.content[0].content?.[0].marks?.some(
        (m) =>
          m.type === 'textStyle' && m.attrs?.color === '#2F6BFF' && m.attrs?.fontSize === '18px'
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
    content: [
      { type: 'paragraph', attrs: { textAlign: 'left' }, content: [{ type: 'text', text: '靠左' }] }
    ]
  })
  check(
    '显式左对齐被保留',
    explicitLeft.paragraphs[0].align === 'left',
    String(explicitLeft.paragraphs[0].align)
  )

  const explicitCenter = tiptapToRich({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { textAlign: 'center' },
        content: [{ type: 'text', text: '居中' }]
      }
    ]
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
  check(
    '项目符号往返保留',
    bulletBack.paragraphs.every((p) => p.bullet === true)
  )
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
  check(
    '无格式不写入 titleRich',
    find(plainId)?.titleRich === undefined,
    String(find(plainId)?.titleRich)
  )
  check('无格式仍写入 title', find(plainId)?.title === '普通文字', String(find(plainId)?.title))

  store().setRichText(id, { paragraphs: [{ runs: [{ text: '改过的', italic: true }] }] })
  check('setRichText 更新标题', find(id)?.title === '改过的', String(find(id)?.title))
  check('setRichText 更新格式', find(id)?.titleRich?.paragraphs[0].runs[0].italic === true)
  store().setRichText(id, null)
  check('setRichText 传 null 清空格式', find(id)?.titleRich === undefined)
  store().undo()
  check('撤销能回退格式修改', find(id)?.titleRich?.paragraphs[0].runs[0].italic === true)

  const snapId = store().addChild(rootId)
  store().updateEditingRich({
    paragraphs: [{ runs: [{ text: '未提交的富文本', color: '#EB5757' }] }]
  })
  const snapshot = snapshotForSave(store())
  const snapTopic = findTopic(activeRoot(snapshot), snapId)
  check(
    '快照包含未提交的富文本格式',
    snapTopic?.titleRich?.paragraphs[0].runs[0].color === '#EB5757'
  )
  check('快照同时写入纯文本', snapTopic?.title === '未提交的富文本')
}

/* ------------------------------------------------------------------ */
/* 8.7 主题系统                                                        */
/* ------------------------------------------------------------------ */

function testTheme(): void {
  group('主题：内置主题库')
  check('内置主题不少于 6 套', BUILTIN_THEMES.length >= 6, String(BUILTIN_THEMES.length))
  check('主题 id 唯一', new Set(BUILTIN_THEMES.map((t) => t.id)).size === BUILTIN_THEMES.length)
  check(
    '内置主题都标记为 builtin',
    BUILTIN_THEMES.every((t) => t.builtin)
  )
  check(
    '内置配色都能通过校验',
    BUILTIN_THEMES.every((t) => normalizeThemeColors(t.colors) !== null)
  )
  check(
    '每套主题至少有 4 个分支配色',
    BUILTIN_THEMES.every((t) => t.colors.branches.length >= 4)
  )
  check('默认主题就是第一套', DEFAULT_THEME.id === BUILTIN_THEMES[0].id)

  group('主题：配色校验')
  eq('完整配色原样通过', normalizeThemeColors(DEFAULT_THEME.colors), DEFAULT_THEME.colors)
  check('空对象视为无效', normalizeThemeColors({}) === null)
  check('非对象视为无效', normalizeThemeColors('abc') === null)
  eq('缺失字段补默认值', normalizeThemeColors({ canvas: '#123456' })?.canvas, '#123456')
  eq(
    '非法颜色替换为默认值',
    normalizeThemeColors({ canvas: 'red' })?.canvas,
    DEFAULT_THEME.colors.canvas
  )
  eq(
    '非法分支配色被过滤',
    normalizeThemeColors({ branches: ['#fff', 'bad', '#112233'] })?.branches,
    ['#fff', '#112233']
  )
  check(
    '分支配色为空时回填默认',
    (normalizeThemeColors({ branches: [] })?.branches.length ?? 0) > 0
  )
  eq(
    '连线过粗被截断到上限',
    normalizeThemeColors({ canvas: '#ffffff', edgeWidth: 999 })?.edgeWidth,
    8
  )
  eq(
    '透明度越界被截断到下限',
    normalizeThemeColors({ canvas: '#ffffff', edgeOpacity: -1 })?.edgeOpacity,
    0.1
  )

  group('主题：主题定义校验')
  const definition = normalizeThemeDefinition({
    id: 'my',
    name: '我的主题',
    colors: DEFAULT_THEME.colors
  })
  check(
    '定义校验通过',
    definition?.id === 'my' && definition?.name === '我的主题' && definition?.builtin === false
  )
  check(
    '缺 id 时自动生成',
    typeof normalizeThemeDefinition({ name: 'a', colors: DEFAULT_THEME.colors })?.id === 'string'
  )
  eq(
    '缺名称时给默认名',
    normalizeThemeDefinition({ colors: DEFAULT_THEME.colors })?.name,
    '未命名主题'
  )
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
    getThemeColors({
      id: 'builtin-minimal',
      colors: { ...DEFAULT_THEME.colors, canvas: '#000000' }
    }).canvas,
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
  eq(
    '一步撤销回到调色之前',
    themeColorsOf(store().workbook).canvas,
    BUILTIN_THEMES[0].colors.canvas
  )
  store().redo()
  eq('重做回到调色之后', themeColorsOf(store().workbook).canvas, '#303030')

  store().updateThemeColors({ branches: ['#111111', '#222222'] })
  eq('可整体替换分支配色', themeColorsOf(store().workbook).branches, ['#111111', '#222222'])
}

/* ------------------------------------------------------------------ */
/* 默认主题：新建文档要能套用                                          */
/* ------------------------------------------------------------------ */

function testDefaultTheme(): void {
  group('默认主题：直接烤进文档（新建文档套用）')

  reset()
  const theme = BUILTIN_THEMES[2]!
  const undoBefore = store().undoStack.length
  const dirtyBefore = store().dirty
  store().primeTheme(theme)

  const baked = store().workbook.sheets[0]!.theme
  eq('主题 id 写进去了', baked?.id, theme.id)
  eq('主题名字也写进去了', baked?.name, theme.name)
  eq('配色已烤进文档', baked?.colors?.canvas, theme.colors.canvas)
  check('分支配色是拷贝而不是引用', baked?.colors?.branches !== theme.colors.branches)
  eq('不产生撤销记录（新建文档不该一上来就能撤销）', store().undoStack.length, undoBefore)
  eq('不改动「未保存」状态', store().dirty, dirtyBefore)

  group('默认主题：applyTheme 才该算一次编辑')

  reset()
  store().applyTheme({ id: theme.id, name: theme.name, colors: theme.colors })
  eq('applyTheme 会产生一步撤销', store().undoStack.length, 1)
  check('applyTheme 会标成未保存', store().dirty === true)
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
  const first = await parseXmind(
    await serializeXmind({ workbook: native, resources: {} } as MindPackage)
  )
  check('Xmind 原生主题结构被保留', first.workbook.sheets[0].theme?.raw !== undefined)
  eq('原生主题属性逐字段保留', first.workbook.sheets[0].theme?.raw?.properties, {
    'svg:fill': '#ffffff'
  })
  const second = await parseXmind(
    await serializeXmind({ workbook: first.workbook, resources: {} } as MindPackage)
  )
  check(
    '原生主题二次往返稳定',
    normalize(second.workbook) === normalize(first.workbook),
    firstDiff(normalize(first.workbook, 2), normalize(second.workbook, 2))
  )
}

/* ------------------------------------------------------------------ */
/* 9. 布局引擎                                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 10. .xmind 往返保真                                                 */
/* ------------------------------------------------------------------ */

async function testRoundTrip(): Promise<void> {
  group('.xmind 往返保真')
  const workbook = buildFeatureRichWorkbook()
  const before = normalize(workbook)
  const beforeSheets = workbook.sheets.length

  const bytes = await serializeXmind({ workbook, resources: {} } as MindPackage)
  check('序列化产出非空字节', bytes.length > 0, String(bytes.length))

  const parsed = await parseXmind(bytes)
  check(
    '画布数量保持',
    parsed.workbook.sheets.length === beforeSheets,
    String(parsed.workbook.sheets.length)
  )
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
  const again = await parseXmind(
    await serializeXmind({ workbook: parsed.workbook, resources: {} } as MindPackage)
  )
  check(
    '二次往返仍然一致',
    normalize(again.workbook) === before,
    firstDiff(normalize(parsed.workbook, 2), normalize(again.workbook, 2))
  )
}

/* ------------------------------------------------------------------ */
/* 10b. 平衡图「左右分别收起」的 .xmind 往返                            */
/* ------------------------------------------------------------------ */

/**
 * 收起标记存在 `topic.style.properties` 的私有键里（与 `TOPIC_SIDE_KEY` 同一套做法：
 * Xmind 忽略不认识的键、我们原样往返），所以它必须跟着 style 一起保存/打开——
 * 这里真跑一遍，确认收起状态不丢、被收起的节点数据也还在。
 */
async function testFoldSidesRoundTrip(): Promise<void> {
  group('平衡图「左右分别收起」：.xmind 往返')

  reset()
  const rootId = root().id
  store().setStructure('org.xmind.ui.map.unbalanced')
  const sides = childFoldSides(root())
  const rightIds = root()
    .children.filter((topic) => sides.get(topic.id) === 'right')
    .map((topic) => topic.id)
  const leftIds = root()
    .children.filter((topic) => sides.get(topic.id) === 'left')
    .map((topic) => topic.id)
  check('默认文档两侧都有分支', leftIds.length > 0 && rightIds.length > 0)
  store().toggleFoldSide(rootId, 'left')

  const pkg = await parseXmind(await serializeXmind({ workbook: store().workbook, resources: {} }))
  const back = pkg.workbook.sheets[0]?.rootTopic
  check('打开后有根主题', Boolean(back))
  if (!back) return
  eq('收起标记随文件往返', foldedSidesOf(back).join(','), 'left')
  eq(
    '打开后左侧仍然收着',
    visibleChildren(back)
      .map((topic) => topic.id)
      .join(','),
    rightIds.join(',')
  )
  check(
    '被收起的左侧分支数据没丢（只是收起）',
    leftIds.every((id) => back.children.some((topic) => topic.id === id))
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
  zip.file(
    'metadata.json',
    JSON.stringify({ creator: { name: 'Xmind', version: '1.0' }, activeSheetId: 'sheet-x' })
  )
  const bytes = await zip.generateAsync({ type: 'uint8array' })

  const parsed = await parseXmind(bytes)
  check('未识别的结构给出提示', parsed.warnings.length === 1, parsed.warnings.join(' '))
  check(
    '未识别的结构类型被原样读入',
    parsed.workbook.sheets[0].rootTopic.structureClass === 'org.xmind.ui.something.unknown'
  )
  check('节点级未知扩展被保留', parsed.workbook.sheets[0].rootTopic.extensions?.length === 1)
  check(
    '子节点未知扩展被保留',
    parsed.workbook.sheets[0].rootTopic.children[0].extensions?.length === 1
  )
  check('未实现的布局不阻塞解析', parsed.workbook.sheets[0].rootTopic.children.length === 1)

  // 另存后未知字段仍在
  const out = await parseXmind(
    await serializeXmind({ workbook: parsed.workbook, resources: {} } as MindPackage)
  )
  check('另存后未知扩展仍然保留', out.workbook.sheets[0].rootTopic.extensions?.length === 1)
  check(
    '另存后子节点未知扩展仍然保留',
    out.workbook.sheets[0].rootTopic.children[0].extensions?.length === 1
  )
  check(
    '另存不会丢掉标记',
    out.workbook.sheets[0].rootTopic.children[0].markers[0]?.markerId === 'star-red'
  )

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
  eq(
    '合法元信息被正确解析',
    parseRecoveryMeta({ originalPath: 'D:/a.xmind', title: '标题', savedAt: 123 }),
    {
      originalPath: 'D:/a.xmind',
      title: '标题',
      savedAt: 123
    }
  )
  eq(
    '缺标题时给默认标题',
    parseRecoveryMeta({ savedAt: 123, originalPath: null })?.title,
    '未命名导图'
  )
  eq('空路径规整为 null', parseRecoveryMeta({ savedAt: 123, originalPath: '' })?.originalPath, null)
  check('多余字段被忽略且不影响解析', parseRecoveryMeta({ savedAt: 123, junk: 1 }) !== null)
}

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

function testOutline(): void {
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

/* ------------------------------------------------------------------ */
/* 12.10 导出：绘图指令 / SVG / PDF                                     */
/* ------------------------------------------------------------------ */

/** 造一张覆盖各种元素的画布，供导出测试用 */

function testExportDrawing(): void {
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
function testExportFormats(): void {
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
function testMeasureStyles(): void {
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
  } finally {
    if (saved === undefined) delete (globalThis as { document?: unknown }).document
    else (globalThis as { document?: unknown }).document = saved
  }
}

/* ------------------------------------------------------------------ */
/* 文档 → 导图：格式识别、抽文本、分段                                  */
/* ------------------------------------------------------------------ */

function testDocument(): void {
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

/* ------------------------------------------------------------------ */
/* 12.12 导入：Markdown / OPML 一键生成导图                            */
/* ------------------------------------------------------------------ */

function testImport(): void {
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
      {
        path: 'D:\\a.xmind',
        name: 'a.xmind',
        title: '甲',
        openedAt: 100,
        openCount: 2,
        pinned: true
      },
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
  eq(
    '排序：常用优先，其余按时间倒序',
    sorted.map((entry) => entry.path),
    ['c', 'b', 'a']
  )

  const before = [
    { path: 'x', name: 'x', title: '', openedAt: 1, openCount: 1, pinned: false },
    { path: 'y', name: 'y', title: '', openedAt: 9, openCount: 1, pinned: false }
  ]
  sortEntries(before)
  eq(
    '排序不修改传入的数组',
    before.map((entry) => entry.path),
    ['x', 'y']
  )

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

  /**
   * 「昨天」按**日历日**算，不按流逝时长算（用本地时间构造，任何时区都确定）。
   * 老代码是 `diff < 2 天 → 昨天`，两个方向都会错。
   */
  {
    // 2026-09-18 01:00（本地）
    const midnightish = new Date(2026, 8, 18, 1, 0, 0).getTime()
    eq(
      '前天晚上（才 30 小时前）不该叫「昨天」',
      relativeTime(midnightish - 30 * 3_600_000, midnightish),
      '2 天前'
    )
    eq(
      '昨天下午（才 10 小时前）按日历日就是「昨天」',
      relativeTime(midnightish - 10 * 3_600_000, midnightish),
      '昨天'
    )
    eq(
      '跨过午夜就是「昨天」（哪怕只过了 2 小时）',
      relativeTime(midnightish - 2 * 3_600_000, midnightish),
      '昨天'
    )
    const evening = new Date(2026, 8, 18, 23, 0, 0).getTime()
    eq('同一天内仍按小时数显示', relativeTime(evening - 2 * 3_600_000, evening), '2 小时前')
  }
}

/* ------------------------------------------------------------------ */
/* 版本快照（纯函数）                                                   */
/* ------------------------------------------------------------------ */

function testSnapshots(): void {
  group('版本快照：文档键')

  eq(
    '已保存文档按路径归并（大小写与斜杠都不敏感）',
    documentKeyOf('D:\\图\\a.xmind'),
    documentKeyOf('d:/图/a.xmind')
  )
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
  check(
    '被裁的 id 不在保留名单里',
    many.dropped.every((id) => !keptIds.has(id))
  )
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
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `a${index}`,
        docKey: DOC_A,
        at: 1000 + index
      })),
      { id: 'b1', docKey: DOC_B, at: 1 }
    ]
  })
  check(
    '另一个文档的版本不受影响',
    twoDocs.index.items.some((item) => item.id === 'b1')
  )

  group('版本快照：增删与查询')

  let result = addSnapshot(emptySnapshotIndex(), snap({ id: 'v1', at: 100 }))
  eq('新增一个版本', result.index.items.length, 1)
  eq('没有需要删的文件', result.dropped.length, 0)

  result = addSnapshot(result.index, snap({ id: 'v2', at: 200 }))
  eq('再新增一个', result.index.items.length, 2)

  eq(
    '按时间倒序查询',
    snapshotsOf(result.index, DOC_A).map((item) => item.id),
    ['v2', 'v1']
  )
  eq('查别的文档为空', snapshotsOf(result.index, DOC_B).length, 0)

  result = addSnapshot(result.index, snap({ id: 'v2', at: 300 }))
  eq('同 id 覆盖而不是重复', result.index.items.length, 2)

  const afterRemove = removeSnapshot(result.index, 'v2')
  eq(
    '删除生效',
    snapshotsOf(afterRemove.index, DOC_A).map((item) => item.id),
    ['v1']
  )
  eq('删除会同时上报要删的文件', afterRemove.dropped, ['v2'])
  eq('删除不存在的 id 不报错', removeSnapshot(result.index, 'not-exist').index.items.length, 2)

  const both = addSnapshot(
    addSnapshot(emptySnapshotIndex(), snap({ id: 'x1' })).index,
    snap({ id: 'y1', docKey: DOC_B })
  ).index
  const cleared = clearDocSnapshots(both, DOC_A)
  eq(
    '只清指定文档的版本',
    cleared.index.items.map((item) => item.id),
    ['y1']
  )
  eq('清掉的 id 会一并上报（否则文件永远留在磁盘上）', cleared.dropped, ['x1'])

  group('版本快照：自动快照的判定')

  check('没有版本时先存一个', shouldAutoSnapshot([], 'h1', 1000))

  const base = [snap({ id: 'v1', at: 10_000, hash: 'same' })]
  check('内容没变就不重复存', !shouldAutoSnapshot(base, 'same', 10_000 + 60 * 60_000))
  check('内容变了但间隔太近也先不存', !shouldAutoSnapshot(base, 'other', 10_000 + 60_000))
  check(
    '内容变了且间隔足够才存',
    shouldAutoSnapshot(base, 'other', 10_000 + SNAPSHOT_LIMITS.minGap)
  )
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
