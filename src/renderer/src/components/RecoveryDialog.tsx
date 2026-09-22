import type { ReactElement } from 'react'
import { HardDriveDownload } from 'lucide-react'
import type { RecoveryInfo } from '@shared/ipc'
import { Modal } from './Dialogs'

interface RecoveryDialogProps {
  items: RecoveryInfo[]
  onRestore(item: RecoveryInfo): void
  onRestoreLatest(): void
  onRestoreAll(): void
  onDiscard(item: RecoveryInfo): void
  onDiscardAll(): void
}

/**
 * 时间戳缺失时**不再现取当前时间**（原文是 `new Date(info.savedAt || Date.now())`）。
 *
 * 渲染期调用 `Date.now()` 是不纯的：每次重渲染都可能算出不同的时间
 * （React Compiler 的 `purity` 规则会报它）。而且存档信息不完整时，
 * 照实说「时间未知」比伪装成「刚刚」更有用——用户据此判断要不要恢复。
 */
function recoveryTimeText(savedAt: number): string {
  return savedAt ? new Date(savedAt).toLocaleString('zh-CN') : '时间未知（存档信息不完整）'
}

/** 崩溃恢复：逐份列出候选，每份可单独恢复，也提供全部恢复与最近一份快速路径。 */
export function RecoveryDialog({
  items,
  onRestore,
  onRestoreLatest,
  onRestoreAll,
  onDiscard,
  onDiscardAll
}: RecoveryDialogProps): ReactElement {
  return (
    <Modal
      title={`发现 ${items.length} 份未保存的内容`}
      icon={<HardDriveDownload size={18} />}
      footer={
        <>
          <button type="button" className="btn" onClick={onDiscardAll}>
            全部忽略并删除
          </button>
          <button type="button" className="btn" onClick={onRestoreAll}>
            全部恢复
          </button>
          <button type="button" className="btn btn--primary" onClick={onRestoreLatest}>
            恢复最近一份
          </button>
        </>
      }
    >
      <p>上次退出时这些文档还有未保存的修改，共 {items.length} 份：</p>
      <div style={{ display: 'grid', gap: 8, margin: '10px 0' }}>
        {items.map((info, index) => (
          <div
            key={info.docId ?? `${info.savedAt}:${info.title}`}
            style={{
              border: '1px solid var(--border, #ddd)',
              borderRadius: 6,
              padding: '8px 10px'
            }}
          >
            <div>
              <strong>《{info.title || '未命名导图'}》</strong>
              {index === 0 && <span className="modal__dim">（最近一份）</span>}
            </div>
            <div className="modal__dim">{recoveryTimeText(info.savedAt)}</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
              <button type="button" className="btn" onClick={() => onDiscard(info)}>
                忽略并删除
              </button>
              <button type="button" className="btn btn--primary" onClick={() => onRestore(info)}>
                恢复这份
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="modal__dim">可逐份恢复，也可一次全部恢复；“恢复最近一份”是改动前的快速路径。</p>
    </Modal>
  )
}
