/**
 * 许可状态的形状与**规范化**（主进程，**不依赖 Electron** → 可被自检覆盖）。
 *
 * 只做一件事：把磁盘上的任意 JSON 收成合法状态。许可文件是用户可能手改、也可能被写坏的东西，
 * **读坏了绝不能让应用起不来**——任何异常形状都退回默认值（未激活、试用 0 次）。
 * 判断与读写分开，是这一批「让主进程也进回归网」的通用做法。
 */

export interface LicenseState {
  version: 1
  /** 用户激活时粘进来的许可码（原样保存，每次启动重新验签） */
  key: string | null
  /** 已经用掉几个「写回合」 */
  trialUsed: number
}

export const DEFAULT_LICENSE_STATE: LicenseState = { version: 1, key: null, trialUsed: 0 }

/**
 * 任意 JSON → 合法状态。
 *
 * 逐字段收敛而不是 `as` 强转：`key` 非空字符串才认，`trialUsed` 必须是有穷正数（取整），
 * 其余（含 `null`、数组、字符串、NaN、负数、"5" 这种字符串数字）一律当"没激活、没用过"。
 */
export function normalizeLicenseState(raw: unknown): LicenseState {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_LICENSE_STATE }
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
}
