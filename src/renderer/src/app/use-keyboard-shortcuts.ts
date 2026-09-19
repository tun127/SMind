import { useEffect } from 'react'
import { inlineRunsToRich, looksLikeMarkdown, parseInlineMarkdown } from '@shared/import/markdown'
import { stageTypedChar } from '../editor/typedChar'
import { useEditor } from '../store/editor'
import { activeDocId } from '../store/tabs'

/**
 * 全局键盘快捷键（自 App.tsx 整块搬出，effect 体逐字未改）。
 *
 * 模块级助手 `hasDomTextSelection` / `readClipboardImage`（含 `PastedImage`）随块搬来：
 * 它们只被这条链路使用。依赖数组仍是 `[showToast]`。
 */

interface Deps {
  showToast(message: string): void
  setSidePanel(value: 'none' | 'theme' | 'node' | 'search' | 'chat'): void
}

export function useKeyboardShortcuts({ showToast, setSidePanel }: Deps): void {
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
          /**
           * 面板里真的选中了文字（聊天回答、节点详情…）→ 把 Ctrl+C **交还给浏览器**。
           *
           * 画布上的节点是 `user-select: none`，所以「有 DOM 选区」就等于「用户选的是面板里的文字」。
           * 以前这里无条件 preventDefault，结果从聊天里复制不出任何东西——
           * 用户报的「无法从会话粘贴东西」根因就在这里（复制不出，当然粘不了）。
           */
          if (hasDomTextSelection()) return
          e.preventDefault()
          store.copySelection()
        } else if (key === 'v') {
          e.preventDefault()
          // 依次试：剪贴板图片 → 带 Markdown 标记的文本 → 内部复制的节点
          void (async () => {
            if (!store.editingId && selectedId) {
              const image = await readClipboardImage()
              if (image) {
                useEditor.getState().setImage(selectedId, {
                  path: image.path,
                  width: image.width,
                  height: image.height
                })
                showToast(
                  image.width > 0
                    ? `已把剪贴板图片贴到选中的主题（${image.width}×${image.height}）`
                    : '已把剪贴板图片贴到选中的主题（未取到像素尺寸，按默认大小显示）'
                )
                return
              }

              // 文本里带 Markdown 标记（`==高亮==`、`^上标^`、`A[^1]`…）→ 建成带格式的子主题。
              // 编辑器内粘贴由 RichTextEditor 自己处理；这里是"选中节点、没在编辑"时的路径。
              const text = await window.api.readClipboardText().catch(() => '')
              const lines = text
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line.length > 0 && looksLikeMarkdown(line))
              if (lines.length > 0) {
                const items = lines.map((line) => {
                  const inline = parseInlineMarkdown(line)
                  return { title: inline.text, rich: inlineRunsToRich(inline.runs) }
                })
                const count = useEditor.getState().addRichChildren(selectedId, items)
                showToast(`已按 Markdown 粘贴 ${count} 个带格式的子主题（可用 Ctrl+Z 撤回）`)
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
    // showToast 是 useCallback([]) 出来的稳定引用，列进来只是为了让依赖完整
  }, [showToast, setSidePanel])
}

/** 用户是否在页面里真的选中了文字（画布节点不可选中，所以有选区就是面板/输入框里的文字） */
function hasDomTextSelection(): boolean {
  const selection = window.getSelection()
  return selection !== null && selection.toString().trim().length > 0
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
        activeDocId(),
        mime === 'image/jpeg' ? '剪贴板图片.jpg' : '剪贴板图片.png',
        bytes
      )
      if (picked) return { path: picked.path, width: picked.width, height: picked.height }
    }
  } catch {
    /* 渲染进程读不到就走主进程 */
  }
  try {
    const picked = await window.api.pasteImage(activeDocId())
    return picked ? { path: picked.path, width: picked.width, height: picked.height } : null
  } catch {
    return null
  }
}
