/**
 * 调度与可见性：回合/调用上限、本轮给模型哪些工具、意图分类。
 *
 * 单一职责：回答「这一轮还跑不跑、给模型看什么、这个意图算不算改动」。
 * 写权限由许可层决定（见 main 的许可闸门），这里只做纯函数判定。
 */
import type { AgentToolDef } from './tools-read'
import { AGENT_TOOLS } from './tools-read'
import { AGENT_WRITE_TOOLS } from './tools-write'
import type { WriteIntent } from './write-intents'

/* ------------------------------------------------------------------ */
/* 循环上限                                                            */
/* ------------------------------------------------------------------ */

/**
 * 一轮对话里最多几轮「模型 → 工具 → 模型」。
 *
 * 上限是安全阀，不该变成体验问题：撞到上限时渲染层会**去掉工具再问最后一轮**，
 * 让模型把已经看到的东西讲清楚——以前撞上限就直接收尾，用户拿到的是半截话。
 *
 * 16 轮 → 40 轮（用户要求"一句命令就生成 100+ 个节点的完整图"之后放的）：
 * 一次完整的详细生成通常是「读骨架 → 按分支逐个 insertSubtree（一个分支一次，
 * 免得单次输出被上限截断）→ 补解释 → 收尾」，分 5~8 个分支就是十几轮，
 * 16 轮会让它写到一半被截断——而截断的表现正是"只写了粗分"。
 */
export const AGENT_MAX_ROUNDS = 40
/**
 * 一轮对话里最多执行多少次**工具调用**（不是操作数——一次 moveTopics 可以搬很多节点）。
 *
 * 为什么不去掉上限：没有它，模型陷入循环时会无限烧用户的钱和 patience。
 * 60 → 200：100+ 节点的详细图（每个节点可能还要单独补备注/代码/公式）在
 * 只读探查 + 分批写入之下会用到几十上百次调用；60 会在写到一半时停住。
 */
export const AGENT_MAX_TOOL_CALLS = 200

/**
 * 还能不能继续下一轮。
 *
 * 返回 reason 是为了**告诉用户为什么停了**——静默停下会让人以为 AI 坏了。
 */
export function canContinueAgentLoop(
  round: number,
  toolCallsUsed: number
): { ok: boolean; reason: string } {
  if (toolCallsUsed >= AGENT_MAX_TOOL_CALLS) {
    return { ok: false, reason: `已达到本次最多 ${AGENT_MAX_TOOL_CALLS} 次工具调用的上限` }
  }
  if (round >= AGENT_MAX_ROUNDS) {
    return { ok: false, reason: `已达到本次最多 ${AGENT_MAX_ROUNDS} 轮的上限` }
  }
  return { ok: true, reason: '' }
}

export const AGENT_ALL_TOOLS: AgentToolDef[] = [...AGENT_TOOLS, ...AGENT_WRITE_TOOLS]

/**
 * 真正会**改动画布**的写工具名（**不含 askUser**）。
 *
 * 用途：试用计数只认「这次对话真的动了画布吗」——askUser 只是提问、什么都没改，
 * 把它算进去等于"只问一句就消耗一个试用回合"。
 */
export const AGENT_CANVAS_TOOL_NAMES: string[] = AGENT_WRITE_TOOLS.filter(
  (tool) => tool.name !== 'askUser'
).map((tool) => tool.name)

/**
 * 这次对话**允许模型看到的工具**。
 *
 * 闸门放在「下发哪些工具定义」这一层，而不是"调用时再拦"——模型看不到写工具，
 * 就物理上调不动它，与「工具即权限边界」是同一条原则（也是提示词注入的最终防线）。
 * `canWrite` 由主进程按许可状态算出（Pro，或试用还没用完）。
 */
export function planAvailableTools(canWrite: boolean): AgentToolDef[] {
  return canWrite ? AGENT_ALL_TOOLS : AGENT_TOOLS
}

export function isMutatingIntent(intent: WriteIntent): boolean {
  return intent.kind !== 'ask'
}

/** 这个名字是不是只读工具（渲染层据此决定「直接执行」还是「走写工具流程」） */
export function isReadToolName(name: string): boolean {
  return AGENT_TOOLS.some((tool) => tool.name === name)
}
