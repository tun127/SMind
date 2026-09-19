/**
 * 工具栏末端的「从更多 ▾ 拿出来」组：新建窗口 / 画布副本 / 历史记录 / 启动默认视角锁定 / 快捷键。
 *
 * JSX 自 Toolbar.tsx 整块搬出、逐字未改；这些都默认收在「更多 ▾」里，拿出一个显示一个。
 */

import { AppWindow, CircleHelp, Copy, Crosshair, History as HistoryIcon } from 'lucide-react'
import type { ReactElement } from 'react'
import { patchAppSettings } from '../../store/editor'
import type { ToolbarActions } from '../Toolbar'
import type { QuickRender } from './quick-items'

interface Props {
  actions: ToolbarActions
  quick: QuickRender
  /** 启动时是否默认开启视角锁定（决定按钮按下态与点击后的取反） */
  defaultViewLock: boolean
}

export default function PinnedGroup({ actions, quick, defaultViewLock }: Props): ReactElement {
  return (
    // 从「更多 ▾」拿出来的功能落在这里：默认全部收着，拿出一个显示一个
    <div className="toolbar__group">
      {quick(
        'new-window',
        <button
          type="button"
          className="tool-btn"
          title="新建窗口（Ctrl+Shift+N）"
          onClick={actions.onNewWindow}
        >
          <AppWindow size={17} />
        </button>
      )}
      {quick(
        'sheet-copy',
        <button
          type="button"
          className="tool-btn"
          title="在新窗口打开画布副本（副本独立，不影响当前文档）"
          onClick={actions.onOpenSheetWindow}
        >
          <Copy size={17} />
        </button>
      )}
      {quick(
        'history',
        <button
          type="button"
          className="tool-btn"
          title="历史记录与常用（最近打开 / 固定常用 / 默认保存位置）"
          onClick={actions.onHistory}
        >
          <HistoryIcon size={17} />
        </button>
      )}
      {quick(
        'default-view-lock',
        <button
          type="button"
          className={defaultViewLock ? 'tool-btn tool-btn--active' : 'tool-btn'}
          title="启动时默认开启视角锁定（只影响新开文档，点击切换）"
          onClick={() => void patchAppSettings({ defaultViewLock: !defaultViewLock })}
        >
          <Crosshair size={17} />
        </button>
      )}
      {quick(
        'shortcuts',
        <button type="button" className="tool-btn" title="快捷键说明" onClick={actions.onHelp}>
          <CircleHelp size={17} />
        </button>
      )}
    </div>
  )
}
