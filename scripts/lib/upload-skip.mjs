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

/**
 * 「递延发版」持有闸门：仓库根 `.release-hold` 存在、且其 `version` 等于当前版本时，拒绝上传。
 *
 * 为什么需要：2026-09-22 用户拍板「0.9.4 冻结但先不发，等 0.9.5 冻结后再发 0.9.4」。
 * 而 `package.json` 此刻已经是 0.9.4、线上服务的是 0.9.3 —— 谁手一抖跑一次
 * `npm run mirror:oss`，就会把持有版直接发给用户。
 *
 * 判据刻意**失败即拦**：标记文件存在但内容读不懂时同样拦住。宁可多问一句，
 * 也不要在一个「本来就不该发」的时刻静默发出去。
 * 释放：正常发布时删掉 `.release-hold`；应急用 `SMIND_RELEASE_FORCE=1`。
 */
export function releaseHoldBlocksUpload(holdText, version) {
  if (typeof holdText !== 'string' || holdText.trim() === '') return false
  try {
    const hold = JSON.parse(holdText)
    return hold?.version === version
  } catch {
    return true
  }
}

/** 从 electron-updater 的 YAML 清单里读 `version:` 行；读不到返回 null。 */
export function manifestVersionOf(text) {
  const match = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)
  return match?.[1] ?? null
}
