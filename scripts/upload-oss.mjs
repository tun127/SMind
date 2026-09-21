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
 * 三个为"上传大文件会中断"而做的设计（2026-09-20 实测踩过：108 MB 的 portable 传到一半
 * 断在 `fetch failed`，而脚本当时会直接退出、也不做校验）：
 *   - **断点续传的替代**：上传前先 HEAD，**对象已存在且大小一致就跳过**，只补传缺的那个；
 *     ⚠ **清单文件（`latest.yml` / `rt.yml`）例外：永不跳过**。它们只有 347 字节，跳过毫无收益；
 *     而两个版本的 YAML 结构固定（版本号恒 3 字符、sha512 恒 88 字符 base64）→ **字节数天然相等**，
 *     于是"大小一致"会把它误判成"已传过" → **线上清单仍指旧版本** → 普通用户永远收不到更新，
 *     而 rt 通道却收得到（假绿）。2026-09-21 发 0.9.2 时真实发生过（报告 §16 / D-20）。
 *   - **失败重试**：每个对象最多试 3 次（1s / 3s 退避）；
 *   - **校验不再被跳过**：即使有对象上传失败，也把已成功的逐个 HEAD 验一遍，最后才以非 0 退出。
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
    neverSkip: true,
    note: '自动更新渠道（清单文件：永不按体积跳过，见文件头 D-20）'
  },
  {
    name: `SMind-${version}-x64-setup.exe.blockmap`,
    contentType: 'application/octet-stream',
    required: false,
    note: '自动更新差分下载'
  },
  {
    name: 'rt.yml',
    /**
     * 内容与 `latest.yml` **完全同一份**，只是换个对象名（所以用 sourceName 指回它）。
     *
     * 为什么必须有：预发布构建（`0.9.2-rt.N` 这类）的 app-update.yml 里是 `channel: rt`，
     * electron-updater 取的是 `rt.yml` 而不是 `latest.yml` —— 只传后者的话那边拿到 404，
     * 而例行检查失败是**刻意静默**的，现场表现就是"什么都没发生"，
     * 足以把 D4 的首跑验收做成假通过（报告 §7.4 / D-16）。
     */
    sourceName: 'latest.yml',
    contentType: 'text/yaml; charset=utf-8',
    required: false,
    neverSkip: true,
    note: '预发布通道（channel: rt）：与 latest.yml 同一份内容另存（同样永不跳过）'
  }
]

/**
 * OSS 原生 V1 签名的待签字符串（注意：Content-MD5 与 Content-Type 即使为空也要占位，
 * 段之间用 \n 连接，最后一段是 `/桶名/对象名`——顺序错一个字符就是 403）。
 */
function authorization(method, key, contentType, date) {
  const stringToSign = [method, '', contentType, date, `/${bucket}/${key}`].join('\n')
  const signature = createHmac('sha1', keySecret).update(stringToSign, 'utf8').digest('base64')
  return `OSS ${keyId}:${signature}`
}

function signedHeaders(method, key, contentType) {
  const date = new Date().toUTCString()
  return {
    Date: date,
    'Content-Type': contentType,
    Authorization: authorization(method, key, contentType, date)
  }
}

/** 已存在则返回字节数，不存在返回 null（HEAD 不计流量费，可放心用来做"跳过已传"） */
async function head(key) {
  const res = await fetch(`https://${bucket}.${endpoint}/${key}`, {
    method: 'HEAD',
    headers: signedHeaders('HEAD', key, '')
  })
  if (res.status === 404) return null
  if (!res.ok) return null
  const len = res.headers.get('content-length')
  return len === null ? null : Number(len)
}

