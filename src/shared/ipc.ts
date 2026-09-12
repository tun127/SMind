import type { Workbook } from './model/types'
import type { ThemeDefinition } from './theme'

export interface OpenResult {
  path: string
  workbook: Workbook
  warnings: string[]
  /** 是否存在未加载完成的资源（P4 使用） */
  resourceCount: number
}

export interface SaveResult {
  path: string
}

/** 插入图片后返回的元信息（字节已经存进包里，模型只记路径与尺寸） */
export interface PickedImage {
  /** 包内相对路径，如 resources/img-xxx-photo.png */
  path: string
  name: string
  width: number
  height: number
  size: number
}

/** 插入附件后返回的元信息 */
export interface PickedAttachment {
  id: string
  path: string
  name: string
  size: number
  mime: string
}

export interface RecoveryInfo {
  /** 自动保存时对应的原始文件路径，全新未保存的文件为 null */
  originalPath: string | null
  title: string
  savedAt: number
}

export const IPC = {
  openDialog: 'file:open-dialog',
  openPath: 'file:open-path',
  saveToPath: 'file:save-to-path',
  saveAs: 'file:save-as',
  autosave: 'file:autosave',
  autosaveClear: 'file:autosave-clear',
  recoveryCheck: 'recovery:check',
  recoveryLoad: 'recovery:load',
  recoveryDiscard: 'recovery:discard',
  confirmClose: 'window:confirm-close',
  closeRequest: 'window:close-request',
  setTitle: 'window:set-title',
  showInFolder: 'shell:show-in-folder',
  openExternal: 'shell:open-external',
  menuCommand: 'menu:command',
  documentReset: 'document:reset',
  themesList: 'themes:list',
  themesSave: 'themes:save',
  themesDelete: 'themes:delete',
  themesImport: 'themes:import',
  themesExport: 'themes:export',
  /* ---- 图片与附件（P4） ---- */
  pickImage: 'resource:pick-image',
  pickAttachment: 'resource:pick-attachment',
  openAttachment: 'resource:open-attachment',
  saveAttachmentAs: 'resource:save-attachment-as'
} as const

export type MenuCommand =
  | 'file:new'
  | 'file:open'
  | 'file:save'
  | 'file:save-as'
  | 'edit:undo'
  | 'edit:redo'
  | 'edit:delete'
  | 'edit:copy'
  | 'edit:paste'
  | 'view:zoom-in'
  | 'view:zoom-out'
  | 'view:zoom-reset'
  | 'view:fit'
  | 'view:toggle-structure'
  | 'help:shortcuts'

/** preload 暴露给渲染进程的 API */
export interface MindApi {
  openDialog(): Promise<OpenResult | null>
  openPath(path: string): Promise<OpenResult>
  saveToPath(path: string, workbook: Workbook): Promise<SaveResult>
  saveAs(workbook: Workbook, suggestedName: string): Promise<SaveResult | null>
  autosave(workbook: Workbook, originalPath: string | null, title: string): Promise<void>
  clearAutosave(): Promise<void>
  /**
   * 丢弃当前文档的残留状态：自动存档 + 已加载的附件资源。
   * 新建文档时必须调用，否则上一份文件的图片/附件会被写进新文件。
   */
  documentReset(): Promise<void>
  recoveryCheck(): Promise<RecoveryInfo | null>
  recoveryLoad(): Promise<OpenResult | null>
  recoveryDiscard(): Promise<void>
  confirmClose(): void
  setTitle(title: string): void
  showInFolder(path: string): void
  /** 用系统默认程序打开外部链接（仅允许 http/https/mailto） */
  openExternal(url: string): Promise<boolean>
  onMenuCommand(handler: (command: MenuCommand) => void): () => void
  onCloseRequest(handler: () => void): () => void

  /* ---- 主题 ---- */
  /** 读取「我的主题」（存放在用户数据目录的 themes.json） */
  themesList(): Promise<ThemeDefinition[]>
  themesSave(theme: ThemeDefinition): Promise<void>
  themesDelete(id: string): Promise<void>
  /** 从 .json 导入主题，取消返回 null */
  themesImport(): Promise<ThemeDefinition | null>
  /** 导出主题到 .json，取消或失败返回 false */
  themesExport(theme: ThemeDefinition): Promise<boolean>

  /* ---- 图片与附件（P4） ---- */
  /** 选择一张图片并读进当前文档的资源里，取消返回 null */
  pickImage(): Promise<PickedImage | null>
  /** 选择一个文件作为附件，取消返回 null */
  pickAttachment(): Promise<PickedAttachment | null>
  /** 用系统默认程序打开附件（name 用于生成可读的临时文件名），失败返回 false */
  openAttachment(path: string, name: string): Promise<boolean>
  /** 把附件另存到用户选择的位置，取消或失败返回 false */
  saveAttachmentAs(path: string, suggestedName: string): Promise<boolean>
}
