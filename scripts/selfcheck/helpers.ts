/**
 * 自检的**共享测试助手**（由 scripts/selfcheck.ts 按行范围搬出，行为零变化）。
 *
 * 这里放"各域都要用"的东西：编辑器 store 的取用（store/root/sheet/find）、
 * 重置与建节点（reset/addChildOf/addSiblingOf）、布局与连线的检查工具、
 * 各种样例构造器（buildFeatureRichWorkbook / buildSweepTopic / buildExportScene…）、
 * 以及 fixture 常量（LEGACY_XML / DOC_A / DOC_B / VER2_DOC）。
 *
 * 为什么要独立：按域拆出的 `selfcheck/*.ts` **不能从入口 import**（入口要调用域函数，
 * 会形成循环导入），所以共用助手必须待在比域更底层的模块里。
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
import { themeColorsOf, useEditor } from '../../src/renderer/src/store/editor'

import { activeRoot, activeSheet, findTopic } from '../../src/shared/model/tree'
import { createTopic, createWorkbook } from '../../src/shared/model/factory'

import { type SnapshotItem } from '../../src/shared/snapshot'
import { layoutSheet } from '../../src/shared/layout'

import { MARKER_STRIP_GAP, markerStripSize, imageBoxSize } from '../../src/shared/layout/accessory'

import type { LayoutResult, MeasureResult, NodeLayout } from '../../src/shared/layout/types'
import type { Topic, Workbook } from '../../src/shared/model/types'

/* ---- D1 拆分：断言原语搬进 ./selfcheck/harness.ts，按域拆分的其它文件共用它 ---- */

export const store = (): ReturnType<typeof useEditor.getState> => useEditor.getState()

export const root = (): Topic => activeRoot(store().workbook)

export const sheet = (): ReturnType<typeof activeSheet> => activeSheet(store().workbook)

export const find = (id: string): Topic | null => findTopic(root(), id)

export function reset(): void {
  store().newDocument()
}

/** 新建子主题并写入标题 */

export function addChildOf(parentId: string, title: string): string {
  const id = store().addChild(parentId)
  if (!id) throw new Error('addChild 返回空 id')
  store().updateEditingText(title)
  store().commitEdit(id)
  return id
}

/** 新建同级主题并写入标题 */

export function addSiblingOf(siblingId: string, title: string): string {
  const id = store().addSibling(siblingId)
  if (!id) throw new Error('addSibling 返回空 id')
  store().updateEditingText(title)
  store().commitEdit(id)
  return id
}

export function base64UrlBytesOf(text: string): Uint8Array | null {
  try {
    const normalized = text.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const binary = atob(padded)
    const out = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index)
    return out
  } catch {
    return null
  }
}

export const multilineMeasure = (topic: Topic, depth: number): MeasureResult => {
  const base = fakeMeasure(topic, depth)
  const maxTextWidth = depth === 0 ? 320 : 240
  const textWidth = 90 + topic.title.length * 9
  const lines = Math.max(1, Math.ceil(textWidth / maxTextWidth))
  return {
    ...base,
    width: Math.max(Math.min(textWidth, maxTextWidth) + base.paddingX * 2, 76),
    height: (depth === 0 ? 44 : 30) + (lines - 1) * base.lineHeight
  }
}

/** 两个节点盒是否相交（各收缩 1px 容忍取整误差） */

export function boxesOverlap(a: NodeLayout, b: NodeLayout): boolean {
  return (
    a.x + 1 < b.x + b.width &&
    b.x + 1 < a.x + a.width &&
    a.y + 1 < b.y + b.height &&
    b.y + 1 < a.y + a.height
  )
}

/** 全树两两检查节点盒，返回第一对相交的节点（无则 null） */

export function firstOverlap(layout: LayoutResult): [string, string] | null {
  for (let i = 0; i < layout.nodes.length; i += 1) {
    for (let j = i + 1; j < layout.nodes.length; j += 1) {
      if (boxesOverlap(layout.nodes[i], layout.nodes[j])) {
        return [
          `${layout.nodes[i].topic.title}(${Math.round(layout.nodes[i].x)},${Math.round(layout.nodes[i].y)})`,
          `${layout.nodes[j].topic.title}(${Math.round(layout.nodes[j].x)},${Math.round(layout.nodes[j].y)})`
        ]
      }
    }
  }
  return null
}

