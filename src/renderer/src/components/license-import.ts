/**
 * 「从文件导入许可码」：挑文件 → 抽出 `SMIND1.` 串 → 走与粘贴**完全相同**的激活路径。
 *
 * 为什么值得有这条入口（需求 B5）：
 * 1. 许可码 200+ 字符，在邮件/聊天里极易断行或漏字符，**文件形态最稳**；
 * 2. 换电脑时"许可文件存网盘再导入"比"回头翻那串文本"体验好得多——
 *    而 EULA 承诺的正是"重装不锁机"。
 *
 * 抽不到码时**不抛错**：返回一条可读提示，界面照原样显示（用户还能手动粘贴）。
 */
import { findLicenseKeyInText, type LicenseView } from '@shared/license'

export interface LicenseImportResult {
  ok: boolean
  message: string
  view: LicenseView
}

/** 返回 null = 用户在文件框里点了取消（调用方不该改任何状态） */
export async function importLicenseFromFile(): Promise<LicenseImportResult | null> {
  const picked = await window.api.importText('license')
  if (!picked) return null

  const key = findLicenseKeyInText(picked.text)
  if (!key) {
    return {
      ok: false,
      message: `这个文件（${picked.name}）里没找到 SMIND1 开头的许可码`,
      view: await window.api.licenseGet()
    }
  }
  return window.api.licenseActivate(key)
}
