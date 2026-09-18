/**
 * Agent 的纯逻辑大脑。
 *
 * 这里只有「定义与判定」，没有网络（在 main）、没有回合循环（在渲染层）、
 * 也没有写意图的落地（在渲染层）。按职责拆分如下：
 *
 *   title-index.ts   节点标题的识别与切分（可点击片段）
 *   tools-read.ts    只读工具的 schema
 *   address.ts       寻址：字符串 → 具体节点
 *   run-read.ts      只读工具的执行（纯逻辑）
 *   write-intents.ts 写意图类型 + 破坏性清单 + 确认偏好
 *   tools-write.ts   写工具的 schema
 *   plan-write.ts    写工具的规划（解析 + 寻址 + 校验）
 *   availability.ts  回合上限 + 工具可见性 + 意图分类
 *
 * 本文件显式再导出原来的公开面（ChatPanel / AiSettingsDialog / main / 自检
 * 都从 `@shared/agent` 导入），目录内部的协作符号不对外。
 */
export {
  AGENT_ALL_TOOLS,
  AGENT_CANVAS_TOOL_NAMES,
  AGENT_MAX_ROUNDS,
  AGENT_MAX_TOOL_CALLS,
  canContinueAgentLoop,
  isMutatingIntent,
  isReadToolName,
  planAvailableTools
} from './availability'
export { AGENT_TOOLS, toWireTools } from './tools-read'
export type { AgentToolDef } from './tools-read'
export { resolveTopicAddress, shortHandleOf, topicPathOf } from './address'
export type { AddressResult, ResolvedTopic } from './address'
export { runReadTool } from './run-read'
export type { ToolContext, ToolResult } from './run-read'
export {
  DESTRUCTIVE_WRITE_KINDS,
  DESTRUCTIVE_WRITE_LABELS,
  isDestructiveWriteKind,
  normalizeConfirmSkip
} from './write-intents'
export type { AttachmentKind, DestructiveWriteKind, WriteIntent, WritePlan } from './write-intents'
export { AGENT_WRITE_TOOLS } from './tools-write'
export { planWriteTool } from './plan-write'
export { buildTitleIndex, segmentTitleMentions } from './title-index'
export type { TextSegment, TitleIndexEntry } from './title-index'
