/**
 * 自检域：testMisc / testTypedChar / testDefaultStyles / testTabs / testMultiWindow / testPickDocumentArg / testViewLock / testSnapshot / testSnapshots / testRichText / testTheme / testDefaultTheme / testThemeRoundTrip / testSafetyHelpers / testRecovery / testRoundTrip / testFoldSidesRoundTrip / testUnknownPassthrough / testNaming / testHistory（由 scripts/selfcheck.ts 按行范围搬出，行为零变化）。
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
import { snapshotForSave, themeColorsOf } from '../../../src/renderer/src/store/editor'
import { useTabs } from '../../../src/renderer/src/store/tabs'
import { withAlpha } from '../../../src/renderer/src/render/theme'
import { pickDocumentArg } from '../../../src/shared/openfile'
import {
  clearTypedChar,
  stageTypedChar,
  takeTypedChar
} from '../../../src/renderer/src/editor/typedChar'
import {
  BUILTIN_THEMES,
  DEFAULT_THEME,
  getThemeColors,
  normalizeThemeColors,
  normalizeThemeDefinition
} from '../../../src/shared/theme'
import {
  activeRoot,
  activeSheet,
  countCharacters,
  childFoldSides,
  findParent,
  findTopic,
  foldedSidesOf,
  attachChild,
  moveTopic,
  visibleChildren
} from '../../../src/shared/model/tree'
import { coerceCode, coerceRichText } from '../../../src/shared/model/coerce'
import {
  checkImagePayload,
  isPlausibleFilePath,
  MAX_IMAGE_BYTES
} from '../../../src/shared/ipc-args'
import { isInstanceAlive, isSelfNavigation } from '../../../src/shared/guards'
import {
  isPortableBuild,
  releaseNotesOf,
  shouldRecheck,
  updateOfferOf,
  UPDATE_RECHECK_INTERVAL_MS
} from '../../../src/shared/update-policy'
import { normalizeLicenseState } from '../../../src/main/license/state'
import { verifyLicenseKeyWith } from '../../../src/main/license/verify'
import { findResourceBytes, resourcePathFromUrl } from '../../../src/main/resource-table'
import { windowsToAsk } from '../../../src/main/quit-flow'
import { windowOwningPath } from '../../../src/main/window-match'
import { generateKeyPairSync, sign as signData } from 'node:crypto'
import {
  bytesToBase64Url,
  encodeLicenseKey,
  licensePayloadSegment,
  type LicensePayload
} from '../../../src/shared/license'
import { writeFileAtomic, writeJsonAtomic } from '../../../src/main/atomic-write'
/*
 * 主进程的回归网：`selfcheck` 此前只覆盖到 `atomic-write.ts` 一个主进程文件（14 个 IPC 域拆分后
 * 全靠 `npm run build` + 手工冒烟）。下面这两个模块**不依赖 Electron**，可以直接纳入：
 * `doc-resources.ts`（按 docId 隔离图片/附件）与 `document.ts`（拖文档抽取 + 防 zip 炸弹）。
 */
import { DOC_ID_MAX, docOf, pruneForSave, type DocResources } from '../../../src/main/doc-resources'
import { IMPORT_DOCUMENT_EXTENSIONS, extractDocumentFromBytes } from '../../../src/main/document'
import { ensureXmindExt, firstPathOf } from '../../../src/main/file-args'
import { createWorkbook } from '../../../src/shared/model/factory'

import { evictOldest } from '../../../src/shared/cache'

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
} from '../../../src/shared/history'
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
} from '../../../src/shared/snapshot'

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { classifyDocument, pathFromFileUrl } from '../../../src/shared/document'

import { autosaveSlotName, findWindowForPath, sameDocPath } from '../../../src/shared/window'

import {
  defaultDocumentName,
  defaultFileName,
  sanitizeFileName
} from '../../../src/shared/model/naming'

import {
  parseRecoveryMeta,
  shouldOfferRecovery,
  type RecoveryMeta
} from '../../../src/shared/recovery'
import { parseXmind } from '../../../src/shared/xmind/parse'
import { serializeXmind } from '../../../src/shared/xmind/serialize'

import {
  appendToRich,
  hasFormatting,
  plainTextOf,
  richFromPlain,
  richToTiptap,
  tiptapToRich,
  withHighlightAll,
  type TipTapDoc,
  type TipTapMark
} from '../../../src/shared/richtext'
import type { MindPackage, RichText, Topic } from '../../../src/shared/model/types'
import { MD_MONO_FONT, isMonoFontFamily } from '../../../src/shared/mono-font'
import {
  inlineRunsToRich,
  parseInlineMarkdown,
  parseInlineRichText
} from '../../../src/shared/import/markdown'
import { overlayRunLines } from '../../../src/shared/layout/overlays'
import {
  BOLD_INPUT,
  BOLD_UNDERSCORE_INPUT,
  FOOTNOTE_INPUT,
  HIGHLIGHT_INPUT,
  ITALIC_INPUT,
  ITALIC_UNDERSCORE_INPUT,
  STRIKE_INPUT,
  SUBSCRIPT_INPUT,
  SUPERSCRIPT_INPUT
} from '../../../src/shared/inline-rules'
import { compositionBoxWidth } from '../../../src/renderer/src/editor/composition-width'
import { codeDraftPatch } from '../../../src/renderer/src/components/nodePanel/code-draft'
import { shouldHandleGlobalShortcut } from '../../../src/renderer/src/app/shortcut-scope'

/* ---- D1 拆分：断言原语搬进 ./selfcheck/harness.ts，按域拆分的其它文件共用它 ---- */
import { check, eq, firstDiff, group, normalize } from '../harness'

/* ---- D1 拆分：共享测试助手搬进 ./selfcheck/helpers.ts（域文件也从那里取） ---- */
import {
  store,
  root,
  find,
  reset,
  addChildOf,
  buildFeatureRichWorkbook,
  DOC_A,
  DOC_B,
  snap
} from '../helpers'

/* ---- D1 拆分：域 testInit/testAddAndCommit/testCommitGuard/testCommitAndAdd/testUndoRedo/testDelete/testMove/testMoveMany 搬进 ./selfcheck/domains/edit.ts ---- */

/* ---- D1 拆分：域 testSortAndDedupe/testNodeDrag/testCollapseSelection/testUndoGranularity/testStructureIsCanvasLevel/testUndoSelectionAndRelayout 搬进 ./selfcheck/domains/canvas.ts ---- */

/* ---- D1 拆分：域 testOverlayReserve/testIncrementalLayout/testLayoutNoOverlap/testLayout/testStructures/testOverlays/testOverlayToggles 搬进 ./selfcheck/domains/layout.ts ---- */

