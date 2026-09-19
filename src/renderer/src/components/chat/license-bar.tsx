/**
 * 许可状态条与就地激活（自 ChatPanel.tsx 整块搬出，JSX 逐字未改）。
 *
 * 四个激活相关的 state 仍住在入口组件（这一条的挂载/卸载由许可状态决定，
 * 把 state 搬进来会在隐藏时被重置），这里只收原样 props 与 setter。
 *
 * 2026-09-19 新增「从文件导入…」：与 AiSettingsDialog 里的那条共用同一段流程
 * （见 ./license-import.ts），长码用文件交付时更稳。
 */

import { TriangleAlert } from 'lucide-react'
import type { ReactElement } from 'react'
import type { LicenseView } from '@shared/license'
import { importLicenseFromFile } from '../license-import'

interface Props {
  license: LicenseView
  activateOpen: boolean
  licenseKey: string
  licenseMessage: string | null
  setActivateOpen(value: boolean): void
  setLicenseKey(value: string): void
  setLicenseMessage(value: string | null): void
  setLicense(view: LicenseView): void
}

export default function LicenseBar({
  license,
  activateOpen,
  licenseKey,
  licenseMessage,
  setActivateOpen,
  setLicenseKey,
  setLicenseMessage,
  setLicense
}: Props): ReactElement {
  /** 从文件导入：取消（返回 null）时一个字都不改，保持原样 */
  const importFromFile = async (): Promise<void> => {
    try {
      const result = await importLicenseFromFile()
      if (!result) return
      setLicense(result.view)
      setLicenseMessage(result.message)
      if (result.ok) {
        setActivateOpen(false)
        setLicenseKey('')
      }
    } catch (error) {
      setLicenseMessage(`导入失败：${(error as Error).message}`)
    }
  }

  return (
    <div className="chat-panel__limits">
      <div className="chat-panel__limits-text">
        <TriangleAlert size={14} />
        <span>{license.writeHint}</span>
      </div>
      {activateOpen ? (
        <div className="chat-panel__activate">
          <textarea
            value={licenseKey}
            rows={3}
            placeholder="把购买时拿到的许可码整串粘进来（可以带换行）"
            onChange={(event) => setLicenseKey(event.target.value)}
          />
          {licenseMessage && <div className="chat-panel__activate-msg">{licenseMessage}</div>}
          <div className="chat-panel__activate-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setActivateOpen(false)
                setLicenseMessage(null)
              }}
            >
              取消
            </button>
            <button type="button" className="btn" onClick={() => void importFromFile()}>
              从文件导入…
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={licenseKey.trim().length === 0}
              onClick={() => {
                void window.api.licenseActivate(licenseKey).then((result) => {
                  setLicense(result.view)
                  setLicenseMessage(result.message)
                  if (result.ok) {
                    setActivateOpen(false)
                    setLicenseKey('')
                  }
                })
              }}
            >
              激活
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setActivateOpen(true)}>
          输入许可码
        </button>
      )}
    </div>
  )
}
