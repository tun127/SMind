import type { Workbook } from './model/types'
import type { AiConfigView, AiMessage } from './ai'
import type { ImageExportFormat } from './export/types'
import type { HistoryEntry } from './history'
import type { SnapshotItem, SnapshotReason } from './snapshot'
import type { OutlineFormat } from './outline'
import type { ThemeDefinition } from './theme'

export interface OpenResult {
  path: string
  workbook: Workbook
  warnings: string[]
  /** 是否存在未加载完成的资源（P4 使用） */
  resourceCount: number
  /**
   * 这是一份**副本**（「在新窗口打开画布副本」开出来的）：
   * 它没有磁盘归属，渲染层必须当成"未保存的新文档"——保存走「另存为」，
   * 绝不覆盖原文件（否则一个窗口里的改动会顺着原路径写回去，影响另一个画布）。
   */
  copy?: boolean
}

export interface SaveResult {
  path: string
}

/** 插入图片后返回的元信息（字节已经存进包里，模型只记路径与尺寸） */
/**
 * 应用级默认设置（存 %APPDATA%\SMind\settings.json）。
 *
 * 所有「默认参数」集中在这里：以后新增默认值直接往这个结构里加字段，
 * 不再散落进各个面板。
 */
export interface AppSettings {
  /** 新建 / 打开文档时的初始视角锁定 */
  defaultViewLock: boolean
  /** 新建文档时套用的主题 id；null = 用内置默认主题 */
  defaultThemeId: string | null
  /** 新建主题标题的默认对齐（左 / 居中 / 右） */
  defaultAlign: 'left' | 'center' | 'right'
  /** 新建节点的默认字体；null = 跟随主题 */
  defaultFontFamily: string | null
  /** 新建节点的默认字号；null = 跟随层级默认 */
  defaultFontSize: number | null
  /** 新建节点的默认文字颜色；null = 跟随主题 */
  defaultColor: string | null
  /** 收进「更多 ▾」的工具栏功能 id 列表（其余都在快捷栏） */
  toolbarHidden: string[]
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultViewLock: false,
  defaultThemeId: null,
  defaultAlign: 'center',
  defaultFontFamily: null,
  defaultFontSize: null,
  defaultColor: null,
  toolbarHidden: []
}

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
  openFilePending: 'file:open-pending',
  fileOpenRequest: 'file:open-request',
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
  /** 新开一个窗口（= 新的一份文档） */
  newWindow: 'window:new',
  /** 在新窗口打开一份文档副本（导入大纲 / AI 生成导图 / 「在新窗口打开副本」用） */
  openSheetWindow: 'window:open-copy',
  /** 在新窗口打开一个已有文件（当前窗口有内容时用它，避免覆盖当前文档） */
  openPathWindow: 'window:open-path',
  /** 读系统剪贴板里的纯文本（粘贴 Markdown 片段用） */
  clipboardText: 'clipboard:read-text',
  /** 渲染进程报告「某个标签现在打开的是哪个文件」（新建＝null） */
  documentPath: 'window:document-path',
  /** 释放一个文档（标签关闭）：主进程丢掉它的图片/附件资源表 */
  releaseDoc: 'document:release',
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
  settingsLoad: 'settings:load',
  settingsSave: 'settings:save',
  pickImage: 'resource:pick-image',
  pasteImage: 'resource:paste-image',
  addImage: 'resource:add-image',
  pickAttachment: 'resource:pick-attachment',
  openAttachment: 'resource:open-attachment',
  saveAttachmentAs: 'resource:save-attachment-as',
  /* ---- 大纲导出（P5） ---- */
  exportOutline: 'outline:export',
  /* ---- 图片导出（P6） ---- */
  saveExport: 'export:save',
  /* ---- AI（P8） ---- */
  aiConfigGet: 'ai:config-get',
  aiConfigSave: 'ai:config-save',
  aiChat: 'ai:chat',
  aiTest: 'ai:test',
  /* ---- 大纲文件导入（P9+） ---- */
  importText: 'file:import-text',
  /* ---- 历史记录与常用（P9+） ---- */
  historyList: 'history:list',
  historyTogglePin: 'history:toggle-pin',
  historyRemove: 'history:remove',
  historyClear: 'history:clear',
  historySaveDir: 'history:save-dir',
  historyChooseSaveDir: 'history:choose-save-dir',
  historyReveal: 'history:reveal',
  /* ---- 文档版本快照（P9+） ---- */
  snapshotList: 'snapshot:list',
  snapshotCreate: 'snapshot:create',
  snapshotRestore: 'snapshot:restore',
  snapshotRemove: 'snapshot:remove',
  snapshotClear: 'snapshot:clear'
} as const