async function put(key, filePath, contentType) {
  const body = readFileSync(filePath)
  const res = await fetch(`https://${bucket}.${endpoint}/${key}`, {
    method: 'PUT',
    headers: signedHeaders('PUT', key, contentType),
    body
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`)
  }
}

/** undici 的 `fetch failed` 会把真正原因藏在 cause 里，不打印出来根本没法排查 */
function describe(error) {
  const cause = error instanceof Error ? error.cause : undefined
  const detail = cause instanceof Error ? cause.message : ''
  return detail
    ? `${error.message}（${detail}）`
    : String(error instanceof Error ? error.message : error)
}

async function putWithRetry(key, filePath, contentType) {
  const attempts = 3
  for (let i = 1; i <= attempts; i++) {
    try {
      await put(key, filePath, contentType)
      return
    } catch (error) {
      if (i === attempts) throw error
      console.warn(`  ⚠ 第 ${i} 次失败（${describe(error)}），${i * 2} 秒后重试…`)
      await new Promise((r) => setTimeout(r, i * 2000))
    }
  }
}

let failed = false
let missingOptional = false
const uploaded = []

for (const target of targets) {
  // 默认从同名产物读；带 sourceName 的（rt.yml）与 latest.yml 共用同一份内容
  const local = resolve('release', target.sourceName ?? target.name)
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

  const size = statSync(local).size
  const mb = (size / 1024 / 1024).toFixed(1)

  // 已存在且大小一致就跳过：补传时不必把 108 MB 白传一遍
  let remote = null
  try {
    remote = await head(target.name)
  } catch (error) {
    console.warn(`  （HEAD 探测失败，将直接上传：${describe(error)}）`)
  }
  // 清单文件永不跳过：体积相同 ≠ 内容相同（0.9.1 与 0.9.2 的 latest.yml 都是 347 字节），
  // 跳过就会让线上清单停留在旧版本 → 普通用户收不到新版（D-20，2026-09-21 真实踩过）。
  if (remote === size && !target.neverSkip) {
    console.log(`= ${target.name}（${mb} MB）远端已存在且大小一致 → 跳过`)
    uploaded.push(target.name)
    continue
  }
  if (remote === size && target.neverSkip) {
    console.log(`↑ ${target.name}（${mb} MB）体积与远端相同，但它是清单文件 → 强制重传`)
  }

  console.log(`上传 ${target.name}（${mb} MB）→ ${bucket}/${target.name} ...`)
  try {
    await putWithRetry(target.name, local, target.contentType)
    console.log(`✓ ${publicBase}/${target.name}`)
    uploaded.push(target.name)
  } catch (error) {
    console.error(`✗ ${target.name} 上传失败：${describe(error)}`)
    failed = true
  }
}

// 不论上面有没有失败，都把已传成功的验一遍 —— 否则"哪几个真上去了"要靠猜
if (uploaded.length > 0) {
  console.log('校验直链…')
  for (const name of uploaded) {
    try {
      const res = await fetch(`${publicBase}/${name}`, { method: 'HEAD' })
      console.log(
        res.ok
          ? `✓ ${publicBase}/${name} 可下载（${res.headers.get('content-length') ?? '?'} 字节）`
          : `⚠ ${publicBase}/${name} 返回 ${res.status}（刚绑域名或刚设公共读时，稍等几分钟再试）`
      )
    } catch (e) {
      console.warn(`⚠ 无法访问 ${publicBase}/${name}：${describe(e)}`)
    }
  }
}

if (missingOptional) {
  console.warn(
    '⚠ 有更新渠道文件没上传（见上面的 ⚠ 行）：安装包能下，但客户端不会自动提示新版本，' +
      '也不会走差分下载。发正式版时请确保 release/ 里有 latest.yml 与 *.blockmap。'
  )
}

/**
 * 收尾硬校验：**线上正在服务的清单必须指向本次发的版本**。
 *
 * 这是发版验收的最后一跳，也是唯一能证明"用户在拿到新版本"的证据 ——
 * 上传成功 ≠ 生效（D-20 就是"上传成功但清单没变"）。
 */
for (const name of ['latest.yml', 'rt.yml']) {
  try {
    const res = await fetch(`${publicBase}/${name}`, { cache: 'no-store' })
    if (!res.ok) {
      console.error(`✗ ${name} 拉不到（HTTP ${res.status}）→ 自动更新渠道不可用`)
      failed = true
      continue
    }
    const text = await res.text()
    if (text.includes(`version: ${version}`)) {
      console.log(`✓ ${name} 指向 ${version}（线上清单已生效）`)
    } else {
      console.error(`✗ ${name} 里没有 version: ${version} → 客户端不会收到本次更新`)
      failed = true
    }
  } catch (error) {
    console.warn(`⚠ 无法校验 ${name}：${describe(error)}`)
  }
}

if (failed) {
  console.error('有对象上传失败：直接重跑本命令即可（已传成功的会被跳过，只补失败的那些）。')
  process.exit(1)
}
