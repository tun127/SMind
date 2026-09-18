import { create } from 'zustand'
import { applyPatches, enablePatches, produce, produceWithPatches, type Patch } from 'immer'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/ipc'
import {
  withOverlayTextStyle,
  type OverlayKind,
  type OverlayTextStylePatch
} from '@shared/model/overlay-style'
import type {
  Attachment,
  RichText,
  Sheet,
  ThemeColors,
  Topic,
  TopicCode,
  TopicImage,
  Workbook
} from '@shared/model/types'
import { createId, createTopic, createWorkbook } from '@shared/model/factory'
import { countOutlineNodes, outlineToTopic, type OutlineNode } from '@shared/ai'
import {
  appendToRich,
  hasFormatting,
  normalizeRich,
  plainTextOf,
  richFromPlain
} from '@shared/richtext'
import {
  EMPTY_FILTER,
  countOccurrences,
  countTitleMatches,
  replaceInText,
  type SearchOptions,
  type TopicFilter
} from '@shared/search'
import { DEFAULT_THEME, getThemeColors } from '@shared/theme'
import { BLOCK_GAP, codeMinNodeSize } from '@shared/layout/accessory'
import type { Size } from '@shared/layout/types'
import { NODE_FONT_SIZES, nodePaddingOf } from '../render/measure'
import { formulaSize } from '../render/formula'
import {
  activeRoot,
  activeSheet,
  cloneTopicDeep,
  detachTopic,
  ensureExpanded,
  findParent,
  findTopic,
  flatten,
  childFoldSides,
  foldedSidesOf,
  isSelfOrDescendant,
  moveTopic,
  splitFoldSidesOf,
  walk,
  withFoldedSides,
  type FoldSide
} from '@shared/model/tree'
import { buildRange, parseRange, readCurveOffset, sameRange, withCurveOffset } from '@shared/layout'
import {
  reconcileMarkers,
  RELATIONSHIP_CURVE_KEY,
  TOPIC_SIDE_KEY,
  withMarkerToggled
} from '@shared/xmind/constants'
import { notesHtmlFrom } from '@shared/richtext'
import { resolveDrop, type DropMode } from '@shared/model/drop'

enablePatches()

const HISTORY_LIMIT = 200

interface HistoryEntry {
  label: string
  patches: Patch[]
  inverse: Patch[]
  /** 连续同类操作（例如拖动调色）合并为一步撤销 */
  coalesceKey?: string
  time: number
  /** 这次修改**之前**的选择（框选/多选）。撤销时恢复它，框选才不会凭空丢掉 */
  selectionBefore?: string[]
  /** 撤销那一刻的选择，重做时恢复 */
  selectionAtUndo?: string[]
}

/** 过滤掉已经不存在的节点，选择绝不指向幽灵 id */
function liveSelection(root: Topic, ids: string[] | undefined): string[] {
  if (!ids || ids.length === 0) return []
  return ids.filter((id) => findTopic(root, id) !== null)
}

/** 合并窗口：同一个 coalesceKey 在此时间内的连续操作算作一步 */
const COALESCE_WINDOW_MS = 1500

/** 搜索状态：条件放在 store 里，画布与搜索面板才能用同一份条件算命中 */
export interface SearchState {
  query: string
  replacement: string
  options: Required<SearchOptions>
}

const EMPTY_SEARCH: SearchState = {
  query: '',
  replacement: '',
  options: { caseSensitive: false, inNotes: false, inLabels: false }
}

export interface EditorState {
  workbook: Workbook
  filePath: string | null
  dirty: boolean
  /** 文档代次，每次新建/打开自增，用于触发画布重新居中 */
  docSeq: number

  selection: string[]
  editingId: string | null
  /** 正在编辑的纯文本镜像，用于比较与统计 */
  editingText: string
  /** 正在编辑的富文本内容 */
  editingRich: RichText | null
  /**
   * 渲染默认值（默认对齐 / 代码块基准字号）的变更计数。
   *
   * 这些默认值作用于**没有显式样式**的节点，改了会让测量结果变化，所以布局必须依赖它——
   * 否则改了设置要等到别的操作才生效（画布上表现为"设置似乎没起作用"）。
   */
  renderEpoch: number
  clipboard: Topic | null

  zoom: number
  pan: { x: number; y: number }

  /** 搜索条件：面板与画布共用，保证两边看到的命中完全一致 */
  search: SearchState
  /** 按标记 / 标签筛选 */
  filter: TopicFilter

  undoStack: HistoryEntry[]
  redoStack: HistoryEntry[]
  /** 进行中的 AI 回合（null = 不在 AI 操作中；此时禁止撤销，见 undo 的说明） */
  aiTurn: { depth: number; selectionBefore: string[] } | null

  /* ---- 检索（P7） ---- */
  setSearchQuery(query: string): void
  setSearchReplacement(replacement: string): void
  setSearchOption(key: keyof SearchOptions, value: boolean): void
  resetSearch(): void
  /** 把标题里的关键词全部替换掉，返回替换处数 */
  replaceAllInTitles(): number
  /** 替换某一个节点标题里的关键词，返回替换处数 */
  replaceInTopic(topicId: string): number

  /* ---- 筛选（P7） ---- */
  toggleFilterMarker(markerId: string): void
  toggleFilterLabel(label: string): void
  clearFilter(): void

  /* ---- AI 结果落地（P8） ---- */
  /** 给某个主题一次性追加若干子主题（AI 扩写用，整批算一步撤销） */
  addChildTitles(parentId: string, titles: string[]): number
  /** 追加若干**带格式**的子主题（粘贴 Markdown 片段用；整批一步撤销） */
  addRichChildren(parentId: string, items: Array<{ title: string; rich?: RichText }>): number
  /**
   * 把 AI 生成的整棵大纲挂到指定主题下面。
   *
   * 「生成新导图」不再走这里——那会往当前文档里塞内容；改成在新窗口里成为独立文档
   * （见 App 的 `openGeneratedInNewWindow`）。
   */
  applyOutlineTree(parentId: string, root: OutlineNode): number

  /** 把当前「默认文字样式」（字体/字号/颜色）一次性应用到全部现有节点（一步撤销） */
  applyDefaultsToAll(): void

  /* ---- 视图 ---- */
  setZoom(zoom: number): void
  setPan(pan: { x: number; y: number }): void
  /**
   * 视角锁定：开启后画布始终把**选中的主题**按在视口中央。
   *
   * 方向键在主题间移动、点大纲、搜索跳转、拖完重排……视角都会跟过去，
   * 长导图里不必再手动拖画布去找"现在到底选到哪了"。
   */
  viewLock: boolean
  setViewLock(on: boolean): void
  /** 切换视角锁定，返回切换后的状态（提示语要用） */
  toggleViewLock(): boolean

  /* ---- 文档 ---- */
  newDocument(): void
  loadDocument(workbook: Workbook, path: string | null): void
  /**
   * 把当前文档的内容换成某个历史版本。
   * 刻意**保留 filePath**（恢复的是「当前文档的旧内容」，不该把文档换成别的文件），
   * 并标记为未保存——恢复出来的内容与磁盘上的还不一样。
   */
  restoreDocument(workbook: Workbook): void
  markSaved(path: string): void

  /* ---- 编辑 ---- */
  /**
   * @param coalesceKey 传入后，短时间内同 key 的连续修改会合并成一步撤销。
   *                    适用于拖动调色这类高频小改动。
   */
  mutate(recipe: (draft: Workbook) => void, label: string, coalesceKey?: string): boolean
  undo(): void
  redo(): void
  /**
   * 开始一个 AI 回合。
   *
   * AI 一次命令可能改几十个节点——每个改动各记一步撤销等于没有撤销。
   * 从 begin 到 commit 之间的所有改动会在结束时**并成一步**，用户按一下 `Ctrl+Z` 全回来。
   */
  beginAiTurn(): void
  /** 结束 AI 回合并合并；返回这一步是否真的产生了改动 */
  commitAiTurn(label: string): boolean

  /* ---- 选择与编辑态 ---- */
  select(id: string | null, additive?: boolean): void
  /**
   * 进入编辑。
   * `insertText` 用于「选中主题后直接打字」：把这一下敲的字符**接到末尾**再进入编辑
   * （是追加不是覆盖——误按一个字母就把整句标题冲掉太危险）。
   */
  beginEdit(id: string, insertText?: string): void
  updateEditingText(text: string): void
  updateEditingRich(rich: RichText): void
  /**
   * 提交当前正在编辑的内容。
   * @param forId 只有当前编辑中的正是这个节点时才提交。
   *              用于避免「新建节点后旧输入框失焦」把新节点的编辑态误关掉。
   */
  commitEdit(forId?: string): void
  cancelEdit(): void
  /** 提交编辑并新建子主题（编辑中按 Tab） */
  commitAndAddChild(): void
  /** 提交编辑并新建同级主题（编辑中按 Enter） */
  commitAndAddSibling(): void