export type MenuCommand =
  | 'file:new'
  | 'file:open'
  | 'file:save'
  | 'file:save-as'
  /** 在新窗口打开当前画布（并排看两张画布） */
  | 'file:open-sheet-window'
  | 'edit:undo'
  | 'edit:redo'
  | 'edit:delete'
  | 'edit:copy'
  | 'edit:paste'
  | 'view:zoom-in'
  | 'view:zoom-out'
  | 'view:zoom-reset'
  | 'view:fit'
  | 'view:lock'
  | 'view:toggle-structure'
  | 'help:shortcuts'
  | 'file:import-theme'
  | 'file:import-markdown'
  | 'file:import-opml'
  | 'file:export-image'
  | 'file:export-txt'
  | 'file:export-md'
  | 'file:export-opml'
  | 'file:history'

/** preload 暴露给渲染进程的 API */
export interface MindApi {
  /**
   * 多文档标签下，每个文档都有稳定的 docId；
   * 主进程按 docId 隔离图片/附件资源——涉及「读文件 / 存文件 / 插资源」的
   * IPC 第一个参数都是 docId。
   */
  openDialog(docId: string): Promise<OpenResult | null>
  openPath(docId: string, path: string): Promise<OpenResult>
  /**
   * 启动时命令行里带的文档（双击 `.xmind`、把文件拖到 exe 上、右键「打开方式 → Mind」都走这里）。
   * 取一次即清空，没有则返回 null。
   */
  openFilePending(): Promise<string | null>
  /** 窗口已经开着时又打开了一个文档：主进程把它推过来（返回取消订阅） */
  onFileOpenRequest(handler: (path: string) => void): () => void
  saveToPath(docId: string, path: string, workbook: Workbook): Promise<SaveResult>
  saveAs(docId: string, workbook: Workbook, suggestedName: string): Promise<SaveResult | null>
  autosave(docId: string, workbook: Workbook, originalPath: string | null, title: string): Promise<void>
  clearAutosave(): Promise<void>
  /**
   * 释放一个文档的残留资源（标签关闭时调用）：
   * 主进程丢掉这个 docId 的图片/附件资源表。
   * 自动存档不在这里清——它按窗口槽位存，由 clearAutosave / 正常关窗负责。
   */
  releaseDoc(docId: string): Promise<void>
  recoveryCheck(): Promise<RecoveryInfo | null>
  recoveryLoad(docId: string): Promise<OpenResult | null>
  recoveryDiscard(): Promise<void>
  confirmClose(): void
  setTitle(title: string): void
  /** 开一个新窗口（= 新的一份文档）；每个窗口各自独立文档与撤销栈 */
  newWindow(): Promise<void>
  /**
   * 在**新窗口**打开一份文档（副本语义）。
   *
   * 用途：① 「在新窗口打开副本」——当前文档复制一份到新窗口，两边互不影响；
   * ② 导入 Markdown/OPML、AI 生成导图——直接在**新窗口**里成为独立文档，
   * 不往当前文档里塞东西（也就不会影响用户正在编辑的内容）。
   *
   * 副本**没有磁盘归属**：保存时会走「另存为」，永远不会覆盖原文件。
   */
  openWorkbookInNewWindow(docId: string, workbook: Workbook): Promise<'ok' | 'failed'>
  /**
   * 在**新窗口**打开一个已有文件。
   *
   * 当前窗口里已经有内容时，菜单「打开 / 导入 .xmind」走这条路——
   * 直接就地打开会把当前文档（含所有画布）整份换掉，用户会觉得"画布 1 被覆盖了"。
   */
  openPathInNewWindow(path: string): Promise<'ok' | 'failed'>
  /** 读系统剪贴板里的纯文本（粘贴 Markdown 片段用） */
  readClipboardText(): Promise<string>
  /**
   * 告诉主进程「某个标签现在打开的是哪个文件」（新建文档传 null）。
   * 主进程用它判断「双击的那个文件是不是已经开着」，从而聚焦对应窗口/标签。
   */
  reportDocument(docId: string, path: string | null): void
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

  /* ---- 应用设置 ---- */
  /** 读取应用级默认设置（文件缺失或损坏时返回默认值） */
  settingsLoad(): Promise<AppSettings>
  /** 写回应用级默认设置 */
  settingsSave(settings: AppSettings): Promise<void>