export function pathSegments(d: string): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = []
  const tokens = d.match(/[MLHVmlhv][^MLHVmlhv]*/g) ?? []
  let cx = 0
  let cy = 0
  for (const token of tokens) {
    const cmd = token[0]
    const nums = (token.slice(1).match(/-?\d+(\.\d+)?/g) ?? []).map(Number)
    if (cmd === 'M' || cmd === 'L') {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        const x = nums[i]!
        const y = nums[i + 1]!
        if (cmd === 'L') out.push([cx, cy, x, y])
        cx = x
        cy = y
      }
    } else if (cmd === 'H') {
      for (const x of nums) {
        out.push([cx, cy, x, cy])
        cx = x
      }
    } else if (cmd === 'V') {
      for (const y of nums) {
        out.push([cx, cy, cx, y])
        cy = y
      }
    }
  }
  return out
}

/**
 * 线段是否伸进了节点盒内部（贴边不算）。
 *
 * 用**线段-矩形求交**（Liang-Barsky），不能只比包围盒：
 * 鱼骨图的大骨/小骨是**斜线**，包围盒与盒子相交并不代表线段真的穿过去——
 * 早先按包围盒判，斜线一律被误报成"穿框"，把排查带偏过。
 */

export function segmentHitsBox(seg: [number, number, number, number], box: NodeLayout): boolean {
  const [x0, y0, x1, y1] = seg
  const dx = x1 - x0
  const dy = y1 - y0
  const pad = 1
  const xmin = box.x + pad
  const xmax = box.x + box.width - pad
  const ymin = box.y + pad
  const ymax = box.y + box.height - pad
  if (xmax <= xmin || ymax <= ymin) return false

  let t0 = 0
  let t1 = 1
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-9) return q >= 0
    const r = q / p
    if (p < 0) {
      if (r > t1) return false
      if (r > t0) t0 = r
    } else {
      if (r < t0) return false
      if (r < t1) t1 = r
    }
    return true
  }
  if (!clip(-dx, x0 - xmin)) return false
  if (!clip(dx, xmax - x0)) return false
  if (!clip(-dy, y0 - ymin)) return false
  if (!clip(dy, ymax - y0)) return false
  return t1 - t0 > 1e-3
}

/** 连线穿过节点的所有情形（父子两端不算） */

export function crossingProblems(layout: LayoutResult): string[] {
  const out: string[] = []
  for (const edge of layout.edges) {
    for (const seg of pathSegments(edge.d)) {
      for (const node of layout.nodes) {
        if (node.id === edge.fromId || node.id === edge.toId) continue
        if (!segmentHitsBox(seg, node)) continue
        const from = layout.nodeMap.get(edge.fromId)?.topic.title || '(空)'
        const to = layout.nodeMap.get(edge.toId)?.topic.title || '(空)'
        const text = `「${from}」→「${to}」穿过「${node.topic.title || '(空)'}」`
        if (!out.includes(text)) out.push(text)
      }
    }
  }
  return out
}

/**
 * 连线的两端必须落在节点**边框**上，不许从框内部出发。
 *
 * 反例是放射状早期的画法：「中心到中心」——线从自己的框里穿出来、穿过文字，
 * 再插进对方的框里。用户报的"直线穿过框"就是它。
 */

export function endpointInsideProblems(layout: LayoutResult): string[] {
  const out: string[] = []
  for (const edge of layout.edges) {
    const segs = pathSegments(edge.d)
    const firstSeg = segs[0]
    const lastSeg = segs[segs.length - 1]
    if (!firstSeg || !lastSeg) continue
    const ends: Array<[number, number]> = [
      [firstSeg[0], firstSeg[1]],
      [lastSeg[2], lastSeg[3]]
    ]
    for (const node of layout.nodes) {
      if (node.id !== edge.fromId && node.id !== edge.toId) continue
      const inside = ends.some(
        ([x, y]) =>
          x > node.x + 4 &&
          x < node.x + node.width - 4 &&
          y > node.y + 4 &&
          y < node.y + node.height - 4
      )
      if (inside) out.push(`「${node.topic.title || '(空)'}」的连线从框内部出发`)
    }
  }
  return out
}

/** 两条线段是否真的相交（端点相接不算，平行也不算） */

