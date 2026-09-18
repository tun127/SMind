#!/usr/bin/env node
/**
 * 发布镜像上传：把 release/ 下的安装包上传到 Cloudflare R2（dl.smindapp.cn）。
 *
 * 用法（先配好两个环境变量，再跑）：
 *   CLOUDFLARE_ACCOUNT_ID=xxx CLOUDFLARE_API_TOKEN=xxx npm run mirror
 *
 * 环境变量：
 *   CLOUDFLARE_ACCOUNT_ID  Cloudflare 账户 ID（R2 概览页右侧）
 *   CLOUDFLARE_API_TOKEN   需「Account | Cloudflare R2: Edit」权限的 API Token
 * 可选：
 *   R2_BUCKET   桶名，默认 smind-releases
 * 版本号取自 package.json。
 *
 * 原理：零依赖，直接调 wrangler（npx 自动拉取）执行 `r2 object put`。
 * 上传后对 dl.smindapp.cn 做 HEAD 校验，确认镜像可用。
 */
import { execSync } from 'node:child_process'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const version = pkg.version
const bucket = process.env.R2_BUCKET ?? 'smind-releases'
const account = process.env.CLOUDFLARE_ACCOUNT_ID
const token = process.env.CLOUDFLARE_API_TOKEN
const mirrorBase = 'https://dl.smindapp.cn'

if (!account || !token) {
  console.error('缺少 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN 环境变量。')
  console.error('获取方式：Cloudflare 控制台 → R2 → 管理 R2 API 令牌（权限：Object Read & Write）。')
  process.exit(1)
}

const targets = [
  `SMind-${version}-x64-setup.exe`,
  `SMind-${version}-x64-portable.exe`
]

let failed = false
for (const name of targets) {
  const local = resolve('release', name)
  if (!existsSync(local)) {
    console.error(`✗ 缺少产物：release/${name}（先跑 npm run dist）`)
    failed = true
    continue
  }
  const mb = (statSync(local).size / 1024 / 1024).toFixed(1)
  console.log(`上传 ${name}（${mb} MB）→ ${bucket}/${name} ...`)
  try {
    execSync(
      `npx wrangler r2 object put "${bucket}/${name}" --file="${local}" --remote --content-type "application/octet-stream"`,
      { stdio: 'inherit', env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } }
    )
    console.log(`✓ ${mirrorBase}/${name}`)
  } catch {
    console.error(`✗ ${name} 上传失败`)
    failed = true
  }
}

if (failed) process.exit(1)

// 上传后校验镜像直链可达（注意：dl.smindapp.cn 需在 Cloudflare 里绑定到该桶）
console.log('校验镜像直链…')
for (const name of targets) {
  try {
    const res = await fetch(`${mirrorBase}/${name}`, { method: 'HEAD' })
    console.log(res.ok ? `✓ ${mirrorBase}/${name} 可下载` : `⚠ ${mirrorBase}/${name} 返回 ${res.status}（若刚绑定域名，稍等几分钟再试）`)
  } catch (e) {
    console.warn(`⚠ 无法访问 ${mirrorBase}/${name}：${e.cause?.message ?? e.message}`)
  }
}
