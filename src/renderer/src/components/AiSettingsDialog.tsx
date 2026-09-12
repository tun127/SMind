import { useEffect, useState, type ReactElement } from 'react'
import { CheckCircle2, Plug, Settings2, XCircle } from 'lucide-react'
import { AI_PRESETS, DEFAULT_AI_CONFIG, type AiConfigView } from '@shared/ai'
import { Modal } from './Dialogs'

interface Props {
  onClose(): void
  onNotify(message: string): void
}

/** AI 设置：BaseURL / 模型 / Key / 采样温度，含「测试连接」 */
export default function AiSettingsDialog({ onClose, onNotify }: Props): ReactElement {
  const [view, setView] = useState<AiConfigView | null>(null)
  const [baseUrl, setBaseUrl] = useState(DEFAULT_AI_CONFIG.baseUrl)
  const [model, setModel] = useState(DEFAULT_AI_CONFIG.model)
  const [temperature, setTemperature] = useState(DEFAULT_AI_CONFIG.temperature)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const current = await window.api.aiConfigGet()
        setView(current)
        setBaseUrl(current.baseUrl)
        setModel(current.model)
        setTemperature(current.temperature)
      } catch (error) {
        onNotify(`读取 AI 配置失败：${(error as Error).message}`)
      }
    })()
  }, [onNotify])

  const save = async (notify = true): Promise<boolean> => {
    try {
      setBusy(true)
      // Key 留空表示「不改动已保存的 Key」
      const next = await window.api.aiConfigSave({ baseUrl, model, temperature, apiKey })
      setView(next)
      setApiKey('')
      if (notify) onNotify('AI 设置已保存（Key 只存在本机配置文件里，不会写进 .xmind）')
      return true
    } catch (error) {
      onNotify(`保存失败：${(error as Error).message}`)
      return false
    } finally {
      setBusy(false)
    }
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      // 先保存再测，避免「测的是旧配置」
      if (apiKey.trim().length > 0 || baseUrl !== view?.baseUrl || model !== view?.model) {
        const ok = await save(false)
        if (!ok) return
      }
      const result = await window.api.aiTest()
      setTestResult({ ok: result.ok, message: result.message })
    } catch (error) {
      setTestResult({ ok: false, message: (error as Error).message })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Modal
      title="AI 设置"
      icon={<Settings2 size={18} />}
      onMaskClick={busy ? undefined : onClose}
      footer={
        <>
          <button type="button" className="btn" disabled={busy || testing} onClick={onClose}>
            关闭
          </button>
          <button type="button" className="btn" disabled={busy || testing} onClick={() => void test()}>
            <Plug size={14} />
            {testing ? '正在测试…' : '测试连接'}
          </button>
          <button type="button" className="btn btn--primary" disabled={busy || testing} onClick={() => void save()}>
            保存
          </button>
        </>
      }
    >
      <div className="ai-form">
        <div className="ai-field">
          <span className="ai-field__label">快速填充</span>
          <div className="ai-presets">
            {AI_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="ai-preset"
                title={`${preset.baseUrl} · ${preset.model}`}
                onClick={() => {
                  setBaseUrl(preset.baseUrl)
                  setModel(preset.model)
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <div className="ai-field">
          <span className="ai-field__label">BaseURL</span>
          <input
            className="input"
            placeholder="https://api.deepseek.com/v1"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <span className="ai-field__hint">
            填服务商的兼容地址即可（一般以 /v1 结尾），不填 /chat/completions，软件会自己补。
          </span>
        </div>

        <div className="ai-field">
          <span className="ai-field__label">模型名</span>
          <input
            className="input"
            placeholder="deepseek-chat"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
        </div>

        <div className="ai-field">
          <span className="ai-field__label">API Key</span>
          <input
            className="input"
            type="password"
            placeholder={view?.hasKey ? `已保存：${view.keyPreview}（留空表示不改动）` : 'sk-…'}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <span className="ai-field__hint">
            Key 只保存在本机的 ai-config.json 里，不会写进 .xmind，也不会回传到界面（只显示掩码）。
          </span>
        </div>

        <div className="ai-field ai-field--row">
          <span className="ai-field__label">采样温度</span>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.1}
            value={temperature}
            onChange={(event) => setTemperature(Number(event.target.value))}
          />
          <span className="ai-field__value">{temperature.toFixed(1)}</span>
        </div>
        <span className="ai-field__hint">越低越稳定保守，越高越发散有创意。生成导图建议 0.5–0.8。</span>

        {testResult && (
          <div className={testResult.ok ? 'ai-test ai-test--ok' : 'ai-test ai-test--fail'}>
            {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
            <span>{testResult.message}</span>
          </div>
        )}
      </div>
    </Modal>
  )
}
