/**
 * 离线验签的**纯实现**（不依赖 Electron → 可被自检覆盖）。
 *
 * 签名覆盖的是**许可码里那一段 payload 字节本身**，不是"重新序列化一遍的 JSON"
 * ——后者会因为键序、空格不同而假失败，那是签发工具与客户端最容易对不上的地方。
 *
 * 内嵌公钥由**调用方传进来**（主进程那份传 `./public-key` 的常量）：这样自检可以自己生成
 * 一对 Ed25519 密钥，把「签得对 → 验得过」「改一位 → 验不过」「占位公钥 → 可读报错」都真跑一遍，
 * 而不是只知道"函数存在"。
 */
import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto'
import { base64UrlToBytes, decodeLicenseKey } from '@shared/license'

export interface VerifyResult {
  ok: boolean
  holder: string | null
  error: string
}

/**
 * 用给定的公钥验一张许可码。
 *
 * 失败一律返回**可读原因**（界面会直接把这句话显示给用户）：
 * 结构不对 → 转发解码器的原因；没内置公钥 / 公钥坏了 / 签名对不上 → 各自一句话。
 */
export function verifyLicenseKeyWith(raw: string, publicKeyPem: string): VerifyResult {
  const decoded = decodeLicenseKey(raw)
  if (!decoded.ok) return { ok: false, holder: null, error: decoded.error }

  if (publicKeyPem.includes('__SMIND_LICENSE_PUBLIC_KEY__')) {
    return {
      ok: false,
      holder: null,
      error: '这个构建没有内置许可公钥，无法激活 Pro（开发构建请先跑 npm run license:keygen）'
    }
  }

  const signature = base64UrlToBytes(decoded.signature)
  if (!signature) return { ok: false, holder: null, error: '许可码的签名读不出来' }

  let publicKey: KeyObject
  try {
    publicKey = createPublicKey(publicKeyPem)
  } catch {
    return { ok: false, holder: null, error: '内置的许可公钥不可用（这是程序自身的问题，请反馈）' }
  }

  let good = false
  try {
    good = verifySignature(null, Buffer.from(decoded.payloadSegment, 'utf8'), publicKey, signature)
  } catch {
    good = false
  }
  if (!good) {
    return {
      ok: false,
      holder: null,
      error: '许可码的签名对不上：可能复制时缺了字符，或者它不是本产品签发的许可码'
    }
  }
  return { ok: true, holder: decoded.payload.holder ?? null, error: '' }
}
