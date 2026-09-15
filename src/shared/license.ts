/**
 * 许可与试用：与平台无关的**纯逻辑**。
 *
 * 这里只有格式与算术——**验签在主进程**（`src/main/license/`）。渲染层不碰密钥，
 * 也不该有 `node:crypto` 那份能力。放 shared 是为了让**签发脚本、主进程、自检**
 * 三边共用同一套格式：避免"签的时候一种、验的时候另一种"这种最难查的错。
 *
 * 商业化边界（与 README 的承诺一一对应）：
 * - 只读聊天、以及 0.7/0.8 已交付的一切，**永久免费**，绝不收回；
 * - 只有「AI 直接改画布」（agent 写工具）是 Pro，免费给 20 个写回合试用。
 */

/** 许可码前缀：一眼能看出这串东西是什么 */
export const LICENSE_PREFIX = 'SMIND1'

/** 免费试用的**写回合**上限。只读聊天不计数、也不受限 */
export const TRIAL_TURN_LIMIT = 20

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
  const order =
    typeof record.order === 'string' && record.order.trim().length > 0 ? record.order.trim() : undefined
  return { v: 1, edition: 'pro', holder: record.holder.trim(), issuedAt: record.issuedAt.trim(), order }
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
  if (payloadText === null) return { ok: false, error: '许可码的内容读不出来（复制时可能缺了字符）' }

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
 * 这一批工具调用里有没有**写工具**（有 = 这次算一个试用回合）。
 *
 * 只读工具（看结构）不计数：免费用户随便问、随便看，这是产品的门面，
 * 也是让用户自己产生「让它直接改」这个念头的地方。
 */
export function hasWriteToolCall(names: readonly string[], writeToolNames: readonly string[]): boolean {
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
