import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AiChatResult,
  type AiConfigPatch,
  type AiTestResult,
  type ImportedTextFile,
  type MenuCommand,
  type MindApi,
  type OpenResult,
  type PickedAttachment,
  type AppSettings,
  type PickedImage,
  type RecoveryInfo,
  type SaveResult
} from '@shared/ipc'
import type { AiConfigView, AiMessage, AiStreamEvent, ChatHistoryEntry } from '@shared/ai'
import type { HistoryEntry } from '@shared/history'
import type { SnapshotItem, SnapshotReason } from '@shared/snapshot'
import type { SnapshotRestoreResult } from '@shared/ipc'
import type { Workbook } from '@shared/model/types'
import type { ImageExportFormat } from '@shared/export/types'
import type { OutlineFormat } from '@shared/outline'
import type { ThemeDefinition } from '@shared/theme'

const api: MindApi = {
  openDialog: (docId: string) => ipcRenderer.invoke(IPC.openDialog, docId) as Promise<OpenResult | null>,

  openPath: (docId: string, path: string) =>
    ipcRenderer.invoke(IPC.openPath, docId, path) as Promise<OpenResult>,

  openFilePending: () => ipcRenderer.invoke(IPC.openFilePending) as Promise<string | null>,

  onFileOpenRequest: (handler: (path: string) => void) => {
    const listener = (_e: unknown, path: string): void => handler(path)
    ipcRenderer.on(IPC.fileOpenRequest, listener)
    return () => ipcRenderer.removeListener(IPC.fileOpenRequest, listener)
  },

  saveToPath: (docId: string, path: string, workbook: Workbook) =>
    ipcRenderer.invoke(IPC.saveToPath, docId, path, workbook) as Promise<SaveResult>,

  saveAs: (docId: string, workbook: Workbook, suggestedName: string) =>
    ipcRenderer.invoke(IPC.saveAs, docId, workbook, suggestedName) as Promise<SaveResult | null>,

  autosave: (docId: string, workbook: Workbook, originalPath: string | null, title: string) =>
    ipcRenderer.invoke(IPC.autosave, docId, workbook, originalPath, title) as Promise<void>,

  clearAutosave: () => ipcRenderer.invoke(IPC.autosaveClear) as Promise<void>,

  releaseDoc: (docId: string) => ipcRenderer.invoke(IPC.releaseDoc, docId) as Promise<void>,

  recoveryCheck: () => ipcRenderer.invoke(IPC.recoveryCheck) as Promise<RecoveryInfo | null>,

  recoveryLoad: (docId: string) => ipcRenderer.invoke(IPC.recoveryLoad, docId) as Promise<OpenResult | null>,

  recoveryDiscard: () => ipcRenderer.invoke(IPC.recoveryDiscard) as Promise<void>,

  confirmClose: () => ipcRenderer.send(IPC.confirmClose),

  setTitle: (title: string) => ipcRenderer.send(IPC.setTitle, title),

  newWindow: () => ipcRenderer.invoke(IPC.newWindow) as Promise<void>,

  openWorkbookInNewWindow: (docId: string, workbook: Workbook) =>
    ipcRenderer.invoke(IPC.openSheetWindow, docId, workbook) as Promise<'ok' | 'failed'>,

  readClipboardText: () => ipcRenderer.invoke(IPC.clipboardText) as Promise<string>,

  reportDocument: (docId: string, path: string | null) => ipcRenderer.send(IPC.documentPath, docId, path),

  showInFolder: (path: string) => ipcRenderer.send(IPC.showInFolder, path),

  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<boolean>,

  onMenuCommand: (handler: (command: MenuCommand) => void) => {
    const listener = (_e: unknown, command: MenuCommand): void => handler(command)
    ipcRenderer.on(IPC.menuCommand, listener)
    return () => ipcRenderer.removeListener(IPC.menuCommand, listener)
  },

  onCloseRequest: (handler: () => void) => {
    const listener = (): void => handler()
    ipcRenderer.on(IPC.closeRequest, listener)
    return () => ipcRenderer.removeListener(IPC.closeRequest, listener)
  },

  themesList: () => ipcRenderer.invoke(IPC.themesList) as Promise<ThemeDefinition[]>,

  themesSave: (theme: ThemeDefinition) => ipcRenderer.invoke(IPC.themesSave, theme) as Promise<void>,

  themesDelete: (id: string) => ipcRenderer.invoke(IPC.themesDelete, id) as Promise<void>,

  themesImport: () => ipcRenderer.invoke(IPC.themesImport) as Promise<ThemeDefinition | null>,

  themesExport: (theme: ThemeDefinition) => ipcRenderer.invoke(IPC.themesExport, theme) as Promise<boolean>,

  settingsLoad: () => ipcRenderer.invoke(IPC.settingsLoad) as Promise<AppSettings>,

  settingsSave: (settings: AppSettings) => ipcRenderer.invoke(IPC.settingsSave, settings) as Promise<void>,

  pickImage: (docId: string) => ipcRenderer.invoke(IPC.pickImage, docId) as Promise<PickedImage | null>,

  pasteImage: (docId: string) => ipcRenderer.invoke(IPC.pasteImage, docId) as Promise<PickedImage | null>,

  addImage: (docId: string, name: string, bytes: Uint8Array) =>
    ipcRenderer.invoke(IPC.addImage, docId, name, bytes) as Promise<PickedImage | null>,

  pickAttachment: (docId: string) =>
    ipcRenderer.invoke(IPC.pickAttachment, docId) as Promise<PickedAttachment | null>,

  openAttachment: (path: string, name: string) =>
    ipcRenderer.invoke(IPC.openAttachment, path, name) as Promise<boolean>,

  saveAttachmentAs: (path: string, suggestedName: string) =>
    ipcRenderer.invoke(IPC.saveAttachmentAs, path, suggestedName) as Promise<boolean>,

  exportOutline: (workbook: Workbook, format: OutlineFormat) =>
    ipcRenderer.invoke(IPC.exportOutline, workbook, format) as Promise<string | null>,

  saveExport: (data: Uint8Array | string, fileName: string, ext: ImageExportFormat) =>
    ipcRenderer.invoke(IPC.saveExport, data, fileName, ext) as Promise<string | null>,

  aiConfigGet: () => ipcRenderer.invoke(IPC.aiConfigGet) as Promise<AiConfigView>,

  aiConfigSave: (patch: AiConfigPatch) => ipcRenderer.invoke(IPC.aiConfigSave, patch) as Promise<AiConfigView>,

  aiChat: (messages: AiMessage[], options?: { timeoutMs?: number }) =>
    ipcRenderer.invoke(IPC.aiChat, messages, options) as Promise<AiChatResult>,

  aiTest: () => ipcRenderer.invoke(IPC.aiTest) as Promise<AiTestResult>,

  aiChatStream: (requestId: string, messages: AiMessage[], options?: { useTools?: boolean }) =>
    ipcRenderer.invoke(IPC.aiChatStream, requestId, messages, options) as Promise<void>,

  aiChatStreamCancel: (requestId: string) => ipcRenderer.send(IPC.aiChatStreamCancel, requestId),

  onAiStreamEvent: (handler: (event: AiStreamEvent) => void) => {
    const listener = (_e: unknown, event: AiStreamEvent): void => handler(event)
    ipcRenderer.on(IPC.aiStreamEvent, listener)
    return () => ipcRenderer.removeListener(IPC.aiStreamEvent, listener)
  },

  chatHistoryLoad: (key: string) => ipcRenderer.invoke(IPC.chatHistoryLoad, key) as Promise<ChatHistoryEntry[]>,

  chatHistorySave: (key: string, messages: ChatHistoryEntry[]) =>
    ipcRenderer.invoke(IPC.chatHistorySave, key, messages) as Promise<void>,

  chatHistoryClear: (key: string) => ipcRenderer.invoke(IPC.chatHistoryClear, key) as Promise<void>,

  importText: (kind: 'markdown' | 'opml') =>
    ipcRenderer.invoke(IPC.importText, kind) as Promise<ImportedTextFile | null>,

  historyList: () => ipcRenderer.invoke(IPC.historyList) as Promise<HistoryEntry[]>,

  historyTogglePin: (path: string) => ipcRenderer.invoke(IPC.historyTogglePin, path) as Promise<HistoryEntry[]>,

  historyRemove: (path: string) => ipcRenderer.invoke(IPC.historyRemove, path) as Promise<HistoryEntry[]>,

  historyClear: () => ipcRenderer.invoke(IPC.historyClear) as Promise<HistoryEntry[]>,

  historySaveDir: () => ipcRenderer.invoke(IPC.historySaveDir) as Promise<string>,

  historyChooseSaveDir: () => ipcRenderer.invoke(IPC.historyChooseSaveDir) as Promise<string | null>,

  revealInFolder: (path: string) => ipcRenderer.invoke(IPC.historyReveal, path) as Promise<void>,

  snapshotList: (path: string | null) =>
    ipcRenderer.invoke(IPC.snapshotList, path) as Promise<SnapshotItem[]>,

  snapshotCreate: (
    docId: string,
    input: {
      workbook: Workbook
      path: string | null
      title: string
      reason: SnapshotReason
      note?: string
    }
  ) => ipcRenderer.invoke(IPC.snapshotCreate, docId, input) as Promise<SnapshotItem[]>,

  snapshotRestore: (docId: string, id: string) =>
    ipcRenderer.invoke(IPC.snapshotRestore, docId, id) as Promise<SnapshotRestoreResult>,

  snapshotRemove: (id: string, path: string | null) =>
    ipcRenderer.invoke(IPC.snapshotRemove, id, path) as Promise<SnapshotItem[]>,

  snapshotClear: (path: string | null) =>
    ipcRenderer.invoke(IPC.snapshotClear, path) as Promise<SnapshotItem[]>
}

contextBridge.exposeInMainWorld('api', api)