export function segmentsCross(
  a: [number, number, number, number],
  b: [number, number, number, number]
): boolean {
  const d1x = a[2] - a[0]
  const d1y = a[3] - a[1]
  const d2x = b[2] - b[0]
  const d2y = b[3] - b[1]
  const den = d1x * d2y - d1y * d2x
  if (Math.abs(den) < 1e-6) return false
  const t = ((b[0] - a[0]) * d2y - (b[1] - a[1]) * d2x) / den
  const u = ((b[0] - a[0]) * d1y - (b[1] - a[1]) * d1x) / den
  /**
   * 容差取 2%：小骨起点**落在大骨中段**（是"接上去"，不是"穿过去"），
   * 坐标经过取整之后 t 会有千分之几的误差，太小会把接头误判成交叉。
   */
  const eps = 0.02
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps
}

/**
 * 连线**互相**穿过：用户说的「随便穿线」。
 *
 * 只查"线穿节点"是不够的——放射状（顺时针）那种长斜线可以一根节点都不碰，
 * 却横七竖八地互相交叉，看起来就是乱画。同一个父节点发出的线、指向同一个子节点的线不算。
 */

export function lineCrossingProblems(layout: LayoutResult): string[] {
  const out: string[] = []
  for (let i = 0; i < layout.edges.length; i += 1) {
    for (let j = i + 1; j < layout.edges.length; j += 1) {
      const first = layout.edges[i]
      const second = layout.edges[j]
      if (!first || !second) continue
      if (first.fromId === second.fromId || first.toId === second.toId) continue
      /**
       * 两条线在**端点处相接**不算交叉——小骨挂在大骨上、父子共用锚点，
       * 这类"接上"是正确画法（数值上会有零点几像素的偏差，所以留 2px 容差）。
       */
      const endsOf = (edge: (typeof layout.edges)[number]): Array<[number, number]> => {
        const segs = pathSegments(edge.d)
        const firstSeg = segs[0]
        const lastSeg = segs[segs.length - 1]
        if (!firstSeg || !lastSeg) return []
        return [
          [firstSeg[0], firstSeg[1]],
          [lastSeg[2], lastSeg[3]]
        ]
      }
      const touching = endsOf(first).some((a) =>
        endsOf(second).some((b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 2)
      )
      if (touching) continue
      let crossed = false
      for (const a of pathSegments(first.d)) {
        for (const b of pathSegments(second.d)) {
          if (segmentsCross(a, b)) crossed = true
        }
      }
      if (!crossed) continue
      const f1 = layout.nodeMap.get(first.fromId)?.topic.title || '(空)'
      const t1 = layout.nodeMap.get(first.toId)?.topic.title || '(空)'
      const f2 = layout.nodeMap.get(second.fromId)?.topic.title || '(空)'
      const t2 = layout.nodeMap.get(second.toId)?.topic.title || '(空)'
      out.push(`「${f1}」→「${t1}」⨯「${f2}」→「${t2}」`)
    }
  }
  return out
}

export interface SweepSpec {
  title: string
  children?: SweepSpec[]
  /** 模拟"手动拖过"：布局要认偏移，但不能因此压到别人或让连线穿框 */
  offset?: { x: number; y: number }
}

export function buildSweepTopic(spec: SweepSpec): Topic {
  const topic = createTopic(spec.title)
  if (spec.offset) topic.position = spec.offset
  topic.children = (spec.children ?? []).map(buildSweepTopic)
  return topic
}

/** 一条 len 层的链 */

export function sweepChain(prefix: string, len: number): SweepSpec {
  let node: SweepSpec = { title: `${prefix} 叶` }
  for (let i = len; i >= 1; i -= 1) node = { title: `${prefix}${i}`, children: [node] }
  return node
}

/**
 * 审计用的文档形态：一张导图能不能排对，取决于它的**形状**（宽 / 深 / 参差 / 空标题 /
 * 拖过），而不是标题内容。用户报的四种"错位"分别落在"一列兄弟"和"手动拖过"这两种形状上，
 * 所以这里把形状摊开：任何一个结构在任何一个形状下都不许重叠、不许穿框。
 */
export const STRUCTURE_SWEEP: Array<{ name: string; root: SweepSpec }> = [
  {
    name: '单个分支两个子',
    root: {
      title: '中心主题',
      children: [{ title: '分支主题 1', children: [{ title: '子一' }, { title: '子二' }] }]
    }
  },
  { name: '单链', root: { title: '中心主题', children: [sweepChain('分支', 2)] } },
  {
    // 用户截图那张形状：两个分支各带两个子节点（分支数 2 时每个分支的扇区/槽位最宽）
    name: '两分支各两子',
    root: {
      title: '中心主题',
      children: [1, 2].map((i) => ({
        title: `分支主题 ${i}`,
        children: [{ title: `${i} 甲` }, { title: `${i} 乙` }]
      }))
    }
  },
  {
    name: '宽浅（5 分支 × 2 子）',
    root: {
      title: '中心主题',
      children: Array.from({ length: 5 }, (_, i) => ({
        title: `分支 ${i + 1}`,
        children: [{ title: `要点 ${i + 1} 甲` }, { title: `要点 ${i + 1} 乙` }]
      }))
    }
  },
  {
    name: '深窄（6 层链 + 两个短分支）',
    root: {
      title: '中心主题',
      children: [
        sweepChain('深', 6),
        { title: '短一', children: [sweepChain('短一', 3)] },
        sweepChain('短二', 2)
      ]
    }
  },
  {
    name: '参差（深度 1 / 3 / 5）',
    root: {
      title: '中心主题',
      children: [
        { title: '浅分支', children: [{ title: '浅一' }] },
        sweepChain('中', 3),
        { title: '深分支', children: [sweepChain('深', 5)] }
      ]
    }
  },
  {
    name: '长标题（换行）',
    root: {
      title: '中心主题写得很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长',
      children: [
        {
          title: '分支标题也写得很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长',
          children: [
            { title: '子节点标题继续写得很长很长很长很长很长很长很长很长很长很长很长很长' },
            { title: '另一个同样很长的子节点标题用来撑高度撑宽度看看会不会压在一起' }
          ]
        }
      ]
    }
  },
  {
    name: '空标题',
    root: { title: '', children: [{ title: '', children: [{ title: '' }, { title: '' }] }] }
  },
  {
    name: '手动拖过（每个子节点都有偏移）',
    root: {
      title: '中心主题',
      children: [
        {
          title: '分支主题 1',
          children: [
            { title: '子一', offset: { x: -8, y: -30 } },
            { title: '子二', offset: { x: 12, y: 8 } }
          ]
        },
        {
          title: '分支主题 2',
          children: [
            { title: '子三', offset: { x: 40, y: 0 } },
            { title: '子四', offset: { x: 0, y: 46 } }
          ]
        }
      ]
    }
  }
]

/**
 * 覆盖层（边界/概要）侵入了**非成员**节点没有？
 *
 * 注意：边界本来就该把自己的成员框在里面，所以成员节点不算入侵；
 * 要防的是紧邻的**外部**分支被标题带 / 括号压住（文档里记的那条遗留）。
 */

export function overlayIntruder(
  layout: LayoutResult,
  members: Set<string>
): [string, string] | null {
  const hit = (a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  const outside = layout.nodes.filter((node) => !members.has(node.id))
  for (const boundary of layout.boundaries) {
    for (const node of outside) {
      if (hit(boundary, node)) {
        return [
          `边界「${boundary.title ?? ''}」(${Math.round(boundary.y)}..${Math.round(boundary.y + boundary.height)})`,
          `${node.topic.title}(${Math.round(node.y)}..${Math.round(node.y + node.height)})`
        ]
      }
    }
  }
  for (const summary of layout.summaries) {
    const size = summary.labelSize ?? { width: 0, height: 0 }
    const label = { x: summary.label.x, y: summary.label.y, width: size.width, height: size.height }
    for (const node of outside) {
      if (hit(label, node)) return [`概要「${summary.title ?? ''}」`, node.topic.title]
    }
  }
  return null
}

export function layoutDigest(layout: LayoutResult): string {
  const parts: string[] = []
  for (const node of layout.nodes) {
    parts.push(
      [
        'N',
        node.id,
        node.x,
        node.y,
        node.width,
        node.height,
        node.depth,
        node.side,
        node.lines.map((line) => line.segments.map((seg) => seg.text).join('')).join('/')
      ].join('|')
    )
  }
  for (const edge of layout.edges) parts.push(['E', edge.fromId, edge.toId, edge.d].join('|'))
  for (const deco of layout.decorations) {
    parts.push(
      ['D', deco.d, deco.widthScale ?? '', deco.branchId ?? '', deco.dashed ? 1 : 0].join('|')
    )
  }
  for (const boundary of layout.boundaries) {
    parts.push(
      ['B', boundary.id, boundary.x, boundary.y, boundary.width, boundary.height, boundary.d].join(
        '|'
      )
    )
  }
  for (const summary of layout.summaries) {
    parts.push(['S', summary.id, summary.d, summary.label.x, summary.label.y].join('|'))
  }
  for (const rel of layout.relationships) {
    parts.push(['R', rel.id, rel.d, rel.label.x, rel.label.y].join('|'))
  }
  parts.push(
    [
      'F',
      layout.bounds.width,
      layout.bounds.height,
      [...layout.branchIndex.entries()]
        .sort()
        .map(([key, value]) => `${key}:${value}`)
        .join(',')
    ].join('|')
  )
  return parts.join('\n')
}

/** 尺寸与标题无关的测量：用来单独验「只有文字变了」那条路径 */

export const fixedSizeMeasure = (topic: Topic, depth: number): MeasureResult => ({
  ...fakeMeasure(topic, depth),
  width: 130,
  height: 32
})

export const fakeMeasure = (topic: Topic, depth: number): MeasureResult => {
  const fontSize = depth === 0 ? 19 : 14
  const lineHeight = Math.round(fontSize * 1.5)

  const items = [
    ...(topic.notes ? [{ kind: 'notes' as const, width: 16 }] : []),
    ...(topic.href ? [{ kind: 'link' as const, width: 16 }] : []),
    ...(topic.attachments.length > 0 ? [{ kind: 'attachment' as const, width: 16 }] : []),
    ...(topic.formula ? [{ kind: 'formula' as const, width: 16 }] : [])
  ]

  const accessory = {
    items,
    height: items.length > 0 ? 21 : 0,
    width: items.length > 0 ? items.length * 16 + (items.length - 1) * 3 : 0
  }
  const labelRow = {
    items: topic.labels.map((text) => ({ text, width: 30 + text.length * 7 })),
    height: topic.labels.length > 0 ? 23 : 0,
    width: topic.labels.reduce((sum, text) => sum + 30 + text.length * 7, 0)
  }

  const markerIds = topic.markers.map((marker) => marker.markerId).filter((id) => id.length > 0)
  const markerStrip = markerStripSize(markerIds.length)
  const stripWidth = markerStrip.width > 0 ? markerStrip.width + MARKER_STRIP_GAP : 0

  // 手动拉伸的语义与 measure.ts 一致：宽度取给定值（有下限），高度只作下限；
  // 图片也按同一套边界等比缩放
  const override = topic.sizeOverride
  const paddingX = depth === 0 ? 24 : 14
  const paddingY = depth === 0 ? 15 : 9
  const imageBounds = override
    ? {
        width: Math.max(24, override.width - paddingX * 2 - stripWidth),
        height: Math.max(24, override.height - paddingY * 2 - 24)
      }
    : undefined
  const imageBox = imageBoxSize(topic.image, imageBounds)

  // 标记条挂在盒外，不占节点宽度
  const autoWidth = Math.max(90 + topic.title.length * 9, imageBox.width)
  const autoHeight = Math.max(
    (depth === 0 ? 44 : 30) + accessory.height + labelRow.height + imageBox.height,
    markerStrip.height + paddingY * 2
  )

  return {
    imageBox,
    width: override ? Math.max(override.width, stripWidth + paddingX * 2 + 40) : autoWidth,
    height: override ? Math.max(override.height, autoHeight) : autoHeight,
    lines: [
      {
        segments:
          topic.title.length > 0
            ? [{ text: topic.title, fontSize, weight: depth === 0 ? 700 : 500 }]
            : [],
        width: 90 + topic.title.length * 9,
        height: lineHeight,
        align: 'center'
      }
    ],
    fontSize,
    lineHeight,
    paddingX: depth === 0 ? 24 : 14,
    paddingY: depth === 0 ? 15 : 9,
    markerStrip: { markerIds, width: markerStrip.width, height: markerStrip.height },
    accessory,
    labelRow
  }
}

export function buildFeatureRichWorkbook(): Workbook {
  reset()
  const rootId = root().id
  store().setTitle(rootId, '总目标')
  const a = addChildOf(rootId, '第一分支')
  const b = addChildOf(rootId, '第二分支')
  const a1 = addChildOf(a, '子项 1')
  addChildOf(a, '子项 2')
  addChildOf(b, '另一个子项')
  addChildOf(b, '另一个子项二')
  store().toggleCollapse(b)
  store().offsetPosition(a1, 60, -30)

  store().mutate((draft) => {
    const topics = draft.sheets[0].rootTopic
    const findIn = (node: Topic, id: string): Topic | null => {
      if (node.id === id) return node
      for (const c of node.children) {
        const hit = findIn(c, id)
        if (hit) return hit
      }
      return null
    }
    const target = findIn(topics, a)!
    target.labels = ['核心', 'P1']
    target.markers = [{ markerId: 'priority-1' }, { markerId: 'task-done' }]
    target.notes = '这是备注\n第二行'
    target.notesHtml = '<p>这是备注</p>'
    target.href = 'https://example.com'
    target.titleRich = {
      paragraphs: [{ align: 'center', runs: [{ text: '第一分支', bold: true, color: '#ff0000' }] }]
    }
    // 手动拉伸的尺寸覆盖也要能往返（P7）
    target.sizeOverride = { width: 260, height: 96 }

    const rootTopic = draft.sheets[0].rootTopic
    rootTopic.style = { properties: { 'svg:fill': '#FF8A65', 'fo:color': '#FFFFFF' } }

    draft.sheets[0].relationships.push({ id: 'rel-1', end1Id: a, end2Id: b, title: '相关' })
    draft.sheets[0].boundaries.push({ id: 'bd-1', range: `(${a1},${b})`, title: '范围' })
    draft.sheets[0].summaries.push({
      id: 'sm-1',
      topicId: a1,
      range: `(${a1},${b})`,
      title: '概要'
    })
    draft.sheets[0].topicPositioning = 'fixed'

    // 第二个画布
    draft.sheets.push({
      id: 'sheet-2',
      title: '第二画布',
      rootTopic: {
        id: 'topic-2',
        title: '第二个根',
        children: [
          {
            id: 'topic-2-1',
            title: '二-1',
            children: [],
            detachedChildren: [],
            labels: [],
            markers: [],
            attachments: []
          }
        ],
        detachedChildren: [],
        labels: [],
        markers: [],
        attachments: []
      },
      relationships: [],
      boundaries: [],
      summaries: []
    })
  }, '构造测试数据')

  return store().workbook
}

export function buildStructureSample(): void {
  reset()
  const rootId = root().id
  const b1 = addChildOf(rootId, '分支一')
  const b2 = addChildOf(rootId, '分支二')
  const b3 = addChildOf(rootId, '分支三')
  addChildOf(b1, '一甲')
  addChildOf(b1, '一乙')
  const deep = addChildOf(b1, '一丙')
  addChildOf(deep, '一丙子')
  addChildOf(b2, '二甲')
  addChildOf(b2, '二乙')
  addChildOf(b3, '三甲')
  void deep
}

export function overlapReport(nodes: ReturnType<typeof layoutSheet>['nodes']): string[] {
  const overlaps: string[] = []
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]
      const b = nodes[j]
      const separated =
        a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y
      if (!separated) overlaps.push(`${a.topic.title} × ${b.topic.title}`)
    }
  }
  return overlaps
}

