/**
 * 节点属性面板的「选到节点」分支。
 *
 * 草稿 `useState` 与聚焦 ref **留在入口层**（`NodePanel.tsx`），这里只收原样 props：
 * 草稿一旦搬进本组件，切换选中对象时的挂载/卸载会改变它的生命周期
 * （任务表把这条列为 A4 的高危点）。JSX 与处理器逐字未改，store 订阅随块一起搬进来。
 *
 * 四段自己不碰草稿的内容（标记图标 / 节点内图片 / 附件 / 画布元素）另拆成段落组件，
 * 使本文件保持在子模块上限（≤400 行）以内。
 */

import { Code2, ExternalLink, Plus, Sigma, X } from 'lucide-react'
import type { ReactElement, RefObject } from 'react'
import { normalizeFormulaInput } from '@shared/formula'
import { CODE_LANGUAGES } from '@shared/code-language'
import type { Sheet, Topic } from '@shared/model/types'
import { formulaHtml } from '../../render/formula'
import { useEditor } from '../../store/editor'
import { PanelHeader, defaultCodeLanguage } from './panel-parts'
import { codeDraftPatch } from './code-draft'
import AttachmentSection from './attachment-section'
import ImageSection from './image-section'
import MarkerSection from './marker-section'
import OverlayListSection from './overlay-list-section'

interface Props {
  /** 当前选中的主题（入口已确认非空） */
  topic: Topic
  topicId: string
  sheet: Sheet
  /* 草稿与 setter：state 声明在入口层，这里只做原样传递 */
  labelDraft: string
  setLabelDraft(value: string): void
  notesDraft: string
  setNotesDraft(value: string): void
  hrefDraft: string
  setHrefDraft(value: string): void
  formulaDraft: string
  setFormulaDraft(value: string): void
  codeDraft: string
  setCodeDraft(value: string): void
  codeLangDraft: string
  setCodeLangDraft(value: string): void
  /* 聚焦 ref：入口层的聚焦 effect 与这里的输入框共用同一批 ref */
  notesAreaRef: RefObject<HTMLTextAreaElement | null>
  formulaAreaRef: RefObject<HTMLTextAreaElement | null>
  codeAreaRef: RefObject<HTMLTextAreaElement | null>
  onClose(): void
  onNotify(message: string): void
}

export default function TopicBranch({
  topic,
  topicId,
  sheet,
  labelDraft,
  setLabelDraft,
  notesDraft,
  setNotesDraft,
  hrefDraft,
  setHrefDraft,
  formulaDraft,
  setFormulaDraft,
  codeDraft,
  setCodeDraft,
  codeLangDraft,
  setCodeLangDraft,
  notesAreaRef,
  formulaAreaRef,
  codeAreaRef,
  onClose,
  onNotify
}: Props): ReactElement {
  const addLabel = useEditor((s) => s.addLabel)
  const removeLabel = useEditor((s) => s.removeLabel)
  const setNotes = useEditor((s) => s.setNotes)
  const setHref = useEditor((s) => s.setHref)
  const setFormula = useEditor((s) => s.setFormula)
  const setCode = useEditor((s) => s.setCode)
  const setSizeOverride = useEditor((s) => s.setSizeOverride)

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
    // 判据在 code-draft.ts：空文本且没有既有代码块时**不新建**——
    // 否则点「公式」把焦点从代码框拿走触发的那次 onBlur，就会凭空插入一个空代码块
    const patch = codeDraftPatch(topic.code, codeDraft, codeLangDraft)
    if (patch !== undefined) setCode(topicId, patch)
  }

  return (
    <div className="side-panel">
      <PanelHeader onClose={onClose} />

      <div className="side-panel__body">
        <div className="side-panel__title">当前主题</div>
        <div className="node-preview" title={topic.title}>
          {topic.title || '（空标题）'}
        </div>

        <MarkerSection topic={topic} topicId={topicId} />

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
          <button
            type="button"
            className="btn btn--primary"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleAddLabel}
          >
            <Plus size={14} />
            添加
          </button>
        </div>

        <div className="side-panel__title">备注</div>
        <textarea
          ref={notesAreaRef}
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

        <ImageSection topic={topic} topicId={topicId} onNotify={onNotify} />

        <AttachmentSection topic={topic} topicId={topicId} onNotify={onNotify} />

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
              const language = event.target.value
              setCodeLangDraft(language)
              // 还没有代码块、代码框也是空的时候**只改草稿**：滚轮扫过下拉不该凭空建出
              // 一个空代码块（默认语言正是 python 这类）。真写了内容，失焦时照样带上所选语言。
              const patch = codeDraftPatch(topic.code, codeDraft, language)
              if (patch !== undefined) setCode(topicId, patch)
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
        <div className="side-panel__hint">
          离开输入框即保存；节点里会按等宽字体排版，超出部分可滚动
        </div>
        {(topic.code || codeDraft.length > 0) && (
          <div className="side-panel__row">
            <button
              type="button"
              className="btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setCodeDraft('')
                setCodeLangDraft(defaultCodeLanguage())
                setCode(topicId, null)
              }}
            >
              <X size={14} />
              移除代码块
            </button>
          </div>
        )}

        <OverlayListSection sheet={sheet} />
      </div>
    </div>
  )
}
