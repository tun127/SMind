import { useCallback, useEffect, useState, type ReactElement } from 'react'
import {
  Camera,
  Clock,
  FolderOpen,
  History as HistoryIcon,
  Pin,
  PinOff,
  RotateCcw,
  Star,
  Trash2,
  X
} from 'lucide-react'
import { relativeTime, type HistoryEntry } from '@shared/history'
import {
  formatBytes,
  snapshotLabel,
  snapshotReasonLabel,
  type SnapshotItem,
  type SnapshotReason
} from '@shared/snapshot'
import { defaultDocumentName } from '@shared/model/naming'
import { snapshotForSave, useEditor } from '../store/editor'
import { activeDocId } from '../store/tabs'
import { Modal } from './Dialogs'

interface Props {
  onClose(): void
  onNotify(message: string): void
  /** 打开某个历史文件（由 App 负责走「未保存确认 → 打开」的完整流程） */
  onOpenFile(path: string): void
  /** 恢复某个版本（由 App 负责「先存一份恢复前版本 → 再恢复」） */
  onRestore(snapshotId: string): void
}

type Tab = 'files' | 'snapshots'

const REASON_CLASS: Record<SnapshotReason, string> = {
  auto: 'snapshot-badge--auto',
  manual: 'snapshot-badge--manual',
  'before-restore': 'snapshot-badge--restore'
}

/**
 * 历史记录。
 *
 * 两个标签页解决两件不同的事：
 * - 「打开历史」：最近用过哪些文件（含常用与默认保存位置）
 * - 「版本快照」：**当前这份文档**在不同时间点的内容版本，可随时切回
 *
 * 版本列表由本组件自己读写（只需要路径与会话序号），
 * 只有「恢复」交给 App —— 那一步要走未保存确认，还要先自动存一份恢复前的版本。
 */
