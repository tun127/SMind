import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { OpenResult, RecoveryInfo } from '@shared/ipc'
import type { OutlineFormat } from '@shared/outline'
import { activeRoot } from '@shared/model/tree'
import { defaultDocumentName, defaultFileName } from '@shared/model/naming'
import { parseMarkdownOutline } from '@shared/import/markdown'
import { parseOpmlOutline } from '@shared/import/opml'
import Canvas from './components/Canvas'
import NodePanel from './components/NodePanel'
import OutlinePanel from './components/OutlinePanel'
import RichFormatBar from './components/RichFormatBar'
import SearchPanel from './components/SearchPanel'
import SheetTabs from './components/SheetTabs'
import StatusBar from './components/StatusBar'
import ThemePanel from './components/ThemePanel'
import Toolbar from './components/Toolbar'
import { RecoveryDialog, ShortcutsDialog, UnsavedDialog } from './components/Dialogs'
import AiDialog, { type AiTask } from './components/AiDialog'
import AiSettingsDialog from './components/AiSettingsDialog'
import ExportDialog from './components/ExportDialog'
import HistoryDialog from './components/HistoryDialog'
import { viewportActions } from './render/viewport'
import { bumpMeasureEpoch } from './render/measure'
import { setDefaultTextAlign } from './render/defaults'
import { stageTypedChar } from './editor/typedChar'
import { snapshotForSave, useEditor } from './store/editor'
import SettingsDialog from './components/SettingsDialog'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/ipc'
import type { ThemeDefinition } from '@shared/theme'

/**
 * 把设置里的默认值送到渲染层并让测量缓存失效。
 * 对齐是段落级的兜底默认值（见 render/defaults.ts），改了必须重算测量。
 */
function applyRenderDefaults(settings: AppSettings): void {
  setDefaultTextAlign(settings.defaultAlign)
  bumpMeasureEpoch()
}

