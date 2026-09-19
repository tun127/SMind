/**
 * 节点附加元素切片（自 `editor.ts` 的「节点附加元素」分节整块搬出，成员体逐字未改）：
 * 标记、标签、备注、超链接、公式、代码块、图片、附件。
 *
 * 一律经 `get().mutate(...)` 写入（图片尺寸归一/公式钳制等纯逻辑早已在 `@shared/model/editor-ops`）。
 *
 * 本文件同时拥有这些成员在 `EditorState` 里的**声明**（接口逐字搬来）。
 */

import type { Attachment, TopicCode, TopicImage } from '@shared/model/types'

export interface NodeContentSlice {
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
}

/** 实现（状态初值与动作）随「B1 第二步 B」的对应批次搬入；本文件此刻只有类型声明。 */
