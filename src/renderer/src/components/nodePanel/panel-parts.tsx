/**
 * 节点属性面板的公共零件。
 *
 * 头部栏在拆分前是 NodePanel 里的一个 JSX 变量（三条分支各引用一次），
 * 分支拆成组件后收成这里的一个组件——DOM 输出与原来逐字符相同。
 */

import { X } from 'lucide-react'
import type { ReactElement } from 'react'
import { useEditor } from '../../store/editor'

/** 新建代码块的默认语言：来自「默认样式」面板的设置（null = 纯文本） */
export function defaultCodeLanguage(): string {
  return useEditor.getState().appSettings.defaultCodeLanguage || 'text'
}

interface PanelHeaderProps {
  onClose(): void
}

/** 面板头部：标题 + 关闭按钮 */
export function PanelHeader({ onClose }: PanelHeaderProps): ReactElement {
  return (
    <div className="side-panel__header">
      <span>节点属性</span>
      <button
        type="button"
        className="tool-btn"
        title="关闭"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClose}
      >
        <X size={16} />
      </button>
    </div>
  )
}
