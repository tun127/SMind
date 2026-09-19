/**
 * 许可码签发工具（**只给项目所有者用**，不进应用运行时）。
 *
 * 用法：
 *   npm run license:keygen                                        生成密钥对（私钥写到仓库之外）
 *   npm run license:issue -- --to 张三 [--order A-001] [--date 2026-09-15] [--serial S-0001]
 *   npm run license:issue -- --to 张三 --batch early --count 200   批量签发（卡密池 / 自动发货用）
 *
 * 三条纪律：
 * 1. **私钥永不进仓库**：默认落在 `%USERPROFILE%/SMind-keys/license-private.pem`
 *    （可用 `SMIND_KEY_DIR` 改位置），请离线备份；丢了就签不出新许可码。
 * 2. **公钥换掉 = 已发出的许可码全部失效**：生成一次就固定下来，
 *    把打印出来的 PEM 粘进 `src/main/license/public-key.ts`。
 * 3. **批量签发必须逐码真签**：每张码的 payload 里带一个不同的 `serial`，签名是对**这一张自己的
 *    payload 字节**做的。绝不允许"签一次、改字符串"——那样 200 张码共用同一个签名：
 *    限量形同虚设、泄露了也查不出是哪一张、对账无从谈起。
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  base64UrlToBytes,
  batchSerialOf,
  bytesToBase64Url,
  decodeLicenseKey,
  encodeLicenseKey,
  licensePayloadSegment,
  type LicensePayload
} from '../src/shared/license'

const KEY_DIR = process.env.SMIND_KEY_DIR ?? join(homedir(), 'SMind-keys')
const PRIVATE_KEY_PATH = join(KEY_DIR, 'license-private.pem')

/** 一批最多签多少张：卡密池按批核对，批太大人核不过来（也防手滑写出 --count 1e9） */
const MAX_BATCH = 2000

/** 批次标签的形状（它会拼进序列号，所以形状必须与许可证里的校验一致） */
const BATCH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/

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

/** CSV 单元格：含逗号/引号/换行时按 RFC 4180 加引号转义 */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * 签发一张码：签名覆盖的是**这一张自己的** payload 段字节。
 * 地址化成一个函数，是为了让"逐码真签"在代码形状上无法被打折扣。
 */
function signOne(privateKey: ReturnType<typeof createPrivateKey>, payload: LicensePayload): string {
  const segment = licensePayloadSegment(payload)
  const signature = sign(null, Buffer.from(segment, 'utf8'), privateKey)
  return encodeLicenseKey(payload, bytesToBase64Url(signature))
}

