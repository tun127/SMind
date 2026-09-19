import { useEffect } from 'react'
import { defaultDocumentName, fileNameOf } from '@shared/model/naming'
import { useEditor } from '../store/editor'
import { activeDocId } from '../store/tabs'

/**
 * 窗口标题与「本标签开着哪个文件」的上报（自 App.tsx 整块搬出，effect 体逐字未改）。
 *
 * 多标签/多窗口下双击同一个 .xmind 时，主进程靠 reportDocument 聚焦对应窗口，
 * 再由渲染层切到那个标签（同一文件开两份会互相覆盖）。
 */

interface Deps {
  filePath: string | null
  dirty: boolean
  /** 中心主题标题（改名后标题栏要立刻跟着变，所以参与依赖） */
  rootTitle: string
}

export function useWindowTitle({ filePath, dirty, rootTitle }: Deps): void {
  /* ------------------------------------------------------------------ */
  /* 窗口标题                                                            */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    // 未保存过的新文件，标题也用中心主题的名字，和保存时的默认文件名保持一致
    const name = filePath
      ? (fileNameOf(filePath) ?? '未命名导图')
      : defaultDocumentName(useEditor.getState().workbook)
    window.api.setTitle(`${dirty ? '● ' : ''}${name} - SMind`)
    // 告诉主进程「这个标签开着哪个文件」：多标签/多窗口下双击同一个 .xmind 时，
    // 主进程会聚焦对应窗口，由渲染层切到那个标签（同一文件开两份会互相覆盖）
    window.api.reportDocument(activeDocId(), filePath)
    // rootTitle 参与依赖：改名后标题栏要立刻跟着变
  }, [filePath, dirty, rootTitle])
}