export const LEGACY_XML = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:svg="http://www.w3.org/2000/svg" version="2.0">
  <sheet id="sheet-1" theme="theme-1">
    <title>旧版画布</title>
    <topic id="root-1" structure-class="org.xmind.ui.logic.right" style-id="style-root">
      <title>中心 &amp; 主题</title>
      <notes>
        <plain>纯文本备注</plain>
        <html><![CDATA[<p>HTML 备注 <b>加粗</b></p>]]></html>
      </notes>
      <labels><label>标签A</label><label>标签B</label></labels>
      <marker-refs><marker-ref marker-id="priority-1"/><marker-ref marker-id="star-red"/></marker-refs>
      <href>https://example.com/legacy</href>
      <image src="xap:resources/pic.png" width="120" height="80"/>
      <attachments>
        <attachment id="att-1" path="xap:attachments/doc.pdf" name="doc.pdf" size="2048" mime="application/pdf"/>
      </attachments>
      <children>
        <topics type="attached">
          <topic id="child-1">
            <title>子主题</title>
            <branch>folded</branch>
            <children>
              <topics type="attached">
                <topic id="grand-1"><title>孙主题</title></topic>
              </topics>
            </children>
          </topic>
          <topic id="child-2">
            <title>带未知元素</title>
            <extensions><extension provider="org.example" content="不认识的扩展"/></extensions>
          </topic>
        </topics>
        <topics type="detached">
          <topic id="float-1">
            <title>浮动主题</title>
            <position svg:x="30" svg:y="-40"/>
          </topic>
        </topics>
      </children>
    </topic>
    <relationships>
      <relationship id="rel-1" end1="child-1" end2="child-2"><title>关联</title></relationship>
    </relationships>
    <summaries>
      <summary id="sum-1" topic-id="child-1" range="(child-1,child-2)"><title>阶段总结</title></summary>
    </summaries>
    <boundaries>
      <boundary id="bnd-1" range="(child-1,child-2)"><title>边界</title></boundary>
    </boundaries>
  </sheet>
