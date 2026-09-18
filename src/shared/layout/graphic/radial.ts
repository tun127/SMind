/**
 * 放射状（顺时针）思维导图：以中心为圆心均分扇区，逐层向外扩展；
 * 每层半径按「该层最宽节点所需的弧长」外扩，避免同环节点重叠。
 */
import type { Topic } from '../../model/types'
import { RADIAL_START_ANGLE } from '../../model/tree'
import { addEdge, round, type LayoutBuilder, type Point } from '../core'
import type { LayoutResult, NodeLayout } from '../types'
import { spanX, spanY } from './span'

/* ------------------------------------------------------------------ */
/* 放射状（顺时针）思维导图                                            */
/* ------------------------------------------------------------------ */

/**
 * 从节点中心指向目标的射线，与**节点边框**的交点。
 *
 * 连线必须从边框出发：用中心点的话，线会先从自己的框里穿出来（穿过文字），
 * 再插进对方的框里——用户看到的"直线穿过框"就是这么来的。
 */
function borderToward(node: NodeLayout, target: NodeLayout): Point {
  const cx = node.x + node.width / 2
  const cy = node.y + node.height / 2
  const dx = target.x + target.width / 2 - cx
  const dy = target.y + target.height / 2 - cy
  if (dx === 0 && dy === 0) return { x: round(cx), y: round(cy) }
  const scale = Math.min(
    dx !== 0 ? node.width / 2 / Math.abs(dx) : Number.POSITIVE_INFINITY,
    dy !== 0 ? node.height / 2 / Math.abs(dy) : Number.POSITIVE_INFINITY
  )
  return { x: round(cx + dx * scale), y: round(cy + dy * scale) }
}

/**
 * 以中心为圆心把一级分支均分到各个方向，逐层向外扩展。
 * 每层的半径会按「该层最宽节点所需的弧长」自动外扩，避免同环节点重叠。
 */