  /* ---- 结构操作 ---- */
  addChild(parentId?: string): string
  addSibling(id?: string): string
  deleteSelection(): void
  /**
   * 删除指定主题（连同子树）。
   *
   * AI 写工具用：`deleteSelection` 是给键盘操作的，会连带改用户的选择；
   * AI 不该有这种副作用，所以按 id 删、只在必要时把选择挪到父级。
   */
  deleteTopic(id: string): boolean
  setTitle(id: string, title: string): void
  setRichText(id: string, rich: RichText | null): void
  toggleCollapse(id: string): void
  /**
   * 直接指定折叠状态。拖拽时用它把落点那个折叠着的主题**展开**——
   * 不展开就看不见新子主题会落在哪，落点预览成了空谈。
   */
  setCollapsed(id: string, collapsed: boolean): void
  /**
   * 平衡思维导图的中心主题：**按侧收起 / 展开**（左右分开收）。
   *
   * 只在「中心主题 + 平衡结构 + 该侧确实挂着分支」时生效；
   * 一般主题的收起走 `toggleCollapse`（那里是整体收起）。
   *
   * 刻意做成**设置值**而不是开关（与 `setCollapsed` 同一口径）：AI 重试一次
   * 不会把刚收起来的那一侧又翻回去。
   */
  setFoldSide(id: string, side: FoldSide, folded: boolean): void
  /** 界面上点徽标用：切换某一侧的收起状态（转发到 `setFoldSide`） */
  toggleFoldSide(id: string, side: FoldSide): void
  /** 渲染默认值变更后调用：让布局与画布重算 */
  bumpRenderEpoch(): void
  /**
   * 切换**整张画布**的结构。
   *
   * 刻意的签名（没有 targetId）：结构是画布级属性，只住在中心主题上。
   * 以前它接一个可选目标，于是能在分支上写 `structureClass`——布局随即把那一支
   * 交给别的家族排，画面变成"主干对、下面那截乱"。数据字段仍保留（导入的文件里
   * 可能带着它，另存时原样写回），但**不再参与布局**。
   */
  setStructure(structureClass: string): void
  /**
   * 移动主题。
   *
   * 刻意**没有** coalesceKey：移动会重排 children 数组，
   * 而撤销是基于 immer patch 的，数组重排的 patch 带下标——
   * 把连续两步的 inverse 合成一个再套到"后来的状态"上会下标错位、改坏数组
   * （自检里抓到过 `["甲","乙","甲"]` 这种结果）。
   * 合并只对「替换某个值」类操作安全：折叠、调色、拉伸尺寸。
   */
  moveNode(id: string, targetId: string, index?: number): boolean
  /**
   * 批量移动（AI 的 `moveTopics` 工具走这里）：一次写入落完，返回**实际成功**的条目。
   *
   * 逐条调 `moveNode` 终态相同，但每条都要跑一次 `settleAfterMove` → `pruneOverlays`
   * 的**全树扫描**——一次最多 200 条就是 200 遍全树（O(k×N)），
   * 正是「AI 批量整理大导图」时的固定放大器。
   */
  moveNodes(moves: Array<{ id: string; targetId: string; index: number | null }>): Array<{
    id: string
    targetId: string
  }>
  /**
   * 同级排序（AI 的 `sortSiblings` 走这里）：按给定顺序重排某个主题的子主题。
   * `renumber` 为真时顺便加「1. 2. 」编号（先去掉旧编号，避免「1. 1. xxx」）。
   */
  sortChildren(parentId: string, orderedIds: string[], renumber: boolean): void
  /**
   * 合并同名主题（AI 的 `mergeDuplicates` 走这里）。
   *
   * 每组保留 keepId，把 mergeIds 的**子主题搬过来、缺的备注/代码/公式/标签/标记补上**，
   * 然后删掉那些多余节点。整批算**一步撤销**（`mutate` 一次）。
   */
  mergeTopics(groups: Array<{ keepId: string; mergeIds: string[] }>): number
  /**
   * 用快捷键微调选中主题（与亿图脑图一致，适合结构复杂时精确挪动）：
   * - `↑` / `↓`：在同级里上移 / 下移一位
   * - `Home` / `End`：移到同级的最前 / 最后
   * - `←`：升级，成为父级的后一个兄弟
   * - `→`：降级，成为前一个兄弟的最后一个子主题
   */
  moveSelectionByKey(
    key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'
  ): boolean
  /**
   * 按方向键在主题之间移动**选择**（← 父级、→ 第一个子级、↑↓ 同级）。
   *
   * 抽到 store 里是因为**编辑态**也要用它：刚建出来的空主题里按方向键，
   * 应当退出编辑并移到相邻主题，而不是把光标在一个空格子里挪来挪去（看起来像"方向键失灵"）。
   * 另外它有兜底：选择指向已不存在的主题时自动回到根，键盘永远不会"死掉"。
   */
  navigateSelection(key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'): void
  /**
   * 把一级主题对调到中心主题的另一侧（知犀 / Xmind 的「左右位置调整」）。
   * 平衡结构默认按顺序交替分配左右，这里写入的是显式覆盖。
   */
  setTopicSide(id: string, side: 'left' | 'right'): void
  /** 手动拉伸节点尺寸；传 null 恢复自动尺寸（拖拽过程中会合并成一步撤销） */
  setSizeOverride(id: string, size: { width: number; height: number } | null): void
  /**
   * 拖拽节点释放。落点一律由 `resolveDrop` 裁决（在 shared/model/drop 里，
   * 与画布上的落点预览共用同一套规则）：
   * - `child` → 成为目标的**最后一个子主题**；
   * - `before` / `after` → 插到目标**前面 / 后面**、与它同级；
   * - 落点非法（自己 / 自己的后代 / 原地不动）→ 返回 false，不做改动。
   * 因为判定只看"目标是谁 + 指针在它的哪个分区"，所以**任意两个节点之间**都能拖。
   */
  dropNode(id: string, targetId: string, mode: DropMode): boolean
  offsetPosition(id: string, dx: number, dy: number): void
  /**
   * 一次写完多个主题的自由位置（多选拖拽用）。
   * 走一次 mutate，所以整群移动在撤销里是**一步**，而不是一堆零碎记录。
   */
  offsetPositions(moves: Array<{ id: string; dx: number; dy: number }>): void
  /**
   * 恢复自动布局：把**选中的自由摆放主题**放回自动位置；选中里没有这样的主题就整张画布一起恢复。
   * 返回实际恢复的个数（0 = 没什么可恢复）。
   *
   * 为什么只留一个入口：以前「选中」「全部」各有按钮、菜单里还各有一条名字几乎一样的项
   * （三个入口、两种实现，其中两个完全相同），用户面对的是"我该点哪个"。
   * 现在范围交给选择决定、结果用提示条说清：想只恢复一个，先选中它。
   */
  restoreAutoLayout(): number
  copySelection(): void
  paste(): void

  /* ---- 节点附加元素 ---- */
  toggleMarker(id: string, markerId: string): void
  addLabel(id: string, label: string): void
  removeLabel(id: string, label: string): void
  setNotes(id: string, notes: string): void
  setHref(id: string, href: string): void
  /** 设置 LaTeX 公式源码（传空字符串即移除） */
  setFormula(id: string, formula: string): void
  /** 设置/移除节点里的代码块（language + text 都为空即移除） */
  setCode(id: string, code: TopicCode | null): void
  /** 设置/移除节点内图片（字节由主进程存进包内资源） */
  setImage(id: string, image: TopicImage | null): void
  addAttachment(id: string, attachment: Attachment): void
  removeAttachment(id: string, attachmentId: string): void

  /* ---- 画布级元素（关系线 / 边界 / 概要） ---- */
  /**
   * 这三个都是「开关」：选中状态已经存在对应元素时再点一次是移除，
   * 避免同一个范围被反复叠加出多个元素（叠加会让颜色越来越深）。
   * @returns 新建元素的 id；本次是移除则返回 null
   */
  addRelationship(): string | null
  addBoundary(): string | null
  addSummary(): string | null
  removeRelationship(id: string): void
  removeBoundary(id: string): void
  removeSummary(id: string): void
  /** 拖动线身调整弧线位置（偏移量累加，连续拖动合并为一步撤销） */
  offsetRelationshipCurve(id: string, dx: number, dy: number): void
  /** 把弧线弯度恢复到自动计算的位置 */
  resetRelationshipCurve(id: string): void
  /** 框选用：一次性设置选中集合 */
  setSelection(ids: string[]): void
  /**
   * 画布级元素（概要 / 边界 / 关系线）的选中态。
   *
   * 选中它们就能在面板里改文字与字体样式——概要因此成为「一等公民」：
   * 空文字时也点得到、选得中，不再是「删空就只能删掉重建」。
   */
  selectedOverlay: { kind: OverlayKind; id: string } | null
  selectOverlay(kind: OverlayKind, id: string): void
  clearOverlaySelection(): void
  /**
   * 「请打开节点属性面板」的信号（自增计数）。
   *
   * 画布在选中画布元素（概要/边界/关系线）时发一次：那些元素的文字、字体与删除
   * 全在面板里，选中了却不显示面板，用户会以为「选中没生效」。
   */
  nodePanelTick: number
  requestNodePanel(): void
  /** 「备注」聚焦信号（自增值），NodePanel 监听它 */
  notesFocusTick: number
  /** 请求节点面板聚焦到备注输入框（画布上的备注指示图标点击用）；面板会随之自动打开 */
  requestNotesFocus(): void
  /** 改画布级元素标题样式（字号 / 加粗 / 斜体 / 颜色），一步撤销 */
  setOverlayStyle(kind: OverlayKind, id: string, patch: OverlayTextStylePatch): void
  /** 请求节点面板聚焦到代码输入框（Alt+C 用）；面板未打开时会随打开自动聚焦 */
  requestCodeFocus(): void
  /** 代码聚焦信号（自增值），NodePanel 监听它 */
  codeFocusTick: number
  /** 公式聚焦信号（自增值），NodePanel 监听它 */
  formulaFocusTick: number
  /** 请求节点面板聚焦到公式输入框（快捷栏 / 快捷键用） */
  requestFormulaFocus(): void
  /** 应用级默认设置（默认视角锁定 / 主题 / 对齐），由「设置」对话框读写 */
  appSettings: AppSettings
  setAppSettings(next: AppSettings): void
  /** 把关系线的某一端改接到另一个主题（拖拽端点用） */
  setRelationshipEnd(id: string, end: 'end1Id' | 'end2Id', topicId: string): void
  setRelationshipTitle(id: string, title: string): void
  setBoundaryTitle(id: string, title: string): void
  setSummaryTitle(id: string, title: string): void

  /* ---- 画布元素：给 AI 用的「不依赖选中」版本 ---- */
  /**
   * 连一条关系线（按 id，不读用户当前选中）。
   *
   * 为什么不复用上面的 `addRelationship`：那个读的是**选择**，AI 自己改选中会把用户
   * 的选区搅乱；而且它是**开关**语义（再点一次是删除）——模型重试一次就把线删了。
   * 这里一律**幂等**：已经连过就返回原 id，不增不减。
   */
  connectTopics(end1Id: string, end2Id: string): string | null
  /** 给这些同级主题加边界（幂等；title 可省略） */
  addBoundaryFor(topicIds: string[], title?: string): string | null
  /** 给这些同级主题加概要（幂等；title 省略时为「概要」） */
  addSummaryFor(topicIds: string[], title?: string): string | null
  /** 直接设置标记集合（不用 toggle：对模型来说「已存在就删掉」是个陷阱） */
  setMarkers(id: string, markerIds: string[]): void

  /* ---- 主题 ---- */
  /** 应用一整套主题（会把配色写进当前画布） */
  applyTheme(theme: { id: string; name: string; colors: ThemeColors }): void
  /**
   * 把主题直接烤进当前文档，**不写撤销历史、不改「未保存」状态**。
   * 用于「新建文档时套用设置里的默认主题」：那一步是初始化而不是用户的编辑动作，
   * 走 `applyTheme`（内部是 mutate）会让新文档一建出来就顶着未保存标记。
   */
  primeTheme(theme: { id: string; name: string; colors: ThemeColors }): void
  /** 微调当前画布的配色 */
  updateThemeColors(patch: Partial<ThemeColors>, coalesceKey?: string): void
}

/**
 * 「编辑态」的空值。
 * 编辑态＝ editingId + 纯文本 + 富文本三项，而纯文本与富文本本质上是
 * **同一份内容的两种表示**——以前这里有十几处各自手写这三行，漏一处就会漂移。
 */
const NO_EDITING = { editingId: null, editingText: '', editingRich: null }

/**
 * 空标题是**有意允许**的（自检里有两条断言钉着：清空标题能提交、空标题提交不写历史）。
 * 由此推出的一条规矩：**任何"顺手把空标题补成默认名"的改动都是错的**——
 * 用户可能就是想把标题清掉再重新打，或者那个节点只是暂时没名字。
 */

/**
 * 编辑内容的两种表示永远从**同一个来源**产出：给富文本，纯文本由它算出来。
 * 于是"两处不一致"从根上不可能发生，调用方也不必记得同时改两个字段。
 */
function editingContent(rich: RichText | null): {
  editingText: string
  editingRich: RichText | null
} {
  return { editingText: rich ? plainTextOf(rich) : '', editingRich: rich }
}

/** 取某个画布当前生效的配色 */
export function themeColorsOf(workbook: Workbook): ThemeColors {
  const sheet = workbook.sheets.find((s) => s.id === workbook.activeSheetId) ?? workbook.sheets[0]
  return getThemeColors(sheet?.theme)
}

const clampZoom = (z: number): number => Math.min(4, Math.max(0.1, z))

/**
 * 主题移动之后的统一收尾。`moveNode` 与 `dropNode` 共用，避免两套写法走偏。
 * 注意必须清掉自由摆放的偏移：留着它，主题会落在"自动布局位置 + 偏移"的地方，
 * 也就是「落点预览画在这里、松手却出现在别处」，看起来就像没连上。
 */
function settleAfterMove(draft: Workbook, id: string): void {
  const moved = findTopic(activeRoot(draft), id)
  if (moved) moved.position = undefined
  // 换了父级后，原本「同级连续区间」可能不再成立，顺手清掉失效的边界/概要
  pruneOverlays(activeSheet(draft))
}

/** 删除主题后清理指向它们的画布级元素，避免出现悬空的关系线/边界/概要 */
function pruneOverlays(sheet: Sheet): void {
  const alive = new Set<string>()
  const walk = (topic: Topic): void => {
    alive.add(topic.id)
    for (const child of topic.children) walk(child)
  }
  walk(sheet.rootTopic)

  // 区间两端都还在，这段区间才仍然成立（只删中间的主题不影响）
  const rangeAlive = (range: string): boolean => {
    const parsed = parseRange(range)
    return Boolean(parsed && alive.has(parsed[0]) && alive.has(parsed[1]))
  }

  sheet.relationships = sheet.relationships.filter(
    (item) => alive.has(item.end1Id) && alive.has(item.end2Id)
  )
  sheet.boundaries = sheet.boundaries.filter((item) => rangeAlive(item.range))
  sheet.summaries = sheet.summaries.filter((item) => rangeAlive(item.range))
}

/** 备注 HTML 的转义统一走共享实现（见 shared/richtext） */

function sameRich(a: RichText | undefined, b: RichText | null): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/* ------------------------------------------------------------------ */
/* 默认文字样式（设置里的「默认字体 / 字号 / 颜色」）                     */
/* ------------------------------------------------------------------ */

/**
 * 给一份富文本补上「默认文字样式」（只补缺失的属性，显式格式不被覆盖）。
 * 返回同一份对象（就地修改）。
 */
function stampRichDefaults(rich: RichText, settings: AppSettings): RichText {
  const { defaultFontFamily, defaultFontSize, defaultColor } = settings
  if (!defaultFontFamily && !defaultFontSize && !defaultColor) return rich
  for (const paragraph of rich.paragraphs) {
    for (const run of paragraph.runs) {
      if (defaultFontFamily && !run.fontFamily) run.fontFamily = defaultFontFamily
      if (defaultFontSize && !run.fontSize) run.fontSize = defaultFontSize
      if (defaultColor && !run.color) run.color = defaultColor
    }
  }
  return rich
}

/**
 * 把「默认文字样式」落到一个**新建节点**上（AI 批量建节点等直接带标题的路径）。
 * 用户手打的节点走 commitEdit 的「首次命名」分支，不在这里处理。
 */
function stampNodeDefaults(topic: Topic, settings: AppSettings): void {
  const hasAny = settings.defaultFontFamily || settings.defaultFontSize || settings.defaultColor
  if (!hasAny) return
  if (topic.titleRich && topic.titleRich.paragraphs.length > 0) {
    topic.titleRich = stampRichDefaults(normalizeRich(topic.titleRich), settings)
    return
  }
  if (!topic.title) return
  topic.titleRich = stampRichDefaults(richFromPlain(topic.title), settings)
}

/** 连同整棵子树一起落默认样式（AI 生成 / 应用到全部时用） */
function walkStampDefaults(topic: Topic, settings: AppSettings): void {
  stampNodeDefaults(topic, settings)
  for (const child of topic.children) walkStampDefaults(child, settings)
  for (const floating of topic.detachedChildren ?? []) walkStampDefaults(floating, settings)
}

/**
 * 改应用设置：写进 store 并落盘。所有「默认值」入口（格式栏默认样式面板 /
 * 主题面板的默认主题 / 工具栏收纳）都走这一个门，保证 settings.json 是唯一真相。
 */
export async function patchAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...useEditor.getState().appSettings, ...patch }
  useEditor.getState().setAppSettings(next)
  try {
    await window.api.settingsSave(next)
  } catch {
    /* 落盘失败不影响本次会话 */
  }
  return next
}

