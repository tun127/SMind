import { useEffect, useState, type ReactElement } from 'react'
import { CheckCircle2, Plug, Settings2, XCircle } from 'lucide-react'
import { AI_PRESETS, DEFAULT_AI_CONFIG, type AiConfigView } from '@shared/ai'
import type { LicenseView } from '@shared/license'
import { Modal } from './Dialogs'

/**
 * 许可状态一句话。
 *
 * 为什么必须**常驻**显示这句：以前只有"试用用完"之后，聊天面板里才会露出许可码输入框——
 * 于是想支持你的用户在试用期里**找不到地方激活**（真被问过）。
 */
function licenseSummary(view: LicenseView | null): string {
  if (!view) return '正在读取许可状态…'
  if (view.pro) {
    return `已激活 Pro${view.holder ? `（${view.holder}）` : ''}：AI 可以直接改画布，没有次数限制。`
  }
  if (view.remaining > 0) {
    return `试用中：AI 改画布还剩 ${view.remaining} 次（共 ${view.trialLimit} 次）。只读聊天永久免费。`
  }
  return `试用已用完（${view.trialLimit}/${view.trialLimit}）。只读聊天仍然免费；粘入许可码即可继续让 AI 改画布。`
}

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
  /** 许可状态：Pro / 试用剩余。闸门判定在主进程，这里只负责显示与激活 */
  const [license, setLicense] = useState<LicenseView | null>(null)
  const [licenseKey, setLicenseKey] = useState('')
  const [licenseNote, setLicenseNote] = useState<string | null>(null)
  const [licenseBusy, setLicenseBusy] = useState(false)

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

  useEffect(() => {
    void window.api
      .licenseGet()
      .then(setLicense)
      .catch(() => undefined)
  }, [])

  /** 激活：许可码只在本机离线验签（Ed25519），不发任何网络请求 */
  const activate = async (): Promise<void> => {
    setLicenseBusy(true)
    try {
      const result = await window.api.licenseActivate(licenseKey)
      setLicense(result.view)
      setLicenseNote(result.message)
      if (result.ok) {
        setLicenseKey('')
        onNotify(result.message)
      }
    } catch (error) {
      setLicenseNote(`激活失败：${(error as Error).message}`)
    } finally {
      setLicenseBusy(false)
    }
  }

  const deactivate = async (): Promise<void> => {
    setLicenseBusy(true)
    try {
      setLicense(await window.api.licenseDeactivate())
      setLicenseNote('已取消激活：本机的许可已清除（换机器 / 退货都用它）')
    } catch (error) {
      setLicenseNote(`取消失败：${(error as Error).message}`)
    } finally {
      setLicenseBusy(false)
    }
  }

  const save = async (notify = true): Promise<boolean> => {
    try {
      setBusy(true)
      // Key 留空表示「不改动已保存的 Key」
      const next = await window.api.aiConfigSave({ baseUrl, model, temperature, apiKey })
      setView(next)
      setApiKey('')
      if (notify) {
        onNotify('AI 设置已保存（Key 只存在本机配置文件里，不会写进 .xmind）')
        // 保存成功就直接关掉：用户的意图已经完成，不该再要求他点一次「关闭」
        // （「测试连接」里也会调 save(false)，那条路不能关，所以放在 notify 分支里）
        onClose()
      }
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

        {/* 许可：**常驻**入口。以前只有试用用完后才在聊天面板里露出输入框，
            想提前支持的人反而找不到地方激活 */}
        <div className="ai-field">
          <span className="ai-field__label">许可（Pro）</span>
          <p className="modal__dim">{licenseSummary(license)}</p>
          <div className="ai-presets">
            <input
              className="input"
              placeholder="把购买时拿到的许可码整串粘进来（可以带换行）"
              value={licenseKey}
              onChange={(event) => setLicenseKey(event.target.value)}
            />
            <button
              type="button"
              className="btn btn--primary"
              disabled={licenseBusy || licenseKey.trim().length === 0}
              onClick={() => void activate()}
            >
              激活
            </button>
            {license?.pro && (
              <button type="button" className="btn" disabled={licenseBusy} onClick={() => void deactivate()}>
                取消激活
              </button>
            )}
          </div>
          {licenseNote && <p className="modal__dim">{licenseNote}</p>}
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
          <span className="ai-field__hint">
            让 AI <strong>直接改画布</strong>时，模型的选择影响很大：优先用支持工具调用的强模型
            （DeepSeek-V3 系、Qwen3 系、GPT、Claude 等）。上下文太小的模型（8k 级）装不下
            agent 回合（骨架 + 历史 + 工具往返），会频繁「走一步推一步」。
          </span>
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
