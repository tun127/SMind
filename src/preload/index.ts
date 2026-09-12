import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type MenuCommand,
  type MindApi,
  type OpenResult,
  type PickedAttachment,
  type PickedImage,
  type RecoveryInfo,
  type SaveResult
} from '@shared/ipc'
import type { Workbook } from '@shared/model/types'
import type { ImageExportFormat } from '@shared/export/types'
import type { OutlineFormat } from '@shared/outline'
import type { ThemeDefinition } from '@shared/theme'

const api: MindApi = {
  openDialog: () => ipcRenderer.invoke(IPC.openDialog) as Promise<OpenResult | null>,

  openPath: (path) => ipcRenderer.invoke(IPC.openPath, path) as Promise<OpenResult>,

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

  pickImage: () => ipcRenderer.invoke(IPC.pickImage) as Promise<PickedImage | null>,

  pickAttachment: () => ipcRenderer.invoke(IPC.pickAttachment) as Promise<PickedAttachment | null>,

  openAttachment: (path: string, name: string) =>
    ipcRenderer.invoke(IPC.openAttachment, path, name) as Promise<boolean>,

  saveAttachmentAs: (path: string, suggestedName: string) =>
    ipcRenderer.invoke(IPC.saveAttachmentAs, path, suggestedName) as Promise<boolean>,

  exportOutline: (workbook: Workbook, format: OutlineFormat) =>
    ipcRenderer.invoke(IPC.exportOutline, workbook, format) as Promise<string | null>,

  saveExport: (data: Uint8Array | string, fileName: string, ext: ImageExportFormat) =>
    ipcRenderer.invoke(IPC.saveExport, data, fileName, ext) as Promise<string | null>
}

contextBridge.exposeInMainWorld('api', api)
