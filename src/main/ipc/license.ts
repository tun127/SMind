import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'

import { type LicenseView } from '@shared/license'
import { activateLicense, deactivateLicense, getLicenseView } from '../license'

/**
 * 这些处理器原来都在 `main/index.ts` 的 `registerIpc()` 里，整块搬来：
 * 函数体、先后顺序、通道名逐字未改（搬迁只做剪切粘贴）。
 */
export function registerLicenseIpc(): void {
  ipcMain.handle(IPC.licenseGet, (): Promise<LicenseView> => getLicenseView())

  ipcMain.handle(IPC.licenseActivate, async (_e, key: unknown) => {
    // 许可码是外部输入（用户粘贴的），长度与类型都验一遍再进验签
    if (typeof key !== 'string' || key.length === 0 || key.length > 4000) {
      return {
        ok: false,
        message: '许可码无效：请把购买时拿到的那一整串原样粘进来',
        view: await getLicenseView()
      }
    }
    return activateLicense(key)
  })

  ipcMain.handle(IPC.licenseDeactivate, (): Promise<LicenseView> => deactivateLicense())
}
