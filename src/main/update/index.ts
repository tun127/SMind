/**
 * 自动更新（electron-updater）。
 *
 * 三条刻意的取舍：
 *
 * 1. **只在打包版启用**：开发版没有 latest.yml 可查，检查必然失败，白报错。
 * 2. **例行检查失败一律安静**：启动时的后台检查不该为「没网 / GitHub 访问不了 /
 *    还没配置发布渠道」打扰用户——记日志即可；只有菜单里的**主动检查**才把结果说清楚。
 * 3. **下载在后台、安装放在退出时**（autoInstallOnAppQuit）：不弹窗打断正在画图的人。
 *    真想立刻升级，帮助菜单里随时能主动检查并选择「立即重启安装」。
 *
 * 更新渠道是 GitHub Releases（与开源发布是同一个地方，见 electron-builder.yml 的 publish）。
 * 没配 owner/repo 时主动检查会报「检查失败」，这是预期内的提示，不是故障。
 *
 * 与签名的关系：签名（Azure Trusted Signing）不是自动更新的前置——未签名也能收提示、
 * 也能在退出时静默装（electron-updater 会校验 latest.yml 里的 SHA512，防下载损坏）。
 * 但**签名是 SmartScreen 信誉的前置**：不签名，用户首次运行与安装时都会看到系统警告。
 * 两者互不阻塞，见 electron-builder.yml 里留好的签名配置位。
 */
import { autoUpdater } from 'electron-updater'
import { app, dialog, type BrowserWindow } from 'electron'

/** 已下载完成、等待安装的版本号（null = 没有可立即安装的更新） */
let downloadedVersion: string | null = null

async function showInfo(win: BrowserWindow | null, title: string, message: string): Promise<void> {
  if (win === null) {
    await dialog.showMessageBox({ type: 'info', title, message, noLink: true })
    return
  }
  await dialog.showMessageBox(win, { type: 'info', title, message, noLink: true })
}

/** 应用启动时调用：只在打包版生效，启动后延迟做一次后台检查 */
export function startAutoUpdate(): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = console

  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version ?? null
  })

  // 例行检查的失败（离线、没配发布渠道）记日志就好，别弹窗打扰用户
  autoUpdater.on('error', (error) => {
    console.warn('[updater]', (error as Error).message)
  })

  // 启动 45 秒后再查：别和应用抢启动时的磁盘与网络
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch(() => undefined)
  }, 45_000)
}

/**
 * 帮助菜单的「检查更新…」：主动检查，结果必须说清楚（包括失败）。
 * 有新版且已下载完 → 可以立即重启安装；还在下 → 告知会装在退出时。
 */
export async function checkForUpdateInteractive(win: BrowserWindow | null): Promise<void> {
  if (!app.isPackaged) {
    await showInfo(win, '检查更新', '开发版不检查更新：改动会直接出现在 npm run dev 里。')
    return
  }

  try {
    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo.version ?? null
    const current = app.getVersion()

    if (version !== null && version !== current) {
      const ready = downloadedVersion !== null
      const options = {
        type: 'info' as const,
        title: '发现新版本',
        message: `发现新版本 v${version}（当前 v${current}）`,
        detail: ready
          ? '更新已下载完成。现在重启会直接安装（安装完会自动重新打开应用）。'
          : '正在后台下载，退出应用时会自动完成安装；也可以稍后再来这里立即安装。',
        buttons: ready ? (['立即重启并安装', '稍后'] as string[]) : (['好的'] as string[]),
        defaultId: 0,
        noLink: true
      }
      const choice = win === null ? await dialog.showMessageBox(options) : await dialog.showMessageBox(win, options)
      if (ready && choice.response === 0) {
        setImmediate(() => autoUpdater.quitAndInstall())
      }
      return
    }

    await showInfo(win, '检查更新', `已经是最新版（v${current}）。`)
  } catch (error) {
    await showInfo(
      win,
      '检查更新',
      `检查失败：${(error as Error).message}\n\n` +
        '多见于没有联网，或还没配置发布渠道（electron-builder.yml 的 publish: owner/repo）。'
    )
  }
}
