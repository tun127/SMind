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
import type { AiConfigView, AiMessage } from '@shared/ai'
import type { HistoryEntry } from '@shared/history'
import type { SnapshotItem, SnapshotReason } from '@shared/snapshot'
import type { SnapshotRestoreResult } from '@shared/ipc'
import type { Workbook } from '@shared/model/types'
import type { ImageExportFormat } from '@shared/export/types'
import type { OutlineFormat } from '@shared/outline'
import type { ThemeDefinition } from '@shared/theme'

const api: MindApi = {
  openDialog: () => ipcRenderer.invoke(IPC.openDialog) as Promise<OpenResult | null>,

  openPath: (path) => ipcRenderer.invoke(IPC.openPath, path) as Promise<OpenResult>,

  openFilePending: () => ipcRenderer.invoke(IPC.openFilePending) as Promise<string | null>,

  onFileOpenRequest: (handler: (path: string) => void) => {
    const listener = (_e: unknown, path: string): void => handler(path)
    ipcRenderer.on(IPC.fileOpenRequest, listener)
    return () => ipcRenderer.removeListener(IPC.fileOpenRequest, listener)
  },

  saveToPath: (path, workbook: Workbook) =>
    ipcRenderer.invoke(IPC.saveToPath, path, workbook) as Promise<SaveResult>,

  saveAs: (workbook: Workbook, suggestedName: string) =>
    ipcRenderer.invoke(IPC.saveAs, workbook, suggestedName) as Promise<SaveResult | null>,

  autosave: (workbook: Workbook, originalPath: string | null, title: string) =>
    ipcRenderer.invoke(IPC.autosave, workbook, originalPath, title) as Promise<void>,

  clearAutosave: () => ipcRenderer.invoke(IPC.autosaveClear) as Promise<void>,

  documentReset: () => ipcRenderer.invoke(IPC.documentReset) as Promise<void>,

  recoveryCheck: () => ipcRenderer.invoke(IPC.recoveryCheck) as Promise<RecoveryInfo | null>,

  recoveryLoad: () => ipcRenderer.invoke(IPC.recoveryLoad) as Promise<OpenResult | null>,

  recoveryDiscard: () => ipcRenderer.invoke(IPC.recoveryDiscard) as Promise<void>,

  confirmClose: () => ipcRenderer.send(IPC.confirmClose),

  setTitle: (title: string) => ipcRenderer.send(IPC.setTitle, title),

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

  pickImage: () => ipcRenderer.invoke(IPC.pickImage) as Promise<PickedImage | null>,

  pasteImage: () => ipcRenderer.invoke(IPC.pasteImage) as Promise<PickedImage | null>,

  addImage: (name: string, bytes: Uint8Array) =>
    ipcRenderer.invoke(IPC.addImage, name, bytes) as Promise<PickedImage | null>,

  pickAttachment: () => ipcRenderer.invoke(IPC.pickAttachment) as Promise<PickedAttachment | null>,

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

  snapshotCreate: (input: {
    workbook: Workbook
    path: string | null
    title: string
    reason: SnapshotReason
    note?: string
  }) => ipcRenderer.invoke(IPC.snapshotCreate, input) as Promise<SnapshotItem[]>,

  snapshotRestore: (id: string) =>
    ipcRenderer.invoke(IPC.snapshotRestore, id) as Promise<SnapshotRestoreResult>,

  snapshotRemove: (id: string, path: string | null) =>
    ipcRenderer.invoke(IPC.snapshotRemove, id, path) as Promise<SnapshotItem[]>,

  snapshotClear: (path: string | null) =>
    ipcRenderer.invoke(IPC.snapshotClear, path) as Promise<SnapshotItem[]>
}

contextBridge.exposeInMainWorld('api', api)
