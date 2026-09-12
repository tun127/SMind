import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { RecoveryInfo } from '@shared/ipc'
import { activeRoot, findParent, findTopic } from '@shared/model/tree'
import Canvas from './components/Canvas'
import NodePanel from './components/NodePanel'
import OutlinePanel from './components/OutlinePanel'
import RichFormatBar from './components/RichFormatBar'
import StatusBar from './components/StatusBar'
import ThemePanel from './components/ThemePanel'
import Toolbar from './components/Toolbar'
import { RecoveryDialog, ShortcutsDialog, UnsavedDialog } from './components/Dialogs'
import { viewportActions } from './render/viewport'
import { snapshotForSave, useEditor } from './store/editor'

function fileNameOf(path: string | null): string | null {
  if (!path) return null
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export default function App(): ReactElement {
  const filePath = useEditor((s) => s.filePath)
  const dirty = useEditor((s) => s.dirty)

  const [toast, setToast] = useState<string | null>(null)
  const [recovery, setRecovery] = useState<RecoveryInfo | null>(null)
  const [pending, setPending] = useState<{ run: () => void } | null>(null)
  const [showShortcuts, setShowShortcuts] = useState(false)
  /** 右侧抽屉：同一时刻只开一个 */
  const [sidePanel, setSidePanel] = useState<'none' | 'theme' | 'node'>('none')
  /** 左侧大纲面板：与画布并排显示，改哪边另一边都跟着变 */
  const [showOutline, setShowOutline] = useState(false)
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
          const suggested = state.filePath ?? '未命名导图.xmind'
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

  const openDocument = useCallback(async (): Promise<void> => {
    commitPending()
    try {
      const result = await window.api.openDialog()
      if (!result) return
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
    } catch (err) {
      showToast(`打开失败：${(err as Error).message}`)
    }
  }, [commitPending, showToast])

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

  const newDocument = useCallback((): void => {
    useEditor.getState().newDocument()
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
  /* 菜单命令                                                            */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    const off = window.api.onMenuCommand((command) => {
      const store = useEditor.getState()
      switch (command) {
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
        case 'help:shortcuts':
          setShowShortcuts(true)
          break
        default:
          break
      }
    })
    return off
  }, [guard, newDocument, openDocument, saveDocument])

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
    const name = fileNameOf(filePath) ?? '未命名导图'
    window.api.setTitle(`${dirty ? '● ' : ''}${name} - 思维导图`)
  }, [filePath, dirty])

  /* ------------------------------------------------------------------ */
  /* 键盘快捷键                                                          */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    const navigate = (key: string, selectedId: string | undefined): void => {
      const store = useEditor.getState()
      const root = activeRoot(store.workbook)
      const currentId = selectedId ?? root.id
      if (key === 'ArrowLeft') {
        const parent = findParent(root, currentId)
        if (parent) store.select(parent.id)
        return
      }
      if (key === 'ArrowRight') {
        const node = findTopic(root, currentId)
        if (node && node.children.length > 0) store.select(node.children[0].id)
        return
      }
      const parent = findParent(root, currentId) ?? root
      const index = parent.children.findIndex((c) => c.id === currentId)
      if (index < 0) return
      const nextIndex = key === 'ArrowUp' ? index - 1 : index + 1
      if (nextIndex >= 0 && nextIndex < parent.children.length) store.select(parent.children[nextIndex].id)
    }

    const onKeyDown = (e: KeyboardEvent): void => {
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
          store.paste()
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
        case ' ':
          if (selectedId) {
            e.preventDefault()
            store.toggleCollapse(selectedId)
          }
          break
        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowLeft':
        case 'ArrowRight':
          e.preventDefault()
          navigate(e.key, selectedId)
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

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
          onOutline: () => setShowOutline((current) => !current)
        }}
      />

      <div className={showOutline ? 'app__body app__body--with-outline' : 'app__body'}>
        {showOutline && <OutlinePanel onClose={() => setShowOutline(false)} onNotify={showToast} />}
        <Canvas />
        {sidePanel === 'theme' && <ThemePanel onClose={() => setSidePanel('none')} onNotify={showToast} />}
        {sidePanel === 'node' && <NodePanel onClose={() => setSidePanel('none')} onNotify={showToast} />}
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

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
