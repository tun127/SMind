import { DEFAULT_STRUCTURE } from '../xmind/constants'
import { CREATOR, MODEL_VERSION, type Sheet, type Topic, type Workbook } from './types'

let idCounter = 0

/** 生成稳定唯一 id（不依赖 crypto.randomUUID，避免 file:// 下不可用） */
export function createId(prefix = 't'): string {
  idCounter += 1
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${rand}`
}

export function createTopic(title = '分支主题', structureClass?: string): Topic {
  return {
    id: createId('topic'),
    title,
    structureClass,
    children: [],
    detachedChildren: [],
    labels: [],
    markers: [],
    attachments: []
  }
}

export function createSheet(title = '画布 1', rootTitle = '中心主题'): Sheet {
  return {
    id: createId('sheet'),
    title,
    // 新建画布的结构一律取 DEFAULT_STRUCTURE（逻辑图·向右）。
    // 这里曾经写死过「思维导图（平衡）」，于是「默认结构」这个约定被悄悄绕过：
    // 只有导入的文件和工具栏下拉认识它，真正常用的「新建导图 / 新建画布」出来的却还是平衡图。
    rootTopic: {
      ...createTopic(rootTitle),
      structureClass: DEFAULT_STRUCTURE
    },
    relationships: [],
    boundaries: [],
    summaries: []
  }
}

export interface CreateWorkbookOptions {
  rootTitle?: string
  sheetTitle?: string
  /** 预置若干一级子主题，用于新建时给出示例结构 */
  seedBranches?: string[]
}

/**
 * 用一棵**现成的主题树**构建一份新文档。
 *
 * 用途：导入 Markdown/OPML、AI 生成导图——它们都要"在新窗口里成为一份独立文档"，
 * 而不是往当前文档里塞内容（那会让用户觉得"当前文档被覆盖了"）。
 */
export function createWorkbookFromRoot(rootTopic: Topic, sheetTitle = '画布 1'): Workbook {
  const sheet = createSheet(sheetTitle, rootTopic.title)
  sheet.rootTopic = rootTopic
  return {
    version: MODEL_VERSION,
    sheets: [sheet],
    activeSheetId: sheet.id,
    creator: { ...CREATOR }
  }
}

export function createWorkbook(options: CreateWorkbookOptions = {}): Workbook {
  const sheet = createSheet(options.sheetTitle ?? '画布 1', options.rootTitle ?? '中心主题')
  const branches = options.seedBranches ?? ['分支主题 1', '分支主题 2']
  sheet.rootTopic.children = branches.map((b) => createTopic(b))
  return {
    version: MODEL_VERSION,
    sheets: [sheet],
    activeSheetId: sheet.id,
    creator: { ...CREATOR }
  }
}

export function emptyTopic(): Topic {
  return createTopic('')
}

export { MODEL_VERSION, CREATOR }
