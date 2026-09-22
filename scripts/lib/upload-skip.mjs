/**
 * 上传脚本的纯判据：哪些对象可以按体积跳过、线上清单里的版本怎么读。
 *
 * 单独放在这里的目的：上传脚本本身一 `import` 就会校验 OSS 环境变量并结束进程，
 * 自检不能直接 import 它；把纯逻辑抽出来后，D-20 的两条硬判据可以被脚本化钉死。
 */

/** 自动更新清单永不走「体积一致就跳过」：两个正式版的 latest.yml 天然都是 347 字节。 */
export const NEVER_SKIP_UPLOAD_NAMES = new Set(['latest.yml', 'rt.yml'])

/**
 * 跳过判据：
 * - `latest.yml` / `rt.yml` 恒为 false（必须每次发版都 PUT）；
 * - 其它对象（尤其两个 108 MB 的 exe）在远端大小一致时才允许跳过。
 */
export function shouldSkipUpload(name, remoteSize, localSize, neverSkip = false) {
  if (neverSkip || NEVER_SKIP_UPLOAD_NAMES.has(name)) return false
  return typeof remoteSize === 'number' && remoteSize === localSize
}

/** 从 electron-updater 的 YAML 清单里读 `version:` 行；读不到返回 null。 */
export function manifestVersionOf(text) {
  const match = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)
  return match?.[1] ?? null
}
