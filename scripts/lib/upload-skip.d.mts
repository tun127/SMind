export const NEVER_SKIP_UPLOAD_NAMES: Set<string>

export function shouldSkipUpload(
  name: string,
  remoteSize: number | null,
  localSize: number,
  neverSkip?: boolean
): boolean

/**
 * 「递延发版」持有闸门：仓库根 `.release-hold` 存在、且其 `version` 等于当前版本时返回 true。
 * 标记存在但内容读不懂时**同样返回 true**（失败即拦：宁可不发，也不误发）。
 */
export function releaseHoldBlocksUpload(holdText: string | null, version: string): boolean

export function manifestVersionOf(text: string): string | null
