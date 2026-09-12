/**
 * 布局入口：按结构类型分派到对应的算法。
 * 未识别的结构统一降级为思维导图，保证任何文件都能正常打开。
 *
 * 画布级元素（关系线/边界/概要）不在树里，但依赖节点的最终坐标，
 * 所以在结构算法跑完、坐标归一化之后统一补上。
 */
import type { Sheet, Topic } from '../model/types'
import { getStructureDef } from '../xmind/constants'
import { LAYOUT_DEFAULTS, LayoutBuilder } from './core'
import { addOverlays } from './overlays'
import { layoutBrace, layoutLogic, layoutMindmap, layoutSpreadsheet, layoutTree } from './stack'
import { layoutOrgChart } from './orgchart'
import { layoutFishbone, layoutMatrix, layoutRadial } from './graphic'
import { layoutTimelineHorizontal, layoutTimelineVertical } from './timeline'
import type { LayoutOptions, LayoutResult, MeasureFn } from './types'

export * from './types'
export { LAYOUT_DEFAULTS } from './core'
export {
  buildRange,
  indexTree,
  parseRange,
  readCurveOffset,
  resolveRange,
  sameRange,
  withCurveOffset
} from './overlays'

export function layoutSheet(
  rootTopic: Topic,
  measure: MeasureFn,
  options: LayoutOptions = {},
  sheet?: Sheet
): LayoutResult {
  const builder = new LayoutBuilder(
    measure,
    options.gapX ?? LAYOUT_DEFAULTS.gapX,
    options.gapY ?? LAYOUT_DEFAULTS.gapY,
    options.padding ?? LAYOUT_DEFAULTS.padding
  )
  builder.measureAll(rootTopic)

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
      result = layoutOrgChart(rootTopic, builder, cls === 'org.xmind.ui.org-chart.up' ? 'up' : 'down')
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
        cls === 'org.xmind.ui.map.clockwise' ? layoutRadial(rootTopic, builder) : layoutMindmap(rootTopic, builder)
      break
    default:
      result = layoutMindmap(rootTopic, builder)
      break
  }

  if (sheet) addOverlays(result, rootTopic, sheet)
  return result
}
