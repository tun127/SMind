/**
 * 节点附加元素切片（自 `editor.ts` 的「节点附加元素」分节整块搬出，成员体逐字未改）：
 * 标记、标签、备注、超链接、公式、代码块、图片、附件。
 *
 * 一律经 `get().mutate(...)` 写入（图片尺寸归一/公式钳制等纯逻辑早已在 `@shared/model/editor-ops`）。
 *
 * 本文件同时拥有这些成员在 `EditorState` 里的**声明**（接口逐字搬来）。
 */

import type { Attachment, TopicCode, TopicImage } from '@shared/model/types'

import { activeRoot, findTopic } from '@shared/model/tree'
import { withMarkerToggled } from '@shared/xmind/constants'
import { notesHtmlFrom } from '@shared/richtext'

import { normalizeImage } from '@shared/model/editor-ops'
import type { StateCreator } from 'zustand'
import type { EditorState } from './types'

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

export const createNodeContentSlice: StateCreator<EditorState, [], [], NodeContentSlice> = (
  _set,
  get
) => ({
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
    const next = normalizeImage(image)

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
  }
})
