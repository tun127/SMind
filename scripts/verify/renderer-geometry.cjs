/**
 * 渲染侧验证的宿主：开一个**隐藏的真窗口**，注入真实样式与 renderer-probe.js，
 * 把页面里的断言结果收集回来打印，并据此决定退出码。
 *
 * 用法：npx electron scripts/verify/renderer-geometry.cjs
 * （一条命令的入口见 scripts/verify/run-all.ps1）
 *
 * 为什么不用 mock：CSS 的 flex 约束、`getBoundingClientRect` 的真实值都只有真渲染器能给 ——
 * A3 那次"读代码全对、真机无效"正是栽在这一点上。
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '../..')
const cssPath = path.join(repoRoot, 'src/renderer/src/styles/09-section.css')
const probePath = path.join(__dirname, 'renderer-probe.js')

app.disableHardwareAcceleration()

app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      show: false,
      width: 900,
      height: 600,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false }
    })
    const html = [
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
      '<style>',
      // 真实样式：项目里那份，避免"验证用的 CSS"与产品漂移
      fs.readFileSync(cssPath, 'utf8'),
      'body { margin: 0; }',
      '</style></head><body></body></html>'
    ].join('\n')
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))

    const source = fs.readFileSync(probePath, 'utf8')
    const outcome = await win.webContents.executeJavaScript(source)
    if (!outcome || !Array.isArray(outcome.results)) {
      console.error('渲染侧探针没有返回结果（检查 renderer-probe.js 是否抛错）')
      app.exit(2)
      return
    }
    console.log('=== 渲染侧：CSS 约束 / 探针（真窗口） ===')
    for (const item of outcome.results) {
      console.log(
        `${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? '   << ' + item.detail : ''}`
      )
    }
    console.log(
      `SUMMARY pass=${outcome.results.length - outcome.failures.length} fail=${outcome.failures.length}`
    )
    app.exit(outcome.failures.length === 0 ? 0 : 1)
  })
  .catch((error) => {
    console.error('HARNESS_ERROR', error && error.stack ? error.stack : String(error))
    app.exit(3)
  })
