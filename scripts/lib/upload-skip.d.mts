export const NEVER_SKIP_UPLOAD_NAMES: Set<string>

export function shouldSkipUpload(
  name: string,
  remoteSize: number | null,
  localSize: number,
  neverSkip?: boolean
): boolean

export function manifestVersionOf(text: string): string | null
