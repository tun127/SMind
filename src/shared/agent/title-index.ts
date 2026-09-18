/**
 * 节点标题的识别与切分。
 *
 * 单一职责：把模型输出里「提到了哪些标题」切成可点击的片段，并建立标题 → 主题的索引。
 * 不碰工具、不碰寻址，可独立验证。
 */
import type { Topic } from '../model/types'

/* ------------------------------------------------------------------ */
/* 节点标题的识别与切分                                                */
/* ------------------------------------------------------------------ */

export interface TextSegment {
  text: string
  /** 命中节点时有值；纯文本片段为 null */
  topicId: string | null
}

export interface TitleIndexEntry {
  title: string
  id: string
}

/**
 * 建「首个字符 → 标题」的索引。
 *
 * 为什么不直接拿全部标题去逐条扫文本：那是 O(标题数 × 文本长度)，
 * 大文档（几千个节点）× 每条回复都扫一遍会卡。
 * 按首字分桶后，每个字符位置只比较少数几个候选。
 *
 * 桶内按标题长度**降序**：保证「先匹配长的」——
 * 否则「成本」会先把「成本控制」咬掉一半。
 */
export function buildTitleIndex(root: Topic, minLength = 2): Map<string, TitleIndexEntry[]> {
  const index = new Map<string, TitleIndexEntry[]>()

  const walk = (topic: Topic): void => {
    const title = topic.title.trim()
    const first = title[0]
    if (title.length >= minLength && first !== undefined) {
      const bucket = index.get(first)
      if (bucket) bucket.push({ title, id: topic.id })
      else index.set(first, [{ title, id: topic.id }])
    }
    for (const child of topic.children) walk(child)
  }
  walk(root)

  for (const bucket of index.values()) {
    bucket.sort((a, b) => b.title.length - a.title.length)
  }
  return index
}

/**
 * 把文本切成「纯文本 / 节点引用」两类片段。
 *
 * 只认**标题原文**（这正是 system 提示词要求模型引用节点的方式）；
 * 同一标题出现多次都会被识别。
 */
export function segmentTitleMentions(
  text: string,
  index: Map<string, TitleIndexEntry[]>
): TextSegment[] {
  // 防御：内容可能来自历史记录等外部数据。坏数据最多让这段不高亮，
  // **绝不能把整个界面带崩**（这里真崩过一次：上游把 content 清成了 undefined）。
  if (typeof text !== 'string' || text.length === 0) return []

  const segments: TextSegment[] = []
  let plain = ''
  let position = 0

  const flushPlain = (): void => {
    if (plain.length > 0) {
      segments.push({ text: plain, topicId: null })
      plain = ''
    }
  }

  while (position < text.length) {
    const char = text[position]
    if (char === undefined) break
    const bucket = index.get(char)
    let matched: TitleIndexEntry | null = null
    if (bucket) {
      for (const item of bucket) {
        if (text.startsWith(item.title, position)) {
          matched = item
          break
        }
      }
    }

    if (matched) {
      flushPlain()
      segments.push({ text: matched.title, topicId: matched.id })
      position += matched.title.length
    } else {
      plain += char
      position += 1
    }
  }

  flushPlain()
  return segments
}
