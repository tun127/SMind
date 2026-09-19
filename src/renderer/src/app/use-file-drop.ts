import { useEffect } from 'react'
import { readableIpcError } from '@shared/ai'
import type { ExtractedDocument } from '@shared/document'
import { MINDMAP_FILE_RE } from '@shared/openfile'
import { useEditor } from '../store/editor'
import { activeDocId } from '../store/tabs'

/**
 * 拖文件进窗口的三种去处（自 App.tsx 整块搬出，effect 体逐字未改）：
 * `.xmind/.emmx/.emm` 放行给主进程打开；图片贴到选中主题；其它文档读成文本交给 AI 生成导图。
 * 不支持的格式也要拦下默认导航——否则界面被替换成那个文件，看起来就像"软件坏了"。
 */

interface Deps {
  showToast(message: string): void
  setDocToMap(value: ExtractedDocument | null): void
}

export function useFileDrop({ showToast, setDocToMap }: Deps): void {
  /* ------------------------------------------------------------------ */
  /* 拖拽图片文件到窗口：贴到选中的主题                                     */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    /**
     * 拖文件进来有三种去处：
     * - `.xmind / .emmx / .emm`：**不拦**，让 Chromium 的默认导航发生，
     *   主进程的 will-navigate 拦截器接住并走「打开文档」流程（既有行为）；
     * - 图片：贴到选中的主题（既有行为）；
     * - 其它文档（docx / xlsx / pptx / md / txt / csv / json / 代码 …）：
     *   读成文本交给 AI，**按文档内容生成导图**。
     *
     * 不支持的格式（如 PDF）也要拦下默认导航：否则整个界面会被替换成那个文件，
     * 看起来就像"软件坏了"；这里给一句人话提示（提示文案由主进程按格式给出）。
     */
    // 导图文件的判定走共享原语（E1 收敛：这里与 ChatPanel 各写过一份同样的正则）
    const IMAGE_RE = /\.(png|jpe?g|gif|bmp|webp|svg|avif)$/i
    /** 混着导图文件时整体交给「打开文档」流程（既有语义，保持不变） */
    const hasMindmap = (files: FileList | null): boolean =>
      files ? Array.from(files).some((file) => MINDMAP_FILE_RE.test(file.name)) : false
    const firstFile = (files: FileList | null, match: (file: File) => boolean): File | null => {
      if (!files) return null
      for (const file of Array.from(files)) if (match(file)) return file
      return null
    }
    const isImage = (file: File): boolean =>
      file.type.startsWith('image/') || IMAGE_RE.test(file.name)
    const pickImageFile = (files: FileList | null): File | null =>
      hasMindmap(files) ? null : firstFile(files, isImage)
    const pickDocumentFile = (files: FileList | null): File | null =>
      hasMindmap(files) ? null : firstFile(files, (file) => !isImage(file))

    const onDragOver = (event: DragEvent): void => {
      const files = event.dataTransfer?.files ?? null
      // 导图文件放行（交给主进程打开），其余一律拦下——不能让 Chromium 导航过去
      if (files && files.length > 0 && !hasMindmap(files)) event.preventDefault()
    }
    const onDrop = (event: DragEvent): void => {
      const files = event.dataTransfer?.files ?? null
      if (hasMindmap(files)) return
      const documentFile = pickDocumentFile(files)
      if (documentFile) {
        event.preventDefault()
        void (async () => {
          try {
            showToast(`正在读取《${documentFile.name}》…`)
            const bytes = new Uint8Array(await documentFile.arrayBuffer())
            const extracted = await window.api.documentExtract(documentFile.name, bytes)
            setDocToMap(extracted)
          } catch (error) {
            showToast(readableIpcError((error as Error).message))
          }
        })()
        return
      }
      const file = pickImageFile(files)
      if (!file) return
      event.preventDefault()
      void (async () => {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const image = await window.api.addImage(activeDocId(), file.name, bytes)
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
  }, [showToast, setDocToMap])
}
