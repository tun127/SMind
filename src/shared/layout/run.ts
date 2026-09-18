/**
 * 摆放 → 归一化 → 补画布级元素 的完整流程。
 *
 * 单独一个文件是为了让**全量布局**（`layoutSheet`）与**增量布局**
 * （`layoutSheetCached`）共用同一段代码：两者的差别只在「builder 里带不带缓存」，
 * 流程本身必须一模一样，否则增量的结果就不可能等于全量。
 */
import type { Sheet, Topic } from '../model/types'
import { getStructureDef } from '../xmind/constants'
import type { LayoutBuilder } from './core'
import { addOverlays, overlayReserves, type OverlayReserves } from './overlays'
import { layoutBrace, layoutLogic, layoutMindmap, layoutSpreadsheet, layoutTree } from './stack'
import { layoutOrgChart } from './orgchart'
import { layoutFishbone, layoutMatrix, layoutRadial } from './graphic'
import { layoutTimelineHorizontal, layoutTimelineVertical } from './timeline'
import type { LayoutResult } from './types'

export function runLayout(
  builder: LayoutBuilder,
  rootTopic: Topic,
  sheet: Sheet | undefined,
  reserves?: OverlayReserves
): LayoutResult {
  builder.measureAll(rootTopic)
  /**
   * 边界/概要在区间外侧占用的空间，先交给布局
   * （否则标题带与括号会压住紧邻的分支）。
   */
  if (sheet) builder.applyOverlayReserves(reserves ?? overlayReserves(rootTopic, sheet))

  const cls = rootTopic.structureClass
  const family = getStructureDef(cls).family

  let result: LayoutResult
  switch (family) {
    case 'logic':
      result = layoutLogic(rootTopic, builder, cls === 'org.xmind.ui.logic.left' ? -1 : 1)
      break
    case 'tree':
      result = layoutTree(rootTopic, builder, cls === 'org.xmind.ui.tree.left' ? -1 : 1)
      break
    case 'orgchart':
      result = layoutOrgChart(
        rootTopic,
        builder,
        cls === 'org.xmind.ui.org-chart.up' ? 'up' : 'down'
      )
      break
    case 'timeline':
      result =
        cls === 'org.xmind.ui.timeline.vertical'
          ? layoutTimelineVertical(rootTopic, builder)
          : layoutTimelineHorizontal(rootTopic, builder)
      break
    case 'brace':
      result = layoutBrace(rootTopic, builder)
      break
    case 'fishbone':
      result = layoutFishbone(rootTopic, builder)
      break
    case 'spreadsheet':
      result = layoutSpreadsheet(rootTopic, builder)
      break
    case 'matrix':
      result = layoutMatrix(rootTopic, builder)
      break
    case 'mindmap':
      result =
        cls === 'org.xmind.ui.map.clockwise'
          ? layoutRadial(rootTopic, builder)
          : layoutMindmap(rootTopic, builder)
      break
    default:
      result = layoutMindmap(rootTopic, builder)
      break
  }

  if (sheet) addOverlays(result, rootTopic, sheet)
  return result
}
