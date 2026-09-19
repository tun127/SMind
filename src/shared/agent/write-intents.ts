/**
 * 写意图的数据层：WriteIntent 的 20 个 kind、破坏性清单、确认偏好与附件类别。
 *
 * 单一职责：只定义「一次写入请求长什么样、哪些是破坏性的」，
 * 不负责把请求解析出来（见 plan-write.ts）、也不负责落到 store（见渲染层）。
 */
import type { OutlineNode } from '../ai'
import type { FoldSide } from '../model/tree'
import type { TopicCode } from '../model/types'

/* ------------------------------------------------------------------ */
/* 写工具（三期二期）：能真正改画布的那一批                             */
/* ------------------------------------------------------------------ */

/**
 * 写工具**不在这里直接改 store**。
 *
 * `planWriteTool` 只把模型给的参数解析成一条「操作意图」，由渲染层执行。这样：
 * ① 这一层保持纯逻辑（自检能直接跑，不用起 React）；
 * ② 解析/寻址失败时能把可读原因原样回喂给模型，让它自己纠正；
 * ③ 破坏性操作有地方插「确认」这一步（执行前拦一道）。
 */
export type WriteIntent =
  | { kind: 'rename'; id: string; title: string }
  /** nodes = 要挂上去的若干**同级**新主题（并列多行时会有多个） */
  | { kind: 'insert'; id: string; nodes: OutlineNode[]; count: number }
  | { kind: 'delete'; id: string; title: string; size: number }
  | { kind: 'move'; id: string; targetId: string; index: number | null }
  /**
   * 批量移动：整理大导图的正路。一次工具调用搬很多节点，
   * 否则「把 84 个平铺节点归类」这种任务在任何调用上限下都做不完。
   */
  | {
      kind: 'moveMany'
      moves: Array<{ id: string; targetId: string; index: number | null }>
      requested: number
    }
  /**
   * 折叠 / 展开。
   * `side` 只在**思维导图（平衡 / 顺时针）的中心主题**上有效：只收起 / 展开那一侧，
   * 不传就是整体折叠（与以前一致）。时间轴 / 鱼骨图刻意不在支持范围内。
   */
  | { kind: 'collapse'; id: string; collapsed: boolean; side?: FoldSide }
  /** 切换结构（思维导图 / 鱼骨 / 时间轴 …）：整张图或某一支 */
  | { kind: 'structure'; id: string; structureClass: string }
  /** 同级排序（+ 可选自动编号）：orderedIds 是排好的子主题顺序 */
  | { kind: 'sortChildren'; id: string; orderedIds: string[]; renumber: boolean }
  /** 合并同名主题：每组保留 keepId，把 mergeIds 的内容并进去后删掉它们 */
  | { kind: 'dedupe'; groups: Array<{ keepId: string; mergeIds: string[] }> }
  | { kind: 'notes'; id: string; text: string }
  | { kind: 'code'; id: string; code: TopicCode | null }
  | { kind: 'formula'; id: string; formula: string }
  | { kind: 'ask'; question: string; options: string[] }
  /* ---- 第二批：画布元素（关系线 / 边界 / 概要）+ 标记 / 标签 ---- */
  | { kind: 'relationship'; ends: [string, string]; label: string; title: string | null }
  | { kind: 'boundary'; topicIds: string[]; label: string; title: string | null }
  | { kind: 'summary'; topicIds: string[]; label: string; title: string | null }
  | { kind: 'attachmentTitle'; target: AttachmentKind; id: string; title: string }
  | { kind: 'attachmentRemove'; target: AttachmentKind; id: string; label: string }
  | { kind: 'markers'; id: string; markerIds: string[] }
  | { kind: 'label'; id: string; label: string; add: boolean }

/**
 * 方向的中文名：工具摘要与 `getSubtree` 的读取标注共用。
 *
 * up / down 目前**不对外提供**（时间轴 / 鱼骨图不按侧收起，见 `splitFoldSidesOf`），
 * 留在这里是为了读出旧文件里可能带着的方向标记时不至于显示成空白。
 */
import { FOLD_SIDE_LABELS } from '../model/fold-labels'

/** 方向名的唯一来源在 `shared/model/fold-labels`；这里原样再导出，保持旧引用路径可用 */
export { FOLD_SIDE_LABELS }

/**
 * 「执行前必须先问用户一次」的破坏性操作种类（**唯一来源**）。
 *
 * 三处必须一致：① 规划层给 `WritePlan.destructive` 打的标记；② 渲染层的确认框；
 * ③ 「不再询问」记住的范围 + 设置界面里可撤销的清单。
 * 三处各写一份的话，将来新加一个破坏性工具时总有一处会漏——漏掉的那一处
 * 就是「AI 悄悄删了东西而用户没被问过」。
 */
export const DESTRUCTIVE_WRITE_KINDS = ['delete', 'attachmentRemove', 'dedupe'] as const

export type DestructiveWriteKind = (typeof DESTRUCTIVE_WRITE_KINDS)[number]

/** 中文名：给用户看的（确认框的「不再询问」与设置里的清单都用它） */
export const DESTRUCTIVE_WRITE_LABELS: Record<DestructiveWriteKind, string> = {
  delete: '删除主题（含整个分支）',
  attachmentRemove: '删除关系线 / 边界 / 概要',
  dedupe: '合并同名主题（会删掉多余的那些）'
}

export function isDestructiveWriteKind(kind: string): kind is DestructiveWriteKind {
  return (DESTRUCTIVE_WRITE_KINDS as readonly string[]).includes(kind)
}

/** 这次操作要不要先问用户：清单见 `DESTRUCTIVE_WRITE_KINDS` */
export function destructiveOf(kind: WriteIntent['kind']): boolean {
  return isDestructiveWriteKind(kind)
}

/**
 * 把设置里读到的「不再询问」清单收敛成合法值。
 *
 * 配置可能被手改坏、也可能来自旧版本：**只认清单里的种类**，其余一律丢掉——
 * 宁可多问一次，也不要因为一条脏数据把确认框永久关掉。
 */
export function normalizeConfirmSkip(raw: unknown): DestructiveWriteKind[] {
  if (!Array.isArray(raw)) return []
  const out: DestructiveWriteKind[] = []
  for (const item of raw) {
    if (typeof item === 'string' && isDestructiveWriteKind(item) && !out.includes(item)) {
      out.push(item)
    }
  }
  return out
}

/** 画布上的三种元素（第二批工具的共通目标） */
export type AttachmentKind = 'relationship' | 'boundary' | 'summary'

/** 中文名：摘要与报错里用它，避免用户看到 relationship 这种词 */
export const ATTACHMENT_LABEL: Record<AttachmentKind, string> = {
  relationship: '关系线',
  boundary: '边界',
  summary: '概要'
}

export function readAttachmentKind(raw: unknown): AttachmentKind | null {
  return raw === 'relationship' || raw === 'boundary' || raw === 'summary' ? raw : null
}

export type WritePlan =
  | { ok: true; intent: WriteIntent; summary: string; destructive: boolean }
  | { ok: false; error: string; summary: string }
