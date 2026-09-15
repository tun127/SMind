import type { ReactElement } from 'react'
import { activeSheet, countCharacters, countTopics } from '@shared/model/tree'
import { useEditor } from '../store/editor'

function fileNameOf(path: string | null): string | null {
  if (!path) return null
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** 构建时间戳（构建时注入，见 electron.vite.config.ts） */
declare const __BUILD_STAMP__: string

/** 开发版的渲染层走 http，打包版是 file://：用它区分，省掉对 vite/client 类型的依赖 */
const isDev = !window.location.protocol.startsWith('file')

/**
 * 「构建 HH:MM:SS」。
 *
 * 开发期唯一用途：判断眼前这个窗口是不是**旧的**。改完代码却没热更时，
 * 用户（和开发者）会在旧界面上复验，白折腾一轮——把这个时间摆在状态栏就不必猜了。
 */
function buildStamp(): string {
  if (!isDev) return ''
  const at = new Date(__BUILD_STAMP__)
  if (Number.isNaN(at.getTime())) return ''
  return `构建 ${at.toLocaleTimeString('zh-CN', { hour12: false })}`
}

export default function StatusBar(): ReactElement {
  const workbook = useEditor((s) => s.workbook)
  const filePath = useEditor((s) => s.filePath)
  const dirty = useEditor((s) => s.dirty)
  const zoom = useEditor((s) => s.zoom)
  const viewLock = useEditor((s) => s.viewLock)
  const toggleViewLock = useEditor((s) => s.toggleViewLock)

  const sheet = activeSheet(workbook)
  const root = sheet.rootTopic
  const nodes = countTopics(root)
  const chars = countCharacters(root)

  return (
    <div className="statusbar">
      <div className="statusbar__left">
        <span className="statusbar__file" title={filePath ?? '尚未保存到磁盘'}>
          {fileNameOf(filePath) ?? '未命名导图'}
        </span>
        <span className={dirty ? 'statusbar__dot statusbar__dot--dirty' : 'statusbar__dot'} />
        <span className="statusbar__hint">{dirty ? '有未保存的修改' : '已保存'}</span>
        {filePath && (
          <button
            type="button"
            className="statusbar__link"
            onClick={() => window.api.showInFolder(filePath)}
          >
            在文件夹中显示
          </button>
        )}
      </div>

      <div className="statusbar__right">
        <span>画布：{sheet.title}</span>
        <span className="statusbar__sep">|</span>
        <span>主题 {nodes}</span>
        <span className="statusbar__sep">|</span>
        <span>字数 {chars}</span>
        <span className="statusbar__sep">|</span>
        <span>缩放 {Math.round(zoom * 100)}%</span>
        {buildStamp().length > 0 && (
          <>
            <span className="statusbar__sep">|</span>
            <span title="当前界面的构建时间（开发版）：比你最后一次改动还旧，就说明窗口没热更、看的是旧代码">
              {buildStamp()}
            </span>
          </>
        )}
        {viewLock && (
          <>
            <span className="statusbar__sep">|</span>
            <button
              type="button"
              className="statusbar__link"
              title="视角锁定中：视角始终跟住选中的主题（点击取消）"
              onClick={() => toggleViewLock()}
            >
              视角锁定
            </button>
          </>
        )}
      </div>
    </div>
  )
}
