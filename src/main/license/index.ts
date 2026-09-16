/**
 * 许可与试用的**主进程**实现：离线验签、状态落盘、试用计数。
 *
 * 为什么闸门必须在这一层：AI 请求本来就是主进程代理的，**由主进程决定下发哪些
 * 工具定义**，模型看不到写工具就物理上调不动它。渲染层的界面提示只是礼貌，
 * 不是边界——与「工具即权限边界」是同一条原则。
 *
 * 不做在线激活（符合 local-first）：许可码里带 Ed25519 签名，本地用内嵌公钥验。
 * 这意味着一台离线机器也能激活，也意味着有心人可以去改客户端——个人软件的
 * 荣誉制取舍，已经在商业化一节里记过账。
 */
import { readFile } from 'node:fs/promises'
import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import {
  base64UrlToBytes,
  bumpTrialUsed,
  decodeLicenseKey,
  licenseViewOf,
  normalizeLicenseKey,
  type LicenseView
} from '@shared/license'
import { writeFileAtomic } from '../atomic-write'
import { LICENSE_PUBLIC_KEY_PEM } from './public-key'

interface LicenseState {
  version: 1
  /** 用户激活时粘进来的许可码（原样保存，每次启动重新验签） */
  key: string | null
  /** 已经用掉几个「写回合」 */
  trialUsed: number
}

const DEFAULT_STATE: LicenseState = { version: 1, key: null, trialUsed: 0 }

function licenseFilePath(): string {
  return join(app.getPath('userData'), 'license.json')
}

/** 读状态；文件缺失或损坏一律回退到默认值（许可问题不该让应用起不来） */
export async function readLicenseState(): Promise<LicenseState> {
  try {
    const raw: unknown = JSON.parse(await readFile(licenseFilePath(), 'utf8'))
    if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_STATE }
    const record = raw as Record<string, unknown>
    return {
      version: 1,
      key: typeof record.key === 'string' && record.key.length > 0 ? record.key : null,
      trialUsed:
        typeof record.trialUsed === 'number' &&
        Number.isFinite(record.trialUsed) &&
        record.trialUsed > 0
          ? Math.floor(record.trialUsed)
          : 0
    }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

async function saveLicenseState(state: LicenseState): Promise<void> {
  await writeFileAtomic(licenseFilePath(), Buffer.from(JSON.stringify(state, null, 2), 'utf8'))
}

export interface VerifyResult {
  ok: boolean
  holder: string | null
  error: string
}

/**
 * 离线验签。
 *
 * 签名覆盖的是**许可码里那一段 payload 字节本身**，不是"重新序列化一遍的 JSON"
 * ——后者会因为键序、空格不同而假失败，那是签发工具与客户端最容易对不上的地方。
 */
export function verifyLicenseKey(raw: string): VerifyResult {
  const decoded = decodeLicenseKey(raw)
  if (!decoded.ok) return { ok: false, holder: null, error: decoded.error }

  if (LICENSE_PUBLIC_KEY_PEM.includes('__SMIND_LICENSE_PUBLIC_KEY__')) {
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
    publicKey = createPublicKey(LICENSE_PUBLIC_KEY_PEM)
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
  return { ok: true, holder: decoded.payload.holder, error: '' }
}

/**
 * Pro 状态缓存。
 *
 * 验签是纯计算、很便宜，但它要读盘；而这条路径在**每次发起对话**时都要问一次，
 * 所以缓存住，只有激活 / 取消激活时才失效。
 */
let proCache: { pro: boolean; holder: string | null } | null = null

async function loadPro(): Promise<{ pro: boolean; holder: string | null }> {
  if (proCache) return proCache
  const state = await readLicenseState()
  if (state.key === null) {
    proCache = { pro: false, holder: null }
    return proCache
  }
  const verified = verifyLicenseKey(state.key)
  proCache = verified.ok ? { pro: true, holder: verified.holder } : { pro: false, holder: null }
  return proCache
}

/** 当前许可状态（渲染层显示用；主进程判定也用它，两边不会各算一套） */
export async function getLicenseView(): Promise<LicenseView> {
  const state = await readLicenseState()
  const pro = await loadPro()
  return licenseViewOf({ pro: pro.pro, holder: pro.holder, trialUsed: state.trialUsed })
}

export async function activateLicense(
  raw: string
): Promise<{ ok: boolean; message: string; view: LicenseView }> {
  const verified = verifyLicenseKey(raw)
  if (!verified.ok) {
    return { ok: false, message: verified.error, view: await getLicenseView() }
  }
  const state = await readLicenseState()
  await saveLicenseState({ ...state, key: normalizeLicenseKey(raw) })
  proCache = null
  return {
    ok: true,
    message: `已激活 Pro（${verified.holder ?? ''}）。AI 现在可以直接改画布了，感谢支持。`,
    view: await getLicenseView()
  }
}

/** 取消激活（换机器、退货、自己反悔都用它） */
export async function deactivateLicense(): Promise<LicenseView> {
  const state = await readLicenseState()
  await saveLicenseState({ ...state, key: null })
  proCache = null
  return getLicenseView()
}

/**
 * 用掉一个试用回合。
 *
 * 已经是 Pro 就不计数（花过钱的人不该再被数次数）；到上限就停在上限，
 * 免得数字越滚越大、以后改上限时老用户反而"欠费"。
 */
export async function consumeTrialTurn(): Promise<void> {
  const pro = await loadPro()
  if (pro.pro) return
  const state = await readLicenseState()
  const next = bumpTrialUsed(state.trialUsed)
  if (next === state.trialUsed) return
  await saveLicenseState({ ...state, trialUsed: next })
}