/* ---- D1 拆分：域 testAiChatHelpers/testAgentHelpers/testLicenseHelpers 搬进 ./selfcheck/domains/ai.ts ---- */

/* ---- D1 拆分：域 testAgentTools/testAttachmentTools/testWriteToolsAndTurn/testAi 搬进 ./selfcheck/domains/agent.ts ---- */

/* ---- D1 拆分：域 testMarkdownFullFormat/testMarkdownRoundTrip/testExportDrawing/testExportFormats/testMeasureStyles/testDocument/testImport/testOutline/testSearch 搬进 ./selfcheck/domains/io.ts ---- */

export async function testSafetyHelpers(): Promise<void> {
  /** 对象比较统一转 JSON 串，避免依赖断言器的深比较行为 */
  const json = (value: unknown): string => JSON.stringify(value) ?? 'undefined'

  group('自动更新策略（免安装版与复查节奏）')

  // 免安装版**不能**自更新：它把自己解压到临时目录再启动，装进去的新版下次启动就没了（A4）
  eq('普通安装版：不拦', isPortableBuild({}), false)
  eq(
    '免安装版：命中标记（electron-builder 的 portable target 注入）',
    isPortableBuild({ PORTABLE_EXECUTABLE_FILE: 'D:/SMind-0.9.1-x64-portable.exe' }),
    true
  )
  eq('标记是空串 → 不算（防误判）', isPortableBuild({ PORTABLE_EXECUTABLE_FILE: '' }), false)

  // 长期开着的窗口：重新获得焦点、且距上次检查够久才再查一次（A5）
  // D-15 / T3（2026-09-21）：null（还没查过）从「该查」改成「不查」 —— 能走到这里的只有窗口聚焦那条复检，
  // 而窗口在启动瞬间就会获得焦点，返回 true 等于让检查在启动 ≈1 秒时抢跑。首次检查交给启动定时器。
  eq('还没查过 → 不查（首次检查由启动定时器负责）', shouldRecheck(null, 1_000), false)
  eq('刚查过 → 不查', shouldRecheck(1_000, 1_000 + 60_000), false)
  eq(
    '差一分钟到间隔 → 不查',
    shouldRecheck(1_000, 1_000 + UPDATE_RECHECK_INTERVAL_MS - 60_000),
    false
  )
  eq('正好到间隔 → 查', shouldRecheck(1_000, 1_000 + UPDATE_RECHECK_INTERVAL_MS), true)
  eq('隔了一整天 → 查', shouldRecheck(1_000, 1_000 + 24 * 60 * 60 * 1000), true)

  /*
   * 「有没有可用更新」的判据（真 bug 的回归断言）：
   * `checkForUpdates()` 在**没有更新**时不返回 null，而是 `{ isUpdateAvailable: false, updateInfo }`，
   * 其中 `updateInfo.version` 是**渠道上的版本号**。曾经用 `version !== current` 判，于是
   * **渠道版本 ≤ 本机**时会误报「发现新版本 v0.9.0（当前 v0.9.1）」并声称"正在后台下载"（永不下载）。
   */
  eq(
    '没有可用更新 → 不报新版本',
    updateOfferOf({ isUpdateAvailable: false, updateInfo: { version: '0.9.0' } }),
    null
  )
  eq('返回 null → 不报新版本', updateOfferOf(null), null)
  eq(
    '有可用更新 → 报渠道版本号',
    updateOfferOf({ isUpdateAvailable: true, updateInfo: { version: '0.9.2' } }),
    '0.9.2'
  )
  eq(
    '说有更新但取不到版本号 → 不报',
    updateOfferOf({ isUpdateAvailable: true, updateInfo: {} }),
    null
  )
  eq('形状不对 → 不报', updateOfferOf('坏了'), null)
  eq(
    '渠道版本低于本机（回滚场景）→ 仍只显示"已是最新"',
    updateOfferOf({
      isUpdateAvailable: false,
      updateInfo: { version: '0.9.0' },
      versionInfo: { version: '0.9.0' }
    }),
    null
  )

  group('主进程：文档资源按 docId 隔离（docOf / pruneForSave）')

  const docState: { docs: Map<string, DocResources> } = { docs: new Map() }
  const docA = docOf(docState, 'doc-a')
  eq('第一次取会建出来', docState.docs.size, 1)
  check('再取拿到同一个对象（不会每次新建、把已收集的资源丢掉）', docOf(docState, 'doc-a') === docA)
  const docB = docOf(docState, 'doc-b')
  check('两份文档各自一条记录（A 保存不会把 B 的图片打进包里）', docA !== docB)
  eq('新记录还没有文件路径', docA.docPath, null)
  eq('docId 长度上限是常量（脏输入不该让主进程无界长胖）', DOC_ID_MAX, 120)

  // pruneForSave：只清「本次会话新插入、之后又不再被引用」的资源
  const pruneWorkbook = createWorkbook({ rootTitle: '裁剪测试' })
  pruneWorkbook.sheets[0].rootTopic.image = { path: 'resources/referenced.png' }
  docA.resources = {
    'resources/referenced.png': new Uint8Array([1]),
    'resources/orphan-new.png': new Uint8Array([2]),
    'resources/orphan-old.png': new Uint8Array([3])
  }
  docA.inserted = new Set(['resources/orphan-new.png'])
  pruneForSave(docA, pruneWorkbook)
  check('仍被节点引用的资源保留', 'resources/referenced.png' in docA.resources)
  check('新插入且已不再被引用的资源被清掉', !('resources/orphan-new.png' in docA.resources))
  check(
    '文件里原本带着的资源一律不动（可能有本软件尚未建模的引用）',
    'resources/orphan-old.png' in docA.resources
  )
  check('清掉之后 inserted 里也一并移除', !docA.inserted.has('resources/orphan-new.png'))

  group('主进程：拖进来的文档怎么读（抽取 + 防 zip 炸弹）')

  {
    // 清单与识别口径必须一致，否则会出现"对话框里能选、真读的时候说读不了"
    const unreadable = IMPORT_DOCUMENT_EXTENSIONS.filter(
      (ext) => classifyDocument(`样本.${ext}`).kind === 'unsupported'
    )
    eq('导入清单里的扩展名都是能读的', unreadable.length, 0)
  }

  let pdfMessage = ''
  try {
    await extractDocumentFromBytes('说明书.pdf', new Uint8Array([1, 2, 3]))
  } catch (error) {
    pdfMessage = (error as Error).message
  }
  check('PDF 明确拒绝并给人话原因（不是空结果让人发呆）', pdfMessage.includes('PDF'))

  let unknownMessage = ''
  try {
    await extractDocumentFromBytes('神秘.zzz', new Uint8Array([1, 2, 3]))
  } catch (error) {
    unknownMessage = (error as Error).message
  }
  check('未知格式同样给人话原因', unknownMessage.length > 0)

  let emptyMessage = ''
  try {
    await extractDocumentFromBytes('空白.txt', new TextEncoder().encode('   \n  '))
  } catch (error) {
    emptyMessage = (error as Error).message
  }
  check('没有可读文字时给专门的原因', emptyMessage.includes('没有可读的文字'))

  const plain = await extractDocumentFromBytes(
    '笔记.txt',
    new TextEncoder().encode('第一行\n\n\n第二行  ')
  )
  eq('纯文本按排版清洗（空行压缩、行尾空白去掉）', plain.text, '第一行\n\n第二行')
  eq('没超上限就不写 note', plain.note, null)
  eq('名字只留文件名', plain.name, '笔记.txt')

  // GBK：Windows 上的中文 txt / csv 大量是 GBK，用 UTF-8 硬读会得到一片「锟斤拷」
  const gbk = await extractDocumentFromBytes('中文.txt', new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]))
  eq('GBK 文本按 GBK 读（不是替换符）', gbk.text, '中文')

  let oversizeMessage = ''
  try {
    await extractDocumentFromBytes('超大.txt', new Uint8Array(32 * 1024 * 1024 + 1))
  } catch (error) {
    oversizeMessage = (error as Error).message
  }
  check('超过 32MB 直接拒绝并说清上限', oversizeMessage.includes('文件太大'))

  const JSZipMod = (await import('jszip')).default
  const docxZip = new JSZipMod()
  docxZip.file(
    'word/document.xml',
    '<w:document><w:p><w:r><w:t>要点&amp;细节</w:t></w:r></w:p></w:document>'
  )
  const docx = await extractDocumentFromBytes(
    '报告.docx',
    await docxZip.generateAsync({ type: 'uint8array' })
  )
  check('docx 走 zip 解包并还原实体', docx.text.includes('要点&细节'), docx.text)

  const longZip = new JSZipMod()
  longZip.file('word/document.xml', `<w:t>${'长'.repeat(320_000)}</w:t>`)
  const longDoc = await extractDocumentFromBytes(
    '长文.docx',
    await longZip.generateAsync({ type: 'uint8array' })
  )
  eq('超过 30 万字的正文如实截断', longDoc.text.length, 300_000)
  check('截断时明确写清「只取了前 N 字」', (longDoc.note ?? '').includes('只取了前'))

  const noTextZip = new JSZipMod()
  noTextZip.file('docProps/app.xml', '<Properties/>')
  let noTextMessage = ''
  try {
    await extractDocumentFromBytes(
      '空壳.docx',
      await noTextZip.generateAsync({ type: 'uint8array' })
    )
  } catch (error) {
    noTextMessage = (error as Error).message
  }
  check('zip 里抽不到文字时给专门的原因', noTextMessage.includes('没有抽到文字'))

  group('主进程：对话框结果与扩展名（file-args）')

  eq('取消的对话框 → null', firstPathOf({ canceled: true, filePaths: ['C:\\a.xmind'] }), null)
  eq('没选文件 → null', firstPathOf({ canceled: false, filePaths: [] }), null)
  eq(
    '取用户选中的第一个',
    firstPathOf({ canceled: false, filePaths: ['C:\\a.xmind', 'D:\\b.xmind'] }),
    'C:\\a.xmind'
  )
  eq('已经有 .xmind 就不动', ensureXmindExt('C:\\a.xmind'), 'C:\\a.xmind')
  eq('大小写不敏感', ensureXmindExt('C:\\a.XMIND'), 'C:\\a.XMIND')
  eq('没扩展名就补上', ensureXmindExt('C:\\a'), 'C:\\a.xmind')
  eq('别的扩展名照样补（与旧行为一致）', ensureXmindExt('C:\\a.txt'), 'C:\\a.txt.xmind')

  group('主进程：许可状态的形状与规范化（坏文件不该让应用起不来）')

  const badState = normalizeLicenseState(null)
  eq('null → 未激活', badState.key, null)
  eq('null → 试用 0 次', badState.trialUsed, 0)
  eq('字符串不是状态 → 未激活', normalizeLicenseState('坏了').key, null)
  eq('空对象 → 未激活', normalizeLicenseState({}).key, null)
  eq(
    'key 原样保留（每次启动重新验签）',
    normalizeLicenseState({ key: 'SMIND1.a.b' }).key,
    'SMIND1.a.b'
  )
  eq('key 是空串 → 当没有', normalizeLicenseState({ key: '' }).key, null)
  eq('key 不是字符串 → 当没有', normalizeLicenseState({ key: 123 }).key, null)
  eq('trialUsed 取整', normalizeLicenseState({ trialUsed: 3.7 }).trialUsed, 3)
  eq('trialUsed 负数 → 0', normalizeLicenseState({ trialUsed: -5 }).trialUsed, 0)
  eq('trialUsed 是 NaN → 0', normalizeLicenseState({ trialUsed: Number.NaN }).trialUsed, 0)
  eq(
    'trialUsed 是字符串数字 → 0（不当成 5）',
    normalizeLicenseState({ trialUsed: '5' }).trialUsed,
    0
  )
  eq('version 一律收敛成 1', normalizeLicenseState({ version: 99 }).version, 1)

  group('更新说明：HTML 剥掉、分段拼接、超长截断（对话框直接显示它）')

  eq('纯文本只规整空白', releaseNotesOf('修了 A\n\n\n\nB'), '修了 A\n\nB')
  eq('HTML 标签剥掉', releaseNotesOf('<b>修了</b> A'), '修了 A')
  eq('数组形式（按版本分段）拼起来', releaseNotesOf([{ note: 'A' }, { note: null }, {}]), 'A')
  eq('空内容 → null（对话框照原样显示）', releaseNotesOf(''), null)
  eq('不是字符串也不是数组 → null', releaseNotesOf(123), null)
  eq('超长截断到 800 字 + 省略号', releaseNotesOf('x'.repeat(900))?.length, 801)

  /*
   * IPC 契约是**冻结面**：C1 拆主进程、A6/A7 拆渲染层期间，「70 条通道常量 / 66 条 ipcMain 注册 /
   * preload 与 main 两侧齐全」全靠一次性脚本 + 人眼核过，**没有任何门保护它**。以后谁新增一个域、
   * 漏注册一条通道，五道门槛照样全绿，而渲染层的 `invoke` 永远等不到回执（静默失效）。
   * 这里把它变成断言：直接扫源码文本（自检本来就是 Node，读文件没有副作用）。
   */
  group('IPC 契约：通道 / 注册 / 两侧覆盖（静态扫描）')

  const readTsTree = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? readTsTree(`${dir}/${entry.name}`)
        : entry.name.endsWith('.ts')
          ? [`${dir}/${entry.name}`]
          : []
    )

  const ipcSource = readFileSync('src/shared/ipc.ts', 'utf8')
  const ipcBlockStart = ipcSource.indexOf('export const IPC = {')
  const ipcBlockEnd = ipcSource.indexOf('} as const', ipcBlockStart)
  const channelNames = [
    ...ipcSource.slice(ipcBlockStart, ipcBlockEnd).matchAll(/^ {2}(\w+):/gm)
  ].map((match) => match[1] ?? '')

  let registrationCount = 0
  const registered = new Set<string>()
  for (const file of readTsTree('src/main')) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/ipcMain\.(?:handle|on)\(\s*IPC\.(\w+)/g)) {
      registrationCount += 1
      registered.add(match[1] ?? '')
    }
  }

  // 这四条是**主→渲染**方向（主进程 `webContents.send`、preload 负责监听），不该有 handler
  const MAIN_TO_RENDERER = ['fileOpenRequest', 'menuCommand', 'closeRequest', 'aiStreamEvent']
  const preloadSource = readFileSync('src/preload/index.ts', 'utf8')
  const missingHandlers = channelNames.filter(
    (name) => !MAIN_TO_RENDERER.includes(name) && !registered.has(name)
  )
  const wronglyRegistered = MAIN_TO_RENDERER.filter((name) => registered.has(name))
  const missingInPreload = channelNames.filter((name) => !preloadSource.includes(`IPC.${name}`))

  eq('通道常量总数 = 70（文档口径）', channelNames.length, 70)
  eq('ipcMain 注册处数 = 66（= 70 − 4 条主→渲染）', registrationCount, 66)
  eq('没有重复注册（同一通道两处注册会静默覆盖）', registered.size, registrationCount)
  eq('每个「渲染→主」通道都有注册', missingHandlers.join(',') || '(none)', '(none)')
  eq('四条「主→渲染」通道不由 handler 注册', wronglyRegistered.join(',') || '(none)', '(none)')
  eq('preload 覆盖全部通道（两侧齐全）', missingInPreload.join(',') || '(none)', '(none)')

  /*
   * 菜单命令是**同一类契约**：主进程 `menu.ts` 发命令 id、渲染层 `use-menu-commands.ts` 分派。
   * 两边对不上时的症状很隐蔽——菜单项点下去毫无反应（或某段处理器永远不执行），
   * 而 typecheck / lint / 自检都不会响。这里按「集合相等」双向断言。
   */
  group('菜单命令契约：主进程发的每条命令都有渲染层处理（静态扫描）')

  const menuSource = readFileSync('src/main/menu.ts', 'utf8')
  const menuCommands = [
    ...new Set([...menuSource.matchAll(/'([a-z]+:[a-z-]+)'/g)].map((match) => match[1] ?? ''))
  ]
  const handledCommands = new Set(
    [
      ...readFileSync('src/renderer/src/app/use-menu-commands.ts', 'utf8').matchAll(
        /case '([a-z]+:[a-z-]+)'/g
      )
    ].map((match) => match[1] ?? '')
  )
  const unhandledMenu = menuCommands.filter((id) => !handledCommands.has(id))
  const orphanHandlers = [...handledCommands].filter((id) => !menuCommands.includes(id))

  check(
    '扫描确实抓到了命令（防正则失效导致下面两条空过）',
    menuCommands.length >= 20 && handledCommands.size >= 20
  )
  eq(
    '主进程发的每条命令都有处理器（否则菜单项点了没反应）',
    unhandledMenu.join(',') || '(none)',
    '(none)'
  )
  eq('渲染层没有多余的死处理器', orphanHandlers.join(',') || '(none)', '(none)')

  group('主进程：资源协议的 URL 还原与查表（只按 key 查内存表，不碰文件系统）')

  eq(
    'URL → 包内路径（逐段百分号编码会被还原）',
    resourcePathFromUrl('mind-resource://local/resources/%E7%85%A7%E7%89%87.png'),
    'resources/照片.png'
  )
  eq(
    '普通 ASCII 路径',
    resourcePathFromUrl('mind-resource://local/resources/a.png'),
    'resources/a.png'
  )
  eq('不是 URL → null（调用方回 400）', resourcePathFromUrl('这不是 URL'), null)

  const resourceTableA: Record<string, Uint8Array> = { 'resources/a.png': new Uint8Array([1]) }
  const resourceTableB: Record<string, Uint8Array> = { 'resources/b.png': new Uint8Array([2]) }
  eq('第一张表命中', findResourceBytes([resourceTableA, resourceTableB], 'resources/a.png')?.[0], 1)
  eq(
    '第二张表也能命中（协议认不出窗口，所以要逐表查）',
    findResourceBytes([resourceTableA, resourceTableB], 'resources/b.png')?.[0],
    2
  )
  eq(
    '查不到 → undefined（协议回 404）',
    findResourceBytes([resourceTableA, resourceTableB], 'resources/nope.png'),
    undefined
  )
  eq(
    '穿越式 key 查不到任何东西（资源只按 key 查内存表，不拼进路径）',
    findResourceBytes([resourceTableA, resourceTableB], '../../etc/passwd'),
    undefined
  )

  group('主进程：退出前该问哪些窗口（多窗口退出不能静默丢改动）')

  eq('没有窗口 → 不用问', windowsToAsk([]).length, 0)
  eq(
    '已批准关闭的不再问',
    windowsToAsk([{ id: 'a', allowClose: true, destroyed: false }]).length,
    0
  )
  eq(
    '界面进程已经没了的问了也没人答',
    windowsToAsk([{ id: 'a', allowClose: false, destroyed: true }]).length,
    0
  )
  eq(
    '正常窗口都要问，且保持原顺序',
    windowsToAsk([
      { id: 'a', allowClose: false, destroyed: false },
      { id: 'b', allowClose: true, destroyed: false },
      { id: 'c', allowClose: false, destroyed: false }
    ])
      .map((item) => item.id)
      .join(','),
    'a,c'
  )

  group('主进程：从外面打开文件时找哪个窗口（多文档窗口 / 界面已亡）')

  const ownershipWindows = [
    { id: 'a', destroyed: false, docPaths: [null, 'C:/docs/one.xmind'] },
    { id: 'b', destroyed: true, docPaths: ['C:/docs/two.xmind'] },
    { id: 'c', destroyed: false, docPaths: ['C:/docs/three.xmind'] }
  ]
  const samePath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

  eq(
    '命中开着该文件的窗口（同一窗口的多份文档要逐个比）',
    windowOwningPath(ownershipWindows, 'C:/docs/one.xmind', samePath)?.id,
    'a'
  )
  eq(
    '路径大小写不敏感（Windows）',
    windowOwningPath(ownershipWindows, 'c:/DOCS/ONE.XMIND', samePath)?.id,
    'a'
  )
  eq(
    '界面进程已经没了的窗口不算（即使它开着这个文件）',
    windowOwningPath(ownershipWindows, 'C:/docs/two.xmind', samePath),
    undefined
  )
  eq(
    '没开过 → undefined（交给聚焦窗口开新标签）',
    windowOwningPath(ownershipWindows, 'C:/docs/nope.xmind', samePath),
    undefined
  )
  eq(
    '未保存过的新文档（docPath = null）不会误命中',
    windowOwningPath(
      [{ id: 'x', destroyed: false, docPaths: [null] }],
      'C:/docs/one.xmind',
      samePath
    ),
    undefined
  )

  group('主进程：许可码验签（自生成密钥对，正反两条路都真跑一遍）')

  {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
    const payload: LicensePayload = {
      v: 1,
      edition: 'pro',
      holder: '测试买家',
      issuedAt: '2026-09-19'
    }
    const segment = licensePayloadSegment(payload)
    const signature = bytesToBase64Url(signData(null, Buffer.from(segment, 'utf8'), privateKey))
    const goodKey = encodeLicenseKey(payload, signature)

    const verified = verifyLicenseKeyWith(goodKey, publicPem)
    check('签得对就验得过', verified.ok)
    eq('持有人带回来（界面要显示它）', verified.holder, '测试买家')

    const tampered = verifyLicenseKeyWith(
      encodeLicenseKey({ ...payload, holder: '别人' }, signature),
      publicPem
    )
    check('改一位内容就验不过', !tampered.ok)
    check('失败原因可读（会原样显示给用户）', tampered.error.includes('签名对不上'))

    const otherPem = generateKeyPairSync('ed25519').publicKey.export({
      type: 'spki',
      format: 'pem'
    }) as string
    check('换一把公钥也验不过', !verifyLicenseKeyWith(goodKey, otherPem).ok)

    // 批量卡密池的码不带持有人名：**必须单独签一次**——签名覆盖的是 payload 段字节本身，
    // 复用带名字那次的签名会验不过（这条断言第一版就写错了，被它自己当场抓出来）
    const noNamePayload: LicensePayload = { v: 1, edition: 'pro', issuedAt: '2026-09-19' }
    const noName = verifyLicenseKeyWith(
      encodeLicenseKey(
        noNamePayload,
        bytesToBase64Url(
          signData(null, Buffer.from(licensePayloadSegment(noNamePayload), 'utf8'), privateKey)
        )
      ),
      publicPem
    )
    check(
      '不带持有人名的批量码：验得过且 holder 为 null（界面不显示空括号）',
      noName.ok && noName.holder === null
    )

    check(
      '占位公钥给可读报错（开发构建）',
      verifyLicenseKeyWith(
        goodKey,
        '-----BEGIN PUBLIC KEY-----\n__SMIND_LICENSE_PUBLIC_KEY__\n-----END PUBLIC KEY-----'
      ).error.includes('没有内置许可公钥')
    )
    check(
      '公钥不是 PEM → 可读报错',
      verifyLicenseKeyWith(goodKey, 'not a pem').error.includes('公钥不可用')
    )
    check(
      '签名段读不出来 → 可读报错',
      verifyLicenseKeyWith(encodeLicenseKey(payload, '@@@'), publicPem).error.includes(
        '签名读不出来'
      )
    )
  }

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