/* ---- 视角锁定的会话间持久化 ----
 * viewLock 原来是纯会话状态：每次重启 / 新开文档都回到设置里的默认值——
 * 用户刚把开关打开，窗口一重启就"消失"了（关闭态不显眼，看起来像功能坏了）。
 * 这里用 localStorage 记住最近一次的开关选择：启动、新开文档、打开文档都恢复它；
 * 「启动默认视角锁定」设置只在用户从未动过开关时作为初值。 */
const VIEW_LOCK_KEY = 'smind.viewLock'

function readPersistedViewLock(): boolean | null {
  try {
    const raw = localStorage.getItem(VIEW_LOCK_KEY)
    if (raw === '1') return true
    if (raw === '0') return false
    return null
  } catch {
    return null
  }
}

function persistViewLock(on: boolean): void {
  try {
    localStorage.setItem(VIEW_LOCK_KEY, on ? '1' : '0')
  } catch {
    /* 存不了就算了，只是下次不记忆 */
  }
}

export const useEditor = create<EditorState>()((set, get) => ({
  workbook: createWorkbook(),
  filePath: null,
  dirty: false,
  docSeq: 0,

  selection: [],
  ...NO_EDITING,
  renderEpoch: 0,
  clipboard: null,

  zoom: 1,
  pan: { x: 0, y: 0 },
  // 上次会话的开关选择优先；从未动过开关才用设置默认值
  viewLock: readPersistedViewLock() ?? false,

  search: { ...EMPTY_SEARCH },
  filter: { ...EMPTY_FILTER },

  undoStack: [],
  redoStack: [],
  aiTurn: null,

  /* ------------------------------------------------------------------ */
  /* 视图                                                                */
  /* ------------------------------------------------------------------ */

  setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),

  setPan: (pan) => set({ pan }),

  setViewLock: (on) => {
    persistViewLock(on)
    set({ viewLock: on })
  },

  toggleViewLock: () => {
    const next = !get().viewLock
    persistViewLock(next)
    set({ viewLock: next })
    return next
  },

  /* ------------------------------------------------------------------ */
  /* 检索与筛选                                                          */
  /* ------------------------------------------------------------------ */

  setSearchQuery: (query) => set((s) => ({ search: { ...s.search, query } })),

  setSearchReplacement: (replacement) => set((s) => ({ search: { ...s.search, replacement } })),

  setSearchOption: (key, value) =>
    set((s) => ({ search: { ...s.search, options: { ...s.search.options, [key]: value } } })),

  resetSearch: () => set({ search: { ...EMPTY_SEARCH } }),

  replaceAllInTitles: () => {
    const { search, workbook } = get()
    const query = search.query
    if (query.length === 0) return 0

    // 先按当前条件数出总处数（mutate 不返回值），再统一替换
    const total = countTitleMatches(workbook, query, search.options)
    if (total === 0) return 0

    get().mutate((draft) => {
      for (const sheet of draft.sheets) {
        walk(sheet.rootTopic, (topic) => {
          const result = replaceInText(
            topic.title,
            query,
            search.replacement,
            search.options.caseSensitive
          )
          if (result.count === 0) return
          topic.title = result.text
          // 文本长度变了，原来的富文本区间就对不上了，必须一并清掉
          topic.titleRich = undefined
        })
      }
    }, '替换全部')
    return total
  },

  replaceInTopic: (topicId) => {
    const { search, workbook } = get()
    const query = search.query
    if (query.length === 0) return 0

    const root = activeRoot(workbook)
    const topic = findTopic(root, topicId)
    if (!topic) return 0
    const count = countOccurrences(topic.title, query, search.options.caseSensitive)
    if (count === 0) return 0

    get().mutate((draft) => {
      const target = findTopic(activeRoot(draft), topicId)
      if (!target) return
      const result = replaceInText(
        target.title,
        query,
        search.replacement,
        search.options.caseSensitive
      )
      target.title = result.text
      target.titleRich = undefined
    }, '替换文本')
    return count
  },

  toggleFilterMarker: (markerId) =>
    set((s) => ({
      filter: {
        ...s.filter,
        markers: s.filter.markers.includes(markerId)
          ? s.filter.markers.filter((id) => id !== markerId)
          : [...s.filter.markers, markerId]
      }
    })),

  toggleFilterLabel: (label) =>
    set((s) => ({
      filter: {
        ...s.filter,
        labels: s.filter.labels.includes(label)
          ? s.filter.labels.filter((item) => item !== label)
          : [...s.filter.labels, label]
      }
    })),

  clearFilter: () => set({ filter: { ...EMPTY_FILTER } }),

  /* ------------------------------------------------------------------ */
  /* AI 结果落地                                                         */
  /* ------------------------------------------------------------------ */

  addChildTitles: (parentId, titles) => {
    const cleaned = titles.map((title) => title.trim()).filter((title) => title.length > 0)
    if (cleaned.length === 0) return 0

    const created: string[] = []
    get().mutate((draft) => {
      const parent = findTopic(activeRoot(draft), parentId) ?? activeRoot(draft)
      for (const title of cleaned) {
        const node = createTopic(title)
        stampNodeDefaults(node, get().appSettings)
        parent.children.push(node)
        created.push(node.id)
      }
      ensureExpanded(parent)
    }, 'AI 扩写子主题')

    if (created.length > 0) set({ selection: created })
    return created.length
  },

  /**
   * 追加若干**带格式**的子主题（粘贴 Markdown 片段用）。
   * 与 `addChildTitles` 的区别：标题之外还能带上富文本（高亮/上下标/加粗…），
   * 而且不进编辑态——粘贴完就能继续操作。
   */
  addRichChildren: (parentId, items) => {
    const cleaned = items.filter((item) => item.title.trim().length > 0)
    if (cleaned.length === 0) return 0

    const created: string[] = []
    get().mutate((draft) => {
      const parent = findTopic(activeRoot(draft), parentId) ?? activeRoot(draft)
      for (const item of cleaned) {
        const node = createTopic(item.title.trim())
        if (item.rich) node.titleRich = item.rich
        stampNodeDefaults(node, get().appSettings)
        parent.children.push(node)
        created.push(node.id)
      }
      ensureExpanded(parent)
    }, '粘贴 Markdown')

    if (created.length > 0) set({ selection: created, ...NO_EDITING })
    return created.length
  },

  applyOutlineTree: (parentId, root) => {
    const count = countOutlineNodes(root)
    if (count === 0) return 0

    // 挂到已有主题下：根节点的文字成为新的子主题
    const childTopic = outlineToTopic(root)
    walkStampDefaults(childTopic, get().appSettings)
    get().mutate((draft) => {
      const parent = findTopic(activeRoot(draft), parentId)
      if (!parent) return
      parent.children.push(childTopic)
      ensureExpanded(parent)
    }, 'AI 生成子主题')
    set({ selection: [childTopic.id] })
    return count
  },

  applyDefaultsToAll: () => {
    const settings = get().appSettings
    get().mutate((draft) => {
      for (const sheet of draft.sheets) walkStampDefaults(sheet.rootTopic, settings)
    }, '应用默认样式到全部节点')
  },

  /* ------------------------------------------------------------------ */
  /* 文档                                                                */
  /* ------------------------------------------------------------------ */

  newDocument: () =>
    set((state) => ({
      workbook: createWorkbook({
        rootTitle: '中心主题',
        seedBranches: ['分支主题 1', '分支主题 2']
      }),
      filePath: null,
      dirty: false,
      docSeq: state.docSeq + 1,
      selection: [],
      ...NO_EDITING,
      undoStack: [],
      redoStack: [],
      // 新文档：优先恢复用户上次的选择；从未动过开关才按「启动默认视角锁定」起手
      viewLock: readPersistedViewLock() ?? state.appSettings.defaultViewLock,
      selectedOverlay: null,
      zoom: 1,
      pan: { x: 0, y: 0 }
    })),

  loadDocument: (workbook, path) =>
    set((state) => ({
      // 界面只显示**第一张画布**（画布切换按钮已移除）：文件的其余画布原样保留在
      // workbook 里，保存时照旧写回，不会丢内容。
      workbook: { ...workbook, activeSheetId: workbook.sheets[0]?.id ?? workbook.activeSheetId },
      filePath: path,
      dirty: false,
      docSeq: state.docSeq + 1,
      selection: [],
      ...NO_EDITING,
      undoStack: [],
      redoStack: [],
      // 打开文档同样恢复上次的选择（与新建一致）
      viewLock: readPersistedViewLock() ?? state.appSettings.defaultViewLock,
      selectedOverlay: null,
      zoom: 1,
      pan: { x: 0, y: 0 }
    })),

  restoreDocument: (workbook) =>
    set((state) => ({
      workbook,
      // filePath 保持不动；标记为未保存，避免用户以为已经落盘
      dirty: true,
      docSeq: state.docSeq + 1,
      selection: [],
      ...NO_EDITING,
      // 恢复是一次大跨度替换，撤销栈对它没有意义（恢复前会自动存一份版本兜底）
      undoStack: [],
      redoStack: []
    })),

  markSaved: (path) => set({ filePath: path, dirty: false }),

  /* ------------------------------------------------------------------ */
  /* 编辑                                                                */
  /* ------------------------------------------------------------------ */

  mutate: (recipe, label, coalesceKey) => {
    const { workbook, undoStack, selection: selectionBefore } = get()
    const [next, patches, inverse] = produceWithPatches(workbook, recipe)
    if (patches.length === 0) return false

    const now = Date.now()
    const last = undoStack[undoStack.length - 1]
    const canMerge =
      coalesceKey !== undefined &&
      last !== undefined &&
      last.coalesceKey === coalesceKey &&
      now - last.time < COALESCE_WINDOW_MS

    if (canMerge) {
      // 合并成一步撤销：重做用最新的 patches，撤销仍然回到最早那次修改之前
      const merged: HistoryEntry = {
        label,
        patches,
        inverse: last.inverse,
        coalesceKey,
        time: now,
        selectionBefore: last.selectionBefore ?? selectionBefore
      }
      set({
        workbook: next,
        dirty: true,
        undoStack: [...undoStack.slice(0, -1), merged],
        redoStack: []
      })
      return true
    }

    set({
      workbook: next,
      dirty: true,
      undoStack: [
        ...undoStack,
        { label, patches, inverse, coalesceKey, time: now, selectionBefore }
      ].slice(-HISTORY_LIMIT),
      redoStack: []
    })
    return true
  },

  beginAiTurn: () => {
    // 已经在回合里就别重入：同一份文档同时只允许一个 AI 回合
    if (get().aiTurn) return
    set({ aiTurn: { depth: get().undoStack.length, selectionBefore: get().selection } })
  },

  /**
   * 结束 AI 回合，把期间的所有改动**并成一步撤销**。
   *
   * 合成规则是这件事的关键：
   * - `patches` 按**发生顺序**拼（撤销栈里的顺序就是发生顺序）；
   * - `inverse` 按**条目倒序**拼（每个 inverse 是针对它自己那次改动**之前**的状态算出来的，
   *   必须从最后一步往前依次套用）。
   *
   * 反过来做（把 inverse 合成一份、正向套到"后来的状态"上）会踩坑：数组重排的 patch 带下标，
   * 套错状态就会改坏 `children`——早期做「连按方向键合并成一步」时就这么坏过数据。
   */
  commitAiTurn: (label) => {
    const turn = get().aiTurn
    if (!turn) return false
    const { undoStack } = get()
    const batch = undoStack.slice(turn.depth)
    if (batch.length === 0) {
      // AI 没改任何东西：不留空条目（否则用户按 Ctrl+Z 会"没反应"）
      set({ aiTurn: null })
      return false
    }

    const patches = batch.flatMap((entry) => entry.patches)
    const inverse: Patch[] = []
    for (let index = batch.length - 1; index >= 0; index -= 1) {
      const entry = batch[index]
      if (entry) inverse.push(...entry.inverse)
    }

    set({
      aiTurn: null,
      undoStack: [
        ...undoStack.slice(0, turn.depth),
        { label, patches, inverse, time: Date.now(), selectionBefore: turn.selectionBefore }
      ].slice(-HISTORY_LIMIT),
      redoStack: []
    })
    return true
  },

  undo: () => {
    // AI 回合进行中禁止撤销：中途把撤销栈抽走，会让后续步骤全部错位
    if (get().aiTurn) return
    const { workbook, undoStack, redoStack } = get()
    const entry = undoStack[undoStack.length - 1]
    if (!entry) return
    const next = applyPatches(workbook, entry.inverse) as Workbook
    const root = activeRoot(next)
    // 撤销连选择一起还原：框选了几个节点，撤销后还是那几个
    entry.selectionAtUndo = get().selection
    set({
      workbook: next,
      dirty: true,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, entry],
      ...NO_EDITING,
      selection: liveSelection(root, entry.selectionBefore)
    })
  },

  redo: () => {
    // 同 undo：AI 回合进行中不许动历史
    if (get().aiTurn) return
    const { workbook, undoStack, redoStack } = get()
    const entry = redoStack[redoStack.length - 1]
    if (!entry) return
    const next = applyPatches(workbook, entry.patches) as Workbook
    const root = activeRoot(next)
    // 重做还原「撤销那一刻」的选择。注意不要覆盖 entry.selectionBefore——
    // 条目回到撤销栈后，再撤销仍要用它还原到「这次修改之前」的框选
    set({
      workbook: next,
      dirty: true,
      undoStack: [...undoStack, entry],
      redoStack: redoStack.slice(0, -1),
      ...NO_EDITING,
      selection: liveSelection(root, entry.selectionAtUndo)
    })
  },

  /* ------------------------------------------------------------------ */
  /* 选择与编辑态                                                        */
  /* ------------------------------------------------------------------ */

  select: (id, additive = false) =>
    set((s) => {
      // 动主题就把画布元素的选中取消（两者不同时高亮）
      if (id === null) return { selection: [], selectedOverlay: null }
      if (!additive) return { selection: [id], selectedOverlay: null }
      return s.selection.includes(id)
        ? { selection: s.selection.filter((x) => x !== id) }
        : { selection: [...s.selection, id], selectedOverlay: null }
    }),

  beginEdit: (id, insertText) => {
    const topic = findTopic(activeRoot(get().workbook), id)
    const base = topic?.titleRich
      ? normalizeRich(topic.titleRich)
      : richFromPlain(topic?.title ?? '')
    const rich = insertText ? appendToRich(base, insertText) : base
    set({ editingId: id, ...editingContent(rich), selection: [id] })
  },

  updateEditingText: (text) => set(editingContent(richFromPlain(text))),

  updateEditingRich: (rich) => set(editingContent(rich)),

  commitEdit: (forId) => {
    const { editingId, editingText, editingRich, workbook } = get()
    if (!editingId) return
    // 旧输入框失焦时可能已经切到了新节点，此时必须忽略这次提交
    if (forId !== undefined && forId !== editingId) return

    const topic = findTopic(activeRoot(workbook), editingId)
    const nextTitle = editingText
    const nextRich = editingRich ? normalizeRich(editingRich) : null
    // 「首次命名」＝新建节点第一次输入文字：给打的内容补上默认字体/字号/颜色。
    // 只认「原来标题为空」的节点——改老节点的文字绝不能突然被换样式。
    const firstNaming = topic !== null && topic.title === ''
    const stampedRich =
      nextRich && firstNaming ? stampRichDefaults(nextRich, get().appSettings) : nextRich
    const keepRich = stampedRich && hasFormatting(stampedRich) ? stampedRich : null

    set(NO_EDITING)
    if (!topic) return
    if (topic.title === nextTitle && sameRich(topic.titleRich, keepRich)) return

    get().mutate((draft) => {
      const target = findTopic(activeRoot(draft), editingId)
      if (!target) return
      target.title = nextTitle
      // 只有真正带格式时才写 titleRich，保持 .xmind 干净且与 Xmind 兼容
      target.titleRich = keepRich ?? undefined
    }, '修改文本')
  },

  cancelEdit: () => set(NO_EDITING),

  bumpRenderEpoch: () => set((state) => ({ renderEpoch: state.renderEpoch + 1 })),

  commitAndAddChild: () => {
    const id = get().editingId
    if (!id) return
    get().commitEdit()
    get().addChild(id)
  },

  commitAndAddSibling: () => {
    const id = get().editingId
    if (!id) return
    get().commitEdit()
    get().addSibling(id)
  },

  /* ------------------------------------------------------------------ */
  /* 结构操作                                                            */
  /* ------------------------------------------------------------------ */

  addChild: (parentId) => {
    const { workbook, selection } = get()
    const root = activeRoot(workbook)
    const baseId = parentId ?? selection[0] ?? root.id
    const parent = findTopic(root, baseId) ?? root
    const node = createTopic('')
    stampNodeDefaults(node, get().appSettings)
    get().mutate((draft) => {
      const target = findTopic(activeRoot(draft), parent.id) ?? activeRoot(draft)
      target.children.push(node)
      // 只在确实折叠着时才改：避免写入多余的 collapsed: false，
      // 否则「打开 → 另存」会因为默认值产生结构性差异
      ensureExpanded(target)
    }, '新建子主题')
    set({ selection: [node.id], editingId: node.id, ...editingContent(richFromPlain('')) })
    return node.id
  },

  addSibling: (id) => {
    const { workbook, selection } = get()
    const root = activeRoot(workbook)
    const baseId = id ?? selection[0]
    if (!baseId || baseId === root.id) return get().addChild(root.id)
    const parent = findParent(root, baseId)
    if (!parent) return get().addChild(root.id)
    const index = parent.children.findIndex((c) => c.id === baseId)
    const node = createTopic('')
    stampNodeDefaults(node, get().appSettings)
    get().mutate((draft) => {
      const draftParent = findTopic(activeRoot(draft), parent.id)
      if (!draftParent) return
      draftParent.children.splice(index < 0 ? draftParent.children.length : index + 1, 0, node)
    }, '新建同级主题')
    set({ selection: [node.id], editingId: node.id, ...editingContent(richFromPlain('')) })
    return node.id
  },

  deleteSelection: () => {
    // 选中的是画布元素（概要 / 边界 / 关系线）时，Delete 删的是它而不是主题
    const overlay = get().selectedOverlay
    if (overlay) {
      const state = get()
      if (overlay.kind === 'summary') state.removeSummary(overlay.id)
      else if (overlay.kind === 'boundary') state.removeBoundary(overlay.id)
      else state.removeRelationship(overlay.id)
      set({ selectedOverlay: null })
      return
    }

    const { workbook, selection } = get()
    const root = activeRoot(workbook)
    const targets = selection.filter((id) => id !== root.id && findTopic(root, id))
    if (targets.length === 0) return

    // 删完必须把选择落到一个**还存在**的主题上：否则选择指向"空"，
    // 方向键、Delete、Tab/Enter 全都失灵，用户只能先拿鼠标点一下才能继续用键盘
    // （这就是反馈里的「删除节点后选择失效，必须鼠标点击才能生效」）。
    // 落点顺序：原位置**之后**的下一个未删除兄弟 → **之前**的上一个 → 父级。
    const first = targets[0]
    if (!first) return
    const parent = findParent(root, first)
    let nextId: string | null = null
    if (parent) {
      const firstIndex = parent.children.findIndex((child) => child.id === first)
      const after = parent.children
        .slice(firstIndex + 1)
        .find((child) => !targets.includes(child.id))
      const before = parent.children
        .slice(0, Math.max(firstIndex, 0))
        .reverse()
        .find((child) => !targets.includes(child.id))
      nextId = after?.id ?? before?.id ?? parent.id
    }

    get().mutate((draft) => {
      const draftRoot = activeRoot(draft)
      for (const id of targets) detachTopic(draftRoot, id)
      // 指向已删除主题的关系线/边界/概要会变成悬空元素，必须一起清掉
      pruneOverlays(activeSheet(draft))
    }, '删除主题')
    set({
      selection: nextId ? [nextId] : [],
      ...NO_EDITING
    })
  },

  deleteTopic: (id) => {
    const { workbook } = get()
    const root = activeRoot(workbook)
    if (id === root.id || !findTopic(root, id)) return false

    const parent = findParent(root, id)
    get().mutate((draft) => {
      const draftRoot = activeRoot(draft)
      detachTopic(draftRoot, id)
      // 指向已删除主题的关系线/边界/概要会变成悬空元素，必须一起清掉
      pruneOverlays(activeSheet(draft))
    }, '删除主题')

    // 选择落在**被删节点的父级**上（不是随便挑一个），用户不会觉得焦点丢了；
    // 原本还选着的其它节点仍然保留
    const stillThere = get().selection.filter(
      (item) => item !== id && findTopic(activeRoot(get().workbook), item) !== null
    )
    set({
      selection: stillThere.length > 0 ? stillThere : parent ? [parent.id] : [],
      ...NO_EDITING
    })
    return true
  },

  setTitle: (id, title) => {
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (topic) {
        topic.title = title
        topic.titleRich = undefined
      }
    }, '修改文本')
  },

  setRichText: (id, rich) => {
    const normalized = rich ? normalizeRich(rich) : null
    const keep = normalized && hasFormatting(normalized) ? normalized : null
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      topic.titleRich = keep ?? undefined
      if (keep) topic.title = plainTextOf(keep)
    }, '修改格式')
  },

  toggleCollapse: (id) => {
    const topic = findTopic(activeRoot(get().workbook), id)
    if (!topic || topic.children.length === 0) return
    /**
     * 「**按侧收起**」也算折叠着：大纲那一行会显示成「展开」按钮（`outlineRows` 的
     * `collapsed` 判据是"有子节点但不是全部可见"），画布上 `Ctrl+/` 也是同一个入口。
     * 此时按一下必须**展开**（把按侧标记清掉），否则就是"提示写展开、点下去把两侧都收起来"——
     * 动作与提示相反，比不做还糟（真踩过）。
     */
    const folded = foldedSidesOf(topic)
    if (folded.length > 0 && !topic.collapsed) {
      get().setCollapsed(id, false)
      return
    }
    /**
     * 只有「**超过 1 个子主题**」才允许折叠（与 `TopicNode` 的徽标显示同一条规则）：
     * 只有一个子节点时折叠没有信息量，而且界面上已经不显示折叠徽标——
     * 这里不守卫的话，键盘（Ctrl + /）或 AI 仍能把折叠状态写进去，
     * 用户就会遇到"看不见任何徽标、图却少了一截"的怪状态。
     * 已折叠的主题总是可以展开（不然一个子节点的折叠状态就永远打不开了）。
     */
    if (!topic.collapsed && topic.children.length < 2) return
    get().setCollapsed(id, !topic.collapsed)
  },

  setCollapsed: (id, collapsed) => {
    const before = get()
    get().mutate(
      (draft) => {
        const topic = findTopic(activeRoot(draft), id)
        if (!topic || topic.children.length === 0) return
        // 用 undefined 表示展开，让模型中只存在「折叠 / 未设置」两种状态
        const next = collapsed ? true : undefined
        const hadFolded = foldedSidesOf(topic).length > 0
        // 按侧收起也算「折叠着」：只有它存在时，展开同样要落一步（否则点了没反应）
        if (topic.collapsed === next && !hadFolded) return
        topic.collapsed = next
        /**
         * 「整体折叠」与「按侧收起」互斥：两者的模型标记各存一处，
         * 不同时清掉就会出现「整体展开了、某一侧却还收着」这种读不懂的状态。
         */
        if (hadFolded) withFoldedSides(topic, [])
      },
      '折叠/展开',
      // 同一个主题、同一个方向的连续折叠（例如连按空格）合并成一步；
      // 方向一变就是新的一步——否则「折叠又展开」会被并成一次空操作，撤销看起来没反应
      `collapse:${id}:${collapsed ? 'fold' : 'unfold'}`
    )

    // 折叠会把整棵子树**藏起来**：选中的主题若正在里面，它就从布局里消失了——
    // 视角锁定再也盯不到它，用户看到的是「锁定突然失效、画面不跟了」。
    // 把选择挪到折叠节点自己身上：既看得见，锁定也能继续跟。
    if (collapsed) {
      const root = activeRoot(before.workbook)
      if (before.selection.some((sel) => sel !== id && isSelfOrDescendant(root, id, sel))) {
        get().select(id)
      }
    }
  },

  setFoldSide: (id, side, folded) => {
    const before = get()
    get().mutate(
      (draft) => {
        const root = activeRoot(draft)
        const topic = findTopic(root, id)
        if (!topic) return
        // 只对「中心主题 + 两个方向都真的挂着分支」的结构生效（与 TopicNode 的多根徽标同一判据）
        if (splitFoldSidesOf(topic, topic.id === root.id).length < 2) return
        if (![...childFoldSides(topic).values()].includes(side)) return
        const current = foldedSidesOf(topic)
        // 已经是这个状态就什么都不写：AI 重试 / 重复点击不该产生撤销记录
        if (current.includes(side) === folded) return
        // 切到按侧收起模式：整体折叠标记要先清掉，否则整体折叠优先、这一侧点了没反应
        if (topic.collapsed) topic.collapsed = undefined
        const next: FoldSide[] = folded
          ? [...current, side]
          : current.filter((item) => item !== side)
        withFoldedSides(topic, next)
      },
      '折叠/展开',
      // 同一侧同一方向连续操作合并成一步；**方向或侧别一变就是新的一步**——
      // 否则「收起又展开」会被并成一次空操作，撤销看起来没反应（与 setCollapsed 同一套口径）
      `fold:${id}:${side}:${folded ? 'fold' : 'unfold'}`
    )

    /**
     * 收起后，落在这一侧的选中主题已经从布局里消失——视角锁定再也盯不到它。
     * 与整体折叠同一处理：把选择挪到中心主题身上（它一定看得见）。
     */
    const after = findTopic(activeRoot(get().workbook), id)
    if (!after || !foldedSidesOf(after).includes(side)) return
    const sides = childFoldSides(after)
    const hidden = after.children.filter((child) => sides.get(child.id) === side)
    const root = activeRoot(before.workbook)
    if (
      before.selection.some((sel) =>
        hidden.some((child) => isSelfOrDescendant(root, child.id, sel))
      )
    ) {
      get().select(id)
    }
  },

  toggleFoldSide: (id, side) => {
    const topic = findTopic(activeRoot(get().workbook), id)
    if (!topic) return
    get().setFoldSide(id, side, !foldedSidesOf(topic).includes(side))
  },

  setTopicSide: (id, side) => {
    get().mutate((draft) => {
      const root = activeRoot(draft)
      const topic = findTopic(root, id)
      if (!topic) return
      const properties: Record<string, string> = { ...(topic.style?.properties ?? {}) }
      const moved = properties[TOPIC_SIDE_KEY] !== side
      if (moved) {
        properties[TOPIC_SIDE_KEY] = side
        topic.style = { ...(topic.style ?? {}), properties }
      }
      /**
       * 拖到的那一侧如果正**收起着**，这个分支会当场消失（看着像把数据弄丢了）——
       * 刚挪过去的东西必须看得见，所以顺手把那一侧展开。
       * 与「新建子主题时自动展开」是同一条规矩。
       */
      if (!moved) return
      const parent = findParent(root, id)
      if (!parent) return
      const folded = foldedSidesOf(parent)
      if (folded.includes(side))
        withFoldedSides(
          parent,
          folded.filter((item) => item !== side)
        )
    }, '调整分支左右')
  },

  setSizeOverride: (id, size) => {
    const next =
      size && size.width > 0 && size.height > 0
        ? { width: Math.round(size.width), height: Math.round(size.height) }
        : null
    get().mutate(
      (draft) => {
        const root = activeRoot(draft)
        const topic = findTopic(root, id)
        if (!topic) return
        if (!next) {
          if (topic.sizeOverride === undefined) return
          topic.sizeOverride = undefined
          return
        }
        // 兜底：框不能小于内容。代码块最小只能缩到缩放下限、公式是整块原子，
        // 任一方都按「内容尺寸 + 内边距」夹一下（渲染层的拉伸手柄也夹，双保险）
        let depth = 0
        let cursor = topic
        while (cursor) {
          const parent = findParent(root, cursor.id)
          if (!parent) break
          depth += 1
          cursor = parent
        }
        const padding = nodePaddingOf(depth)
        // 下标已经 clamp 在数组范围内
        const fontSize = NODE_FONT_SIZES[Math.min(depth, NODE_FONT_SIZES.length - 1)]!
        const mins: Size[] = []
        const codeMin = codeMinNodeSize(topic.code, padding)
        if (codeMin) mins.push(codeMin)
        // 公式块：宽度 = 公式宽 + 内边距；高度 = 公式高 + 一行标题 + 间隔 + 内边距
        // （这里拿不到排版行高，用 1.6 倍字号近似——渲染层手柄才是精确钳制，这里只防历史遗留的过小值）
        if (topic.formula) {
          const box = formulaSize(topic.formula, fontSize)
          mins.push({
            width: box.width + padding.x * 2,
            height: box.height + Math.round(fontSize * 1.6) + BLOCK_GAP + padding.y * 2
          })
        }
        const minWidth = Math.max(0, ...mins.map((item) => item.width))
        const minHeight = Math.max(0, ...mins.map((item) => item.height))
        const clamped =
          minWidth > next.width || minHeight > next.height
            ? {
                width: Math.max(next.width, Math.round(minWidth)),
                height: Math.max(next.height, Math.round(minHeight))
              }
            : next
        if (
          topic.sizeOverride?.width === clamped.width &&
          topic.sizeOverride?.height === clamped.height
        )
          return
        topic.sizeOverride = clamped
      },
      next ? '拉伸节点' : '恢复节点自动尺寸',
      // 拖动过程中每帧都写，合并成一步撤销
      next ? `size:${id}` : undefined
    )
  },

  moveSelectionByKey: (key) => {
    const state = get()
    const id = state.selection[0]
    if (!id) return false
    const root = activeRoot(state.workbook)
    // 中心主题不能被移动
    if (id === root.id) return false
    const parent = findParent(root, id)
    if (!parent) return false
    const index = parent.children.findIndex((child) => child.id === id)
    if (index < 0) return false
    const last = parent.children.length - 1

    // 每次按键各记一步撤销，**刻意不合并**：移动是数组重排，
    // 合并两步的 inverse 会因为下标错位而改坏 children（见 moveNode 的说明）。
    if (key === 'ArrowUp') return index === 0 ? false : state.moveNode(id, parent.id, index - 1)
    if (key === 'ArrowDown')
      return index === last ? false : state.moveNode(id, parent.id, index + 1)
    if (key === 'Home') return index === 0 ? false : state.moveNode(id, parent.id, 0)
    if (key === 'End')
      return index === last ? false : state.moveNode(id, parent.id, parent.children.length)

    if (key === 'ArrowLeft') {
      // 升级：挪到父级的后面，成为父级的兄弟
      const grandParent = findParent(root, parent.id)
      if (!grandParent) return false
      const parentIndex = grandParent.children.findIndex((child) => child.id === parent.id)
      if (parentIndex < 0) return false
      return state.moveNode(id, grandParent.id, parentIndex + 1)
    }

    // 降级：挂到前一个兄弟下面。没有前一个兄弟就无处可降。
    const previous = index > 0 ? parent.children[index - 1] : undefined
    if (!previous) return false
    return state.moveNode(id, previous.id)
  },

  navigateSelection: (key) => {
    const state = get()
    const root = activeRoot(state.workbook)
    const selectedId = state.selection[0]
    const selected = selectedId ? findTopic(root, selectedId) : null
    // 选择可能已经失效（比如它刚被删掉、或撤销回到了另一个版本）→ 先把选择收回根，
    // 保证"键盘永远可用"，不再出现按了没反应、只能拿鼠标点一下的死状态。
    if (selectedId && !selected) set({ selection: [root.id] })
    const currentId = selected ? selected.id : root.id

    if (key === 'ArrowLeft') {
      const parent = findParent(root, currentId)
      if (parent) set({ selection: [parent.id] })
      return
    }
    if (key === 'ArrowRight') {
      const firstChild = findTopic(root, currentId)?.children[0]
      if (firstChild) set({ selection: [firstChild.id] })
      return
    }
    const parent = findParent(root, currentId) ?? root
    const index = parent.children.findIndex((child) => child.id === currentId)
    if (index < 0) return
    const nextIndex = key === 'ArrowUp' ? index - 1 : index + 1
    if (nextIndex >= 0 && nextIndex < parent.children.length) {
      const next = parent.children[nextIndex]
      if (next) set({ selection: [next.id] })
    }
  },

  setStructure: (structureClass) => {
    const root = activeRoot(get().workbook)
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), root.id)
      if (topic) topic.structureClass = structureClass
    }, '切换结构')
  },

  moveNode: (id, targetId, index) => {
    const root = activeRoot(get().workbook)
    if (id === root.id) return false
    if (isSelfOrDescendant(root, id, targetId)) return false
    const parent = findParent(root, id)
    // 同父级且没给插入位置 → 等于原地不动，直接忽略（避免产生空的撤销记录）。
    // 给了 index 才是「同级排序」，那是允许的。
    if (parent && parent.id === targetId && index === undefined) return false
    let ok = false
    get().mutate((draft) => {
      ok = moveTopic(activeRoot(draft), id, targetId, index)
      if (ok) settleAfterMove(draft, id)
    }, '移动主题')
    if (ok) set({ selection: [id] })
    return ok
  },

  moveNodes: (moves) => {
    const applied: Array<{ id: string; targetId: string }> = []
    get().mutate((draft) => {
      const draftRoot = activeRoot(draft)
      for (const move of moves) {
        // 与 moveNode 逐条调用时的准入规则完全一致，只是不再每条都清一遍覆盖层
        if (move.id === draftRoot.id) continue
        if (isSelfOrDescendant(draftRoot, move.id, move.targetId)) continue
        const parent = findParent(draftRoot, move.id)
        // 同父级、又没给插入位置 → 等于原地不动（与 moveNode 的规则一致）
        if (parent && parent.id === move.targetId && move.index === null) continue
        if (!moveTopic(draftRoot, move.id, move.targetId, move.index ?? undefined)) continue
        // 必须清掉自由摆放偏移：留着它节点会落在「自动位置 + 偏移」，
        // 看起来像「落点预览在这里、松手却跑到别处」（与 settleAfterMove 同理）
        const moved = findTopic(draftRoot, move.id)
        if (moved) moved.position = undefined
        applied.push({ id: move.id, targetId: move.targetId })
      }
      // 失效覆盖层只在这里清一次：pruneOverlays 只看最终树、结果幂等，
      // 所以终态与「每条都清一遍」等价，成本从 O(k×N) 降到 O(N + k)
      if (applied.length > 0) pruneOverlays(activeSheet(draft))
    }, '批量移动主题')
    // 逐条调用时每次都会把选中设成刚移动的那个，这里保留同一语义：落到最后一个成功的
    const last = applied[applied.length - 1]
    if (last) set({ selection: [last.id] })
    return applied
  },

  sortChildren: (parentId, orderedIds, renumber) => {
    const index = new Map(orderedIds.map((id, at) => [id, at]))
    get().mutate(
      (draft) => {
        const parent = findTopic(activeRoot(draft), parentId)
        if (!parent) return
        // 只按给定顺序排**还在的**子主题；没给到的（模型看不到的）保持原相对顺序、排在最后
        const ordered = [...parent.children].sort((left, right) => {
          const leftAt = index.get(left.id) ?? Number.MAX_SAFE_INTEGER
          const rightAt = index.get(right.id) ?? Number.MAX_SAFE_INTEGER
          return leftAt - rightAt
        })
        parent.children = ordered
        if (!renumber) return
        ordered.forEach((child, at) => {
          const stripped = child.title.replace(/^\s*\d+\s*[.、)]\s*/, '').trim()
          if (stripped.length === 0) return
          const next = `${at + 1}. ${stripped}`
          if (child.title === next) return
          child.title = next
          // 与手工改名一致：局部格式（加粗/颜色）是按字符位置贴的，留着会盖在错的字上
          child.titleRich = undefined
        })
      },
      renumber ? '同级排序并编号' : '同级排序'
    )
  },

  mergeTopics: (groups) => {
    let merged = 0
    get().mutate((draft) => {
      const draftRoot = activeRoot(draft)
      for (const group of groups) {
        const keep = findTopic(draftRoot, group.keepId)
        if (!keep) continue
        for (const mergeId of group.mergeIds) {
          const loser = findTopic(draftRoot, mergeId)
          if (!loser || loser.id === keep.id) continue
          // 互为祖先时跳过（规划阶段已拦一道，这里是执行侧的最后一道）
          if (
            isSelfOrDescendant(draftRoot, keep.id, loser.id) ||
            isSelfOrDescendant(draftRoot, loser.id, keep.id)
          ) {
            continue
          }
          // 内容并入：保留方缺什么补什么（不覆盖它已有的内容）
          if (!keep.notes && loser.notes) {
            keep.notes = loser.notes
            keep.notesHtml = notesHtmlFrom(loser.notes)
          }
          if (!keep.code && loser.code) keep.code = loser.code
          if (!keep.formula && loser.formula) keep.formula = loser.formula
          const labels = new Set([...(keep.labels ?? []), ...(loser.labels ?? [])])
          if (labels.size > 0) keep.labels = [...labels]
          const markers = new Map((keep.markers ?? []).map((marker) => [marker.markerId, marker]))
          for (const marker of loser.markers ?? []) {
            if (!markers.has(marker.markerId)) markers.set(marker.markerId, marker)
          }
          if (markers.size > 0) keep.markers = [...markers.values()]

          // 子主题原样搬到保留方下面
          for (const child of [...loser.children]) {
            if (!moveTopic(draftRoot, child.id, keep.id, keep.children.length)) continue
            // 清掉自由摆放偏移：留着会落到"自动位置 + 偏移"的地方，看着像搬丢了
            const placed = findTopic(draftRoot, child.id)
            if (placed) placed.position = undefined
          }
          detachTopic(draftRoot, loser.id)
          merged += 1
        }
      }
      // 被删掉的主题可能挂着关系线/边界/概要：一并清掉悬空元素
      if (merged > 0) pruneOverlays(activeSheet(draft))
    }, '合并同名主题')
    return merged
  },

  dropNode: (id, targetId, mode) => {
    const root = activeRoot(get().workbook)
    // 与画布上的落点预览共用同一套裁决规则，避免"预览说这样、落下去却那样"
    const plan = resolveDrop(root, id, targetId, mode)
    if (!plan) return false

    if (plan.mode === 'child') {
      // 落进折叠的目标时顺手展开它，并和移动**合并成同一笔**：
      // 否则新加的子主题被藏起来看不见，而分成两笔又会让撤销要按两次。
      const ok = get().mutate((draft) => {
        const target = findTopic(activeRoot(draft), plan.targetId)
        if (target) ensureExpanded(target)
        moveTopic(activeRoot(draft), id, plan.targetId)
        settleAfterMove(draft, id)
      }, '移动主题')
      if (ok) set({ selection: [id] })
      return ok
    }

    // 同级插入：下标必须在「先把自己摘掉」的数组上算——
    // moveTopic 是先摘后插，若自己原本排在目标之前，用摘除前的下标
    // 插入会整体前移一位、落到错误的位置。
    const parent = findTopic(root, plan.parentId)
    if (!parent) return false
    const rest = parent.children.filter((child) => child.id !== id)
    const at = rest.findIndex((child) => child.id === targetId)
    if (at < 0) return false
    return get().moveNode(id, plan.parentId, plan.mode === 'before' ? at : at + 1)
  },

  offsetPosition: (id, dx, dy) => {
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      const base = topic.position ?? { x: 0, y: 0 }
      topic.position = { x: base.x + dx, y: base.y + dy }
    }, '移动位置')
  },

  offsetPositions: (moves) => {
    if (moves.length === 0) return
    get().mutate((draft) => {
      const root = activeRoot(draft)
      for (const move of moves) {
        const topic = findTopic(root, move.id)
        if (!topic) continue
        const base = topic.position ?? { x: 0, y: 0 }
        topic.position = { x: base.x + move.dx, y: base.y + move.dy }
      }
    }, '移动位置')
  },

  restoreAutoLayout: () => {
    const state = get()
    const root = activeRoot(state.workbook)
    const floating = flatten(root).filter((topic) => topic.position !== undefined)
    if (floating.length === 0) return 0

    /**
     * 范围规则：**选中里只要有自由摆放的主题，就只恢复这些**；否则整张画布一起恢复。
     *
     * 宁可这样也不做两个入口——只有一个按钮时，用户不会在"选中 vs 全部"之间猜；
     * 而"想只恢复一个"这件事本身就已经在手上有选择了，直接用它最自然。
     */
    const selected = state.selection.filter((id) => {
      const topic = findTopic(root, id)
      return topic !== null && topic.position !== undefined
    })
    const targets = selected.length > 0 ? selected : floating.map((topic) => topic.id)
    const scope = new Set(targets)

    get().mutate((draft) => {
      for (const topic of flatten(activeRoot(draft))) {
        if (scope.has(topic.id)) topic.position = undefined
      }
    }, '恢复自动布局')
    return targets.length
  },

  copySelection: () => {
    const { selection, workbook } = get()
    const root = activeRoot(workbook)
    const id = selection[0]
    if (!id) return
    const topic = findTopic(root, id)
    if (!topic) return
    set({ clipboard: cloneTopicDeep(topic) })
  },

  paste: () => {
    const { clipboard, selection, workbook } = get()
    if (!clipboard) return
    const root = activeRoot(workbook)
    const targetId = selection[0] ?? root.id
    const copy = cloneTopicDeep(clipboard)
    get().mutate((draft) => {
      const target = findTopic(activeRoot(draft), targetId) ?? activeRoot(draft)
      target.children.push(copy)
      ensureExpanded(target)
    }, '粘贴主题')
    set({ selection: [copy.id] })
  },

  /* ------------------------------------------------------------------ */
  /* 节点附加元素                                                        */
  /* ------------------------------------------------------------------ */

  toggleMarker: (id, markerId) => {
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      /**
       * 同一**行**只能有一个（与 Xmind 一致）：点同组的另一个是**替换**，不是叠加。
       * 规则本身在 `shared/xmind/constants` 里，渲染层和自检共用同一份。
       */
      const next = withMarkerToggled(
        topic.markers.map((marker) => marker.markerId),
        markerId
      )
      topic.markers = next.map((markerId) => ({ markerId }))
    }, '切换标记')
  },

  addLabel: (id, label) => {
    const text = label.trim()
    if (text.length === 0) return
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic || topic.labels.includes(text)) return
      topic.labels.push(text)
    }, '添加标签')
  },

  removeLabel: (id, label) => {
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      const index = topic.labels.indexOf(label)
      if (index >= 0) topic.labels.splice(index, 1)
    }, '删除标签')
  },

  setNotes: (id, notes) => {
    const text = notes.trim().length > 0 ? notes : ''
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      if (text.length === 0) {
        if (topic.notes === undefined && topic.notesHtml === undefined) return
        topic.notes = undefined
        topic.notesHtml = undefined
        return
      }
      if (topic.notes === text) return
      topic.notes = text
      // notesHtml 由纯文本派生，避免两者说法不一致
      topic.notesHtml = notesHtmlFrom(text)
    }, '修改备注')
  },

  setHref: (id, href) => {
    const next = href.trim()
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      if (next.length === 0) {
        if (topic.href === undefined) return
        topic.href = undefined
        return
      }
      topic.href = next
    }, '修改超链接')
  },

  setFormula: (id, formula) => {
    const next = formula.trim()
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      if (next.length === 0) {
        if (topic.formula === undefined) return
        topic.formula = undefined
        return
      }
      if (topic.formula === next) return
      topic.formula = next
    }, '修改公式')
  },

  setCode: (id, code) => {
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      const next = code && (code.text.length > 0 || code.language.length > 0) ? code : null
      if (!next) {
        if (topic.code === undefined) return
        topic.code = undefined
        return
      }
      if (topic.code?.text === next.text && topic.code?.language === next.language) return
      topic.code = { language: next.language, text: next.text }
    }, '修改代码块')
  },

  setImage: (id, image) => {
    // 拿不到像素尺寸时不要写 0，交给渲染层走「尺寸未知」的兜底框
    const positive = (value: number | undefined): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.round(value)
        : undefined
    const next: TopicImage | null = image
      ? { path: image.path, width: positive(image.width), height: positive(image.height) }
      : null

    get().mutate(
      (draft) => {
        const topic = findTopic(activeRoot(draft), id)
        if (!topic) return
        if (!next) {
          if (topic.image === undefined) return
          topic.image = undefined
          return
        }
        topic.image = { ...next }
      },
      next ? '插入图片' : '移除图片'
    )
  },

  addAttachment: (id, attachment) => {
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      const exists = topic.attachments.some((item) => item.path === attachment.path)
      if (exists) return
      topic.attachments.push({ ...attachment })
    }, '添加附件')
  },

  removeAttachment: (id, attachmentId) => {
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      const index = topic.attachments.findIndex((item) => item.id === attachmentId)
      if (index >= 0) topic.attachments.splice(index, 1)
    }, '删除附件')
  },

  /* ------------------------------------------------------------------ */
  /* 画布级元素                                                          */
  /* ------------------------------------------------------------------ */

  addRelationship: () => {
    const { selection, workbook } = get()
    if (selection.length !== 2) return null
    const [end1Id, end2Id] = selection
    if (!end1Id || !end2Id || end1Id === end2Id) return null

    const existing = activeSheet(workbook).relationships.find(
      (item) =>
        (item.end1Id === end1Id && item.end2Id === end2Id) ||
        (item.end1Id === end2Id && item.end2Id === end1Id)
    )
    // 开关：已经连过就取消，避免同一个位置叠出多条线
    if (existing) {
      get().removeRelationship(existing.id)
      return null
    }

    const id = createId('rel')
    get().mutate((draft) => {
      activeSheet(draft).relationships.push({ id, end1Id, end2Id })
    }, '添加关系线')
    return id
  },

  addBoundary: () => {
    const { selection, workbook } = get()
    const range = buildRange(activeRoot(workbook), selection)
    if (!range) return null

    const existing = activeSheet(workbook).boundaries.find((item) => sameRange(item.range, range))
    // 开关：再点一次移除，否则半透明填充会一层层叠加、颜色越来越深
    if (existing) {
      get().removeBoundary(existing.id)
      return null
    }

    const id = createId('boundary')
    get().mutate((draft) => {
      activeSheet(draft).boundaries.push({ id, range })
    }, '添加边界')
    return id
  },

  addSummary: () => {
    const { selection, workbook } = get()
    const range = buildRange(activeRoot(workbook), selection)
    if (!range) return null

    const existing = activeSheet(workbook).summaries.find((item) => sameRange(item.range, range))
    if (existing) {
      get().removeSummary(existing.id)
      return null
    }

    const topicId = parseRange(range)?.[0] ?? selection[0]
    if (!topicId) return null
    const id = createId('summary')
    get().mutate((draft) => {
      activeSheet(draft).summaries.push({ id, topicId, range, title: '概要' })
    }, '添加概要')
    return id
  },

  connectTopics: (end1Id, end2Id) => {
    if (end1Id === end2Id) return null
    const root = activeRoot(get().workbook)
    // 两端都得真实存在：id 是模型给的，不能默认可信
    if (!findTopic(root, end1Id) || !findTopic(root, end2Id)) return null
    const existing = activeSheet(get().workbook).relationships.find(
      (item) =>
        (item.end1Id === end1Id && item.end2Id === end2Id) ||
        (item.end1Id === end2Id && item.end2Id === end1Id)
    )
    if (existing) return existing.id
    const id = createId('rel')
    get().mutate((draft) => {
      activeSheet(draft).relationships.push({ id, end1Id, end2Id })
    }, '添加关系线')
    return id
  },

  addBoundaryFor: (topicIds, title) => {
    const range = buildRange(activeRoot(get().workbook), topicIds)
    if (!range) return null
    const existing = activeSheet(get().workbook).boundaries.find((item) =>
      sameRange(item.range, range)
    )
    if (existing) return existing.id
    const id = createId('boundary')
    const text = title?.trim()
    get().mutate((draft) => {
      activeSheet(draft).boundaries.push(text ? { id, range, title: text } : { id, range })
    }, '添加边界')
    return id
  },

  addSummaryFor: (topicIds, title) => {
    const range = buildRange(activeRoot(get().workbook), topicIds)
    if (!range) return null
    const topicId = parseRange(range)?.[0]
    if (!topicId) return null
    const existing = activeSheet(get().workbook).summaries.find((item) =>
      sameRange(item.range, range)
    )
    if (existing) return existing.id
    const id = createId('summary')
    get().mutate((draft) => {
      activeSheet(draft).summaries.push({ id, topicId, range, title: title?.trim() || '概要' })
    }, '添加概要')
    return id
  },

  setMarkers: (id, markerIds) => {
    // 整体替换也按「每行一个」收敛：输入可能带着同一行的多个标记
    const wanted = reconcileMarkers(markerIds)
    get().mutate((draft) => {
      const topic = findTopic(activeRoot(draft), id)
      if (!topic) return
      topic.markers = wanted.map((markerId) => ({ markerId }))
    }, '设置标记')
  },

  offsetRelationshipCurve: (id, dx, dy) => {
    get().mutate(
      (draft) => {
        const target = activeSheet(draft).relationships.find((item) => item.id === id)
        if (!target) return
        const current = readCurveOffset(target.style)
        target.style = withCurveOffset(target.style, { x: current.x + dx, y: current.y + dy })
      },
      '调整关系线弯度',
      `curve:${id}`
    )
  },

  resetRelationshipCurve: (id) => {
    get().mutate((draft) => {
      const target = activeSheet(draft).relationships.find((item) => item.id === id)
      if (!target) return
      if (!target.style?.properties?.[RELATIONSHIP_CURVE_KEY]) return
      target.style = withCurveOffset(target.style, { x: 0, y: 0 })
    }, '恢复关系线弯度')
  },

  setSelection: (ids) => {
    const root = activeRoot(get().workbook)
    const valid = Array.from(new Set(ids)).filter((id) => Boolean(findTopic(root, id)))
    // 选主题就取消画布元素的选中（两者不同时高亮）
    set({ selection: valid, ...NO_EDITING, selectedOverlay: null })
  },

  selectedOverlay: null,

  selectOverlay: (kind, id) => set({ selectedOverlay: { kind, id }, selection: [], ...NO_EDITING }),

  clearOverlaySelection: () => set({ selectedOverlay: null }),

  nodePanelTick: 0,

  requestNodePanel: () => set({ nodePanelTick: get().nodePanelTick + 1 }),

  setOverlayStyle: (kind, id, patch) => {
    get().mutate((draft) => {
      const sheet = activeSheet(draft)
      const list =
        kind === 'summary'
          ? sheet.summaries
          : kind === 'boundary'
            ? sheet.boundaries
            : sheet.relationships
      const target = list.find((item) => item.id === id)
      if (!target) return
      const next = withOverlayTextStyle(target.style, patch)
      if (!next) {
        if (target.style === undefined) return
        target.style = undefined
        return
      }
      target.style = next
    }, '修改画布元素样式')
  },

  codeFocusTick: 0,
  requestCodeFocus: () => set((s) => ({ codeFocusTick: s.codeFocusTick + 1 })),

  notesFocusTick: 0,
  requestNotesFocus: () =>
    set((s) => ({ nodePanelTick: s.nodePanelTick + 1, notesFocusTick: s.notesFocusTick + 1 })),

  formulaFocusTick: 0,
  requestFormulaFocus: () => set((s) => ({ formulaFocusTick: s.formulaFocusTick + 1 })),

  appSettings: { ...DEFAULT_APP_SETTINGS },
  setAppSettings: (next) => set({ appSettings: { ...next } }),

  removeRelationship: (id) => {
    get().mutate((draft) => {
      const list = activeSheet(draft).relationships
      const index = list.findIndex((item) => item.id === id)
      if (index >= 0) list.splice(index, 1)
    }, '删除关系线')
  },

  removeBoundary: (id) => {
    get().mutate((draft) => {
      const list = activeSheet(draft).boundaries
      const index = list.findIndex((item) => item.id === id)
      if (index >= 0) list.splice(index, 1)
    }, '删除边界')
  },

  removeSummary: (id) => {
    get().mutate((draft) => {
      const list = activeSheet(draft).summaries
      const index = list.findIndex((item) => item.id === id)
      if (index >= 0) list.splice(index, 1)
    }, '删除概要')
  },

  setRelationshipEnd: (id, end, topicId) => {
    get().mutate((draft) => {
      const target = activeSheet(draft).relationships.find((item) => item.id === id)
      if (!target) return
      const other = end === 'end1Id' ? target.end2Id : target.end1Id
      // 两端不能连到同一个主题，否则连线会退化成零长度
      if (other === topicId) return
      if (target[end] === topicId) return
      target[end] = topicId
    }, '改接关系线')
  },

  setRelationshipTitle: (id, title) => {
    const text = title.trim()
    get().mutate((draft) => {
      const target = activeSheet(draft).relationships.find((item) => item.id === id)
      if (!target) return
      target.title = text.length > 0 ? text : undefined
    }, '修改关系线标题')
  },

  setBoundaryTitle: (id, title) => {
    const text = title.trim()
    get().mutate((draft) => {
      const target = activeSheet(draft).boundaries.find((item) => item.id === id)
      if (!target) return
      target.title = text.length > 0 ? text : undefined
    }, '修改边界标题')
  },

  setSummaryTitle: (id, title) => {
    const text = title.trim()
    get().mutate((draft) => {
      const target = activeSheet(draft).summaries.find((item) => item.id === id)
      if (!target) return
      // 概要文字可能是「没有自带标题、回退显示主题文字」的情况。
      // 用户主动清空时必须写成空串而不是 undefined，
      // 否则清空后会立刻回退成主题的文字，看起来就像「改不动」。
      target.title = text
    }, '修改概要标题')
  },

  /* ------------------------------------------------------------------ */
  /* 主题                                                                */
  /* ------------------------------------------------------------------ */

  primeTheme: (theme) => {
    set((state) => ({
      workbook: produce(state.workbook, (draft) => {
        for (const sheet of draft.sheets) {
          // 把配色「烤」进文档，与 applyTheme 保持同一套写法
          sheet.theme = {
            ...(sheet.theme ?? {}),
            id: theme.id,
            name: theme.name,
            colors: { ...theme.colors, branches: [...theme.colors.branches] }
          }
        }
      })
    }))
  },

  applyTheme: (theme) => {
    const current = (() => {
      const { workbook } = get()
      return (workbook.sheets.find((s) => s.id === workbook.activeSheetId) ?? workbook.sheets[0])
        ?.theme
    })()
    // 已经是这个主题（例如启动时套用「设置」里的默认主题）就别再写一次：
    // 否则新建文档一上来就被记成"有未保存改动"，标题栏立刻出现 ●
    if (
      current &&
      current.id === theme.id &&
      JSON.stringify(current.colors) === JSON.stringify(theme.colors)
    ) {
      return
    }
    get().mutate((draft) => {
      const sheet = draft.sheets.find((s) => s.id === draft.activeSheetId) ?? draft.sheets[0]
      if (!sheet) return
      // 把配色「烤」进文档，内置主题日后调整也不会改变老文件的样子
      sheet.theme = {
        ...(sheet.theme ?? {}),
        id: theme.id,
        name: theme.name,
        colors: { ...theme.colors, branches: [...theme.colors.branches] }
      }
    }, '应用主题')
  },

  updateThemeColors: (patch, coalesceKey) => {
    get().mutate(
      (draft) => {
        const sheet = draft.sheets.find((s) => s.id === draft.activeSheetId) ?? draft.sheets[0]
        if (!sheet) return
        const current = sheet.theme?.colors ?? DEFAULT_THEME.colors
        sheet.theme = {
          ...(sheet.theme ?? {}),
          id: sheet.theme?.id ?? 'custom',
          name: sheet.theme?.name ?? DEFAULT_THEME.name,
          colors: {
            ...current,
            ...patch,
            branches: patch.branches ? [...patch.branches] : [...current.branches]
          }
        }
      },
      '调整主题',
      coalesceKey
    )
  }
}))

