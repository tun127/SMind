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
import { join } from 'node:path'
import { app } from 'electron'
import {
  bumpTrialUsed,
  licenseViewOf,
  normalizeLicenseKey,
  type LicenseView
} from '@shared/license'
import { writeFileAtomic } from '../atomic-write'
import { LICENSE_PUBLIC_KEY_PEM } from './public-key'
import { DEFAULT_LICENSE_STATE, normalizeLicenseState, type LicenseState } from './state'
import { verifyLicenseKeyWith, type VerifyResult } from './verify'

export type { VerifyResult } from './verify'

function licenseFilePath(): string {
  return join(app.getPath('userData'), 'license.json')
}

/**
 * 读状态；文件缺失或损坏一律回退到默认值（许可问题不该让应用起不来）。
 * 形状与逐字段收敛搬进 `./state`（**不依赖 Electron**），因此能被自检覆盖。
 */
export async function readLicenseState(): Promise<LicenseState> {
  try {
    const text = await readFile(licenseFilePath(), 'utf8')
    return normalizeLicenseState(JSON.parse(text))
  } catch {
    return { ...DEFAULT_LICENSE_STATE }
  }
}

async function saveLicenseState(state: LicenseState): Promise<void> {
  await writeFileAtomic(licenseFilePath(), Buffer.from(JSON.stringify(state, null, 2), 'utf8'))
}

/**
 * 离线验签。
 *
 * 签名覆盖的是**许可码里那一段 payload 字节本身**，不是"重新序列化一遍的 JSON"
 * ——后者会因为键序、空格不同而假失败，那是签发工具与客户端最容易对不上的地方。
 */
export function verifyLicenseKey(raw: string): VerifyResult {
  // 实现搬进 ./verify（不依赖 Electron）：自检因此能自己生成一对密钥，把
  // 「签得对 → 验得过」「改一位 → 验不过」「占位公钥 → 可读报错」都真跑一遍。
  // 这里只负责把**内嵌公钥**递进去。
  return verifyLicenseKeyWith(raw, LICENSE_PUBLIC_KEY_PEM)
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
  // 批量卡密池的码不带持有人名（需求 B2）：省略括号，别说成「已激活 Pro（）」
  const who = verified.holder === null ? '' : `（${verified.holder}）`
  return {
    ok: true,
    message: `已激活 Pro${who}。AI 现在可以直接改画布了，感谢支持。`,
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
