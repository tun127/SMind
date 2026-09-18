/**
 * AI 配置：BaseURL / 模型 / Key / 温度 / 质量档位。
 *
 * 单一职责：外部输入 → 合法配置（normalize 如实报告改了什么），
 * 以及给 UI 用的视图与预设。不含提示词（prompts.ts）、不含网络（main）。
 */
import { isRecord } from '../guards'

export const DEFAULT_QUALITY_TIER: QualityTier = 'mid'

export interface AiConfig {
  /** 形如 https://api.deepseek.com/v1 或 https://api.openai.com/v1 */
  baseUrl: string
  /** 只存在主进程的配置文件里，不写进 .xmind */
  apiKey: string
  model: string
  /** 采样温度（0.2 稳定，0.9 发散） */
  temperature: number
  /**
   * 单次回复的输出上限（token）；**0 = 不发送这个字段**（用服务商默认值）。
   *
   * 为什么必须显式给足：多数服务商的默认输出上限只有 1.5k~2k token，
   * 而「完整详细的大纲」（多考点 + 解释 + 真题）动辄 4k~8k——
   * 写到一半被服务端掐断，用户看到的就是「只写了粗分」。
   * 多数实现支持更大的值；不认这个字段的服务商会报错，主进程会**逐级降档**重试
   * （16384 → 8192 → 4096 → 2048 → 不发送），不会把请求搞死。
   */
  maxTokens: number
  /** 生成质量档位（min / high / max）：只影响「要求的规模与深度」，不改 token 上限 */
  tier: QualityTier
}

/** 界面上要用的配置视图：**不包含完整 Key**，只给掩码 */
export interface AiConfigView {
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
  /** 生成质量档位 */
  tier: QualityTier
  hasKey: boolean
  /** 例如 sk-…3f9c；没有 Key 时为 null */
  keyPreview: string | null
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.6,
  /**
   * 默认给到 16384：一句命令生成 100+ 个节点（含每点的解释备注）大约要 8k~14k 输出 token。
   * 嫌慢 / 嫌贵可以在 AI 设置里调小或填 0；
   * 服务商不接受这个值时会**逐级降档重试**（8192 → 4096 → 2048 → 不发送），不会把请求搞死。
   */
  maxTokens: 16384,
  tier: DEFAULT_QUALITY_TIER
}

/** 常见服务商的预设，方便一键填 BaseURL */
export const AI_PRESETS: Array<{ label: string; baseUrl: string; model: string }> = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  {
    label: '通义千问（兼容模式）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus'
  },
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { label: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { label: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' }
]

/** 校验并补全配置；非法字段退回默认值并给出提示 */
export function normalizeAiConfig(raw: unknown): { config: AiConfig; warnings: string[] } {
  const warnings: string[] = []
  const source = isRecord(raw) ? raw : {}

  let baseUrl = typeof source.baseUrl === 'string' ? source.baseUrl.trim() : ''
  if (baseUrl.length === 0) {
    baseUrl = DEFAULT_AI_CONFIG.baseUrl
  } else if (!/^https?:\/\//i.test(baseUrl)) {
    warnings.push('BaseURL 必须以 http:// 或 https:// 开头，已回退为默认值')
    baseUrl = DEFAULT_AI_CONFIG.baseUrl
  }

  const model =
    typeof source.model === 'string' && source.model.trim().length > 0
      ? source.model.trim()
      : DEFAULT_AI_CONFIG.model
  const apiKey = typeof source.apiKey === 'string' ? source.apiKey.trim() : ''

  let temperature =
    typeof source.temperature === 'number' && Number.isFinite(source.temperature)
      ? source.temperature
      : DEFAULT_AI_CONFIG.temperature
  if (temperature < 0) temperature = 0
  if (temperature > 2) temperature = 2

  // 0 是合规值（表示不发送该字段）；负数与超大值都夹回可用区间
  let maxTokens =
    typeof source.maxTokens === 'number' && Number.isFinite(source.maxTokens)
      ? Math.round(source.maxTokens)
      : DEFAULT_AI_CONFIG.maxTokens
  if (maxTokens < 0) maxTokens = 0
  if (maxTokens > 65536) maxTokens = 65536

  return {
    config: {
      baseUrl,
      model,
      apiKey,
      temperature,
      maxTokens,
      tier: normalizeQualityTier(source.tier)
    },
    warnings
  }
}

/** 把配置转成界面上要展示的形态（Key 只给掩码） */
export function toConfigView(config: AiConfig): AiConfigView {
  const key = config.apiKey
  const preview =
    key.length === 0 ? null : key.length <= 8 ? '****' : `${key.slice(0, 3)}…${key.slice(-4)}`
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    tier: config.tier,
    hasKey: key.length > 0,
    keyPreview: preview
  }
}

/**
 * 拼出 chat/completions 的完整地址。
 * 用户可能填 `https://api.x.com`、`https://api.x.com/v1`、`https://api.x.com/v1/` 或完整地址，
 * 这几种都要能用。
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) return ''
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  if (/\/v\d+(\.\d+)?$/i.test(trimmed)) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

export type QualityTier = 'min' | 'mid' | 'max'

/** 界面上的短标签就三档名，详细说明放 hint（悬停可见） */
export const QUALITY_TIERS: Array<{ id: QualityTier; label: string; hint: string }> = [
  {
    id: 'min',
    label: 'min',
    hint: '省 token（及格档）：骨架完整、每点简短，40~80 节点；适合快速起图与简单主题'
  },
  {
    id: 'mid',
    label: 'mid',
    hint: '标准（80 分）：完整覆盖 + 具体内容 + 每板块配例子，100+ 节点；日常推荐'
  },
  {
    id: 'max',
    label: 'max',
    hint: '更细（90 分）：再加机制 / 误区 / 边界 / 对比与更多例子，200+ 节点；最费 token'
  }
]

/**
 * 非法值一律回到默认档（配置可能是旧版本写的，或被手工改坏）。
 * `high` 是改名前的旧写法，按 `mid` 认——用户刚存的档位不能因为一次改名就丢掉。
 */
export function normalizeQualityTier(raw: unknown): QualityTier {
  if (raw === 'high') return 'mid'
  return raw === 'min' || raw === 'mid' || raw === 'max' ? raw : DEFAULT_QUALITY_TIER
}
