/**
 * 工具参数文本的解析（E1 收敛：原先在 `plan-write.ts` 与 `run-read.ts` 各写一份）。
 *
 * **只抽「解析」这一件事**，失败怎么表达留给调用点：写工具把失败包成 `WritePlan`、
 * 读工具包成 `ToolResult`，两者的错误文案也各有各的说法（一个要说"请重新调用"、
 * 一个还要带上工具名）。原语只负责三件事：去空白、`JSON.parse`、必须是对象。
 *
 * 失败**不抛错**：抛错会中断整轮对话，而这段文字要原样回喂给模型，
 * 它看到「参数不是合法 JSON（…）」才知道下一步怎么改。
 */
import { isRecord } from '../guards'

export type ArgsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; kind: 'not-json'; message: string }
  | { ok: false; kind: 'not-object' }

export function parseToolArguments(argumentsText: string): ArgsResult {
  const trimmed = argumentsText.trim()
  // 没有参数就是空对象：模型省略参数时不该算失败
  if (trimmed.length === 0) return { ok: true, args: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    return { ok: false, kind: 'not-json', message: (error as Error).message }
  }
  if (!isRecord(parsed)) return { ok: false, kind: 'not-object' }
  return { ok: true, args: parsed }
}
