import { useState, type ReactElement } from 'react'
import { ImageDown } from 'lucide-react'
import {
  IMAGE_EXPORT_FORMATS,
  IMAGE_EXPORT_SCALES,
  type ExportBackground,
  type ImageExportFormat
} from '@shared/export/types'
import { Modal } from './Dialogs'
import { exportActiveSheet } from '../export'
import { useEditor } from '../store/editor'

interface Props {
  onClose(): void
  onNotify(message: string): void
}

/** 导出图片的设置框：格式 + 倍率 + 背景 */
export default function ExportDialog({ onClose, onNotify }: Props): ReactElement {
  const [format, setFormat] = useState<ImageExportFormat>('png')
  const [scale, setScale] = useState(2)
  const [background, setBackground] = useState<ExportBackground>('theme')
  const [busy, setBusy] = useState(false)

  const current = IMAGE_EXPORT_FORMATS.find((item) => item.id === format) ?? IMAGE_EXPORT_FORMATS[0]

  const run = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const workbook = useEditor.getState().workbook
      const result = await exportActiveSheet(workbook, { format, scale, background })
      const path = await window.api.saveExport(
        result.data,
        result.fileName,
        result.ext as ImageExportFormat
      )
      if (path) {
        onNotify(`已导出：${path}`)
        onClose()
      }
    } catch (error) {
      onNotify(`导出失败：${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="导出为图片"
      icon={<ImageDown size={18} />}
      onMaskClick={busy ? undefined : onClose}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => void run()}
          >
            {busy ? '正在生成…' : '导出'}
          </button>
        </>
      }
    >
      <div className="export-form">
        <div className="export-field">
          <span className="export-field__label">格式</span>
          <div className="export-choices">
            {IMAGE_EXPORT_FORMATS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={
                  item.id === format ? 'export-choice export-choice--active' : 'export-choice'
                }
                onClick={() => setFormat(item.id)}
              >
                <span className="export-choice__title">{item.label}</span>
                <span className="export-choice__hint">{item.hint}</span>
              </button>
            ))}
          </div>
        </div>

        {current?.scalable && (
          <div className="export-field">
            <span className="export-field__label">清晰度</span>
            <div className="export-choices export-choices--inline">
              {IMAGE_EXPORT_SCALES.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={
                    value === scale ? 'export-choice export-choice--active' : 'export-choice'
                  }
                  onClick={() => setScale(value)}
                >
                  {value}×
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="export-field">
          <span className="export-field__label">背景</span>
          <div className="export-choices export-choices--inline">
            {(
              [
                { id: 'theme', label: '跟随主题' },
                { id: 'white', label: '白色' },
                { id: 'transparent', label: '透明（仅 SVG）' }
              ] as Array<{ id: ExportBackground; label: string }>
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                className={
                  item.id === background ? 'export-choice export-choice--active' : 'export-choice'
                }
                onClick={() => setBackground(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="export-note">
          导出的是<b>当前画布</b>的全部内容（不受折叠与筛选影响）。 PNG 与 PDF
          是位图：倍率越高越清晰、文件越大；SVG 是矢量，文字与连线可以再编辑。 PDF 目前是
          <b>单页位图 PDF</b>（不是矢量 PDF）。
        </div>
      </div>
    </Modal>
  )
}
