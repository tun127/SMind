/**
 * 工具栏「AI」组：AI 助手菜单（打开聊天 / 设置）。
 *
 * JSX 自 Toolbar.tsx 整块搬出、逐字未改；`actions` 由入口原样传入。
 */

import { Bot, Settings2, Sparkles } from 'lucide-react'
import type { ReactElement } from 'react'
import type { ToolbarActions } from '../Toolbar'
import ToolMenu from './tool-menu'

interface Props {
  actions: ToolbarActions
}

export default function AiGroup({ actions }: Props): ReactElement {
  // AI：常用动作放在工具栏，设置也在同一处
  return (
    <div className="toolbar__group">
      <ToolMenu
        icon={<Sparkles size={16} />}
        label="AI"
        title="AI 助手（OpenAI 兼容接口）"
        items={[
          {
            key: 'ai-chat',
            label: '打开 AI 聊天…',
            hint: '用自然语言问这页导图',
            icon: <Bot size={15} />,
            onSelect: actions.onAiChat
          },
          {
            key: 'ai-settings',
            label: 'AI 设置…',
            hint: 'BaseURL / Key / 模型',
            icon: <Settings2 size={15} />,
            onSelect: actions.onAiSettings
          }
        ]}
      />
    </div>
  )
}
