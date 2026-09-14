import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Code2, Download, ExternalLink, FolderOpen, Image as ImageIcon, Paperclip, Plus, Sigma, X } from 'lucide-react'
import { activeRoot, activeSheet, findTopic } from '@shared/model/tree'
import { imageBoxSize } from '@shared/layout/accessory'
import { MARKER_GROUPS, markerVisualOf } from '../render/markers'
import { formulaHtml } from '../render/formula'
import { resourceUrl } from '../render/resource'
import { useEditor } from '../store/editor'
import MarkerIcon from './MarkerIcon'
import { CODE_LANGUAGES } from '@shared/code-language'
import { normalizeFormulaInput } from '@shared/formula'

interface Props {
  onClose(): void
  onNotify(message: string): void
}

/** 附件大小显示成 KB/MB，列表里一眼能看出体积 */
function formatSize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
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
  const setFormula = useEditor((s) => s.setFormula)
  const setCode = useEditor((s) => s.setCode)
  const setSizeOverride = useEditor((s) => s.setSizeOverride)
  const codeFocusTick = useEditor((s) => s.codeFocusTick)
  const formulaFocusTick = useEditor((s) => s.formulaFocusTick)
  const setImage = useEditor((s) => s.setImage)
  const addAttachment = useEditor((s) => s.addAttachment)
  const removeAttachment = useEditor((s) => s.removeAttachment)
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
  const [formulaDraft, setFormulaDraft] = useState('')
  const [codeDraft, setCodeDraft] = useState('')
  const [codeLangDraft, setCodeLangDraft] = useState('text')
  const codeAreaRef = useRef<HTMLTextAreaElement | null>(null)
  const formulaAreaRef = useRef<HTMLTextAreaElement | null>(null)

  // Alt+C 的落点：面板一打开（或已打开时收到信号）就把焦点交给代码输入框
  useEffect(() => {
    if (codeFocusTick > 0) codeAreaRef.current?.focus()
  }, [codeFocusTick])

  // 快捷栏「公式」的落点：同理聚焦公式输入框
  useEffect(() => {
    if (formulaFocusTick > 0) formulaAreaRef.current?.focus()
  }, [formulaFocusTick])

  // 只在「切换所选节点」时同步草稿，输入过程中绝不覆盖用户正在敲的内容
  useEffect(() => {
    setLabelDraft('')
    setNotesDraft(topic?.notes ?? '')
    setHrefDraft(topic?.href ?? '')
    setFormulaDraft(topic?.formula ?? '')
    setCodeDraft(topic?.code?.text ?? '')
    setCodeLangDraft(topic?.code?.language || 'text')
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

  const commitFormula = (): void => {
    // 支持 Markdown / LaTeX 各种数学写法：$x^2$、$$x^2$$、\(x^2\)、\[x^2\] 都剥成纯 LaTeX
    const next = normalizeFormulaInput(formulaDraft)
    if (next !== formulaDraft) setFormulaDraft(next)
    if ((topic.formula ?? '') !== next) setFormula(topicId, next)
  }

  const commitCode = (): void => {
    const text = codeDraft.replace(/\s+$/, '')
    const language = codeLangDraft
    if ((topic.code?.text ?? '') === text && (topic.code?.language ?? 'text') === language) return
    setCode(topicId, text.length === 0 && language === 'text' ? null : { language, text })
  }

  const insertImage = async (): Promise<void> => {
    try {
      const picked = await window.api.pickImage()
      if (!picked) return
      setImage(topicId, { path: picked.path, width: picked.width, height: picked.height })
      onNotify(
        picked.width > 0
          ? `已插入图片 ${picked.name}（${picked.width}×${picked.height}）`
          : `已插入图片 ${picked.name}（未取到像素尺寸，按默认大小显示）`
      )
    } catch (error) {
      onNotify(`插入图片失败：${(error as Error).message}`)
    }
  }

  const attachFile = async (): Promise<void> => {
    try {
      const picked = await window.api.pickAttachment()
      if (!picked) return
      addAttachment(topicId, picked)
      onNotify(`已添加附件 ${picked.name}，保存时会打包进 .xmind`)
    } catch (error) {
      onNotify(`添加附件失败：${(error as Error).message}`)
    }
  }

  const openAttachment = async (path: string, name: string): Promise<void> => {
    try {
      const ok = await window.api.openAttachment(path, name)
      if (!ok) onNotify('打不开这个附件：它可能只是文件里的记录，内容已经丢失')
    } catch (error) {
      onNotify(`打开附件失败：${(error as Error).message}`)
    }
  }

  const exportAttachment = async (path: string, name: string): Promise<void> => {
    try {
      const ok = await window.api.saveAttachmentAs(path, name)
      if (ok) onNotify('附件已导出')
    } catch (error) {
      onNotify(`导出附件失败：${(error as Error).message}`)
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
    remove: (id: string) => void,
    multiline = false
  ): ReactElement[] =>
    items.map((item) => (
      <div key={`${kind}-${item.id}`} className="overlay-row">
        <span className="overlay-row__tag">{kind}</span>
        {multiline ? (
          <textarea
            key={`${item.id}-${item.title ?? ''}`}
            className="input input--mini overlay-row__multi"
            rows={2}
            defaultValue={item.title ?? ''}
            placeholder="标题（可留空，Enter 换行）"
            onBlur={(event) => setTitle(item.id, event.currentTarget.value)}
          />
        ) : (
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
        )}
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

        <div className="side-panel__title">节点内图片</div>
        {topic.image ? (
          <div className="image-row">
            <img
              className="image-row__thumb"
              src={resourceUrl(topic.image.path)}
              alt=""
              style={{ width: 64, height: 48 }}
            />
            <div className="image-row__meta">
              <div className="image-row__name" title={topic.image.path}>
                {topic.image.path.split('/').pop()}
              </div>
              <div className="side-panel__hint">
                {topic.image.width && topic.image.height
                  ? `${topic.image.width}×${topic.image.height}`
                  : '尺寸未知'}
                {' · 显示 '}
                {imageBoxSize(topic.image).width}×{imageBoxSize(topic.image).height}
              </div>
              <div className="side-panel__row">
                <button
                  type="button"
                  className="btn"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void insertImage()}
                >
                  <ImageIcon size={14} />
                  更换
                </button>
                <button
                  type="button"
                  className="btn"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setImage(topicId, null)}
                >
                  <X size={14} />
                  移除
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="side-panel__row">
            <button
              type="button"
              className="btn btn--primary"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void insertImage()}
            >
              <ImageIcon size={14} />
              插入图片…
            </button>
          </div>
        )}

        <div className="side-panel__title">附件</div>
        {topic.attachments.length > 0 && (
          <div className="attachment-list">
            {topic.attachments.map((item) => (
              <div key={item.id} className="attachment-row">
                <Paperclip size={13} />
                <span className="attachment-row__name" title={item.name}>
                  {item.name}
                </span>
                <span className="attachment-row__size">{formatSize(item.size)}</span>
                <button
                  type="button"
                  className="chip__del"
                  title="用系统默认程序打开"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void openAttachment(item.path, item.name)}
                >
                  <FolderOpen size={12} />
                </button>
                <button
                  type="button"
                  className="chip__del"
                  title="导出到其他位置"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void exportAttachment(item.path, item.name)}
                >
                  <Download size={12} />
                </button>
                <button
                  type="button"
                  className="chip__del"
                  title="移除附件"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => removeAttachment(topicId, item.id)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="side-panel__row">
          <button
            type="button"
            className="btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void attachFile()}
          >
            <Paperclip size={14} />
            添加附件…
          </button>
        </div>

        <div className="side-panel__title">LaTeX 公式</div>
        <textarea
          ref={formulaAreaRef}
          className="input input--area input--mono"
          rows={3}
          placeholder="例如 \frac{a}{b}、\sqrt{x^2+y^2}；也支持 Markdown 写法 $x^2$ / $$E=mc^2$$"
          value={formulaDraft}
          onChange={(event) => setFormulaDraft(event.target.value)}
          onBlur={commitFormula}
        />
        <div className="formula-preview-row">
          <span className="formula-preview__label">
            <Sigma size={13} /> 预览
          </span>
          {formulaDraft.trim().length > 0 ? (
            <div
              className="formula-preview"
              // KaTeX 的输出由渲染器生成，不是用户 HTML
              dangerouslySetInnerHTML={{ __html: formulaHtml(formulaDraft.trim()) }}
            />
          ) : (
            <span className="side-panel__hint">输入公式后这里会实时预览，离开输入框即保存</span>
          )}
        </div>
        {topic.formula && (
          <div className="side-panel__row">
            <button
              type="button"
              className="btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setFormulaDraft('')
                setFormula(topicId, '')
              }}
            >
              <X size={14} />
              移除公式
            </button>
          </div>
        )}

        {topic.sizeOverride && (
          <>
            <div className="side-panel__title">尺寸</div>
            <div className="side-panel__row">
              <span className="side-panel__hint">
                已手动拉伸为 {topic.sizeOverride.width} × {topic.sizeOverride.height}
              </span>
              <button
                type="button"
                className="btn"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setSizeOverride(topicId, null)}
              >
                <X size={14} />
                恢复自动尺寸
              </button>
            </div>
          </>
        )}

        <div className="side-panel__title">
          <Code2 size={13} /> 代码块
        </div>
        <div className="side-panel__row">
          <select
            className="select"
            value={codeLangDraft}
            onChange={(event) => {
              setCodeLangDraft(event.target.value)
              setCode(topicId, { language: event.target.value, text: codeDraft })
            }}
          >
            {CODE_LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>
                {lang === 'text' ? '纯文本' : lang}
              </option>
            ))}
          </select>
        </div>
        <textarea
          ref={codeAreaRef}
          className="input input--area input--mono"
          rows={6}
          placeholder={'粘贴或输入代码，例如：\nconst sum = (a, b) => a + b'}
          value={codeDraft}
          onChange={(event) => setCodeDraft(event.target.value)}
          onBlur={commitCode}
        />
        <div className="side-panel__hint">离开输入框即保存；节点里会按等宽字体排版，超出部分可滚动</div>
        {(topic.code || codeDraft.length > 0) && (
          <div className="side-panel__row">
            <button
              type="button"
              className="btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setCodeDraft('')
                setCodeLangDraft('text')
                setCode(topicId, null)
              }}
            >
              <X size={14} />
              移除代码块
            </button>
          </div>
        )}

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
        {overlayRow('概要', sheet.summaries.map((item) => ({ id: item.id, title: item.title })), setSummaryTitle, removeSummary, true)}
      </div>
    </div>
  )
}
