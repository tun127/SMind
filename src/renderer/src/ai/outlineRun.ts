/**
 * 大纲类请求的公共执行器：带**自动续写**的 `aiChat`。
 *
 * 为什么需要它：一句「生成一份 X 的导图」的输出动辄 8k~14k token，
 * 服务商的单次输出上限随时可能把它截断。截断就自动接着写，
 * 而不是把半张图丢给用户、让他自己再写一遍提示词（用户明确抱怨过这个）。
 *
 * 用它的地方：AiDialog（按主题生成）、DocumentToMapDialog（按文档生成）、
 * 以及文档分段分析里的每一段。
 */
import { isTruncatedFinish, joinContinuation, type AiMessage } from '@shared/ai'

/** 续写指令：不许重复、不许开场白，直接从中断处往下写 */
const CONTINUE_INSTRUCTION =
  '你上一条输出被服务商的输出上限截断了。请**从中断处继续写完剩余部分**：' +
  '不要重复已经写过的内容，不要写任何开场白或说明，直接从下一行接着往下写（保持同样的缩进大纲格式）。'

export interface OutlineChatResult {
  text: string
  /** 续写用尽后**仍然**被截断（界面要如实告知） */
  truncated: boolean
}

export async function runOutlineChat(
  messages: AiMessage[],
  options: {
    /** 最多自动续写几段（默认 3） */
    continuations?: number
    /** 每次续写前回调一次，用于界面提示进度 */
    onContinue?: (attempt: number, total: number) => void
  } = {}
): Promise<OutlineChatResult> {
  const max = Math.max(0, options.continuations ?? 3)
  let raw = ''
  let truncated = false
  for (let attempt = 0; attempt <= max; attempt += 1) {
    const payload: AiMessage[] =
      attempt === 0
        ? messages
        : [
            ...messages,
            { role: 'assistant', content: raw },
            { role: 'user', content: CONTINUE_INSTRUCTION }
          ]
    const result = await window.api.aiChat(payload)
    raw = attempt === 0 ? result.content : joinContinuation(raw, result.content)
    truncated = isTruncatedFinish(result.finishReason)
    if (!truncated) break
    if (attempt < max) options.onContinue?.(attempt + 1, max)
  }
  return { text: raw, truncated }
}
