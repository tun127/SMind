/**
 * AI 的协议与文本层。
 *
 * 分层约定：**网络在 main**（无 CORS 顾虑）、**回合编排在渲染层**（ChatPanel）、
 * 这里只放纯逻辑。按职责拆分：
 *
 *   config.ts   配置 / 预设 / 质量档位
 *   prompts.ts  提示词文本（大纲、文档出图、聊天系统提示）
 *   outline.ts  大纲解析 + 续写拼接
 *   context.ts  骨架摘要 / 意图分类 / 历史压缩
 *   errors.ts   响应与错误文案
 *   stream.ts   流式协议解析（SSE / 增量 / 工具调用 / 思维链）
 *
 * 本文件显式再导出原来的公开面，消费方（main / 渲染层 / import / 自检）不用改 import。
 */
export {
  AI_PRESETS,
  DEFAULT_AI_CONFIG,
  DEFAULT_QUALITY_TIER,
  QUALITY_TIERS,
  chatCompletionsUrl,
  normalizeAiConfig,
  normalizeQualityTier,
  toConfigView
} from './config'
export type { AiConfig, AiConfigView, QualityTier } from './config'
export {
  buildChatSystemPrompt,
  buildDocumentChunkMessages,
  buildDocumentMergeMessages,
  buildDocumentOutlineMessages
} from './prompts'
export {
  CONTINUATION_MIN_OVERLAP,
  countOutlineNodes,
  joinContinuation,
  mergeContinuation,
  outlineToTopic,
  parseOutline
} from './outline'
export type { ContinuationMerge, ContinuationRelation, OutlineNode, ParsedOutline } from './outline'
export {
  claimsAppliedChange,
  describeAiError,
  extractContent,
  formatTokenCount,
  readableIpcError
} from './errors'
export {
  HISTORY_DIGEST_MAX,
  HISTORY_KEEP_RECENT,
  buildSkeletonDigest,
  classifyTaskIntent,
  compressHistory,
  countTopicTree,
  digestPreamble,
  normalizeChatHistory
} from './context'
export type {
  ChatHistoryEntry,
  CompressedHistory,
  CompressibleMessage,
  TaskIntent
} from './context'
export {
  DEGENERATION_MAX_REPEAT,
  accumulateToolCalls,
  addUsage,
  createSseLineSplitter,
  createRepetitionGuard,
  createThinkingFilter,
  extractStreamDelta,
  finalizeToolCalls,
  isTruncatedFinish,
  toWireMessages
} from './stream'
export type {
  AiMessage,
  AiStreamEvent,
  StreamDelta,
  ThinkingFilter,
  TokenUsage,
  ToolCall,
  ToolCallDelta
} from './stream'