</xmap-content>`

export function buildOutlineSample(): Workbook {
  const workbook = createWorkbook({ rootTitle: '产品规划', seedBranches: [] })
  const root = workbook.sheets[0].rootTopic
  const mk = (title: string): Topic => createTopic(title)
  const market = mk('市场分析')
  market.children = [mk('目标用户'), mk('竞品对比')]
  market.notes = '第一行\n第二行'
  const design = mk('产品设计')
  design.labels = ['重点']
  design.markers = [{ markerId: 'priority-1' }]
  design.href = 'https://example.com'
  design.collapsed = true
  design.children = [mk('信息架构')]
  const launch = mk('上线运营')
  launch.attachments = [{ id: 'att-1', path: 'resources/a.pdf', name: 'a.pdf' }]
  launch.image = { path: 'resources/b.png', width: 100, height: 60 }
  launch.formula = 'E = mc^2'
  market.children[0].children = [mk('画像')]
  root.children = [market, design, launch]
  root.detachedChildren = [mk('浮动想法')]
  return workbook
}

export function countSelfClosing(opml: string): number {
  return (opml.match(/<outline [^>]*\/>/g) ?? []).length
}

export function buildExportScene(): {
  layout: ReturnType<typeof layoutSheet>
  colors: ReturnType<typeof themeColorsOf>
} {
  reset()
  const rootId = root().id
  store().setTitle(rootId, '导出测试')

  const a = addChildOf(rootId, '带标记与标签')
  store().toggleMarker(a, 'priority-1')
  store().toggleMarker(a, 'task-quarter')
  store().addLabel(a, '标签甲')
  store().setNotes(a, '有备注')

  const b = addChildOf(rootId, '带图片与公式')
  store().setImage(b, { path: 'resources/pic.png', width: 120, height: 80 })
  store().setFormula(b, '\\frac{a}{b}')

  const c = addChildOf(b, '子主题')
  store().setTitle(c, '子主题 & <特殊>')

  store().select(a)
  store().toggleMarker(c, 'star-red')

  // 关系线需要按住 Ctrl 选中两个主题，这里直接调动作
  store().select(a)
  const sheetCurrent = sheet()
  void sheetCurrent

  const layout = layoutSheet(root(), fakeMeasure, {}, sheet())
  return { layout, colors: themeColorsOf(store().workbook) }
}

export const DOC_A = 'file:d:\\a.xmind'

export const DOC_B = 'file:d:\\b.xmind'

export function snap(over: Partial<SnapshotItem> & { id: string }): SnapshotItem {
  return {
    docKey: DOC_A,
    title: '甲',
    path: 'D:\\a.xmind',
    at: 1000,
    size: 2048,
    reason: 'auto',
    hash: `hash-${over.id}`,
    ...over
  }
}

export const VER2_DOC = {
  ver: 2,
  contents: [
    {
      id: 'sheet-1',
      title: '',
      type: 'mind',
      config: { template: 'right' },
      root: {
        id: 'r1',
        data: { text: 'Pandas进阶\n', richText: { ops: [{ insert: 'Pandas进阶\n' }] } },
        children: {
          normal: [
            {
              id: 'a1',
              data: { text: '文件读取\n', background: '#ffcc00' },
              children: { normal: [{ id: 'a11', data: { text: 'csv文件' } }] }
            },
            {
              id: 'a2',
              data: {
                text: '颜色示例',
                richText: {
                  ops: [{ insert: '普通' }, { insert: '红色', attributes: { color: '#f44f3b' } }]
                }
              }
            }
          ],
          summary: [
            { id: 's1', data: { text: '不常用', type: 'summary', startId: 'a1', endId: 'a2' } }
          ]
        }
      },
      relativeLinks: [{ id: 'l1', text: '等价\n', start: { nodeId: 'a1' }, end: { nodeId: 'a11' } }]
    }
  ]
}
