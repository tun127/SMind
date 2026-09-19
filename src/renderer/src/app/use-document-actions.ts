import { useCallback, type RefObject } from 'react'
import type { OpenResult } from '@shared/ipc'
import type { OutlineFormat } from '@shared/outline'
import { defaultDocumentName, defaultFileName } from '@shared/model/naming'
import { parseMarkdownOutline } from '@shared/import/markdown'
import { outlineToTopic, type OutlineNode } from '@shared/ai'
import { createWorkbookFromRoot } from '@shared/model/factory'
import { parseOpmlOutline } from '@shared/import/opml'
import { type AppSettings } from '@shared/ipc'
import { BUILTIN_THEMES, type ThemeDefinition } from '@shared/theme'
import { patchAppSettings, snapshotForSave, useEditor } from '../store/editor'
import { activeDocId, useTabs } from '../store/tabs'

/**
 * 文件与多窗口动作（自 App.tsx 整块搬出，回调体逐字未改；本 hook **不含任何 effect**）。
 *
 * 刻意不在这里的：`closeApp` / `closeWindowFlow` / `closeTabById` / `guard` / `receiveExternalFile`
 * 与两个关窗相关 effect —— 它们属于「窗口关闭与未保存确认」这条数据安全链路，
 * 由 App 原样保留（effect 顺序与依赖数组一行未动）。
 */

interface Deps {
  showToast(message: string): void
  themesRef: RefObject<ThemeDefinition[]>
  applyRenderDefaults(settings: AppSettings): void
}

interface Api {
  commitPending(): void
  saveDocument(forceSaveAs?: boolean): Promise<boolean>
  openDocument(): Promise<void>
  openPath(path: string): Promise<void>
  restoreSnapshot(snapshotId: string): Promise<void>
  resolveTheme(id: string | null): ThemeDefinition | null
  onDefaultStyleChanged(): void
  handleSetDefaultTheme(themeId: string): void
  newDocument(): void
  openNewWindow(): void
  openCopyWindow(): void
  openGeneratedInNewWindow(root: OutlineNode, title: string): void
  importTheme(): Promise<void>
  exportOutlineAs(format: OutlineFormat): Promise<void>
  importOutlineFile(kind: 'markdown' | 'opml'): Promise<void>
}

