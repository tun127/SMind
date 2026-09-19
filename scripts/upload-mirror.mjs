#!/usr/bin/env node
/**
 * 发布镜像上传：把 release/ 下的安装包与**自动更新渠道文件**上传到 Cloudflare R2（dl.smindapp.cn）。
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
 * 上传清单：
 *   1. `SMind-<版本>-x64-setup.exe`            必需（安装版）
 *   2. `SMind-<版本>-x64-portable.exe`         必需（免安装版）
 *   3. `latest.yml`                            **自动更新渠道**：客户端靠它比对版本
 *   4. `SMind-<版本>-x64-setup.exe.blockmap`   **自动更新渠道**：差分下载用
 *
 * 3/4 缺失时**只警告、不中断**（只发安装包是允许的），但会自动更新渠道失效，所以警告要显眼。
 * 为什么强烈建议带上它们：GitHub API 匿名限流会让 github provider 静默失效（2026-09-18 实测本机
 * 出口 IP 已 403），把更新源指向本镜像（generic provider）才是稳的，而 generic provider 读的
 * 就是这里的 latest.yml + blockmap。
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
  console.error(
    '获取方式：Cloudflare 控制台 → R2 → 管理 R2 API 令牌（权限：Object Read & Write）。'
  )
  process.exit(1)
}

const targets = [
  {
    name: `SMind-${version}-x64-setup.exe`,
    contentType: 'application/octet-stream',
    required: true
  },
  {
    name: `SMind-${version}-x64-portable.exe`,
    contentType: 'application/octet-stream',
    required: true
  },
  {
    name: 'latest.yml',
    contentType: 'text/yaml; charset=utf-8',
    required: false,
    note: '自动更新渠道'
  },
  {
    name: `SMind-${version}-x64-setup.exe.blockmap`,
    contentType: 'application/octet-stream',
    required: false,
    note: '自动更新差分下载'
  }
]

let failed = false
let missingOptional = false
const uploaded = []

for (const target of targets) {
  const local = resolve('release', target.name)
  if (!existsSync(local)) {
    if (target.required) {
      console.error(`✗ 缺少产物：release/${target.name}（先跑 npm run dist）`)
      failed = true
    } else {
      console.warn(
        `⚠ 缺少 ${target.name}（${target.note ?? ''}）→ 不传；**客户端自动更新渠道会失效**，请确认这是有意的`
      )
      missingOptional = true
    }
    continue
  }
  const mb = (statSync(local).size / 1024 / 1024).toFixed(1)
  console.log(`上传 ${target.name}（${mb} MB）→ ${bucket}/${target.name} ...`)
  try {
    execSync(
      `npx wrangler r2 object put "${bucket}/${target.name}" --file="${local}" --remote --content-type "${target.contentType}"`,
      {
        stdio: 'inherit',
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token }
      }
    )
    console.log(`✓ ${mirrorBase}/${target.name}`)
    uploaded.push(target.name)
  } catch {
    console.error(`✗ ${target.name} 上传失败`)
    failed = true
  }
}

if (failed) process.exit(1)

// 上传后校验镜像直链可达（注意：dl.smindapp.cn 需在 Cloudflare 里绑定到该桶）
console.log('校验镜像直链…')
for (const name of uploaded) {
  try {
    const res = await fetch(`${mirrorBase}/${name}`, { method: 'HEAD' })
    console.log(
      res.ok
        ? `✓ ${mirrorBase}/${name} 可下载`
        : `⚠ ${mirrorBase}/${name} 返回 ${res.status}（若刚绑定域名，稍等几分钟再试）`
    )
  } catch (e) {
    console.warn(`⚠ 无法访问 ${mirrorBase}/${name}：${e.cause?.message ?? e.message}`)
  }
}

if (missingOptional) {
  console.warn(
    '⚠ 有更新渠道文件没上传（见上面的 ⚠ 行）：安装包能下，但客户端不会自动提示新版本，' +
      '也不会走差分下载。发正式版时请确保 release/ 里有 latest.yml 与 *.blockmap。'
  )
}
