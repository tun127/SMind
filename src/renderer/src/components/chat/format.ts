/**
 * AI 聊天面板里的纯函数与常量（自 ChatPanel.tsx 原样搬出）。
 */

import type { OutlineFormat } from '@shared/outline'

/**
 * 导出格式：从工具参数里取，非法值一律回退 md。
 *
 * 放在这里而不是 shared 层：这是**界面侧**的决定（要调哪个导出通道），
 * 纯逻辑层只管把 format 原样带给渲染层。
 */
export function exportFormatOf(argumentsText: string): OutlineFormat {
  try {
    const parsed = JSON.parse(argumentsText) as { format?: unknown }
    const raw = typeof parsed.format === 'string' ? parsed.format.trim().toLowerCase() : ''
    if (raw === 'txt' || raw === 'opml' || raw === 'md') return raw
  } catch {
    /* 参数坏了就用默认格式 */
  }
  return 'md'
}

/** 快捷提问：只跟 AI 聊，不动画布 */
export const QUICK_PROMPTS = ['总结这页导图的主要内容', '指出这个导图结构上薄弱的地方']