export function useDocumentActions({ showToast, themesRef, applyRenderDefaults }: Deps): Api {
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
          const result = await window.api.saveAs(activeDocId(), state.workbook, suggested)
          if (!result) return false
          useEditor.getState().markSaved(result.path)
          showToast(`已保存到 ${result.path}`)
        } else {
          await window.api.saveToPath(activeDocId(), state.filePath, state.workbook)
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

  /** 把「打开结果」落成**一个标签**（对话框打开与历史记录打开共用一套收尾逻辑） */
  const openIntoTab = useCallback(
    async (result: OpenResult): Promise<void> => {
      const tabs = useTabs.getState()
      // 已经开着这个文件：直接切过去（多标签去重，不会同一文件开两份）
      if (!result.copy) {
        const existing = tabs.findByPath(result.path)
        if (existing) {
          tabs.switchTo(existing)
          showToast('这个文件已经开着，已帮你切换到那个标签')
          return
        }
      }
      // 副本没有磁盘归属：当成未保存的新文档（保存时会提示另存为），
      // 这样它跟原文档完全独立——导入/导出/保存都不会影响另一个画布
      tabs.openWorkbook(result.workbook, result.copy ? null : result.path)
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
      const result = await window.api.openDialog(activeDocId())
      if (!result) return
      await openIntoTab(result)
    } catch (err) {
      showToast(`打开失败：${(err as Error).message}`)
    }
  }, [commitPending, openIntoTab, showToast])

  /** 直接打开某个路径（历史记录里点一条、外部拖入/双击共用） */
  const openPath = useCallback(
    async (path: string): Promise<void> => {
      commitPending()
      try {
        await openIntoTab(await window.api.openPath(activeDocId(), path))
      } catch (err) {
        showToast(`打开失败：${(err as Error).message}`)
      }
    },
    [commitPending, openIntoTab, showToast]
  )

  /** 直接打开某个路径（历史记录里点一条走这里） */

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
        await window.api.snapshotCreate(activeDocId(), {
          workbook: snapshotForSave(store),
          path: store.filePath,
          title: defaultDocumentName(store.workbook),
          reason: 'before-restore'
        })
      } catch {
        // 兜底版本存不上也要继续恢复，不能因此卡住用户
      }

      try {
        const result = await window.api.snapshotRestore(activeDocId(), snapshotId)
        useEditor.getState().restoreDocument(result.workbook)
        const messages = ['已恢复到所选版本（恢复前的状态也留了一份，可再切回）']
        if (result.resourceCount > 0)
          messages.push(`带回了 ${result.resourceCount} 个图片/附件资源`)
        if (result.warnings.length > 0) messages.push(...result.warnings)
        showToast(messages.join('；'))
      } catch (error) {
        showToast(`恢复失败：${(error as Error).message}`)
      }
    },
    [commitPending, showToast]
  )

  /**
   * 按 id 找主题。**内置表也要查**：
   * `themesList()` 返回的只有自定义主题，如果只查它，
   * 用户把内置主题设为默认时会静默失效——这正是「默认主题设置无效」的根因。
   */
  const resolveTheme = useCallback(
    (id: string | null): ThemeDefinition | null => {
      if (!id) return null
      return (
        BUILTIN_THEMES.find((item) => item.id === id) ??
        themesRef.current.find((item) => item.id === id) ??
        null
      )
      // themesRef 是 RefObject、applyRenderDefaults 是模块级函数：身份恒定，
      // 列进依赖数组只是为了满足规则（拆分前它们在组件作用域里被 lint 视为稳定）
    },
    [themesRef]
  )

  /** 「默认样式」改动后的统一收尾：渲染兜底值失效 */
  const onDefaultStyleChanged = useCallback((): void => {
    applyRenderDefaults(useEditor.getState().appSettings)
  }, [applyRenderDefaults])

  /** 主题面板：把某个主题设为新文档的默认主题 */
  const handleSetDefaultTheme = useCallback(
    (themeId: string): void => {
      void patchAppSettings({ defaultThemeId: themeId }).then((next) => {
        applyRenderDefaults(next)
        showToast('已设为新文档的默认主题')
      })
    },
    [showToast, applyRenderDefaults]
  )

  const newDocument = useCallback((): void => {
    commitPending()
    // 新建＝开一个**新标签**：当前文档原样留在自己的标签里，不需要未保存确认
    useTabs.getState().newTab()
    // 新文档按「设置」里的默认主题起手（打开已有文件不动它自己的主题）。
    // 用 primeTheme 而不是 applyTheme：后者会写撤销历史并把新文档标成未保存。
    const theme = resolveTheme(useEditor.getState().appSettings.defaultThemeId)
    if (theme) useEditor.getState().primeTheme(theme)
  }, [commitPending, resolveTheme])

  /* ------------------------------------------------------------------ */
  /* 多窗口（一个窗口 = 一份文档）                                        */
  /* ------------------------------------------------------------------ */

  /**
   * 开一个**新窗口**（一份新文档）。
   * 不需要未保存确认：新窗口是空的，不动当前文档。
   */
  const openNewWindow = useCallback((): void => {
    void window.api.newWindow()
  }, [])

  /**
   * 在**新窗口打开当前画布**（实际是这份文档的**副本**）。
   *
   * 副本完全独立：没有磁盘归属，导入/导出/保存都走自己的路，
   * **不会影响当前文档**——这就是"A 画布新建 B 画布、两者互不影响"的做法。
   * 因为副本是直接从内存里的文档序列化出来的（含未保存改动），不需要先保存。
   */
  const openCopyWindow = useCallback((): void => {
    commitPending()
    const store = useEditor.getState()
    void (async () => {
      const result = await window.api.openWorkbookInNewWindow(activeDocId(), store.workbook)
      showToast(
        result === 'ok'
          ? '已在新窗口打开副本：两边互不影响，保存时会让你另存为新文件'
          : '新窗口打开失败，请重试'
      )
    })()
  }, [commitPending, showToast])

  /**
   * AI「生成新导图」：在**新窗口**里成为一份独立文档（副本语义）。
   * 不往当前文档里塞内容——那会让用户觉得"当前导图被塞了东西"。
   */
  const openGeneratedInNewWindow = useCallback(
    (root: OutlineNode, title: string): void => {
      const workbook = createWorkbookFromRoot(outlineToTopic(root), title || 'AI 导图')
      void (async () => {
        const opened = await window.api.openWorkbookInNewWindow(activeDocId(), workbook)
        showToast(opened === 'ok' ? '已在新窗口生成一份独立导图' : '新窗口打开失败，请重试')
      })()
    },
    [showToast]
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

        // 导入＝在**新窗口**里成为一份独立文档：不往当前文档里塞内容，
        // 也就不会影响用户正在编辑的东西（保存时另存为新文件）
        const workbook = createWorkbookFromRoot(outlineToTopic(parsed.root), fallbackTitle)
        const opened = await window.api.openWorkbookInNewWindow(activeDocId(), workbook)
        const extra = parsed.warnings.length > 0 ? `（${parsed.warnings.join('；')}）` : ''
        showToast(
          opened === 'ok'
            ? `已在新窗口打开「${file.name}」导入的 ${parsed.count} 个主题${extra}`
            : '导入失败：新窗口没能打开'
        )
      } catch (error) {
        showToast(`导入失败：${(error as Error).message}`)
      }
    },
    [commitPending, showToast]
  )
  return {
    commitPending,
    saveDocument,
    openDocument,
    openPath,
    restoreSnapshot,
    resolveTheme,
    onDefaultStyleChanged,
    handleSetDefaultTheme,
    newDocument,
    openNewWindow,
    openCopyWindow,
    openGeneratedInNewWindow,
    importTheme,
    exportOutlineAs,
    importOutlineFile
  }
}