  /* ---- 图片与附件（P4） ---- */
  /** 选择一张图片并读进指定文档的资源里，取消返回 null */
  pickImage(docId: string): Promise<PickedImage | null>
  /** 读取系统剪贴板里的图片，剪贴板中没有图片返回 null */
  pasteImage(docId: string): Promise<PickedImage | null>
  /** 把一段图片字节登记进指定文档资源（拖拽图片文件用） */
  addImage(docId: string, name: string, bytes: Uint8Array): Promise<PickedImage | null>
  /** 选择一个文件作为附件，取消返回 null */
  pickAttachment(docId: string): Promise<PickedAttachment | null>
  /** 用系统默认程序打开附件（name 用于生成可读的临时文件名），失败返回 false */
  openAttachment(path: string, name: string): Promise<boolean>
  /** 把附件另存到用户选择的位置，取消或失败返回 false */
  saveAttachmentAs(path: string, suggestedName: string): Promise<boolean>

  /* ---- 大纲导出（P5） ---- */
  /** 导出当前画布的大纲（TXT / Markdown / OPML），取消返回 null，成功返回写入路径 */
  exportOutline(workbook: Workbook, format: OutlineFormat): Promise<string | null>

  /* ---- 图片导出（P6） ---- */
  /**
   * 把已经生成好的导出内容写到用户选择的位置。
   * 渲染进程负责排版与栅格化，主进程只负责弹保存框与落盘。
   */
  saveExport(data: Uint8Array | string, fileName: string, ext: ImageExportFormat): Promise<string | null>

  /* ---- AI（P8） ---- */
  /** 读取 AI 配置（Key 只回掩码，完整 Key 不进渲染进程） */
  aiConfigGet(): Promise<AiConfigView>
  /** 保存 AI 配置；apiKey 传空字符串/不传表示沿用已保存的 Key */
  aiConfigSave(patch: AiConfigPatch): Promise<AiConfigView>
  /** 调一次 chat/completions，返回模型正文 */
  aiChat(messages: AiMessage[], options?: { timeoutMs?: number }): Promise<AiChatResult>
  /** 用一条极短的消息测试连通性 */
  aiTest(): Promise<AiTestResult>

  /* ---- 大纲文件导入 ---- */
  /**
   * 选一个 Markdown / OPML 文件并读出文本（用于一键生成导图）。
   * 取消返回 null。
   */
  importText(kind: 'markdown' | 'opml'): Promise<ImportedTextFile | null>

  /* ---- 历史记录与常用（P9+） ---- */
  /** 打开历史（常用在最前，带「文件是否还在原位置」标记） */
  historyList(): Promise<HistoryEntry[]>
  /** 切换常用（收藏） */
  historyTogglePin(path: string): Promise<HistoryEntry[]>
  /** 从历史里移除一条 */
  historyRemove(path: string): Promise<HistoryEntry[]>
  /** 清空历史 */
  historyClear(): Promise<HistoryEntry[]>
  /** 当前的默认保存目录 */
  historySaveDir(): Promise<string>
  /** 让用户选一个目录作为默认保存位置，取消返回 null */
  historyChooseSaveDir(): Promise<string | null>
  /** 在系统文件管理器里打开某个文件或目录 */
  revealInFolder(path: string): Promise<void>

  /* ---- 文档版本快照（P9+） ---- */
  /**
   * 当前文档的版本列表。
   * 只服务「已保存过的文档」：path 为 null 时返回空列表
   * （未保存文档的内容安全由自动保存与崩溃恢复负责）。
   */
  snapshotList(path: string | null): Promise<SnapshotItem[]>
  /**
   * 存一份版本。
   * reason 为 auto 时，内容与上一份相同（或距上次太近）会被忽略，不会重复写盘。
   */
  snapshotCreate(
    docId: string,
    input: {
      workbook: Workbook
      path: string | null
      title: string
      reason: SnapshotReason
      note?: string
    }
  ): Promise<SnapshotItem[]>
  /**
   * 恢复某个版本。
   * 刻意不复用 OpenResult：恢复是「把当前文档换回旧内容」，
   * 文件路径要保留当前值，而不是变成快照里记录的那个。
   */
  snapshotRestore(docId: string, id: string): Promise<SnapshotRestoreResult>
  snapshotRemove(id: string, path: string | null): Promise<SnapshotItem[]>
  snapshotClear(path: string | null): Promise<SnapshotItem[]>
}

/** 恢复版本的结果：只带回内容，不带路径（路径沿用当前文档） */
export interface SnapshotRestoreResult {
  workbook: Workbook
  warnings: string[]
  resourceCount: number
}

export interface ImportedTextFile {
  path: string
  name: string
  text: string
}

export interface AiConfigPatch {
  baseUrl?: string
  model?: string
  temperature?: number
  apiKey?: string
}

export interface AiChatResult {
  content: string
  /** 实际使用的模型名（服务端可能回不同的） */
  model: string
  /** 本次消耗的 token（服务端没给就是 null） */
  totalTokens: number | null
}

export interface AiTestResult {
  ok: boolean
  message: string
  /** 测试失败时的原始状态码，便于排查 */
  status?: number
}
