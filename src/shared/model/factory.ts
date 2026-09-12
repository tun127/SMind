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
    rootTopic: {
      ...createTopic(rootTitle),
      structureClass: 'org.xmind.ui.map.unbalanced'
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
