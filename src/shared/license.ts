/**
 * 许可与试用：与平台无关的**纯逻辑**。
 *
 * 这里只有格式与算术——**验签在主进程**（`src/main/license/`）。渲染层不碰密钥，
 * 也不该有 `node:crypto` 那份能力。放 shared 是为了让**签发脚本、主进程、自检**
 * 三边共用同一套格式：避免"签的时候一种、验的时候另一种"这种最难查的错。
 *
 * 商业化边界（与 README 的承诺一一对应）：
 * - 只读聊天、以及 0.7/0.8 已交付的一切，**永久免费**，绝不收回；
 * - 只有「AI 直接改画布」（agent 写工具）是 Pro，免费给 30 个写回合试用。
 */

/** 许可码前缀：一眼能看出这串东西是什么 */
export const LICENSE_PREFIX = 'SMIND1'

/**
 * 免费试用的**写回合**上限。只读聊天不计数、也不受限。
 *
 * 2026-09-15 拍板从 20 提到 30：试用的职责是**说服**，不是省钱——
 * 20 次常常不够让用户走完「让它整理一整页」这种真实任务。
 * 这个常量是**唯一真相**：界面文案、试用提示、徽标都从它派生，不会各写一个数字。
 */
export const TRIAL_TURN_LIMIT = 30

export interface LicensePayload {
  v: 1
  edition: 'pro'
  /** 持有人（签发时填的名字，会在界面里显示出来） */
  holder: string
  /** 签发日期 YYYY-MM-DD */
  issuedAt: string
  /** 订单号（可选，售后对账用） */
  order?: string
}

/* ------------------------------------------------------------------ */
/* base64url（不依赖 Buffer：渲染层也要用）                            */
/* ------------------------------------------------------------------ */

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlToBytes(text: string): Uint8Array | null {
  try {
    const normalized = text.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const binary = atob(padded)
    const out = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index)
    return out
  } catch {
    return null
  }
}

export function textToBase64Url(text: string): string {
  return bytesToBase64Url(textEncoder.encode(text))
}

