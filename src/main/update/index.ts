/**
 * 自动更新（electron-updater）。
 *
 * 五条刻意的取舍：
 *
 * 1. **只在打包版启用**：开发版没有 latest.yml 可查，检查必然失败，白报错。
 * 2. **免安装版（portable）不做自动更新**：它运行时把自己解压到临时目录再启动，
 *    electron-updater 会把新版装进那个临时目录，**下次启动仍是旧版**——用户以为更新了、
 *    其实没有。所以对 portable 一律跳过检查，主动检查时给「打开下载页」的出口。
 * 3. **例行检查失败一律安静**：启动时的后台检查不该为「没网 / 镜像还没上 latest.yml」
 *    打扰用户——记日志即可；只有菜单里的**主动检查**才把结果说清楚。
 * 4. **下载在后台、安装放在退出时**（autoInstallOnAppQuit）：不弹窗打断正在画图的人。
 *    真想立刻升级，帮助菜单里随时能主动检查并选择「立即重启安装」。
 * 5. **应用长期开着也要有机会发现新版**：重新获得焦点、且距上次检查超过 6 小时就再查一次
 *    （判据是纯函数 `shouldRecheck`，自检覆盖；失败照旧静默）。
 *
 * 更新源是**自己的镜像**（`electron-builder.yml` 的 `publish: provider: generic`，指向
 * `dl.smindapp.cn`）：GitHub provider 走 GitHub API，匿名额度按 **IP** 限流，国内共享出口
 * 实测已 403，而失败是静默的。镜像里必须有 `latest.yml`（`npm run mirror` 会一起传）。
 *
 * 与签名的关系：签名（Azure Trusted Signing）不是自动更新的前置——未签名也能收提示、
 * 也能在退出时静默装（electron-updater 会校验 latest.yml 里的 SHA512，防下载损坏）。
 * 但**签名是 SmartScreen 信誉的前置**：不签名，用户首次运行与安装时都会看到系统警告。
 * 两者互不阻塞，见 electron-builder.yml 里留好的签名配置位。
 */
import { autoUpdater } from 'electron-updater'
import { app, dialog, shell, type BrowserWindow } from 'electron'
import { isPortableBuild, shouldRecheck } from '@shared/update-policy'

/** 免安装版的手动下载页（它没有自动更新，只能让用户自己去下） */
const PORTABLE_DOWNLOAD_PAGE = 'https://smindapp.cn/download/portable/'

/** 「发现新版本」对话框里最多显示多少字的更新说明（Release 正文可能很长） */
const RELEASE_NOTES_MAX = 800

/** 本机是不是免安装版？判据在 @shared/update-policy（纯函数，自检覆盖两条分支） */
function portableNow(): boolean {
  return isPortableBuild(process.env)
}

/** 已下载完成、等待安装的版本号（null = 没有可立即安装的更新） */
let downloadedVersion: string | null = null

/** 上一次发起检查的时刻（null = 还没查过） */
let lastCheckAt: number | null = null

/** 后台静默检查：记时刻、失败只进日志 */
function checkQuietly(): void {
  lastCheckAt = Date.now()
  void autoUpdater.checkForUpdates().catch(() => undefined)
}

async function showInfo(win: BrowserWindow | null, title: string, message: string): Promise<void> {
  if (win === null) {
    await dialog.showMessageBox({ type: 'info', title, message, noLink: true })
    return
  }
  await dialog.showMessageBox(win, { type: 'info', title, message, noLink: true })
}

/**
 * Release 正文（latest.yml 的 releaseNotes）→ 对话框里能显示的一段纯文本。
 *
 * GitHub 生成的正文可能带 HTML 标签，粗粗剥掉；没有正文就返回 null（对话框照原样显示）。
 */
function releaseNotesOf(raw: unknown): string | null {
  let text = ''
  if (typeof raw === 'string') {
    text = raw
  } else if (Array.isArray(raw)) {
    text = raw
      .map((item) => {
        const note = (item as { note?: unknown } | null)?.note
        return typeof note === 'string' ? note : ''
      })
      .join('\n')
  }
  const clean = text
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (clean.length === 0) return null
  return clean.length > RELEASE_NOTES_MAX ? `${clean.slice(0, RELEASE_NOTES_MAX)}…` : clean
}

/** 应用启动时调用：只在打包版生效，启动后延迟做一次后台检查 */
export function startAutoUpdate(): void {
  if (!app.isPackaged) return
  if (portableNow()) {
    // 装了也不会生效，别白耗网络（原因见文件头第 2 条）
    console.log('[updater] 免安装版：跳过自动更新检查，升级请手动下载新版')
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = console

  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version ?? null
  })

  // 例行检查的失败（离线、镜像没上 latest.yml）记日志就好，别弹窗打扰用户
  autoUpdater.on('error', (error) => {
    console.warn('[updater]', (error as Error).message)
  })

  // 启动 45 秒后再查：别和应用抢启动时的磁盘与网络
  setTimeout(checkQuietly, 45_000)

  // 长期开着的窗口也有机会发现新版：重新获得焦点、且距上次检查超过 6 小时就再查一次
  app.on('browser-window-focus', () => {
    if (!shouldRecheck(lastCheckAt, Date.now())) return
    checkQuietly()
  })
}

/**
 * 帮助菜单的「检查更新…」：主动检查，结果必须说清楚（包括失败）。
 * 有新版且已下载完 → 可以立即重启安装；还在下 → 告知会装在退出时。
 * 免安装版没有自动更新 → 给「打开下载页」。
 */
export async function checkForUpdateInteractive(win: BrowserWindow | null): Promise<void> {
  if (!app.isPackaged) {
    await showInfo(win, '检查更新', '开发版不检查更新：改动会直接出现在 npm run dev 里。')
    return
  }

  if (portableNow()) {
    const options = {
      type: 'info' as const,
      title: '检查更新',
      message: '免安装版不支持自动更新',
      detail:
        '你用的是免安装版：它每次启动都会解压到临时目录，装进去的新版本下次启动就没了。\n\n' +
        '请到官网下载新版（下载后替换原来的 exe 即可，数据与设置都在本机、不会丢）。',
      buttons: ['打开下载页', '知道了'] as string[],
      defaultId: 0,
      noLink: true
    }
    const choice =
      win === null
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(win, options)
    if (choice.response === 0) {
      await shell.openExternal(PORTABLE_DOWNLOAD_PAGE)
    }
    return
  }

  try {
    lastCheckAt = Date.now()
    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo.version ?? null
    const current = app.getVersion()

    if (version !== null && version !== current) {
      const ready = downloadedVersion !== null
      // 「这版改了什么」：发版时把 CHANGELOG 段落写进 Release 正文即可（A6）
      const notes = releaseNotesOf(result?.updateInfo.releaseNotes)
      const lead = ready
        ? '更新已下载完成。现在重启会直接安装（安装完会自动重新打开应用）。'
        : '正在后台下载，退出应用时会自动完成安装；也可以稍后再来这里立即安装。'
      const options = {
        type: 'info' as const,
        title: '发现新版本',
        message: `发现新版本 v${version}（当前 v${current}）`,
        detail: notes === null ? lead : `${lead}\n\n这版改了什么：\n${notes}`,
        buttons: ready ? (['立即重启并安装', '稍后'] as string[]) : (['好的'] as string[]),
        defaultId: 0,
        noLink: true
      }
      const choice =
        win === null
          ? await dialog.showMessageBox(options)
          : await dialog.showMessageBox(win, options)
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
        '多见于没有联网，或镜像里还没有 latest.yml（发版时先 npm run dist，再 npm run mirror）。'
    )
  }
}