export function layoutRadial(root: Topic, builder: LayoutBuilder): LayoutResult {
  const rootSize = builder.size(root.id)
  const rootNode = builder.add(root, -rootSize.width / 2, -rootSize.height / 2, 0, 'root')
  const kids = builder.visibleChildren(root)

  /** 每一层节点的最大"实际占位"（含边界/概要留白），用于决定环间距与扇区半径 */
  const maxSizeByDepth: number[] = []
  const scan = (topic: Topic, depth: number): void => {
    const reach = Math.max(spanX(builder, topic), spanY(builder, topic))
    maxSizeByDepth[depth] = Math.max(maxSizeByDepth[depth] ?? 0, reach)
    for (const child of builder.visibleChildren(topic)) scan(child, depth + 1)
  }
  scan(root, 0)

  /**
   * 环间距。
   * 轴对齐矩形在半径方向上互不重叠，需要中心距 d 满足
   * d·|cosθ| ≥ w 或 d·|sinθ| ≥ h；最坏情况（45°）下 d ≥ √2·max(w,h)，
   * 这里取 1.5 倍留安全余量。
   */
  const ringStep = (depth: number): number => {
    const current = maxSizeByDepth[depth] ?? 40
    const next = maxSizeByDepth[depth + 1] ?? current
    return 1.5 * Math.max(current, next) + builder.gapY * 2
  }

  /** 同一环上相邻节点不重叠所需的最小半径：弦长 2r·sin(Δ/2) 需大于 1.5·maxSize */
  const radiusForSector = (sub: number, size: number): number =>
    (1.5 * size) / (2 * Math.max(Math.sin(Math.min(sub, Math.PI) / 2), 1e-4))

  const centerX = rootNode.x + rootNode.width / 2
  const centerY = rootNode.y + rootNode.height / 2
  /**
   * 扇区按**全部**一级分支算（`childFoldSides` 的「左右半圈」判定用的是同一份角度），
   * 只摆放当前可见的那些。
   *
   * 为什么不用可见数量：收起左侧之后，剩下的一支若按新数量重新均分整圈，
   * 会被铺到左边去——用户看到的还是"左右都有"，像没收起来一样。
   */
  const allKids = root.children
  const count = allKids.length
  /**
   * 每个一级分支分到的扇区角度。
   *
   * 只有一个分支时**不能**给整圈（2π）：那一支的子节点会被摊到 180° 以上、
   * 跑到中心主题的**另一侧**（实测「一个分支 + 两个子节点」画成左一个右一个，
   * 连线还横穿中心主题）。没有别的分支可避让时，给一个直角扇区就够。
   */
  const sector = count > 1 ? (Math.PI * 2) / count : Math.PI / 2

  let baseRadius = 220
  if (count > 1) {
    let maxSize = 0
    for (const kid of kids) {
      maxSize = Math.max(maxSize, Math.max(spanX(builder, kid), spanY(builder, kid)))
    }
    baseRadius = Math.max(baseRadius, radiusForSector(sector, maxSize))
  }

  /**
   * 第一遍：只算**角度与扇区**（跟半径无关），并记下每层"最多需要多大半径"。
   *
   * 为什么要分两遍：半径必须**逐层统一**。早先是每个节点各自按自己的扇区撑开半径，
   * 结果同一层的兄弟半径差出好几百（实测 513 / 726 / 965），画出来就是
   * "每个分支射出一根长短不一的长线"——用户说的"随便穿线"。
   */
  interface RingPlan {
    topic: Topic
    angle: number
    sector: number
    depth: number
  }
  const plans: RingPlan[] = []
  const collect = (topic: Topic, angle: number, sectorWidth: number, depth: number): void => {
    plans.push({ topic, angle, sector: sectorWidth, depth })
    const childList = builder.visibleChildren(topic)
    if (childList.length === 0) return
    /**
     * 子节点的扇区**收窄**到最多 90°。
     *
     * 一级分支自己占的扇区是「整圈 ÷ 分支数」：只有两个分支时每个分支有 180°，
     * 直接把子节点摊到 180° 以上——那不像顺时针图（Xmind 里同一分支的子节点
     * 是**贴着分支方向**挤在一起的），连线也会拉成横穿画面的长斜线。
     */
    const fan = Math.min(sectorWidth, Math.PI / 2)
    const sub = fan / childList.length
    const firstAngle = angle - fan / 2 + sub / 2
    childList.forEach((child, index) => {
      collect(child, firstAngle + sub * index, sub, depth + 1)
    })
  }
  /**
   * 起点角度与「左右半圈」判定**共用同一个常量**（`RADIAL_START_ANGLE`）：
   * 两边各写一份的话，收起一侧后剩下的分支会被判到另一侧去。
   *
   * 官方只规定了"顺时针"这个方向（《如何在 Xmind 中结合不同的结构以及为什么》把顺时针
   * 列为思维导图的一个方向），起点的具体角度属于**我方取值**（见 `docs/structure-spec.md`）。
   * 从正上方（−90°）起铺时，两个一级分支会落在正上／正下，画出来是"一上一下"的
   * 纵向排布，读不出"顺时针"；从右上起，两个分支落在右上与左下，方向感才对。
   */
  const visibleIds = new Set(kids.map((kid) => kid.id))
  allKids.forEach((kid, index) => {
    if (!visibleIds.has(kid.id)) return
    collect(kid, RADIAL_START_ANGLE + sector * index, sector, 1)
  })

  // 第二遍：逐层定半径——本层取该层所有节点的最大需求，同层同半径
  const needByDepth: number[] = []
  for (const plan of plans) {
    // 实际占位（含边界/概要留白）：否则紧邻的那一环会被括号压住
    const reach = Math.max(spanX(builder, plan.topic), spanY(builder, plan.topic))
    const need = radiusForSector(plan.sector, reach)
    needByDepth[plan.depth] = Math.max(needByDepth[plan.depth] ?? 0, need)
  }
  const maxDepth = plans.reduce((deepest, plan) => Math.max(deepest, plan.depth), 1)
  const radiusByDepth: number[] = [0]
  radiusByDepth[1] = Math.max(baseRadius, needByDepth[1] ?? 0)
  for (let depth = 2; depth <= maxDepth; depth += 1) {
    radiusByDepth[depth] = Math.max(
      (radiusByDepth[depth - 1] ?? 0) + ringStep(depth - 1),
      needByDepth[depth] ?? 0
    )
  }

  for (const plan of plans) {
    const size = builder.size(plan.topic.id)
    const radius = radiusByDepth[plan.depth] ?? 0
    builder.add(
      plan.topic,
      centerX + Math.cos(plan.angle) * radius - size.width / 2,
      centerY + Math.sin(plan.angle) * radius - size.height / 2,
      plan.depth,
      Math.cos(plan.angle) < 0 ? 'left' : 'right'
    )
  }

  const result = builder.finish(root)
  /**
   * 连线**从边框连到边框**。
   *
   * 早先这里是「中心到中心」：线必然从自己的框里穿出来、又插进对方的框里，
   * 节点越大越明显——用户看到的就是"直线穿过框、直接穿过文字"。
   */
  const connect = (topic: Topic): void => {
    const parent = result.nodeMap.get(topic.id)
    if (!parent) return
    for (const child of builder.visibleChildren(topic)) {
      const childNode = result.nodeMap.get(child.id)
      if (childNode) {
        addEdge(
          result,
          parent.id,
          childNode.id,
          borderToward(parent, childNode),
          borderToward(childNode, parent),
          'line'
        )
      }
      connect(child)
    }
  }
  connect(root)

  return result
}