export function testMisc(): void {
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

export function testTypedChar(): void {
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

export function testDefaultStyles(): void {
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

export function testTabs(): void {
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
  store().markSaved('D:/Tmp/DocA.xmind', store().docRevision)
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

export function testMultiWindow(): void {
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

export function testPickDocumentArg(): void {
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

export function testViewLock(): void {
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

export function testSnapshot(): void {
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

export function testRichText(): void {
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

  /* ---- A1：行内代码在提交时被丢（marksToStyle 不认 TipTap 的 code mark） ---- */
  group('富文本：行内代码（code mark ↔ 等宽 fontFamily）')

  const codeRich = tiptapToRich({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: '前向传播', marks: [{ type: 'code' }] }]
      }
    ]
  })
  eq(
    'code mark 落地为等宽 fontFamily（提交不再丢格式）',
    codeRich.paragraphs[0].runs[0].fontFamily,
    MD_MONO_FONT
  )

  const codeBack = richToTiptap(codeRich)
  check(
    '等宽 fontFamily 还原成 code mark（再进编辑态仍是代码格式）',
    codeBack.content[0].content?.[0].marks?.some((mark) => mark.type === 'code') === true
  )
  eq('行内代码往返后文字不变', plainTextOf(tiptapToRich(codeBack)), '前向传播')
  eq(
    '行内代码往返后仍是等宽',
    tiptapToRich(codeBack).paragraphs[0].runs[0].fontFamily,
    MD_MONO_FONT
  )

  // 端到端：`` 神经网络`前向传播` `` 是中文紧贴写法里**唯一本来就触发**的一条
  // （反引号输入规则不要求前导边界），但格式会在提交时丢掉 —— 这就是用户实际走的那条链路。
  const importedInline = inlineRunsToRich(parseInlineMarkdown('神经网络`前向传播`').runs)
  eq(
    '导入：紧贴中文的行内代码写成等宽 fontFamily',
    importedInline?.paragraphs[0]?.runs[1]?.fontFamily,
    MD_MONO_FONT
  )
  eq(
    '导入 → 编辑器 → 提交：等宽不丢',
    importedInline
      ? tiptapToRich(richToTiptap(importedInline)).paragraphs[0]?.runs[1]?.fontFamily
      : undefined,
    MD_MONO_FONT
  )

  // 反向防呆：普通字体不能被误判成行内代码
  const serifTiptap = richToTiptap({
    paragraphs: [{ runs: [{ text: 'x', fontFamily: 'Georgia, serif' }] }]
  })
  check(
    '普通 fontFamily 不会变成 code mark',
    serifTiptap.content[0].content?.[0].marks?.some((mark) => mark.type === 'code') !== true
  )
  eq(
    '普通 fontFamily 往返保持不变',
    tiptapToRich(serifTiptap).paragraphs[0].runs[0].fontFamily,
    'Georgia, serif'
  )
  check(
    '等宽嗅探判据：mono 命中、serif 不命中',
    isMonoFontFamily(MD_MONO_FONT) && !isMonoFontFamily('Georgia, serif')
  )

  // marks 的先后顺序由 schema 决定、我们控制不了：code 与 textStyle 同时在场时
  // 结果必须与顺序无关（以 textStyle 里用户挑的字体为准）。
  const fontFamilyAfter = (marks: TipTapMark[]): string | undefined =>
    tiptapToRich({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks }] }]
    }).paragraphs[0].runs[0].fontFamily
  eq(
    'code 在前：仍以 textStyle 里挑的字体为准',
    fontFamilyAfter([
      { type: 'code' },
      { type: 'textStyle', attrs: { fontFamily: 'Fira Code, monospace' } }
    ]),
    'Fira Code, monospace'
  )
  eq(
    'code 在后：结果一致（与 marks 顺序无关）',
    fontFamilyAfter([
      { type: 'textStyle', attrs: { fontFamily: 'Fira Code, monospace' } },
      { type: 'code' }
    ]),
    'Fira Code, monospace'
  )

  /* ---- 高亮：节点属性面板的「整个主题」开关（格式栏那个按钮走同一套 mark） ---- */
  group('富文本：整段高亮开关（节点属性面板用）')
  const litPlain = withHighlightAll(richFromPlain('一段文字'), true)
  check(
    '打开：每个 run 都带上高亮',
    litPlain.paragraphs[0].runs.every((run) => run.highlight === true)
  )
  check('打开后判为有格式（会写进 titleRich）', hasFormatting(litPlain) === true)

  const litMixed = withHighlightAll(
    { paragraphs: [{ runs: [{ text: 'a', bold: true, color: '#f00' }, { text: 'b' }] }] },
    true
  )
  check(
    '打开：原有粗体与颜色不被抹掉',
    litMixed.paragraphs[0].runs[0].bold === true && litMixed.paragraphs[0].runs[0].color === '#f00'
  )
  check(
    '关闭：高亮被清干净',
    withHighlightAll(litMixed, false).paragraphs[0].runs.every((run) => run.highlight === undefined)
  )
  check(
    '关闭后只剩纯高亮 → 不再算富文本（titleRich 会被自动清掉）',
    hasFormatting(withHighlightAll(litPlain, false)) === false
  )
  check('关闭只清高亮，别的格式留下', hasFormatting(withHighlightAll(litMixed, false)) === true)

  const litBullets = withHighlightAll(
    { paragraphs: [{ bullet: true, runs: [{ text: 'x' }] }, { runs: [{ text: 'y' }] }] },
    true
  )
  check(
    '多段：每段的高亮都开上',
    litBullets.paragraphs.every((paragraph) => paragraph.runs[0].highlight === true)
  )
  check('多段：段落级属性（项目符号）原样保留', litBullets.paragraphs[0].bullet === true)

  /* ---- 画布级元素（关系线 / 边界 / 概要）的标题富文本 ---- */
  group('画布级元素：标题富文本按 run 切行')
  const plainLines = overlayRunLines(undefined, '第一行\n第二行')
  eq(
    '没有富文本时按纯文本切行',
    plainLines.map((line) => line.map((run) => run.text).join('')),
    ['第一行', '第二行']
  )
  check('纯文本行只有一段', plainLines[0].length === 1)

  const richLines = overlayRunLines(
    {
      paragraphs: [
        { runs: [{ text: '普通' }, { text: '加粗', bold: true, color: '#f00' }] },
        { runs: [{ text: '第二段' }] }
      ]
    },
    '普通加粗\n第二段'
  )
  eq('行数 = 段落数', richLines.length, 2)
  eq(
    '行内按 run 切成两段',
    richLines[0].map((run) => run.text),
    ['普通', '加粗']
  )
  check(
    '被标记的那段带上自己的格式',
    richLines[0][1].bold === true && richLines[0][1].color === '#f00'
  )
  check('没标记的那段不带样式', richLines[1][0].bold === undefined)

  const splitLines = overlayRunLines(
    { paragraphs: [{ runs: [{ text: '上\n下', highlight: true }] }] },
    '上\n下'
  )
  eq('run 里的换行也算换行', splitLines.length, 2)
  check(
    '拆出来的两行都带上 run 自己的格式',
    splitLines.every((line) => line[0].highlight === true)
  )

  group('画布级元素：文字输入的行内简写')
  const inlineRich = parseInlineRichText('重要：**只看这句** 与 ==高亮==')
  check(
    '粗体与高亮都能解析出来（只作用于被标记的字）',
    Boolean(
      inlineRich?.paragraphs[0].runs.some((run) => run.bold === true) &&
      inlineRich?.paragraphs[0].runs.some((run) => run.highlight === true)
    )
  )
  eq('没有标记的纯文本不产出富文本', parseInlineRichText('就是普通文字'), undefined)
  eq('多行 → 多段', parseInlineRichText('**粗**\n第二行')?.paragraphs.length, 2)
  eq('空串不产出富文本', parseInlineRichText(''), undefined)
  eq(
    '等宽简写也认（与主题同一套语法）',
    parseInlineRichText('`code` 说明')?.paragraphs[0].runs[0].fontFamily,
    MD_MONO_FONT
  )

  /* ---- D-01：撤销栈满之后，AI 回合仍必须并成一步 ---- */
  group('撤销：栈满 200 后 AI 回合仍是一步（D-01）')
  reset()
  const d01Root = root().id
  // 先把撤销栈填满（每次 addChild 都是一条历史）—— 这正是原来那套"按下标记 depth"失效的现场
  for (let index = 0; index < 205; index += 1) store().addChild(d01Root)
  check(
    '撤销栈被 HISTORY_LIMIT 限制在 200 条',
    store().undoStack.length === 200,
    String(store().undoStack.length)
  )

  const childrenBeforeTurn = activeRoot(store().workbook).children.length
  store().beginAiTurn()
  store().addChild(d01Root)
  store().addChild(d01Root)
  store().addChild(d01Root)
  check('栈已满时回合照样能提交', store().commitAiTurn('AI 批量改') === true)
  // 栈满时长度不会增长（HISTORY_LIMIT 截断），所以判据不看长度，而看"并成的那一条覆盖了几处改动"
  const mergedTurnEntry = store().undoStack[store().undoStack.length - 1]
  check('三条改动被并成最后一条历史', mergedTurnEntry?.label === 'AI 批量改')
  check(
    '这一条覆盖了三处改动',
    (mergedTurnEntry?.patches.length ?? 0) >= 3,
    String(mergedTurnEntry?.patches.length)
  )
  store().undo()
  check(
    '一次撤销把三处改动全部回退（修复前栈满时只会退一处）',
    activeRoot(store().workbook).children.length === childrenBeforeTurn,
    String(activeRoot(store().workbook).children.length)
  )

  // 再验一遍"栈没满"的常规路径：合并语义本身也要是 +1
  reset()
  const d01Root2 = root().id
  store().addChild(d01Root2)
  const stackBeforeShort = store().undoStack.length
  store().beginAiTurn()
  store().addChild(d01Root2)
  store().addChild(d01Root2)
  store().commitAiTurn('AI 两步')
  check(
    '栈没满时同样并成恰好一步（+1 而不是 +2）',
    store().undoStack.length === stackBeforeShort + 1,
    String(store().undoStack.length)
  )

  /* ---- A2：中文紧贴的行内 markdown 不触发（输入规则的前导边界） ---- */
  group('输入规则：中文紧贴的行内写法')
  check('中文后面 **粗体** 触发', BOLD_INPUT.test('神经网络**粗体**'))
  check('行首 **粗体** 触发', BOLD_INPUT.test('**粗体**'))
  check('空格后 **粗体** 触发', BOLD_INPUT.test('前 **粗体**'))
  check('字母紧贴仍不触发（`a**b**` 保持原样）', BOLD_INPUT.test('a**b**') === false)
  check('中文后面 __粗体__ 触发', BOLD_UNDERSCORE_INPUT.test('中文__粗体__'))
  check('中文后面 *斜体* 触发', ITALIC_INPUT.test('中文*斜体*'))
  check('算式里的星号不被当成斜体（`2*3*`）', ITALIC_INPUT.test('2*3*') === false)
  check(
    '下划线变量名不被当成斜体（`snake_case_`）',
    ITALIC_UNDERSCORE_INPUT.test('snake_case_') === false
  )
  check('中文后面 ~~删除线~~ 触发', STRIKE_INPUT.test('中文~~删除线~~'))
  check('中文后面 ==高亮== 触发', HIGHLIGHT_INPUT.test('中文==高亮=='))
  check('a^2^ 紧贴字母也触发上标', SUPERSCRIPT_INPUT.test('a^2^'))
  check('中文后面 ^上标^ 触发', SUPERSCRIPT_INPUT.test('中文^上标^'))
  check('a~1~ 紧贴字母也触发下标', SUBSCRIPT_INPUT.test('a~1~'))
  check('~~删除线~~ 不会被下标规则抢走', SUBSCRIPT_INPUT.test('~~删除线~~') === false)
  check('删除线敲到一半（`~~删除线~`）也不被下标抢走', SUBSCRIPT_INPUT.test('~~删除线~') === false)
  check('正文[^1] 紧贴中文也触发脚注', FOOTNOTE_INPUT.test('正文[^1]'))

  /* ---- A3：组词期宽度提示（只钉纯函数部分；真正的组词行为待人眼验收） ---- */
  group('编辑态：输入法组词期的宽度提示')
  eq('组词拼音串会临时加宽', compositionBoxWidth(100, 30, 240), 130)
  eq('没有组词文本时保持原宽', compositionBoxWidth(100, 0, 240), 100)
  eq('宽度异常（NaN）时保持原宽', compositionBoxWidth(100, Number.NaN, 240), 100)
  eq('加宽不超过测量上限', compositionBoxWidth(230, 80, 240), 240)
  eq('已在顶点时不再变大', compositionBoxWidth(240, 40, 240), 240)
  eq('小数向上取整（与测量口径一致）', compositionBoxWidth(100.2, 10.4, 240), 111)

  /* ---- 节点属性面板：代码块草稿的落盘判据（「点公式却插入 python 代码块」的修复） ---- */
  group('节点面板：代码块草稿 → store 的判据')
  eq(
    '空文本 + 没有既有代码块 → 不新建（默认语言也不建）',
    codeDraftPatch(undefined, '', 'python'),
    undefined
  )
  eq('空文本 + 纯文本语言 → 同样不新建', codeDraftPatch(undefined, '', 'text'), undefined)
  check(
    '全是空白也算没内容（滚轮扫过语言下拉不该写 store）',
    codeDraftPatch(undefined, '   \n ', 'python') === undefined
  )
  eq('写了内容 → 写入（顺带去掉行尾空白）', codeDraftPatch(undefined, 'print(1)\n\n', 'python'), {
    language: 'python',
    text: 'print(1)'
  })
  eq(
    '已有空代码块：只换语言，块留着',
    codeDraftPatch({ language: 'text', text: '' }, '', 'python'),
    { language: 'python', text: '' }
  )
  eq(
    '已有代码块：清空文本且语言回到纯文本 → 移除',
    codeDraftPatch({ language: 'python', text: 'x' }, '', 'text'),
    null
  )
  eq(
    '草稿与现状一致 → 不动 store（不写无意义的历史）',
    codeDraftPatch({ language: 'python', text: 'a' }, 'a', 'python'),
    undefined
  )

  // 端到端：面板两个入口都走这条判据 —— 复现「点公式 → 代码框失焦」那一下，
  // 空文本 + 默认 python 语言不该让节点长出代码块。
  const codeId = store().addChild(rootId)
  const codePatch = codeDraftPatch(find(codeId)?.code, '', 'python')
  if (codePatch !== undefined) store().setCode(codeId, codePatch)
  check('端到端：点公式那一下的失焦提交不再长出 python 代码块', find(codeId)?.code === undefined)
  // 反面对照：真写了内容就必须落盘（别把正常路径一起堵掉）
  const writtenPatch = codeDraftPatch(find(codeId)?.code, 'print(1)', 'python')
  if (writtenPatch) store().setCode(codeId, writtenPatch)
  check(
    '对照：真写了内容仍会落盘（带所选语言）',
    find(codeId)?.code?.language === 'python' && find(codeId)?.code?.text === 'print(1)'
  )

  /* ---- 快捷键：编辑态下应用级组合键不再跟着一起失效 ---- */
  group('快捷键：焦点在输入处时的接管判据')

  /* ---- D-15 / T3：启动 45 秒内不发检查请求 ---- */
  group('更新：复检时机判据（D-15 / T3）')
  const nowD15 = Date.now()
  check(
    '还没查过时，焦点复检不触发（否则启动瞬间就抢跑一次）',
    shouldRecheck(null, nowD15) === false
  )
  check(
    '距上次差 1ms 未满 6 小时 → 不查',
    shouldRecheck(nowD15 - UPDATE_RECHECK_INTERVAL_MS + 1, nowD15) === false
  )
  check(
    '刚好满 6 小时 → 查（三条既有语义未被顺手改掉）',
    shouldRecheck(nowD15 - UPDATE_RECHECK_INTERVAL_MS, nowD15) === true
  )

  // D-12：拖拽会话的兜底清理只能做源码级断言（纯函数碰不到 DOM 卸载），改没了它就红
  check(
    '拖拽 hook 里保留了卸载兜底清理（detachRef）',
    readFileSync(
      `${process.cwd()}/src/renderer/src/components/canvas/use-node-drag.ts`,
      'utf8'
    ).includes(`detachRef.current?.()`)
  )

  /* ---- D-09 / D-10：树操作的两个口径 ---- */
  group('树操作：移动失败不动物件 + 负数下标（D-09 / D-10）')
  reset()
  const d09RootId = root().id
  const d09ChildId = store().addChild(d09RootId)
  // store 里的树是 immer 冻结的，而 moveTopic / attachChild 是"就地改"的纯函数：
  // 先克隆一份可变副本再测（否则测试自己会抛 read-only 错误）
  const d09Tree = structuredClone(activeRoot(store().workbook)) as Topic
  const d09Before = normalize(d09Tree)
  check(
    'D-09：目标父级不存在时返回 false',
    moveTopic(d09Tree, d09ChildId, '不存在的父级') === false
  )
  eq(
    'D-09：树与调用前逐字段相同（以前会挂到根下，调用方却按「没移动」处理）',
    normalize(d09Tree),
    d09Before
  )

  // D-10：负数下标 = 从末尾倒数（-1 = 放到最后）。以前规划层把它夹成 0，变成「放到最前」
  store().addChild(d09RootId)
  store().addChild(d09RootId)
  const d10Root = structuredClone(activeRoot(store().workbook)) as Topic
  const d10First = d10Root.children[0]
  if (d10First) {
    const node = d10Root.children.shift() as Topic
    attachChild(d10Root, node, -1)
    check(
      'D-10：index = -1 落到末尾（以前被夹成 0 = 落到最前）',
      d10Root.children[d10Root.children.length - 1]?.id === node.id
    )
    d10Root.children.shift()
    attachChild(d10Root, node, 0)
    check('D-10：index = 0 仍是落到最前（没改坏正常语义）', d10Root.children[0]?.id === node.id)
  }

  // D-11：自动存档的计时必须等到写完（纯函数碰不到 IPC 时序，退一步做源码级断言）
  check(
    'D-11：自动存档计时挂在 .finally 上（不再恒为 0）',
    readFileSync(`${process.cwd()}/src/renderer/src/app/use-autosave.ts`, 'utf8').includes(
      '.finally(endSave)'
    )
  )

  /* ---- D-03：写盘期间的新编辑不能被标成「已保存」 ---- */
  group('保存代次：写盘期间的编辑不会被误标为已保存（D-03）')
  reset()
  const revRoot = root().id
  store().addChild(revRoot)
  const revisionAtSave = store().docRevision
  check('改动之后文档是脏的', store().dirty === true)
  store().markSaved(`${process.cwd()}/tmp.xmind`, revisionAtSave)
  check('没有新改动时，保存后不再脏', store().dirty === false)
  // 模拟"写盘那几百毫秒里用户又改了一笔"：代次涨了，但保存用的是旧代次
  store().addChild(revRoot)
  check('期间又改了一笔 → 重新变脏', store().dirty === true)
  store().markSaved(`${process.cwd()}/tmp.xmind`, revisionAtSave)
  check('用**过期的代次**落盘 → 仍是脏（修复前这里会被清成已保存）', store().dirty === true)
  store().markSaved(`${process.cwd()}/tmp.xmind`, store().docRevision)
  check('用当前代次落盘 → 干净', store().dirty === false)

  const shortcutKey = (
    key: string,
    ctrl = false
  ): { key: string; ctrlKey: boolean; metaKey: boolean } => ({ key, ctrlKey: ctrl, metaKey: false })
  const canvasTarget = { tagName: 'BODY', isContentEditable: false }
  const editorTarget = { tagName: 'DIV', isContentEditable: true }
  const notesTarget = { tagName: 'TEXTAREA', isContentEditable: false }
  const selectTarget = { tagName: 'SELECT', isContentEditable: false }

  check(
    '画布空白处：照旧全部接管',
    shouldHandleGlobalShortcut(canvasTarget, shortcutKey('s', true)) === true
  )
  check(
    '标题编辑器里 Ctrl+S 仍归应用层（编辑态保存不再失效）',
    shouldHandleGlobalShortcut(editorTarget, shortcutKey('s', true)) === true
  )
  check(
    '标题编辑器里 Ctrl+F 仍归应用层（搜索）',
    shouldHandleGlobalShortcut(editorTarget, shortcutKey('f', true)) === true
  )
  check(
    '标题编辑器里单键不接管（那是用户在输入）',
    shouldHandleGlobalShortcut(editorTarget, shortcutKey('a')) === false
  )
  check(
    '标题编辑器里 Ctrl+V 交还给编辑器（要粘文字，不能被 store.paste 抢走）',
    shouldHandleGlobalShortcut(editorTarget, shortcutKey('v', true)) === false
  )
  check(
    '标题编辑器里 Ctrl+Z 交还给编辑器（撤销这一笔输入而不是整图撤销）',
    shouldHandleGlobalShortcut(editorTarget, shortcutKey('z', true)) === false
  )
  check('备注框里单键不接管', shouldHandleGlobalShortcut(notesTarget, shortcutKey('x')) === false)
  check(
    '备注框里 Ctrl+S 仍归应用层',
    shouldHandleGlobalShortcut(notesTarget, shortcutKey('s', true)) === true
  )
  check(
    '下拉框里 Ctrl+A 交还（全选的是下拉项）',
    shouldHandleGlobalShortcut(selectTarget, shortcutKey('a', true)) === false
  )
  check('没有 target 时照旧接管', shouldHandleGlobalShortcut(null, shortcutKey('s', true)) === true)
}

export function testTheme(): void {
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

export function testDefaultTheme(): void {
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

export async function testThemeRoundTrip(): Promise<void> {
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

export async function testRoundTrip(): Promise<void> {
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

export async function testFoldSidesRoundTrip(): Promise<void> {
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

export async function testUnknownPassthrough(): Promise<void> {
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

export function testRecovery(): void {
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

export function testNaming(): void {
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

export function testHistory(): void {
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

export function testSnapshots(): void {
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