export function base64UrlToText(text: string): string | null {
  const bytes = base64UrlToBytes(text)
  if (!bytes) return null
  try {
    return textDecoder.decode(bytes)
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 许可码：SMIND1.<payload 段>.<签名段>                                */
/* ------------------------------------------------------------------ */

/**
 * payload 段。
 *
 * 签发与验签共用它：**签名覆盖的就是这串字节本身**，不是"重新序列化一遍的 JSON"
 * ——后者会因键序/空格不同而假失败，那是最难查的一类对不上。
 */
export function licensePayloadSegment(payload: LicensePayload): string {
  return textToBase64Url(JSON.stringify(payload))
}

/** 组出给用户的那一串（签发脚本与自检共用，保证格式只有一处定义） */
export function encodeLicenseKey(payload: LicensePayload, signatureBase64Url: string): string {
  return `${LICENSE_PREFIX}.${licensePayloadSegment(payload)}.${signatureBase64Url}`
}

export type LicenseDecodeResult =
  | { ok: true; payload: LicensePayload; payloadSegment: string; signature: string }
  | { ok: false; error: string }

/**
 * 清洗用户粘贴的内容。
 *
 * 许可码很长，从聊天窗口、邮件里复制**极易带上换行和空格**；
 * 中文输入法下还常见全角句点/横线。这些都该在验签之前抹平——
 * 否则用户只会看到"签名对不上"，然后怀疑是自己买错了东西。
 */
export function normalizeLicenseKey(raw: string): string {
  return raw
    .replace(/[\s\u3000]+/g, '')
    .replace(/\uFF0E/g, '.')
    .replace(/[\uFF0D\u2010-\u2015]/g, '-')
    .trim()
}

/** 校验许可信息字段；不合格返回 null（**绝不半信半疑地接受**） */
export function normalizeLicensePayload(raw: unknown): LicensePayload | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  if (record.v !== 1 || record.edition !== 'pro') return null
  if (typeof record.holder !== 'string' || record.holder.trim().length === 0) return null
  if (typeof record.issuedAt !== 'string' || record.issuedAt.trim().length === 0) return null

  /**
   * 光"非空"不算校验：签发时间要**能当成日期读出来**，字段还要有长度上限。
   *
   * 为什么值得管：这些字段会被显示、会被存进许可文件、将来还可能参与续期判断，
   * 一个 `issuedAt: "abc"` 或 10 万字的 holder 都能通过"非空"这一关——
   * 前者让日期逻辑静默失效（`Date.parse` 得到 NaN），后者能让界面/日志被灌爆。
   * 格式上宽容一些：日期-only 与完整 ISO 都收（签发工具改过格式也不至于全废），
   * 但必须是**真的能解析**的日期。
   */
  const holder = record.holder.trim()
  if (holder.length > HOLDER_MAX || hasControlChars(holder)) return null
  const issuedAt = record.issuedAt.trim()
  if (issuedAt.length > ISSUED_AT_MAX || !isIsoLikeDate(issuedAt)) return null

  const order =
    typeof record.order === 'string' && record.order.trim().length > 0
      ? record.order.trim()
      : undefined
  if (order !== undefined && (order.length > ORDER_MAX || hasControlChars(order))) return null

  return { v: 1, edition: 'pro', holder, issuedAt, order }
}

/** 持有人名字的长度上限（正常姓名/公司名远小于它，超了就是脏数据） */
const HOLDER_MAX = 120
/** 签发时间字符串长度上限（ISO 8601 最长也就 30 上下） */
const ISSUED_AT_MAX = 40
/** 订单号长度上限 */
const ORDER_MAX = 80

function hasControlChars(text: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(text)
}

/**
 * 像日期的日期：`YYYY-MM-DD` 或 ISO 8601（可带时间、毫秒、Z/±HH:MM），
 * 且 `Date.parse` 必须给出有限值——只匹配形状的话 `2026-02-31` 这种假日期也会混进来。
 */
function isIsoLikeDate(value: string): boolean {
  if (
    !/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(
      value
    )
  ) {
    return false
  }
  if (!Number.isFinite(Date.parse(value))) return false
  // 日期-only 形式还要防"JS 帮你滚"：`2026-02-31` 解析出来是 03-03，
  // 形状看着合法、日期其实不存在。逐项比回来才算数
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (dateOnly) {
    const year = Number(dateOnly[1])
    const month = Number(dateOnly[2])
    const day = Number(dateOnly[3])
    const date = new Date(year, month - 1, day)
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
  }
  return true
}

/**
 * 拆解并做**结构**校验（签名由主进程验）。
 *
 * `payloadSegment` 原样返回：验签覆盖的就是**这一串字节本身**，
 * 而不是"重新序列化一遍的 JSON"——后者会因键序/空格不同而假失败。
 */
export function decodeLicenseKey(raw: string): LicenseDecodeResult {
  const key = normalizeLicenseKey(raw)
  if (key.length === 0) return { ok: false, error: '许可码是空的' }

  const parts = key.split('.')
  if (parts.length !== 3) return { ok: false, error: '许可码格式不对（应该用「.」分成三段）' }
  const [prefix, payloadSegment, signature] = parts
  if (prefix !== LICENSE_PREFIX) return { ok: false, error: '这不像是 SMind 的许可码' }
  if (!payloadSegment || !signature) return { ok: false, error: '许可码不完整（缺少内容或签名）' }

  const payloadText = base64UrlToText(payloadSegment)
  if (payloadText === null)
    return { ok: false, error: '许可码的内容读不出来（复制时可能缺了字符）' }

  let parsed: unknown
  try {
    parsed = JSON.parse(payloadText)
  } catch {
    return { ok: false, error: '许可码的内容不是有效的许可信息' }
  }

  const payload = normalizeLicensePayload(parsed)
  if (!payload) return { ok: false, error: '许可码里的许可信息不完整' }

  return { ok: true, payload, payloadSegment, signature }
}

/* ------------------------------------------------------------------ */
/* 试用与闸门判定                                                      */
/* ------------------------------------------------------------------ */

/** 还剩几个写回合（不返回负数） */
export function remainingTrialTurns(used: number): number {
  if (!Number.isFinite(used) || used <= 0) return TRIAL_TURN_LIMIT
  return Math.max(0, TRIAL_TURN_LIMIT - Math.floor(used))
}

/** 用掉一个写回合；到上限就停在**上限**，不无限增长 */
export function bumpTrialUsed(used: number): number {
  const current = Number.isFinite(used) && used > 0 ? Math.floor(used) : 0
  return Math.min(current + 1, TRIAL_TURN_LIMIT)
}

/**
 * 这次请求该不该算一个新回合？（返回 true = 计数并记下它）
 *
 * 计数单位必须是**一次用户命令**，而不是「一轮模型请求」。
 *
 * 踩过的坑：主进程原来在每个流式请求结束后都调一次计数——而一条命令可能跑十几二十轮
 * （现在「一句命令生成 100+ 节点的详细图」正是这样），于是**一条命令就吃掉十几个试用回合**，
 * "送 30 个写回合"实际只够两三次操作。
 *
 * 由渲染层为每个用户命令生成一个 `turnId`，主进程按它去重：同一个 turnId 只在
 * 第一次出现时计数。集合按插入序淘汰，避免长期运行无限增长。
 */
export function markTrialTurnSeen(seen: Set<string>, turnId: string, limit = 1000): boolean {
  if (turnId.length === 0) return true
  if (seen.has(turnId)) return false
  seen.add(turnId)
  while (seen.size > limit) {
    const oldest = seen.values().next().value
    if (oldest === undefined) break
    seen.delete(oldest)
  }
  return true
}

/**
 * 这一批工具调用里有没有**写工具**（有 = 这次算一个试用回合）。
 *
 * 只读工具（看结构）不计数：免费用户随便问、随便看，这是产品的门面，
 * 也是让用户自己产生「让它直接改」这个念头的地方。
 */
export function hasWriteToolCall(
  names: readonly string[],
  writeToolNames: readonly string[]
): boolean {
  return names.some((name) => writeToolNames.includes(name))
}

/** 许可状态视图：渲染层显示与主进程判定共用一份，避免两边各算一套 */
export interface LicenseView {
  pro: boolean
  holder: string | null
  trialUsed: number
  trialLimit: number
  remaining: number
  /** 现在还能不能让 AI 改图（Pro，或试用没花完） */
  canWrite: boolean
  /** 不能改图时给用户的一句话（面板直接显示） */
  writeHint: string | null
}

export function licenseViewOf(input: {
  pro: boolean
  holder: string | null
  trialUsed: number
}): LicenseView {
  const remaining = remainingTrialTurns(input.trialUsed)
  const canWrite = input.pro || remaining > 0
  return {
    pro: input.pro,
    holder: input.pro ? input.holder : null,
    trialUsed: input.trialUsed,
    trialLimit: TRIAL_TURN_LIMIT,
    remaining,
    canWrite,
    writeHint: canWrite
      ? null
      : `AI 改图的试用已经用完（${TRIAL_TURN_LIMIT}/${TRIAL_TURN_LIMIT}）。` +
        '只读聊天永久免费；输入许可码可以继续让 AI 直接改画布。'
  }
}

/** 许可信息不可用时的兜底视图（文件损坏、读取失败都用它，绝不让面板白屏） */
export function unknownLicenseView(): LicenseView {
  return licenseViewOf({ pro: false, holder: null, trialUsed: 0 })
}
