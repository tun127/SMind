/**
 * 响应与错误文案：把 HTTP 状态、IPC 异常、模型输出翻成人话。
 *
 * 单一职责：只做「机器信息 → 用户能读懂并知道下一步怎么办」的翻译，
 * 不做解析（stream.ts）、不做配置（config.ts）。
 */
import { isRecord } from '../guards'

/** 从 OpenAI 兼容响应里取正文；取不到时抛出可读错误 */
export function extractContent(payload: unknown): string {
  if (!isRecord(payload)) throw new Error('AI 返回的内容不是合法的 JSON 对象')
  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    // 有些实现把错误塞在 body 里
    const message =
      isRecord(payload.error) && typeof payload.error.message === 'string'
        ? payload.error.message
        : null
    throw new Error(message ? `AI 返回错误：${message}` : 'AI 没有返回任何结果（choices 为空）')
  }

  const first = choices[0]
  if (!isRecord(first)) throw new Error('AI 返回结构不正确（choices[0] 不是对象）')
  const message = first.message
  if (isRecord(message) && typeof message.content === 'string') return message.content
  if (typeof first.text === 'string') return first.text
  throw new Error('AI 返回结构不正确（缺少 message.content）')
}

/** 把 HTTP 状态码与响应体翻译成用户能看懂的中文提示 */
export function describeAiError(status: number, bodyText: string): string {
  let detail = bodyText.trim()
  try {
    const parsed: unknown = JSON.parse(bodyText)
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string') {
      detail = parsed.error.message
    }
  } catch {
    /* 不是 JSON 就用原文 */
  }
  const short = detail.length > 200 ? `${detail.slice(0, 200)}…` : detail

  if (status === 401 || status === 403) {
    return `鉴权失败（${status}）：API Key 不对或没有权限。请到「AI 设置」里检查 Key。${short ? ` 服务端信息：${short}` : ''}`
  }
  if (status === 404) {
    return `接口不存在（404）：多半是 BaseURL 或模型名填错了，BaseURL 一般要带 /v1。${short ? ` 服务端信息：${short}` : ''}`
  }
  if (status === 429) {
    return `请求太频繁或被限流（429）：稍后再试，或换一个模型/额度。${short ? ` 服务端信息：${short}` : ''}`
  }
  if (status === 400) {
    return `请求被拒绝（400）：可能是模型名不对或提示词过长。${short ? ` 服务端信息：${short}` : ''}`
  }
  if (status >= 500) {
    return `AI 服务端错误（${status}）：不是你的问题，稍后再试。${short ? ` 服务端信息：${short}` : ''}`
  }
  return `AI 请求失败（${status}）${short ? `：${short}` : ''}`
}

/**
 * 助手的话里有没有「已经改好了」这类**结果声明**。
 *
 * 用来兜住一种事故：模型嘴上说改了，实际一个写工具都没调（或全失败了），
 * 用户以为已经改好。判定出「有声明 + 本轮零改动」时，面板会在气泡上如实标注。
 * 宁可偶尔多标一句（话里出现"已"字），也不要让用户以为改动落了地。
 */
export function claimsAppliedChange(text: string): boolean {
  if (text.trim().length === 0) return false
  return /(已经|已)(改|修|整理|调整|移动|归|添加|删除|处理|完成|搞定)|改好了|改完了|整理好了|搞定|done|fixed/i.test(
    text
  )
}

/**
 * 把 Electron 的 invoke 拒绝信息还原成人话。
 *
 * 主进程 throw 的错会被包成 `Error invoking remote method 'ai:chat-stream': Error: 真正的话`，
 * 原样显示给用户等于让他看一行技术噪声（真出现过：粘一长段内容后，面板上就这一行）。
 */
export function readableIpcError(message: string): string {
  const marker = 'Error invoking remote method'
  const at = message.indexOf(marker)
  if (at < 0) return message
  const colon = message.indexOf(': ', at)
  if (colon < 0) return message
  return message.slice(colon + 2).replace(/^Error:\s*/, '')
}

/** 展示用：1234 → 「1.2k」；45 → 「45」 */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0'
  if (count < 1000) return String(Math.round(count))
  return `${(count / 1000).toFixed(1)}k`
}
