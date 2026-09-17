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
import { isTruncatedFinish, mergeContinuation, type AiMessage } from '@shared/ai'

/**
 * 续写指令：先让模型判断「最后一行写完了没有」，再决定是**重写它**还是**另起一行**。
 *
 * 以前这里写的是「不要重复已经写过的内容，直接从下一行接着往下写」——
 * 对「断在一行中间」这种最常见的情况，这两句话等于**放弃那半行**：
 * 模型乖乖另起一行，那个节点的内容就再也补不回来了
 * （用户看到的就是「AI 又漏了一个考点」，而漏在哪完全无从发现）。
 *
 * 现在改成「没写完就从行首重写一遍」，于是被丢掉的只可能是**残片**，
 * 而它的完整版一定出现在续写的第一行里——`mergeContinuation` 的第 1 条规则认得出来。
 */
const CONTINUE_INSTRUCTION =
  '你上一条输出被服务商的输出上限截断了，请接着往下写。规则：' +
  '① 如果最后一行**没有写完**（半句话），请把它**从行首完整重写一遍**（不要只写后半截），再继续往下；' +
  '② 如果最后一行已经写完整了，就**不要重复它**，直接从新的一行继续。' +
  '不要写任何开场白或说明，保持与上文完全相同的格式。'

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
    if (attempt === 0) {
      raw = result.content
    } else {
      /**
       * 留下续写拼接的**现场**：关系 / 被处理的尾行 / 续写首行。
       *
       * 「少了一个节点」和「多出一句残话」都发生在这条缝上，而它此前只能靠猜。
       * 渲染层的 console 会被主进程转发进应用日志（渲染层没有独立日志通道）。
       * 观测一段时间、拿到真实分布后，这段可以撤掉。
       */
      const merged = mergeContinuation(raw, result.content)
      console.warn(`[outline] 续写拼接：${merged.relation}`, {
        tail: merged.tail.slice(-120),
        head: merged.head.slice(0, 120),
        chars: `${raw.length} → ${merged.text.length}`
      })
      raw = merged.text
    }
    truncated = isTruncatedFinish(result.finishReason)
    if (!truncated) break
    if (attempt < max) options.onContinue?.(attempt + 1, max)
  }
  return { text: raw, truncated }
}
