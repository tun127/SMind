/**
 * 编辑器纯逻辑：自 `store/editor.ts` 下沉（函数体**逐字未改**，这一批只搬代码、不改行为）。
 *
 * **为什么它们算纯逻辑**：不读 zustand 的 `set`/`get`，不碰 `window`/DOM/`localStorage`/IPC，
 * 只做计算（个别就地修改传入的 draft，在 immer 里同样算纯逻辑），依赖面只有 `@shared` 下的模块
 * ——所以放 `shared/model/` 合法（`shared` 不许 import `renderer`），也**能被 selfcheck 直接覆盖**。
 *
 * 11 个函数：`liveSelection`（过滤幽灵 id）、`editingContent`（编辑态两种表示同源产出）、
 * `themeColorsOf`（当前画布配色）、`clampZoom`（缩放钳制）、
 * `settleAfterMove`（移动后收尾：清 position + 清失效 overlay）、
 * `pruneOverlays`（删主题后清悬空关系线/边界/概要）、`sameRich`（富文本等价）、
 * `stampRichDefaults` / `stampNodeDefaults` / `walkStampDefaults`（默认文字样式：补 / 落到新节点 / 整棵子树）、
 * `overlayToggleOf`（关系线·边界·概要三个开关的当前状态）。
 *
 * 两个**公开面**（`themeColorsOf` / `overlayToggleOf`）在 `store/editor.ts` 里再导出了一次，
 * 4 个外部调用点（Canvas / export/index / ThemePanel / overlay-group）**一行都不用改**。
 */

import type { AppSettings } from '../ipc'
import { buildRange, parseRange, sameRange } from '../layout'
import { normalizeRich, plainTextOf, richFromPlain } from '../richtext'
import { getThemeColors } from '../theme'
import { activeRoot, activeSheet, findTopic } from './tree'
import type { RichText, Sheet, ThemeColors, Topic, Workbook } from './types'

/** 过滤掉已经不存在的节点，选择绝不指向幽灵 id */
export function liveSelection(root: Topic, ids: string[] | undefined): string[] {
  if (!ids || ids.length === 0) return []
  return ids.filter((id) => findTopic(root, id) !== null)
}

/**
 * 编辑内容的两种表示永远从**同一个来源**产出：给富文本，纯文本由它算出来。
 * 于是"两处不一致"从根上不可能发生，调用方也不必记得同时改两个字段。
 */
export function editingContent(rich: RichText | null): {
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

export const clampZoom = (z: number): number => Math.min(4, Math.max(0.1, z))

/**
 * 主题移动之后的统一收尾。`moveNode` 与 `dropNode` 共用，避免两套写法走偏。
 * 注意必须清掉自由摆放的偏移：留着它，主题会落在"自动布局位置 + 偏移"的地方，
 * 也就是「落点预览画在这里、松手却出现在别处」，看起来就像没连上。
 */
export function settleAfterMove(draft: Workbook, id: string): void {
  const moved = findTopic(activeRoot(draft), id)
  if (moved) moved.position = undefined
  // 换了父级后，原本「同级连续区间」可能不再成立，顺手清掉失效的边界/概要
  pruneOverlays(activeSheet(draft))
}

/** 删除主题后清理指向它们的画布级元素，避免出现悬空的关系线/边界/概要 */
export function pruneOverlays(sheet: Sheet): void {
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

export function sameRich(a: RichText | undefined, b: RichText | null): boolean {
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
export function stampRichDefaults(rich: RichText, settings: AppSettings): RichText {
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
export function stampNodeDefaults(topic: Topic, settings: AppSettings): void {
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
export function walkStampDefaults(topic: Topic, settings: AppSettings): void {
  stampNodeDefaults(topic, settings)
  for (const child of topic.children) walkStampDefaults(child, settings)
  for (const floating of topic.detachedChildren ?? []) walkStampDefaults(floating, settings)
}

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
