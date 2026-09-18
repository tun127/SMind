/**
 * 鱼骨图。
 *
 * 主脊＝一条水平直线（鱼头在末端）；一级主题＝大骨，斜向分列主脊上下；
 * 第二层＝小骨，从大骨引出、水平且与主脊平行；更深层级在小骨上向右延伸。
 */
import type { Topic } from '../../model/types'
import { childFoldSides } from '../../model/tree'
import { addDecoration, addEdge, anchorPoint, round, type LayoutBuilder, type Point } from '../core'
import type { LayoutResult, NodeLayout } from '../types'
import { spanX, spanY } from './span'

/* ------------------------------------------------------------------ */
/* 鱼骨图                                                              */
/* ------------------------------------------------------------------ */

/**
 * 沿水平方向向右堆叠（小骨上更深的层级）：同一层的兄弟在父节点右侧上下排开。
 *
 * 参考：「第三层及更深：继续在小骨上叠加短横线向右延伸」。
 * 不能顺着主脊方向往上/下堆——那会和相邻小骨分到的区域撞在一起。
 */
function placeRightColumn(
  builder: LayoutBuilder,
  topic: Topic,
  x: number,
  y: number,
  depth: number
): void {
  const size = builder.size(topic.id)
  let cursor = y
  for (const child of builder.visibleChildren(topic)) {
    const childSize = builder.size(child.id)
    const childX = x + size.width + builder.gapX
    // 边界标题带在这一格上方 → 先让出高度再摆
    cursor += builder.reserveTop(child)
    builder.add(child, childX, cursor, depth + 1, 'right')
    placeRightColumn(builder, child, childX, cursor, depth + 1)
    cursor += childSize.height + builder.reserveBottom(child) + builder.gapY
  }
}

/** 向右延伸的列一共占多宽（小骨上更深的层级沿它排开） */
function rightColumnWidth(builder: LayoutBuilder, topic: Topic): number {
  let widest = 0
  for (const child of builder.visibleChildren(topic)) {
    widest = Math.max(
      widest,
      builder.gapX + spanX(builder, child) + rightColumnWidth(builder, child)
    )
  }
  return widest
}

/**
 * 鱼骨图。
 *
 * 参考长相（Xmind）：
 * - 主脊＝一条**水平**直线，鱼头在末端；
 * - 一级主题＝「大骨」，**斜向**分列主脊上下；
 * - 第二层＝「小骨」，从大骨引出，**水平短线、与主脊平行**；
 * - 第三层及更深：继续在小骨上叠加短横线，**向右延伸**。
 *
 * 小骨挂在**靠主脊的一侧**，并留一点间隙：大骨从主脊斜着上来，
 * 贴着挂会正好擦到小骨的角（自检的"穿框"当场抓到过）。
 */
