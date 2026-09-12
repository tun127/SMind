import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { ExternalLink, Plus, X } from 'lucide-react'
import { activeRoot, activeSheet, findTopic } from '@shared/model/tree'
import { MARKER_GROUPS, markerVisualOf } from '../render/markers'
import { useEditor } from '../store/editor'
import MarkerIcon from './MarkerIcon'

interface Props {
  onClose(): void
  onNotify(message: string): void
}

/** 备注与超链接用本地草稿 + 失焦提交：既不怕输入法打断，也不需要每敲一个字就写历史 */
export default function NodePanel({ onClose, onNotify }: Props): ReactElement {
  const workbook = useEditor((s) => s.workbook)
  const selection = useEditor((s) => s.selection)
  const toggleMarker = useEditor((s) => s.toggleMarker)
  const addLabel = useEditor((s) => s.addLabel)
  const removeLabel = useEditor((s) => s.removeLabel)
  const setNotes = useEditor((s) => s.setNotes)
  const setHref = useEditor((s) => s.setHref)
  const removeRelationship = useEditor((s) => s.removeRelationship)
  const removeBoundary = useEditor((s) => s.removeBoundary)
  const removeSummary = useEditor((s) => s.removeSummary)
  const setRelationshipTitle = useEditor((s) => s.setRelationshipTitle)
  const setBoundaryTitle = useEditor((s) => s.setBoundaryTitle)
  const setSummaryTitle = useEditor((s) => s.setSummaryTitle)

  const sheet = useMemo(() => activeSheet(workbook), [workbook])

  const id = selection[0] ?? null
  const topic = useMemo(() => (id ? findTopic(activeRoot(workbook), id) : null), [workbook, id])

  const [labelDraft, setLabelDraft] = useState('')
  const [notesDraft, setNotesDraft] = useState('')
  const [hrefDraft, setHrefDraft] = useState('')

  // 只在「切换所选节点」时同步草稿，输入过程中绝不覆盖用户正在敲的内容
  useEffect(() => {
    setLabelDraft('')
    setNotesDraft(topic?.notes ?? '')
    setHrefDraft(topic?.href ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const header = (
    <div className="side-panel__header">
      <span>节点属性</span>
      <button type="button" className="tool-btn" title="关闭" onMouseDown={(e) => e.preventDefault()} onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  )

  if (!topic || !id) {
    return (
      <div className="side-panel">
        {header}
        <div className="side-panel__body">
          <div className="side-panel__empty">
            请先在画布上选中一个主题，再设置它的标记图标、标签、备注与超链接。
          </div>
        </div>
      </div>
    )
  }

  const topicId = id

  const commitNotes = (): void => {
    if ((topic.notes ?? '') !== notesDraft) setNotes(topicId, notesDraft)
  }

  const commitHref = (): void => {
    if ((topic.href ?? '') !== hrefDraft) setHref(topicId, hrefDraft)
  }

  const handleAddLabel = (): void => {
    const text = labelDraft.trim()
    if (text.length === 0) return
    addLabel(topicId, text)
    setLabelDraft('')
  }

  const openHref = async (): Promise<void> => {
    if (!topic.href) return
    try {
      const ok = await window.api.openExternal(topic.href)
      if (!ok) onNotify('这个链接不是 http/https/mailto，无法用系统程序打开')
    } catch (error) {
      onNotify(`打开链接失败：${(error as Error).message}`)
    }
  }

  /**
   * 画布元素的一行。
   * 标题用「非受控输入 + 失焦提交」：既不会被中文输入法打断，
   * 也不会每敲一个字就写一条撤销记录。
   * key 里带上已保存的标题，撤销/重做后能自动同步显示。
   */
  const overlayRow = (
    kind: string,
    items: Array<{ id: string; title: string | undefined }>,
    setTitle: (id: string, title: string) => void,
    remove: (id: string) => void
  ): ReactElement[] =>
    items.map((item) => (
      <div key={`${kind}-${item.id}`} className="overlay-row">
        <span className="overlay-row__tag">{kind}</span>
        <input
          key={`${item.id}-${item.title ?? ''}`}
          className="input input--mini"
          defaultValue={item.title ?? ''}
          placeholder="标题（可留空）"
          onBlur={(event) => setTitle(item.id, event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
        <button
          type="button"
          className="chip__del"
          title={`移除这条${kind}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => remove(item.id)}
        >
          <X size={10} />
        </button>
      </div>
    ))

  return (
    <div className="side-panel">
      {header}

      <div className="side-panel__body">
        <div className="side-panel__title">当前主题</div>
        <div className="node-preview" title={topic.title}>
          {topic.title || '（空标题）'}
        </div>

        <div className="side-panel__title">标记图标</div>

        {/* 已添加的标记（包含文件里带来、本软件不认识的标记，这里可以移除） */}
        {topic.markers.length > 0 ? (
          <div className="chip-row">
            {topic.markers.map((marker) => (
              <span key={`on-${marker.markerId}`} className="chip">
                <MarkerIcon markerId={marker.markerId} size={14} />
                <span className="chip__text">{markerVisualOf(marker.markerId).label}</span>
                <button
                  type="button"
                  className="chip__del"
                  title="移除此标记"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => toggleMarker(topicId, marker.markerId)}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <div className="side-panel__hint">还没有标记。点击下面的图标即可添加。</div>
        )}

        {MARKER_GROUPS.map((group) => (
          <div key={group.title} className="marker-row">
            <span className="marker-row__label">{group.title}</span>
            <div className="marker-picker">
              {group.markers.map((markerId) => {
                const active = topic.markers.some((marker) => marker.markerId === markerId)
                return (
                  <button
                    key={markerId}
                    type="button"
                    className={active ? 'marker-btn marker-btn--active' : 'marker-btn'}
                    title={markerVisualOf(markerId).label}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => toggleMarker(topicId, markerId)}
                  >
                    <MarkerIcon markerId={markerId} />
                  </button>
                )
              })}
            </div>
          </div>
        ))}

        <div className="side-panel__title">标签</div>
        {topic.labels.length > 0 && (
          <div className="chip-row">
            {topic.labels.map((label) => (
              <span key={`label-${label}`} className="chip">
                <span className="chip__text">{label}</span>
                <button
                  type="button"
                  className="chip__del"
                  title="移除标签"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => removeLabel(topicId, label)}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="side-panel__row">
          <input
            className="input"
            placeholder="输入标签后回车"
            value={labelDraft}
            onChange={(event) => setLabelDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleAddLabel()
            }}
          />
          <button type="button" className="btn btn--primary" onMouseDown={(e) => e.preventDefault()} onClick={handleAddLabel}>
            <Plus size={14} />
            添加
          </button>
        </div>

        <div className="side-panel__title">备注</div>
        <textarea
          className="input input--area"
          rows={5}
          placeholder="记录这个主题的详细说明（点别处或离开输入框时保存）"
          value={notesDraft}
          onChange={(event) => setNotesDraft(event.target.value)}
          onBlur={commitNotes}
        />

        <div className="side-panel__title">超链接</div>
        <div className="side-panel__row">
          <input
            className="input"
            placeholder="https://example.com"
            value={hrefDraft}
            onChange={(event) => setHrefDraft(event.target.value)}
            onBlur={commitHref}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitHref()
            }}
          />
          <button
            type="button"
            className="btn"
            disabled={!topic.href}
            title={topic.href ? '用系统浏览器打开' : '先填写链接'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void openHref()}
          >
            <ExternalLink size={14} />
            打开
          </button>
        </div>

        <div className="side-panel__title">其他附加内容</div>
        <div className="side-panel__hint">
          附件 {topic.attachments.length} 个
          {topic.image ? ' · 含图片' : ''}
          {topic.formula ? ' · 含公式' : ''}
          <br />
          这些内容目前会随文件完整保留，编辑入口在后续阶段开放。
        </div>

        <div className="side-panel__title">画布元素</div>
        <div className="side-panel__hint">
          新建请用<b>工具栏</b>上的「关系线 / 概要 / 边界」：
          <br />
          关系线需按住 <b>Ctrl</b> 选中两个主题；概要 / 边界需选中若干个<b>同级</b>主题。
          <br />
          <b>双击画布上的标题</b>可直接改文字；关系线拖动<b>两端圆点</b>改接、拖动<b>线身</b>移动。
        </div>

        {overlayRow('关系线', sheet.relationships.map((item) => ({ id: item.id, title: item.title })), setRelationshipTitle, removeRelationship)}
        {overlayRow('边界', sheet.boundaries.map((item) => ({ id: item.id, title: item.title })), setBoundaryTitle, removeBoundary)}
        {overlayRow('概要', sheet.summaries.map((item) => ({ id: item.id, title: item.title })), setSummaryTitle, removeSummary)}
      </div>
    </div>
  )
}