/* ------------------------------------------------------------------ */
/* 派生工具                                                            */
/* ------------------------------------------------------------------ */

/**
 * 工具栏「关系线 / 边界 / 概要」三个开关的当前状态。
 * 返回已存在元素的 id，按钮据此显示为「已按下」，用户也能看出再点一次会取消。
 *
 * 注意：这里刻意接收 workbook / selection 而不是整个 state，
 * 是为了能在组件里用 useMemo 包住——直接当 zustand selector 用会每次返回新对象，
 * 触发 useSyncExternalStore 的无限重渲染。
 */
export function overlayToggleOf(
  workbook: Workbook,
  selection: string[]
): {
  relationshipId: string | null
  boundaryId: string | null
  summaryId: string | null
} {
  const sheet = activeSheet(workbook)

  let relationshipId: string | null = null
  if (selection.length === 2) {
    const [first, second] = selection
    relationshipId =
      sheet.relationships.find(
        (item) =>
          (item.end1Id === first && item.end2Id === second) ||
          (item.end1Id === second && item.end2Id === first)
      )?.id ?? null
  }

  const range = buildRange(activeRoot(workbook), selection)
  return {
    relationshipId,
    boundaryId: range
      ? (sheet.boundaries.find((item) => sameRange(item.range, range))?.id ?? null)
      : null,
    summaryId: range
      ? (sheet.summaries.find((item) => sameRange(item.range, range))?.id ?? null)
      : null
  }
}

/**
 * 落盘用的快照。
 * 把「正在编辑但还没提交」的内容也包含进去，
 * 这样自动保存不会因为用户还在输入而丢掉最后几个字，
 * 同时也不需要打断用户的输入（不会改动编辑态）。
 */
export function snapshotForSave(state: EditorState): Workbook {
  if (!state.editingId) return state.workbook
  const editingId = state.editingId
  const rich = state.editingRich
  const text = state.editingText
  return produce(state.workbook, (draft) => {
    const topic = findTopic(activeRoot(draft), editingId)
    if (!topic) return
    topic.title = text
    const normalized = rich ? normalizeRich(rich) : null
    topic.titleRich = normalized && hasFormatting(normalized) ? normalized : undefined
  })
}
