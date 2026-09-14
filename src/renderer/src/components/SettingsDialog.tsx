import type { ReactElement } from 'react'
import { Settings2 } from 'lucide-react'
import type { AppSettings } from '@shared/ipc'
import { Modal } from './Dialogs'

interface Props {
  settings: AppSettings
  themes: Array<{ id: string; name: string }>
  onChange(next: AppSettings): void
  onClose(): void
}

/**
 * 设置：**所有「默认参数」集中在这里改**。
 *
 * 目前三项：默认视角锁定 / 默认主题 / 默认对齐；以后新增默认值直接挂这里，
 * 不再散落进各个面板（存在 %APPDATA%\SMind\settings.json）。
 */
export default function SettingsDialog({ settings, themes, onChange, onClose }: Props): ReactElement {
  const patch = (part: Partial<AppSettings>): void => onChange({ ...settings, ...part })

  return (
    <Modal
      title="设置"
      icon={<Settings2 size={16} />}
      onMaskClick={onClose}
      footer={
        <button type="button" className="btn btn--primary" onClick={onClose}>
          完成
        </button>
      }
    >
      <div className="ai-form">
        <div className="ai-field">
          <span className="ai-field__label">默认视角锁定</span>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={settings.defaultViewLock}
              onChange={(event) => patch({ defaultViewLock: event.target.checked })}
            />
            <span>新建 / 打开文档时自动开启视角锁定（镜头跟住选中的主题）</span>
          </label>
        </div>

        <div className="ai-field">
          <span className="ai-field__label">默认主题</span>
          <select
            className="select"
            value={settings.defaultThemeId ?? ''}
            onChange={(event) => patch({ defaultThemeId: event.target.value || null })}
          >
            <option value="">内置默认主题</option>
            {themes.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.name}
              </option>
            ))}
          </select>
          <span className="ai-field__hint">新建文档时套用；打开已有文件不会改它自己的主题。</span>
        </div>

        <div className="ai-field">
          <span className="ai-field__label">默认对齐</span>
          <select
            className="select"
            value={settings.defaultAlign}
            onChange={(event) => patch({ defaultAlign: event.target.value as AppSettings['defaultAlign'] })}
          >
            <option value="left">左对齐</option>
            <option value="center">居中</option>
            <option value="right">右对齐</option>
          </select>
          <span className="ai-field__hint">
            没有单独设置过对齐的段落都用它（改完立即生效；单独设过对齐的段落不受影响）。
          </span>
        </div>
      </div>
    </Modal>
  )
}
