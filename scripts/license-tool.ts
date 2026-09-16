/**
 * 许可码签发工具（**只给项目所有者用**，不进应用运行时）。
 *
 * 用法：
 *   npm run license:keygen                              生成密钥对（私钥写到仓库之外）
 *   npm run license:issue -- --to 张三 [--order A-001] [--date 2026-09-15]
 *
 * 两条纪律：
 * 1. **私钥永不进仓库**：默认落在 `%USERPROFILE%/SMind-keys/license-private.pem`
 *    （可用 `SMIND_KEY_DIR` 改位置），请离线备份；丢了就签不出新许可码。
 * 2. **公钥换掉 = 已发出的许可码全部失效**：生成一次就固定下来，
 *    把打印出来的 PEM 粘进 `src/main/license/public-key.ts`。
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  base64UrlToBytes,
  bytesToBase64Url,
  decodeLicenseKey,
  encodeLicenseKey,
  licensePayloadSegment,
  type LicensePayload
} from '../src/shared/license'

const KEY_DIR = process.env.SMIND_KEY_DIR ?? join(homedir(), 'SMind-keys')
const PRIVATE_KEY_PATH = join(KEY_DIR, 'license-private.pem')

function readArg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return null
  const value = process.argv[index + 1]
  return value && !value.startsWith('--') ? value : null
}

function printPublicKey(): void {
  const privateKey = createPrivateKey(readFileSync(PRIVATE_KEY_PATH))
  const pem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) as string
  console.log('把下面这段（连同反引号）粘进 src/main/license/public-key.ts：\n')
  console.log(pem)
}

function keygen(): void {
  if (existsSync(PRIVATE_KEY_PATH)) {
    console.log(`私钥已存在，不覆盖：${PRIVATE_KEY_PATH}`)
    console.log('（要换密钥请先手工移走它——换掉会让已发出的许可码全部失效）')
  } else {
    const { privateKey } = generateKeyPairSync('ed25519')
    mkdirSync(KEY_DIR, { recursive: true })
    writeFileSync(PRIVATE_KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, {
      mode: 0o600
    })
    console.log(`私钥已写入：${PRIVATE_KEY_PATH}`)
    console.log('★ 请立刻离线备份，并确认它永远不进仓库（仓库已忽略 *.pem 之外的密钥目录）。')
  }
  printPublicKey()
}

function issue(): void {
  const holder = readArg('to')
  if (!holder) {
    console.error('缺少 --to（持有人名字，会印在许可码里）')
    process.exitCode = 1
    return
  }
  if (!existsSync(PRIVATE_KEY_PATH)) {
    console.error(
      `找不到私钥：${PRIVATE_KEY_PATH}\n请先跑 npm run license:keygen，或设置 SMIND_KEY_DIR`
    )
    process.exitCode = 1
    return
  }

  const payload: LicensePayload = {
    v: 1,
    edition: 'pro',
    holder,
    issuedAt: readArg('date') ?? new Date().toISOString().slice(0, 10),
    order: readArg('order') ?? undefined
  }

  // 签名覆盖 payload 段的字节本身：客户端验签用的就是同一串，不存在序列化差异
  const segment = licensePayloadSegment(payload)
  const signature = sign(
    null,
    Buffer.from(segment, 'utf8'),
    createPrivateKey(readFileSync(PRIVATE_KEY_PATH))
  )
  const key = encodeLicenseKey(payload, bytesToBase64Url(signature))

  console.log(`持有人：${payload.holder}`)
  console.log(`签发日期：${payload.issuedAt}${payload.order ? `  订单：${payload.order}` : ''}`)
  console.log('\n许可码（整串发给用户，让他粘进「AI 聊天面板 → 输入许可码」）：\n')
  console.log(key)
}

/**
 * 配套自检：用真私钥签一张许可码，再用**客户端内嵌的公钥**验回来。
 *
 * 专防"换了密钥却忘了把公钥粘进客户端"这个错——它的后果是用户拿着合法许可码
 * 激活失败，而你在本地怎么试都试不出来（因为本地签、本地验都用自己的公钥）。
 */
function selftest(): void {
  if (!existsSync(PRIVATE_KEY_PATH)) {
    console.error(`找不到私钥：${PRIVATE_KEY_PATH}\n请先跑 npm run license:keygen`)
    process.exitCode = 1
    return
  }
  const source = readFileSync(join(process.cwd(), 'src/main/license/public-key.ts'), 'utf8')
  const pem = source.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/)
  if (!pem) {
    console.error('读不到客户端内嵌的公钥（src/main/license/public-key.ts）')
    process.exitCode = 1
    return
  }

  const payload: LicensePayload = {
    v: 1,
    edition: 'pro',
    holder: '配套自检',
    issuedAt: new Date().toISOString().slice(0, 10)
  }
  const segment = licensePayloadSegment(payload)
  const signature = sign(
    null,
    Buffer.from(segment, 'utf8'),
    createPrivateKey(readFileSync(PRIVATE_KEY_PATH))
  )
  const key = encodeLicenseKey(payload, bytesToBase64Url(signature))

  const decoded = decodeLicenseKey(key)
  const signatureBytes = decoded.ok ? base64UrlToBytes(decoded.signature) : null
  const matched =
    decoded.ok &&
    signatureBytes !== null &&
    verify(
      null,
      Buffer.from(decoded.payloadSegment, 'utf8'),
      createPublicKey(pem[0]),
      signatureBytes
    )

  if (matched) {
    console.log('✅ 签发私钥与客户端内嵌公钥配套：签出来的许可码能在客户端激活')
  } else {
    console.error('❌ 不配套：换了密钥却忘了把新公钥粘进 src/main/license/public-key.ts')
    process.exitCode = 1
  }
}

const command = process.argv[2]
if (command === 'keygen') keygen()
else if (command === 'issue') issue()
else if (command === 'selftest') selftest()
else {
  console.log('用法：license-tool.ts keygen | issue --to 名字 [--order 单号] | selftest')
}