function fileNameOf(path: string | null): string | null {
  if (!path) return null
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

interface PastedImage {
  path: string
  width: number
  height: number
}

/**
 * 读取系统剪贴板里的图片。
 *
 * 优先走渲染进程的标准异步剪贴板 API（navigator.clipboard.read）——它读的就是
 * 系统剪贴板，截图 / 复制的图都能拿到；读不到（权限或实现差异）再退回
 * 主进程的 paste-image。两条路都没有图片就返回 null，由调用方按「粘贴节点」处理。
 */
async function readClipboardImage(): Promise<PastedImage | null> {
  try {
    const items = await navigator.clipboard.read()
    for (const item of items) {
      const mime = item.types.find((type) => type.startsWith('image/'))
      if (!mime) continue
      const blob = await item.getType(mime)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (bytes.byteLength === 0) continue
      const picked = await window.api.addImage(
        mime === 'image/jpeg' ? '剪贴板图片.jpg' : '剪贴板图片.png',
        bytes
      )
      if (picked) return { path: picked.path, width: picked.width, height: picked.height }
    }
  } catch {
    /* 渲染进程读不到就走主进程 */
  }
  try {
    const picked = await window.api.pasteImage()
    return picked ? { path: picked.path, width: picked.width, height: picked.height } : null
  } catch {
    return null
  }
}

export default function App(): ReactElement {
  const filePath = useEditor((s) => s.filePath)
  const dirty = useEditor((s) => s.dirty)
  // 只订阅「中心主题的文字」这一个字符串：标题栏与默认文件名都跟着它变，又不至于每次改动都重渲染
  const rootTitle = useEditor((s) => activeRoot(s.workbook).title)

  const [toast, setToast] = useState<string | null>(null)
  const [recovery, setRecovery] = useState<RecoveryInfo | null>(null)
  const [pending, setPending] = useState<{ run: () => void } | null>(null)
  const [showShortcuts, setShowShortcuts] = useState(false)
  /** 右侧抽屉：同一时刻只开一个 */
  const [sidePanel, setSidePanel] = useState<'none' | 'theme' | 'node' | 'search'>('none')
  /** 左侧大纲面板：与画布并排显示，改哪边另一边都跟着变 */
  const [showOutline, setShowOutline] = useState(false)
  /** 导出设置框 */
  const [showExport, setShowExport] = useState(false)
  /** AI 对话框：生成 / 扩写 / 润色 */
  const [aiTask, setAiTask] = useState<AiTask | null>(null)
  const [showAiSettings, setShowAiSettings] = useState(false)
  /** 设置对话框（默认视角锁定 / 默认主题 / 默认对齐） */
  const [showSettings, setShowSettings] = useState(false)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS)
  const themesRef = useRef<ThemeDefinition[]>([])
  /** 历史记录 / 常用 / 保存位置 */
  const [showHistory, setShowHistory] = useState(false)
  const toastTimer = useRef<number | null>(null)
  /** 是否还停在「发现未保存内容」这一步没做决定 */
  const recoveryPendingRef = useRef(false)

  const showToast = useCallback((message: string): void => {
    setToast(message)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 4600)
  }, [])

  /* ------------------------------------------------------------------ */
  /* 文件操作                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 先把「正在编辑但还没提交」的文本落定。
   * 否则 dirty 判断与实际内容不一致，会出现「刚打的字被无声丢掉」。
   */
  const commitPending = useCallback((): void => {
    const store = useEditor.getState()
    if (store.editingId) store.commitEdit()
  }, [])

  const saveDocument = useCallback(
    async (forceSaveAs = false): Promise<boolean> => {
      commitPending()
      const state = useEditor.getState()
      try {
        if (!state.filePath || forceSaveAs) {
          // 默认文件名用中心主题的名字（空标题才退回「未命名导图」）
          const suggested = state.filePath ?? defaultFileName(state.workbook, 'xmind')
          const result = await window.api.saveAs(state.workbook, suggested)
          if (!result) return false
          useEditor.getState().markSaved(result.path)
          showToast(`已保存到 ${result.path}`)
        } else {
          await window.api.saveToPath(state.filePath, state.workbook)
          useEditor.getState().markSaved(state.filePath)
          showToast('已保存')
        }
        await window.api.clearAutosave()
        return true
      } catch (err) {
        showToast(`保存失败：${(err as Error).message}`)
        return false
      }
    },
    [commitPending, showToast]
  )

  /** 把「打开结果」落到编辑器里（对话框打开与历史记录打开共用一套收尾逻辑） */
  const applyOpenResult = useCallback(
    async (result: OpenResult): Promise<void> => {
      useEditor.getState().loadDocument(result.workbook, result.path)
      // 换了文档，上一份的自动存档已经没意义，清掉避免下次启动误提示恢复
      try {
        await window.api.clearAutosave()
      } catch {
        /* 忽略 */
      }
      const messages: string[] = []
      if (result.resourceCount > 0) {
        messages.push(`已加载 ${result.resourceCount} 个图片/附件资源（保存时会一并写回）`)
      }
      if (result.warnings.length > 0) messages.push(...result.warnings)
      if (messages.length > 0) showToast(messages.join('；'))
    },
    [showToast]
  )

  const openDocument = useCallback(async (): Promise<void> => {
    commitPending()
    try {
      const result = await window.api.openDialog()
      if (!result) return
      await applyOpenResult(result)
    } catch (err) {
      showToast(`打开失败：${(err as Error).message}`)
    }
  }, [commitPending, applyOpenResult, showToast])

  /** 直接打开某个路径（历史记录里点一条走这里） */
  const openPath = useCallback(
    async (path: string): Promise<void> => {
      commitPending()
      try {
        await applyOpenResult(await window.api.openPath(path))
      } catch (err) {
        showToast(`打开失败：${(err as Error).message}`)
      }
    },
    [commitPending, applyOpenResult, showToast]
  )

  /**
   * 恢复到某个历史版本。
   *
   * 恢复前**先自动存一份「恢复前」的版本**：万一点错了还能再回来，
   * 这也是恢复动作不进撤销栈的安全网。
   */
  const restoreSnapshot = useCallback(
    async (snapshotId: string): Promise<void> => {
      commitPending()
      const store = useEditor.getState()

      try {
        await window.api.snapshotCreate({
          workbook: snapshotForSave(store),
          path: store.filePath,
          title: defaultDocumentName(store.workbook),
          reason: 'before-restore'
        })
      } catch {
        // 兜底版本存不上也要继续恢复，不能因此卡住用户
      }

      try {
        const result = await window.api.snapshotRestore(snapshotId)
        useEditor.getState().restoreDocument(result.workbook)
        const messages = ['已恢复到所选版本（恢复前的状态也留了一份，可再切回）']
        if (result.resourceCount > 0) messages.push(`带回了 ${result.resourceCount} 个图片/附件资源`)
        if (result.warnings.length > 0) messages.push(...result.warnings)
        showToast(messages.join('；'))
      } catch (error) {
        showToast(`恢复失败：${(error as Error).message}`)
      }
    },
    [commitPending, showToast]
  )

  /**
   * 正常关闭应用。
   * 关键：关闭前必须清掉自动存档，否则「不保存退出」后下次启动还会反复提示恢复。
   * 但如果用户还停在「发现未保存内容」的弹窗上没有做决定，就不能悄悄删掉存档。
   */
  const closeApp = useCallback((): void => {
    const finish = (): void => window.api.confirmClose()
    if (recoveryPendingRef.current) {
      finish()
      return
    }
    void (async () => {
      try {
        await window.api.clearAutosave()
      } catch {
        /* 忽略：清不掉也不该阻塞关闭 */
      }
      finish()
    })()
  }, [])

  /* 启动时读一次应用设置与主题库：默认参数影响新建文档、主题下拉可选项 */
  useEffect(() => {
    void (async () => {
      try {
        const loaded = await window.api.settingsLoad()
        setSettings(loaded)
        useEditor.getState().setAppSettings(loaded)
        applyRenderDefaults(loaded)
      } catch {
        /* 读不到就用内置默认值 */
      }
      try {
        themesRef.current = await window.api.themesList()
      } catch {
        themesRef.current = []
      }
    })()
  }, [])

  /** 设置对话框改动：即时写进 store（影响后续新建文档）并落盘 */
  const updateSettings = useCallback((next: AppSettings): void => {
    setSettings(next)
    useEditor.getState().setAppSettings(next)
    applyRenderDefaults(next)
    void window.api.settingsSave(next).catch(() => undefined)
  }, [])

  const newDocument = useCallback((): void => {
    useEditor.getState().newDocument()
    // 新建文档时套用「设置」里的默认主题（打开已有文件不动它自己的主题）
    const preferred = useEditor.getState().appSettings.defaultThemeId
    if (preferred) {
      const theme = themesRef.current.find((item) => item.id === preferred)
      if (theme) useEditor.getState().applyTheme({ id: theme.id, name: theme.name, colors: theme.colors })
    }
    // 一并清掉上一份文档残留的自动存档与附件资源，
    // 否则旧文件的图片会被写进新文件
    void window.api.documentReset()
  }, [])

  /** 有未保存内容时先弹确认框（先把未提交的输入落定，dirty 才准确） */
  const guard = useCallback(
    (run: () => void): void => {
      commitPending()
      if (useEditor.getState().dirty) setPending({ run })
      else run()
    },
    [commitPending]
  )

  /* ------------------------------------------------------------------ */
  /* 导入 / 导出（工具栏与菜单共用）                                      */
  /* ------------------------------------------------------------------ */

  /** 导入主题文件（.json），存进「我的主题」 */
  const importTheme = useCallback(async (): Promise<void> => {
    try {
      const theme = await window.api.themesImport()
      if (!theme) return
      await window.api.themesSave(theme)
      showToast(`已导入主题「${theme.name}」，可在「主题外观」里选用`)
    } catch (error) {
      showToast(`导入主题失败：${(error as Error).message}`)
    }
  }, [showToast])

  /** 导出当前画布的大纲（TXT / Markdown / OPML） */
  const exportOutlineAs = useCallback(
    async (format: OutlineFormat): Promise<void> => {
      commitPending()
      try {
        const workbook = useEditor.getState().workbook
        const path = await window.api.exportOutline(workbook, format)
        if (path) showToast(`已导出大纲：${path}`)
      } catch (error) {
        showToast(`导出大纲失败：${(error as Error).message}`)
      }
    },
    [commitPending, showToast]
  )

  /**
   * 导入 Markdown / OPML 一键生成导图。
   * 解析逻辑在 shared 里（纯函数、有自检），这里只负责选文件、落地到新画布、给提示。
   */
  const importOutlineFile = useCallback(
    async (kind: 'markdown' | 'opml'): Promise<void> => {
      commitPending()
      try {
        const file = await window.api.importText(kind)
        if (!file) return

        const fallbackTitle = file.name.replace(/\.[^.]+$/, '') || '导入的大纲'
        const parsed =
          kind === 'markdown'
            ? parseMarkdownOutline(file.text, fallbackTitle)
            : parseOpmlOutline(file.text, fallbackTitle)

        if (!parsed.root) {
          showToast(`导入失败：${parsed.warnings.join('；') || '文件里没有可用的大纲'}`)
          return
        }

        const count = useEditor.getState().applyOutlineTree({ kind: 'newSheet' }, parsed.root, fallbackTitle)
        const extra = parsed.warnings.length > 0 ? `（${parsed.warnings.join('；')}）` : ''
        showToast(`已从「${file.name}」导入 ${count} 个主题${extra}，可用 Ctrl+Z 撤回`)
      } catch (error) {
        showToast(`导入失败：${(error as Error).message}`)
      }
    },
    [commitPending, showToast]
  )

  /* ------------------------------------------------------------------ */
  /* 菜单命令                                                            */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    const off = window.api.onMenuCommand((command) => {
      const store = useEditor.getState()
      switch (command) {
        case 'app:settings':
          setShowSettings(true)
          break
        case 'file:new':
          guard(newDocument)
          break
        case 'file:open':
          guard(() => void openDocument())
          break
        case 'file:save':
          void saveDocument(false)
          break
        case 'file:save-as':
          void saveDocument(true)
          break
        case 'edit:undo':
          store.undo()
          break
        case 'edit:redo':
          store.redo()
          break
        case 'edit:delete':
          store.deleteSelection()
          break
        case 'edit:copy':
          store.copySelection()
          break
        case 'edit:paste':
          store.paste()
          break
        case 'view:zoom-in':
          viewportActions.zoomTo(store.zoom * 1.2)
          break
        case 'view:zoom-out':
          viewportActions.zoomTo(store.zoom / 1.2)
          break
        case 'view:zoom-reset':
          viewportActions.zoomTo(1)
          break
        case 'view:fit':
          viewportActions.fit()
          break
        case 'view:lock':
          // 视角锁定：开着的时候视角始终把选中的主题按在视口正中
          showToast(
            store.toggleViewLock() ? '视角锁定：已开启，视角会跟住选中的主题' : '视角锁定：已关闭'
          )
          break
        case 'help:shortcuts':
          setShowShortcuts(true)
          break
        case 'file:import-theme':
          void importTheme()
          break
        case 'file:import-markdown':
          void importOutlineFile('markdown')
          break
        case 'file:import-opml':
          void importOutlineFile('opml')
          break
        case 'file:export-image':
          setShowExport(true)
          break
        case 'file:export-txt':
          void exportOutlineAs('txt')
          break
        case 'file:export-md':
          void exportOutlineAs('md')
          break
        case 'file:export-opml':
          void exportOutlineAs('opml')
          break
        case 'file:history':
          setShowHistory(true)
          break
        default:
          break
      }
    })
    return off
  }, [
    guard,
    newDocument,
    openDocument,
    saveDocument,
    importTheme,
    importOutlineFile,
    exportOutlineAs,
    showToast
  ])

  /**
   * 从文件管理器打开本地文档。
   *
   * - **启动时**（双击 `.xmind` / 把文件拖到 exe 上 / 右键「打开方式 → Mind」）：路径在命令行里，
   *   主进程替我们存着，这里就绪后取一次（取走即清空）；
   * - **窗口已经开着时**再打开一个：主进程通过 `fileOpenRequest` 推过来。
   *
   * 两条路都走 `guard`，避免在"有未保存改动"时静默替换掉当前文档。
   */
  useEffect(() => {
    void window.api.openFilePending().then((path) => {
      if (path) guard(() => void openPath(path))
    })
    return window.api.onFileOpenRequest((path) => guard(() => void openPath(path)))
  }, [guard, openPath])

  /* ------------------------------------------------------------------ */
  /* 关闭窗口                                                            */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    const off = window.api.onCloseRequest(() => {
      commitPending()
      if (useEditor.getState().dirty) setPending({ run: closeApp })
      else closeApp()
    })
    return off
  }, [commitPending, closeApp])

  /* ------------------------------------------------------------------ */
  /* 自动保存                                                            */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    const timer = window.setInterval(() => {
      const store = useEditor.getState()
      if (!store.dirty) return
      // 用快照而不是直接落库：把正在输入但还没提交的文本也写进去，
      // 同时不打断用户的输入（不会退出编辑态）
      void window.api.autosave(
        snapshotForSave(store),
        store.filePath,
        fileNameOf(store.filePath) ?? '未命名导图'
      )
    }, 30000)
    return () => window.clearInterval(timer)
  }, [])

  /* ------------------------------------------------------------------ */
  /* 自动版本快照                                                        */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    // 每 10 分钟留一个版本；内容与上一份相同（或距上次太近）时
    // 主进程会按内容指纹直接忽略，不会白写盘。
    // 只对「已保存过的文档」记录：还没有路径的文档由自动保存与崩溃恢复兜底。
    const timer = window.setInterval(() => {
      const store = useEditor.getState()
      if (!store.filePath) return
      void window.api
        .snapshotCreate({
          workbook: snapshotForSave(store),
          path: store.filePath,
          title: defaultDocumentName(store.workbook),
          reason: 'auto'
        })
        .catch(() => undefined)
    }, 600000)
    return () => window.clearInterval(timer)
  }, [])

  /* ------------------------------------------------------------------ */
  /* 崩溃恢复                                                            */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    void (async () => {
      try {
        const info = await window.api.recoveryCheck()
        if (info) {
          recoveryPendingRef.current = true
          setRecovery(info)
        }
      } catch {
        /* 忽略 */
      }
    })()
  }, [])

  const handleRestore = useCallback(async (): Promise<void> => {
    setRecovery(null)
    try {
      const result = await window.api.recoveryLoad()
      if (result) {
        useEditor.getState().loadDocument(result.workbook, result.path || null)
        showToast('已恢复未保存的内容')
      }
    } catch (err) {
      // 存档读不出来（多半已损坏），清掉它，否则每次启动都会再问一次
      void window.api.recoveryDiscard()
      showToast(`恢复失败：${(err as Error).message}`)
    } finally {
      recoveryPendingRef.current = false
    }
  }, [showToast])

  const handleDiscardRecovery = useCallback((): void => {
    recoveryPendingRef.current = false
    setRecovery(null)
    void window.api.recoveryDiscard()
  }, [])

  /* ------------------------------------------------------------------ */
  /* 窗口标题                                                            */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    // 未保存过的新文件，标题也用中心主题的名字，和保存时的默认文件名保持一致
    const name = filePath
      ? (fileNameOf(filePath) ?? '未命名导图')
      : defaultDocumentName(useEditor.getState().workbook)
    window.api.setTitle(`${dirty ? '● ' : ''}${name} - SMind`)
    // 顺手告诉主进程「这个窗口开着哪个文件」：多窗口下双击同一个 .xmind 时，
    // 主进程会聚焦已经开着它的那个窗口，而不是又开一份（同一个文件两边改会互相覆盖）
    window.api.reportDocument(filePath)
    // rootTitle 参与依赖：改名后标题栏要立刻跟着变
  }, [filePath, dirty, rootTitle])

  /**
   * 画布上选中了画布元素（概要 / 边界 / 关系线）时把节点属性面板打开：
   * 它们的文字、字体、删除入口都在面板里，选中了却不给看，用户会以为"选中没生效"。
   */
  const nodePanelTick = useEditor((state) => state.nodePanelTick)
  useEffect(() => {
    if (nodePanelTick > 0) setSidePanel('node')
  }, [nodePanelTick])

  /* ------------------------------------------------------------------ */
  /* 键盘快捷键                                                          */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // 已经被内层处理掉的按键不再重复处理（例如富文本编辑器自己的快捷键）
      if (e.defaultPrevented) return
      // 输入法组词过程中的按键交给输入法处理
      if (e.isComposing || e.keyCode === 229) return

      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }

      const store = useEditor.getState()
      const selectedId = store.selection[0]

      /**
       * 仍在编辑态时（焦点可能因为点了底部格式栏而离开编辑器），**单键动作一律不接管**：
       * 否则"想输入空格"会被当成折叠主题、想输入字符会被当成删除/新建节点。
       * Ctrl 组合键（保存、撤销、搜索…）照旧放行。
       */
      if (store.editingId && !(e.ctrlKey || e.metaKey)) return

      // Alt+↑ / ↓：同级上移 / 下移（知犀的写法，和 Ctrl+Shift+方向键等价）
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        store.moveSelectionByKey(e.key)
        return
      }

      // Alt+C：给选中主题打开代码块编辑（面板聚焦到代码输入框）
      if (e.altKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault()
        if (selectedId) {
          setSidePanel('node')
          useEditor.getState().requestCodeFocus()
        }
        return
      }

      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase()
        if (key === 'z') {
          e.preventDefault()
          if (e.shiftKey) store.redo()
          else store.undo()
        } else if (key === 'y') {
          e.preventDefault()
          store.redo()
        } else if (key === 'c') {
          e.preventDefault()
          store.copySelection()
        } else if (key === 'v') {
          e.preventDefault()
          // 先试剪贴板里的图片（截图后直接 Ctrl+V 贴到选中的主题上）；没有图片再按「粘贴节点」处理
          void (async () => {
            if (!store.editingId && selectedId) {
              const image = await readClipboardImage()
              if (image) {
                useEditor
                  .getState()
                  .setImage(selectedId, { path: image.path, width: image.width, height: image.height })
                showToast(
                  image.width > 0
                    ? `已把剪贴板图片贴到选中的主题（${image.width}×${image.height}）`
                    : '已把剪贴板图片贴到选中的主题（未取到像素尺寸，按默认大小显示）'
                )
                return
              }
            }
            useEditor.getState().paste()
          })()
        } else if (key === 'f') {
          // Ctrl+F：打开搜索面板（与 Xmind 一致）
          e.preventDefault()
          setSidePanel('search')
        } else if (e.key === '/') {
          // Ctrl+/：折叠 / 展开。空格已经让给"直接输入空格"（选中后直接打字即进入编辑）
          e.preventDefault()
          if (selectedId) store.toggleCollapse(selectedId)
        } else if (
          // 编辑态里 Ctrl+Shift+方向键交给浏览器/编辑器（选词），不要去挪节点
          !store.editingId &&
          e.shiftKey &&
          (e.key === 'ArrowUp' ||
            e.key === 'ArrowDown' ||
            e.key === 'ArrowLeft' ||
            e.key === 'ArrowRight' ||
            e.key === 'Home' ||
            e.key === 'End')
        ) {
          // Ctrl+Shift+方向键：选中主题的精确移动（与亿图脑图一致）
          e.preventDefault()
          store.moveSelectionByKey(e.key)
        }
        return
      }

      switch (e.key) {
        case 'Tab':
          e.preventDefault()
          store.addChild(selectedId)
          break
        case 'Enter':
          e.preventDefault()
          store.addSibling(selectedId)
          break
        case 'F2':
          if (selectedId) {
            e.preventDefault()
            store.beginEdit(selectedId)
          }
          break
        case 'Delete':
        case 'Backspace':
          e.preventDefault()
          store.deleteSelection()
          break
        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowLeft':
        case 'ArrowRight':
          e.preventDefault()
          store.navigateSelection(e.key)
          break
        default:
          /**
           * 选中主题后**直接打字就进入编辑**（Xmind 的手感）。
           *
           * 两条防呆：
           * 1. 空格只用来"进入编辑"，**不落字**——输入法用空格选词、用户也可能只是
           *    习惯性按一下，在空白框里留下一个前导空格没有任何意义；
           * 2. 其它字符落字后**寄存**一笔（`stageTypedChar`）：它可能只是拼音的第一个
           *    字母（输入法组词时的第一个 keydown 完全看不出组词迹象），
           *    编辑器发现真正的组词开始后会把这个字符让给输入法，避免空框里冒出 `w` 这种怪字符。
           */
          if (selectedId && !e.altKey && e.key.length === 1) {
            e.preventDefault()
            if (e.key === ' ') {
              store.beginEdit(selectedId)
            } else {
              store.beginEdit(selectedId, e.key)
              stageTypedChar(selectedId, e.key)
            }
          }
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /* ------------------------------------------------------------------ */
  /* 拖拽图片文件到窗口：贴到选中的主题                                     */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    // 文档文件（.xmind 等）不拦：不 preventDefault，让 Chromium 的默认导航发生，
    // 主进程的 will-navigate 拦截器才能接住并走「打开文档」流程
    const DOCUMENT_RE = /\.(xmind|emmx|emm)$/i
    const pickImageFile = (files: FileList | null): File | null => {
      if (!files) return null
      for (const file of Array.from(files)) {
        if (DOCUMENT_RE.test(file.name)) return null // 混着文档时整体交给文档流程
        if (file.type.startsWith('image/') || /\.(png|jpe?g|gif|bmp|webp|svg|avif)$/i.test(file.name)) {
          return file
        }
      }
      return null
    }
    const onDragOver = (event: DragEvent): void => {
      if (pickImageFile(event.dataTransfer?.files ?? null)) event.preventDefault()
    }
    const onDrop = (event: DragEvent): void => {
      const file = pickImageFile(event.dataTransfer?.files ?? null)
      if (!file) return
      event.preventDefault()
      void (async () => {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const image = await window.api.addImage(file.name, bytes)
          const store = useEditor.getState()
          const id = store.selection[0]
          if (!image || !id) {
            showToast('请先选中一个主题，再把图片拖进来')
            return
          }
          store.setImage(id, { path: image.path, width: image.width, height: image.height })
          showToast(
            image.width > 0
              ? `已插入图片 ${file.name}（${image.width}×${image.height}）`
              : `已插入图片 ${file.name}（未取到像素尺寸，按默认大小显示）`
          )
        } catch (error) {
          showToast(`插入图片失败：${(error as Error).message}`)
        }
      })()
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [showToast])

  /* ------------------------------------------------------------------ */

  const displayName = fileNameOf(filePath) ?? '未命名导图'

  return (
    <div className="app">
      <Toolbar
        outlineOpen={showOutline}
        actions={{
          onNew: () => guard(newDocument),
          onOpen: () => guard(() => void openDocument()),
          onSave: () => void saveDocument(false),
          onSaveAs: () => void saveDocument(true),
          onHelp: () => setShowShortcuts(true),
          onThemes: () => setSidePanel((current) => (current === 'theme' ? 'none' : 'theme')),
          onNodes: () => setSidePanel((current) => (current === 'node' ? 'none' : 'node')),
          onOutline: () => setShowOutline((current) => !current),
          onSearch: () => setSidePanel((current) => (current === 'search' ? 'none' : 'search')),
          onRelayout: () => useEditor.getState().relayoutAll(),
          onFormula: () => {
            setSidePanel('node')
            useEditor.getState().requestFormulaFocus()
          },
          onCode: () => {
            setSidePanel('node')
            useEditor.getState().requestCodeFocus()
          },
          onExport: () => setShowExport(true),
          onImportTheme: () => void importTheme(),
          onImportMarkdown: () => void importOutlineFile('markdown'),
          onImportOpml: () => void importOutlineFile('opml'),
          onExportOutline: (format) => void exportOutlineAs(format),
          onAiGenerate: () => setAiTask('generate'),
          onAiExpand: () => setAiTask('expand'),
          onAiPolish: () => setAiTask('polish'),
          onAiSettings: () => setShowAiSettings(true),
          onHistory: () => setShowHistory(true)
        }}
      />

      <div className={showOutline ? 'app__body app__body--tabs app__body--with-outline' : 'app__body app__body--tabs'}>
        {showOutline && <OutlinePanel onClose={() => setShowOutline(false)} onNotify={showToast} />}
        <Canvas />
        <SheetTabs onNotify={showToast} />
        {sidePanel === 'theme' && <ThemePanel onClose={() => setSidePanel('none')} onNotify={showToast} />}
        {sidePanel === 'node' && <NodePanel onClose={() => setSidePanel('none')} onNotify={showToast} />}
        {sidePanel === 'search' && <SearchPanel onClose={() => setSidePanel('none')} onNotify={showToast} />}
      </div>

      {/* 仅在进入编辑态时出现 */}
      <RichFormatBar />

      <StatusBar />

      {recovery && (
        <RecoveryDialog
          info={recovery}
          onRestore={() => void handleRestore()}
          onDiscard={handleDiscardRecovery}
        />
      )}

      {pending && (
        <UnsavedDialog
          fileName={displayName}
          onCancel={() => setPending(null)}
          onDiscard={() => {
            const action = pending
            setPending(null)
            action.run()
          }}
          onSave={() => {
            const action = pending
            setPending(null)
            void saveDocument(false).then((ok) => {
              if (ok) action.run()
            })
          }}
        />
      )}

      {showShortcuts && <ShortcutsDialog onClose={() => setShowShortcuts(false)} />}

      {showExport && <ExportDialog onClose={() => setShowExport(false)} onNotify={showToast} />}

      {aiTask && <AiDialog task={aiTask} onClose={() => setAiTask(null)} onNotify={showToast} />}

      {showAiSettings && (
        <AiSettingsDialog onClose={() => setShowAiSettings(false)} onNotify={showToast} />
      )}

      {showSettings && (
        <SettingsDialog
          settings={settings}
          themes={themesRef.current}
          onChange={updateSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showHistory && (
        <HistoryDialog
          onClose={() => setShowHistory(false)}
          onNotify={showToast}
          onOpenFile={(path) => guard(() => void openPath(path))}
          onRestore={(snapshotId) => guard(() => void restoreSnapshot(snapshotId))}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