function issue(): void {
  // --to 可省略：批量卡密池的码没有买家名字（省略时界面显示「已激活 Pro」，不带括号名字）
  const holder = readArg('to') ?? undefined

  const countText = readArg('count')
  const count = countText === null ? 1 : Number(countText)
  const batch = readArg('batch')
  const serialArg = readArg('serial')

  if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH) {
    console.error(`--count 必须是 1..${MAX_BATCH} 之间的整数（收到 ${countText ?? '(空)'}）`)
    process.exitCode = 1
    return
  }
  if (count > 1 && !batch) {
    console.error(
      '批量签发必须给 --batch 标签：序列号要能一眼看出属于哪一批（例如 --batch early-2026）'
    )
    process.exitCode = 1
    return
  }
  if (count > 1 && serialArg !== null) {
    console.error('--serial 只用于单张签发；批量请用 --batch + --count，序列号由工具逐张生成')
    process.exitCode = 1
    return
  }
  if (batch !== null && !BATCH_RE.test(batch)) {
    console.error('--batch 只允许字母数字开头，可带 - . _ ，最长 41 个字符')
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

  const issuedAt = readArg('date') ?? new Date().toISOString().slice(0, 10)
  const order = readArg('order') ?? undefined
  const privateKey = createPrivateKey(readFileSync(PRIVATE_KEY_PATH))

  const rows: { serial: string; code: string }[] = []
  for (let index = 0; index < count; index += 1) {
    const serial =
      batch !== null ? batchSerialOf(batch, index + 1) : serialArg !== null ? serialArg : undefined
    const payload: LicensePayload = { v: 1, edition: 'pro', holder, issuedAt, order, serial }
    const code = signOne(privateKey, payload)

    // 逐张自查：解不回来（例如 --serial 里有不允许的字符）就当场停，绝不落盘半批码
    const decoded = decodeLicenseKey(code)
    if (!decoded.ok) {
      console.error(`第 ${index + 1} 张的自检没过：${decoded.error}`)
      console.error(
        '（常见原因：--serial 形状不对——字母数字开头，可带 - . _，最长 64；或 holder/order 里有控制字符）'
      )
      process.exitCode = 1
      return
    }
    if (decoded.payload.serial !== serial) {
      console.error(`第 ${index + 1} 张的序列号在往返中丢了，已停止（不落盘）`)
      process.exitCode = 1
      return
    }
    rows.push({ serial: serial ?? '', code })
  }

  // 唯一性守卫：出现重复的码 = "签一次改字符串"式的事故，卡密池会立刻失去意义
  if (new Set(rows.map((row) => row.code)).size !== rows.length) {
    console.error('生成了重复的许可码（卡密池会失去意义），已停止（不落盘）')
    process.exitCode = 1
    return
  }
  if (new Set(rows.map((row) => row.serial)).size !== rows.length) {
    console.error('生成了重复的序列号，已停止（不落盘）')
    process.exitCode = 1
    return
  }

  const single = rows[0]
  if (rows.length === 1 && single) {
    console.log(`持有人：${holder ?? '(未指定，界面显示「已激活 Pro」)'}`)
    console.log(`签发日期：${issuedAt}${order ? `  订单：${order}` : ''}`)
    if (single.serial) console.log(`序列号：${single.serial}`)
    console.log('\n许可码（整串发给用户，让他粘进「AI 聊天面板 → 输入许可码」）：\n')
    console.log(single.code)
    return
  }

  const first = rows[0]?.serial ?? ''
  const last = rows[rows.length - 1]?.serial ?? ''
  const csvPath = join(KEY_DIR, `codes-${batch ?? 'batch'}-${issuedAt}.csv`)
  const header = 'serial,code,holder,order,issuedAt'
  const body = rows.map((row) =>
    [row.serial, row.code, holder ?? '', order ?? '', issuedAt].map(csvCell).join(',')
  )
  // UTF-8 带 BOM + CRLF：Excel 双击不乱码、不并成一列
  writeFileSync(csvPath, `\uFEFF${[header, ...body].join('\r\n')}\r\n`, {
    encoding: 'utf8',
    mode: 0o600
  })

  console.log(`已签发 ${rows.length} 张（逐张真签、序列号互不相同）：${first} … ${last}`)
  console.log(`批量：${batch}   持有人：${holder}   签发日期：${issuedAt}`)
  console.log(`\n卡密池 CSV 已写入（列：serial, code, holder, order, issuedAt）：\n${csvPath}`)
  console.log('★ 导入卡密池时用 serial 列做唯一键；这个文件在仓库之外，别粘进聊天记录。')
}

/**
 * 配套自检：用真私钥签一张许可码，再用**客户端内嵌的公钥**验回来。
 *
 * 专防"换了密钥却忘了把公钥粘进客户端"这个错——它的后果是用户拿着合法许可码
 * 激活失败，而你在本地怎么试都试不出来（因为本地签、本地验都用自己的公钥）。
 * 顺带钉住一条：**序列号确实在签名覆盖范围内**（改掉它签名必须失效）。
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
  const clientKey = createPublicKey(pem[0])

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
    verify(null, Buffer.from(decoded.payloadSegment, 'utf8'), clientKey, signatureBytes)

  if (matched) {
    console.log('✅ 签发私钥与客户端内嵌公钥配套：签出来的许可码能在客户端激活')
  } else {
    console.error('❌ 不配套：换了密钥却忘了把新公钥粘进 src/main/license/public-key.ts')
    process.exitCode = 1
    return
  }

  // 序列号参与签名的实证：同一把私钥、同一个 serial 之外只差一位
  const serialPayload: LicensePayload = { ...payload, serial: batchSerialOf('SELFTEST', 1) }
  const serialSignature = sign(
    null,
    Buffer.from(licensePayloadSegment(serialPayload), 'utf8'),
    createPrivateKey(readFileSync(PRIVATE_KEY_PATH))
  )
  const tamperedOk = verify(
    null,
    Buffer.from(
      licensePayloadSegment({ ...serialPayload, serial: batchSerialOf('SELFTEST', 2) }),
      'utf8'
    ),
    clientKey,
    serialSignature
  )
  if (tamperedOk) {
    console.error('❌ 只改序列号签名竟然还验得过：serial 没有进签名覆盖范围，批量签发不安全')
    process.exitCode = 1
  } else {
    console.log('✅ 序列号在签名覆盖范围内（改一位即失效），批量签发的码互相不可替代')
  }
}

const command = process.argv[2]
if (command === 'keygen') keygen()
else if (command === 'issue') issue()
else if (command === 'selftest') selftest()
else {
  console.log(
    '用法：license-tool.ts keygen\n' +
      '      license-tool.ts issue [--to 名字] [--order 单号] [--date 日期] [--serial 序列号]\n' +
      '      license-tool.ts issue --batch 批次 --count 张数 [--to 名字]\n' +
      '      license-tool.ts selftest'
  )
}