export function layoutFishbone(root: Topic, builder: LayoutBuilder): LayoutResult {
  const rootSize = builder.size(root.id)
  const rootNode = builder.add(root, 0, -rootSize.height / 2, 0, 'root')
  const spineCenterY = rootNode.y + rootNode.height / 2

  const kids = builder.visibleChildren(root)
  /**
   * 大骨的竖向跨度必须装得下所有小骨：小骨沿大骨按比例取点排开，
   * 相邻两根的间距 = 跨度 ÷（小骨数 + 1），要求它 ≥ 小骨高 + 行距。
   */
  const maxRibKids = Math.max(0, ...kids.map((child) => builder.visibleChildren(child).length))
  /** 小骨这一格**实际**占的高（含边界预留）：沿大骨取点时的最小间距由它决定 */
  const ribKidHeight = Math.max(
    0,
    ...kids.flatMap((child) => builder.visibleChildren(child).map((kid) => spanY(builder, kid)))
  )
  const ribSpan = maxRibKids > 1 ? (maxRibKids + 1) * (ribKidHeight + builder.gapY) : 0
  /** 大骨在主脊的哪一侧：取 `childFoldSides`（唯一来源），与折叠无关 */
  const sides = childFoldSides(root)
  /** 大骨在 `side` 那一侧、离主脊半高最远需要多少（**只算靠主脊那一侧的留白**） */
  const boneReach = (side: -1 | 1): number => {
    let reach = rootSize.height / 2
    for (const child of kids) {
      if ((sides.get(child.id) === 'up' ? -1 : 1) !== side) continue
      reach = Math.max(
        reach,
        builder.size(child.id).height / 2 +
          (side < 0 ? builder.reserveBottom(child) : builder.reserveTop(child))
      )
    }
    return reach
  }
  /**
   * 大骨的上下偏移。
   *
   * 除了「装得下小骨」（`ribSpan`），还要装得下**边界**：边框与标题带画在大骨外侧，
   * 靠近主脊的那一侧若不让位，边框就会压到主脊上（远离主脊的一侧是往外长，不用管）。
   */
  const boneOffset = Math.max(
    46,
    ribSpan,
    boneReach(-1) + builder.gapY * 3,
    boneReach(1) + builder.gapY * 3
  )
  // 骨刺斜度：让骨刺看起来是斜的，而不是垂直的
  const boneSlant = Math.round(boneOffset * 0.45)
  /** 小骨长度（大骨上的取点 → 子主题左缘） */
  const ribGap = Math.max(16, Math.round(builder.gapX * 0.3))

  const anchors: Array<{ id: string; side: -1 | 1 }> = []
  /** 小骨：记下"哪根大骨的第几段"，最终坐标到 finish 之后再算 */
  const ribs: Array<{ branchId: string; childId: string; side: -1 | 1; t: number }> = []
  let cursor = rootNode.x + rootNode.width + builder.gapX * 2

  kids.forEach((child) => {
    // 大骨占的宽度要含概要在它右侧留出的括号位
    const extent = builder.horizontalExtent(child) + builder.reserveSpanX(child)
    const size = builder.size(child.id)
    const nodeCenterX = cursor + boneSlant + extent / 2
    const anchorX = nodeCenterX - boneSlant
    const side: -1 | 1 = sides.get(child.id) === 'up' ? -1 : 1
    const childY = side < 0 ? spineCenterY - boneOffset - size.height : spineCenterY + boneOffset

    builder.add(child, nodeCenterX - size.width / 2, childY, 1, side < 0 ? 'up' : 'down')

    // 小骨：沿大骨（主脊上的锚点 → 这一支的近侧边缘）按比例取点
    const nearY = side < 0 ? childY + size.height : childY
    const ribKids = builder.visibleChildren(child)
    /**
     * 这一根大骨上所有小骨的**取点**（先全算出来，再决定子主题那一列放哪）。
     *
     * 为什么不能像以前那样"每根小骨各自往右挪一点点就放下子主题"：那样同一根大骨下的
     * 子主题会沿着斜线**错开成阶梯**（实测：第一个在 x=373、第二个在 x=398），
     * 小骨只剩 17px 长、几乎看不见，看着像"几个框斜着飘在骨头旁边"——
     * 用户报的"鱼骨子节点也有问题"就是这个。
     *
     * 官方的要求是「小要因标在**鱼骨分支**上」（《鱼骨图教学｜定位问题根因》2021-06-15），
     * 所以小骨要**看得见**：取最靠右的那个取点作为公共列，子主题**对齐成一列**，
     * 每根小骨从自己的取点水平连到这一列——长短不一，但都是清清楚楚的水平线。
     */
    const ribPoints = ribKids.map((_kid, ribIndex) => {
      const t = (ribIndex + 1) / (ribKids.length + 1)
      return {
        t,
        x: anchorX + (nodeCenterX - anchorX) * t,
        y: spineCenterY + (nearY - spineCenterY) * t
      }
    })
    const columnX = ribKids.length > 0 ? Math.max(...ribPoints.map((point) => point.x)) + ribGap : 0

    ribKids.forEach((kid, ribIndex) => {
      const point = ribPoints[ribIndex]
      if (!point) return
      const kidSize = builder.size(kid.id)
      /**
       * 子主题**以取点的高度为中心**、x 对齐到公共列：小骨因此是**水平**的
       * （与主脊平行），完全符合"小骨"的形状。
       */
      const kidY = point.y - kidSize.height / 2
      builder.add(kid, columnX, kidY, 2, side < 0 ? 'up' : 'down')
      placeRightColumn(builder, kid, columnX, kidY, 2)
      ribs.push({ branchId: child.id, childId: kid.id, side, t: point.t })
    })

    anchors.push({ id: child.id, side })
    /**
     * 推进量：一根大骨占的宽度 = 锚点 → 子主题那一列的右边缘（含小骨子树向右延伸的宽度）。
     * 不算进来就会顶到隔壁大骨的地盘（自检的"节点重叠"当场抓到过：深4 ⨯ 短二2）。
     */
    const ribFootprint = ribKids.reduce(
      (widest, kid) => Math.max(widest, spanX(builder, kid) + rightColumnWidth(builder, kid)),
      0
    )
    const ownFootprint = ribKids.length > 0 ? columnX - anchorX + ribFootprint : boneSlant + ribGap
    cursor += Math.max(extent, ownFootprint) + builder.gapX
  })

  const result = builder.finish(root)
  const rootFinal = result.nodeMap.get(root.id)!
  const spineY = round(rootFinal.y + rootFinal.height / 2)

  /**
   * 主脊。
   *
   * **没有可见分支时整条不画**：折叠之后（整体折叠，或收起全部方向）
   * 主脊仍会从中心主题往右画一截 120px 的兜底短线——一条什么也没挂着的孤线，
   * 看着就是「凭空多了一根线」（用户截图）。鱼骨没有分支时，图里只该剩中心主题。
   */
  if (anchors.length > 0) {
    const lastBranchNode = result.nodeMap.get(anchors[anchors.length - 1]!.id)
    const spineEnd = lastBranchNode
      ? round(lastBranchNode.x + lastBranchNode.width / 2 - boneSlant + 60)
      : round(rootFinal.x + rootFinal.width + 120)
    addDecoration(result, {
      d: `M ${round(rootFinal.x + rootFinal.width)} ${spineY} L ${spineEnd} ${spineY}`,
      widthScale: 1.3
    })
  }

  /**
   * 大骨：从主脊斜向连到一级主题。
   *
   * **必须用最终坐标算**：早先这里把归一化之前的 x 和归一化之后的 y 混着用，
   * 大骨的方向被拉歪、于是从子主题身上压过去（自检的"穿框"当场抓到）。
   */
  const boneOf = (branch: NodeLayout, side: -1 | 1): { start: Point; end: Point } => {
    const centerX = round(branch.x + branch.width / 2)
    return {
      start: { x: round(centerX - boneSlant), y: spineY },
      end: { x: centerX, y: side < 0 ? round(branch.y + branch.height) : branch.y }
    }
  }

  for (const anchor of anchors) {
    const childNode = result.nodeMap.get(anchor.id)
    if (!childNode) continue
    const bone = boneOf(childNode, anchor.side)
    addEdge(result, root.id, anchor.id, bone.start, bone.end, 'line')
  }

  // 小骨：从大骨上的取点**水平**拉到子主题左缘（与主脊平行）
  for (const rib of ribs) {
    const branch = result.nodeMap.get(rib.branchId)
    const kid = result.nodeMap.get(rib.childId)
    if (!branch || !kid) continue
    const bone = boneOf(branch, rib.side)
    addEdge(
      result,
      rib.branchId,
      rib.childId,
      {
        x: round(bone.start.x + (bone.end.x - bone.start.x) * rib.t),
        y: round(bone.start.y + (bone.end.y - bone.start.y) * rib.t)
      },
      { x: round(kid.x), y: round(kid.y + kid.height / 2) },
      'line'
    )
  }

  // 小骨上的更深层级：一条竖脊挂一排短横线（不能是"父下→子上"，否则会穿过上面的兄弟）
  const connect = (topic: Topic): void => {
    for (const child of builder.visibleChildren(topic)) {
      const parent = result.nodeMap.get(topic.id)
      const childNode = result.nodeMap.get(child.id)
      if (parent && childNode && parent.depth >= 2) {
        addEdge(
          result,
          parent.id,
          childNode.id,
          anchorPoint(parent, 'bottom'),
          anchorPoint(childNode, 'top'),
          'spine'
        )
      }
      connect(child)
    }
  }
  for (const child of kids) connect(child)

  return result
}
