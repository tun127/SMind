/**
 * AI 聊天面板的类型（自 ChatPanel.tsx 原样搬出）。
 */

import type { TokenUsage } from '@shared/ai'
import type { WriteIntent } from '@shared/agent'

export interface ChatMsg {
  /** 用作 React key：列表只会追加，但用下标做 key 在插入场景会错位 */
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 这条回答被用户手动停止——标注出来，别让人以为说完了 */
  aborted?: boolean
  /**
   * 思维链（推理模型的思考过程，可折叠展示）。
   * 只用于界面直播：**不进历史存档**（normalizeChatHistory 只留 role/content）。
   */
  thinking?: string
  /** 这一轮里 AI 做过什么（工具调用摘要），让用户看得见它干的事 */
  toolNotes?: string[]
  /** 这条回答花了多少 token（多轮工具调用会累计；服务商没回报就没有） */
  usage?: TokenUsage
  /** 诚实标注：模型说改了、实际零改动（或写操作没落实）时显示 */
  warning?: string
}

/** 挂在这个会话上的文档（只有正文，没有路径） */
export interface ChatDoc {
  name: string
  text: string
}

/** 需要用户点头的破坏性操作（删分支等） */
export interface PendingWrite {
  summary: string
  /** 这次操作的种类：决定「不再询问」记住什么 */
  kind: WriteIntent['kind']
  /** 给人看的种类名（清单见 DESTRUCTIVE_WRITE_LABELS） */
  label: string
}

/** 执行计划（模型用 updatePlan 工具写的） */
export interface ChatPlan {
  steps: string[]
  done: number
}