export default function HistoryDialog({ onClose, onNotify, onOpenFile, onRestore }: Props): ReactElement {
  const filePath = useEditor((s) => s.filePath)

  const [tab, setTab] = useState<Tab>('files')

  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [saveDir, setSaveDir] = useState('')
  const [loading, setLoading] = useState(true)
  const [confirmClear, setConfirmClear] = useState(false)

  const [snapshots, setSnapshots] = useState<SnapshotItem[]>([])
  const [snapshotLoading, setSnapshotLoading] = useState(true)
  const [noteDraft, setNoteDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmClearSnapshots, setConfirmClearSnapshots] = useState(false)

  /* ---- 打开历史 ---- */

  const refreshHistory = useCallback(async (): Promise<void> => {
    try {
      const [list, dir] = await Promise.all([window.api.historyList(), window.api.historySaveDir()])
      setEntries(list)
      setSaveDir(dir)
    } catch (error) {
      onNotify(`读取历史失败：${(error as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [onNotify])

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  /* ---- 版本快照 ---- */

  const refreshSnapshots = useCallback(async (): Promise<void> => {
    try {
      setSnapshots(await window.api.snapshotList(filePath))
    } catch (error) {
      onNotify(`读取版本失败：${(error as Error).message}`)
    } finally {
      setSnapshotLoading(false)
    }
  }, [filePath, onNotify])

  useEffect(() => {
    void refreshSnapshots()
  }, [refreshSnapshots])

  const pinned = entries.filter((entry) => entry.pinned)
  const recent = entries.filter((entry) => !entry.pinned)

  const act = async (run: () => Promise<HistoryEntry[]>, failText: string): Promise<void> => {
    try {
      setEntries(await run())
    } catch (error) {
      onNotify(`${failText}：${(error as Error).message}`)
    }
  }

  const chooseDir = async (): Promise<void> => {
    try {
      const dir = await window.api.historyChooseSaveDir()
      if (!dir) return
      setSaveDir(dir)
      onNotify(`默认保存位置已改为：${dir}`)
    } catch (error) {
      onNotify(`选择目录失败：${(error as Error).message}`)
    }
  }

  const createVersion = async (): Promise<void> => {
    if (busy || !filePath) return
    setBusy(true)
    try {
      const store = useEditor.getState()
      const note = noteDraft.trim()
      const list = await window.api.snapshotCreate(activeDocId(), {
        // 用「把正在输入的内容也算上」的快照，避免刚敲的字没进版本
        workbook: snapshotForSave(store),
        path: store.filePath,
        title: defaultDocumentName(store.workbook),
        reason: 'manual',
        note
      })
      setSnapshots(list)
      setNoteDraft('')
      onNotify(note.length > 0 ? `已存为版本：${note}` : '已存为一个版本')
    } catch (error) {
      onNotify(`存版本失败：${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const removeVersion = async (id: string): Promise<void> => {
    try {
      setSnapshots(await window.api.snapshotRemove(id, filePath))
      onNotify('已删除该版本')
    } catch (error) {
      onNotify(`删除失败：${(error as Error).message}`)
    }
  }

  const clearVersions = async (): Promise<void> => {
    if (!confirmClearSnapshots) {
      setConfirmClearSnapshots(true)
      return
    }
    setConfirmClearSnapshots(false)
    try {
      setSnapshots(await window.api.snapshotClear(filePath))
      onNotify('已清空本文档的版本')
    } catch (error) {
      onNotify(`清空失败：${(error as Error).message}`)
    }
  }

  /* ---- 渲染 ---- */

  const fileRow = (entry: HistoryEntry): ReactElement => (
    <div key={entry.path} className={entry.missing ? 'history-row history-row--missing' : 'history-row'}>
      <button
        type="button"
        className="history-row__main"
        title={entry.missing ? '文件已不在原位置' : `打开 ${entry.path}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (entry.missing) {
            onNotify('这个文件已不在原位置：可能被移动或删除了，可以从列表里移除它')
            return
          }
          onOpenFile(entry.path)
          onClose()
        }}
      >
        <span className="history-row__name">
          {entry.pinned ? <Star size={12} className="history-row__star" /> : null}
          {entry.title && entry.title.length > 0 ? entry.title : entry.name}
        </span>
        <span className="history-row__meta">
          {entry.missing ? '⚠ 已不在原位置 · ' : ''}
          {relativeTime(entry.openedAt)}
          {entry.openCount > 1 ? ` · 打开过 ${entry.openCount} 次` : ''}
          {' · '}
          <span className="history-row__path">{entry.path}</span>
        </span>
      </button>

      <button
        type="button"
        className="chip__del"
        title={entry.pinned ? '取消常用' : '设为常用'}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void act(() => window.api.historyTogglePin(entry.path), '操作失败')}
      >
        {entry.pinned ? <PinOff size={12} /> : <Pin size={12} />}
      </button>
      <button
        type="button"
        className="chip__del"
        title="在文件夹中显示"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void window.api.revealInFolder(entry.path)}
      >
        <FolderOpen size={12} />
      </button>
      <button
        type="button"
        className="chip__del"
        title="从历史中移除"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void act(() => window.api.historyRemove(entry.path), '移除失败')}
      >
        <X size={12} />
      </button>
    </div>
  )

  const versionRow = (item: SnapshotItem): ReactElement => (
    <div key={item.id} className="snapshot-row">
      <div className="snapshot-row__main">
        <span className="snapshot-row__name">
          <span className={`snapshot-badge ${REASON_CLASS[item.reason]}`}>
            {snapshotReasonLabel(item.reason)}
          </span>
          {snapshotLabel(item)}
        </span>
        <span className="snapshot-row__meta">
          {relativeTime(item.at)} · {formatBytes(item.size)}
          {item.path ? ` · ${item.path}` : ' · 当时还没保存过'}
        </span>
      </div>
      <button
        type="button"
        className="snapshot-row__act"
        title="恢复到这个版本（恢复前会自动把当前状态也存成一个版本，可再切回）"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          onClose()
          onRestore(item.id)
        }}
      >
        <RotateCcw size={13} />
        恢复
      </button>
      <button
        type="button"
        className="chip__del"
        title="删除这个版本"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void removeVersion(item.id)}
      >
        <X size={12} />
      </button>
    </div>
  )

  return (
    <Modal
      title="历史记录"
      icon={<HistoryIcon size={18} />}
      onMaskClick={onClose}
      footer={
        <>
          {tab === 'files' ? (
            <button
              type="button"
              className="btn btn--danger"
              disabled={entries.length === 0}
              onClick={() => {
                if (!confirmClear) {
                  setConfirmClear(true)
                  return
                }
                setConfirmClear(false)
                void act(() => window.api.historyClear(), '清空失败')
              }}
            >
              <Trash2 size={14} />
              {confirmClear ? '再点一次确认清空' : '清空历史'}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--danger"
              disabled={snapshots.length === 0}
              onClick={() => void clearVersions()}
            >
              <Trash2 size={14} />
              {confirmClearSnapshots ? '再点一次确认清空' : '清空本文档的版本'}
            </button>
          )}
          <button type="button" className="btn btn--primary" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      <div className="hist-tabs">
        <button
          type="button"
          className={tab === 'files' ? 'hist-tab hist-tab--active' : 'hist-tab'}
          onClick={() => setTab('files')}
        >
          打开历史
          <em>{entries.length}</em>
        </button>
        <button
          type="button"
          className={tab === 'snapshots' ? 'hist-tab hist-tab--active' : 'hist-tab'}
          onClick={() => setTab('snapshots')}
        >
          <Camera size={13} />
          版本快照
          <em>{snapshots.length}</em>
        </button>
      </div>

      <div className="history-form">
        {tab === 'files' ? (
          <>
            <div className="history-dir">
              <span className="history-dir__label">默认保存位置</span>
              <span className="history-dir__path" title={saveDir}>
                {saveDir || '（未设置）'}
              </span>
              <button type="button" className="btn" onClick={() => void chooseDir()}>
                <FolderOpen size={14} />
                更换
              </button>
              <button
                type="button"
                className="btn"
                disabled={saveDir.length === 0}
                onClick={() => void window.api.revealInFolder(saveDir)}
              >
                打开文件夹
              </button>
            </div>

            {loading ? (
              <div className="history-empty">正在读取…</div>
            ) : entries.length === 0 ? (
              <div className="history-empty">
                <Clock size={16} />
                <span>还没有历史记录。打开或保存过 .xmind 之后，这里会列出最近用过的文件。</span>
              </div>
            ) : (
              <>
                <div className="side-panel__title">
                  <Star size={12} /> 常用（{pinned.length}）
                </div>
                {pinned.length === 0 ? (
                  <div className="history-hint">
                    点列表右侧的图钉按钮，可以把常用的导图固定到这里——固定的条目不会被后来的记录挤掉。
                  </div>
                ) : (
                  <div className="history-list">{pinned.map(fileRow)}</div>
                )}

                <div className="side-panel__title side-panel__title--sub">
                  <Clock size={12} /> 最近打开（{recent.length}）
                </div>
                {recent.length === 0 ? (
                  <div className="history-hint">暂无最近打开的文件。</div>
                ) : (
                  <div className="history-list">{recent.map(fileRow)}</div>
                )}
              </>
            )}
          </>
        ) : !filePath ? (
          <div className="history-empty history-empty--top">
            <Camera size={16} />
            <span>
              这份文档还没有保存过，暂时没有版本记录。
              <br />
              先按 <b>Ctrl+S</b> 存成 .xmind 文件，之后编辑过程中就会自动累积版本。
              <br />
              未保存的内容另有保护：每 30 秒自动存档，异常退出后下次启动会提示恢复。
            </span>
          </div>
        ) : (
          <>
            <div className="snapshot-create">
              <input
                className="input input--mini"
                placeholder="给这个版本写个备注（可留空）"
                value={noteDraft}
                onChange={(event) => setNoteDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void createVersion()
                }}
              />
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void createVersion()}
              >
                <Camera size={14} />
                存一个版本
              </button>
            </div>

            <div className="history-hint">
              每 <b>10 分钟</b>会自动留一个版本（内容没变就跳过，不占地方）；
              手动存的版本不会被自动版本挤掉。恢复前也会自动存一份当前状态，<b>点错了还能切回来</b>。
            </div>

            {snapshotLoading ? (
              <div className="history-empty">正在读取…</div>
            ) : snapshots.length === 0 ? (
              <div className="history-empty">
                <Camera size={16} />
                <span>
                  这份文档还没有版本记录。可以先点「存一个版本」手动留一个，
                  之后编辑过程中也会自动累积。
                </span>
              </div>
            ) : (
              <div className="history-list">{snapshots.map(versionRow)}</div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
