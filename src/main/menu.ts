import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { IPC, type MenuCommand } from '@shared/ipc'

interface MenuActions {
  /** 开一个新窗口（= 新的一份文档）；由主进程处理，不走渲染进程命令 */
  newWindow: () => void
  /** 打开日志目录（排查崩溃与异常用） */
  openLogs: () => void
  /** 主动检查更新（有结果一定说清楚，与启动时的安静检查不同） */
  checkUpdates: () => void
}

function send(command: MenuCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(IPC.menuCommand, command)
}

export function buildAppMenu(actions: MenuActions): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '新建', accelerator: 'CmdOrCtrl+N', click: () => send('file:new') },
        { label: '新建窗口', accelerator: 'CmdOrCtrl+Shift+N', click: () => actions.newWindow() },
        {
          // 画布（标签页）是文档内部的，想**并排**看两张画布就得再开一个窗口；
          // 开出来的是**副本**：两边互不影响，保存时另存为新文件
          label: '在新窗口打开画布副本',
          click: () => send('file:open-sheet-window')
        },
        {
          label: '打开 / 导入 .xmind…',
          accelerator: 'CmdOrCtrl+O',
          click: () => send('file:open')
        },
        {
          label: '导入',
          submenu: [
            { label: '导入 Markdown 生成导图…', click: () => send('file:import-markdown') },
            { label: '导入 OPML 生成导图…', click: () => send('file:import-opml') },
            { type: 'separator' },
            { label: '导入主题文件…', click: () => send('file:import-theme') }
          ]
        },
        { type: 'separator' },
        { label: '历史记录与常用…', accelerator: 'CmdOrCtrl+H', click: () => send('file:history') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('file:save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('file:save-as') },
        { type: 'separator' },
        {
          label: '导出',
          submenu: [
            {
              label: '图片 / SVG / PDF…',
              accelerator: 'CmdOrCtrl+E',
              click: () => send('file:export-image')
            },
            { type: 'separator' },
            { label: '大纲 · TXT', click: () => send('file:export-txt') },
            { label: '大纲 · Markdown', click: () => send('file:export-md') },
            { label: '大纲 · OPML', click: () => send('file:export-opml') }
          ]
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      // 这些操作故意不注册加速键：
      // Electron 的菜单加速键会抢在页面之前触发，导致「在节点里打字时按 Delete/Backspace
      // 删除的是整个节点」「Ctrl+C 复制的不是选中的文字」。
      // 统一交给渲染进程的键盘处理，它会判断焦点是否在输入框里。
      submenu: [
        { label: '撤销（Ctrl+Z）', click: () => send('edit:undo') },
        { label: '重做（Ctrl+Shift+Z）', click: () => send('edit:redo') },
        { type: 'separator' },
        { label: '复制主题（Ctrl+C）', click: () => send('edit:copy') },
        { label: '粘贴主题（Ctrl+V）', click: () => send('edit:paste') },
        { label: '删除主题（Delete）', click: () => send('edit:delete') }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => send('view:zoom-in') },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => send('view:zoom-out') },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: () => send('view:zoom-reset') },
        { label: '适应画布', accelerator: 'CmdOrCtrl+1', click: () => send('view:fit') },
        {
          label: '视角锁定：跟住选中的主题 / 取消',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => send('view:lock')
        },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '快捷键说明', click: () => send('help:shortcuts') },
        { label: '打开日志目录', click: () => actions.openLogs() },
        { label: '检查更新…', click: () => actions.checkUpdates() },
        { type: 'separator' },
        {
          label: `版本 ${app.getVersion()}`,
          enabled: false
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}
