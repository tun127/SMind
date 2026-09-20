#!/usr/bin/env node
/**
 * 阿里云 OSS 上传：把 release/ 下的安装包与**自动更新渠道文件**传到 OSS（国内镜像）。
 *
 * 用法（先配好四个环境变量，再跑）：
 *   OSS_BUCKET=smind-releases OSS_ENDPOINT=oss-cn-hongkong.aliyuncs.com \
 *   OSS_ACCESS_KEY_ID=xxx OSS_ACCESS_KEY_SECRET=xxx npm run mirror:oss
 *
 * 环境变量：
 *   OSS_BUCKET             桶名，如 smind-releases
 *   OSS_ENDPOINT           地域端点，**不带 https://**，如 oss-cn-hongkong.aliyuncs.com
 *   OSS_ACCESS_KEY_ID      建议用 RAM 子账号，只授这个桶的读写（见 docs/release-oss.md）
 *   OSS_ACCESS_KEY_SECRET  对应密钥
 * 可选：
 *   OSS_PUBLIC_BASE        对外访问前缀，默认 https://{bucket}.{endpoint}
 *                          绑了自定义域名就填 https://dl.smindapp.cn
 *
 * 上传清单（与 R2 那套完全一致，一个都不能少）：
 *   1. `SMind-<版本>-x64-setup.exe`            必需（安装版）
 *   2. `SMind-<版本>-x64-portable.exe`         必需（免安装版）
 *   3. `latest.yml`                            **自动更新渠道**：客户端靠它比对版本
 *   4. `SMind-<版本>-x64-setup.exe.blockmap`   **自动更新渠道**：差分下载用
 *
 * 3/4 缺失时**只警告、不中断**（只发安装包是允许的），但会自动更新渠道失效。
 *
 * 为什么用 OSS：Cloudflare R2 激活必须绑支付方式（免费额度内不扣费，但不绑就开不了），
 * 而阿里云 OSS 用支付宝即可、香港节点绑自定义域名**不需要 ICP 备案**。详见 docs/release-oss.md。
 *
 * 原理：零依赖，直接按**阿里云 OSS 原生 V1 签名**（`Authorization: OSS <key>:<hmac-sha1>`）
 * 发 PUT，不引 SDK、不装 CLI。
 */
import { createHmac } from 'node:crypto'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const version = pkg.version

const bucket = process.env.OSS_BUCKET
const endpoint = (process.env.OSS_ENDPOINT ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '')
const keyId = process.env.OSS_ACCESS_KEY_ID
const keySecret = process.env.OSS_ACCESS_KEY_SECRET
const publicBase = (process.env.OSS_PUBLIC_BASE ?? `https://${bucket}.${endpoint}`).replace(
  /\/+$/,
  ''
)

if (!bucket || !endpoint || !keyId || !keySecret) {
  console.error(
    '缺少环境变量：OSS_BUCKET / OSS_ENDPOINT / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET'
  )
  console.error('创建方式见 docs/release-oss.md（RAM 子账号 + 只授该桶的读写权限）。')
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

/**
 * OSS 原生 V1 签名的待签字符串（注意：Content-MD5 与 Content-Type 即使为空也要占位，
 * 段之间用 \n 连接，最后一段是 `/桶名/对象名`——顺序错一个字符就是 403）。
 */
function authorization(key, contentType, date) {
  const stringToSign = ['PUT', '', contentType, date, `/${bucket}/${key}`].join('\n')
  const signature = createHmac('sha1', keySecret).update(stringToSign, 'utf8').digest('base64')
  return `OSS ${keyId}:${signature}`
}

async function put(key, filePath, contentType) {
  const body = readFileSync(filePath)
  // OSS 要求 Date 头且与签名一致；这里用标准 UTC 串（GMT）
  const date = new Date().toUTCString()
  const res = await fetch(`https://${bucket}.${endpoint}/${key}`, {
    method: 'PUT',
    headers: {
      Date: date,
      'Content-Type': contentType,
      Authorization: authorization(key, contentType, date)
    },
    body
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`)
  }
}

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
    await put(target.name, local, target.contentType)
    console.log(`✓ ${publicBase}/${target.name}`)
    uploaded.push(target.name)
  } catch (error) {
    console.error(`✗ ${target.name} 上传失败：${error.message}`)
    failed = true
  }
}

if (failed) process.exit(1)

// 上传后校验直链可达：既验证桶的读权限，也验证自定义域名绑定是否生效
console.log('校验直链…')
for (const name of uploaded) {
  try {
    const res = await fetch(`${publicBase}/${name}`, { method: 'HEAD' })
    console.log(
      res.ok
        ? `✓ ${publicBase}/${name} 可下载（${res.headers.get('content-length') ?? '?'} 字节）`
        : `⚠ ${publicBase}/${name} 返回 ${res.status}（刚绑域名/刚设公共读时，稍等几分钟再试）`
    )
  } catch (e) {
    console.warn(`⚠ 无法访问 ${publicBase}/${name}：${e.cause?.message ?? e.message}`)
  }
}

if (missingOptional) {
  console.warn(
    '⚠ 有更新渠道文件没上传（见上面的 ⚠ 行）：安装包能下，但客户端不会自动提示新版本，' +
      '也不会走差分下载。发正式版时请确保 release/ 里有 latest.yml 与 *.blockmap。'
  )
}
