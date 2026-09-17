import { useMemo, useState, type ReactElement } from 'react'
import { AlertTriangle, Check, Sparkles, Wand2 } from 'lucide-react'
import {
  buildExpandMessages,
  buildGenerateMessages,
  buildPolishMessages,
  cleanPolishedTitle,
  countOutlineNodes,
  parseFlatList,
  parseOutline,
  type GenerateDetail,
  type OutlineNode
} from '@shared/ai'
import { ancestorsOf, activeRoot, findTopic } from '@shared/model/tree'
import { runOutlineChat } from '../ai/outlineRun'
import { Modal } from './Dialogs'
import { OutlinePreview, countNotedNodes } from './OutlinePreview'
import { useEditor } from '../store/editor'

export type AiTask = 'generate' | 'expand' | 'polish'

interface Props {
  task: AiTask
  onClose(): void
  onNotify(message: string): void
  /**
   * 「生成新导图」的落地方式：在**新窗口**里成为一份独立文档。
   *
   * 不再往当前文档里加内容——那会让用户觉得"当前导图被塞了东西/被覆盖了"。
   */
  onGenerateInNewWindow(root: OutlineNode, title: string): void
}

export default function AiDialog({
  task,
  onClose,
  onNotify,
  onGenerateInNewWindow
}: Props): ReactElement {
  const workbook = useEditor((s) => s.workbook)
  const selection = useEditor((s) => s.selection)
  const selectedId = selection[0] ?? null
  const selectedTopic = useMemo(
    () => (selectedId ? findTopic(activeRoot(workbook), selectedId) : null),
    [workbook, selectedId]
  )

  const [topic, setTopic] = useState(selectedTopic?.title ?? '')
  /**
   * 层级默认 4（原来是 3）。
   *
   * 3 层对"我要一份完整的导图"来说太浅了：一层大方向 + 一层分类就没有下文，
   * 看起来正是"只写完粗分"。
   */
  const [depth, setDepth] = useState(4)
  /**
   * 详细程度，默认**详细**。
   *
   * 原来的提示词是「最多 N 层、每个节点不超过 12 字」——12 字装不下任何知识点，
   * 模型只能写标题词，于是只出一副骨架。用户要的是"有解释、有例子"的图，
   * 所以默认走详细模式（骨架模式仍然保留给"先起个框架"的用法）。
   */
  const [detail, setDetail] = useState<GenerateDetail>('detailed')
  const [extra, setExtra] = useState('')
  const [count, setCount] = useState(5)
  const [style, setStyle] = useState('简洁、专业、通顺')
  const [target, setTarget] = useState<'newWindow' | 'child'>('newWindow')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rawText, setRawText] = useState('')
  const [outline, setOutline] = useState<OutlineNode | null>(null)
  const [flat, setFlat] = useState<string[]>([])
  const [polished, setPolished] = useState('')

  const titles = {
    generate: 'AI 一键生成导图',
    expand: 'AI 扩写子主题',
    polish: 'AI 润色标题'
  }[task]

  const run = async (): Promise<void> => {
    if (busy) return
    setError(null)
    setOutline(null)
    setFlat([])
    setPolished('')

    try {
      setBusy(true)

      if (task === 'polish') {
        if (!selectedTopic) {
          setError('请先在画布上选中一个主题')
          return
        }
        const result = await window.api.aiChat(
          buildPolishMessages({ title: selectedTopic.title, style }),
          {
            timeoutMs: 60000
          }
        )
        setRawText(result.content)
        setPolished(cleanPolishedTitle(result.content))
        return
      }

      if (task === 'expand') {
        if (!selectedTopic) {
          setError('请先在画布上选中一个主题')
          return
        }
        const path = ancestorsOf(activeRoot(workbook), selectedTopic.id)
          .map((id) => findTopic(activeRoot(workbook), id)?.title ?? '')
          .filter((title) => title.length > 0)
        const result = await window.api.aiChat(
          buildExpandMessages({
            title: selectedTopic.title,
            existing: selectedTopic.children.map((child) => child.title),
            count,
            notes: selectedTopic.notes,
            path: [...path, selectedTopic.title]
          })
        )
        setRawText(result.content)
        setFlat(parseFlatList(result.content))
        return
      }

      // generate
      if (topic.trim().length === 0) {
        setError('请先填写要生成的主题')
        return
      }
      /**
       * 生成（含**自动续写**，逻辑在 `ai/outlineRun` 里，与"按文档生成"共用）。
       *
       * 一句命令要产出上百节点的详细图，输出动辄 8k~14k token：
       * 服务商的单次输出上限随时可能把它截断。截断就自动接着写（最多 3 段），
       * 而不是把半张图丢给用户、让他自己再写一遍提示词——那正是用户抱怨的做法。
       */
      const { text: raw, truncated } = await runOutlineChat(
        buildGenerateMessages({ topic, depth, extra, detail }),
        {
          onContinue: (attempt, total) =>
            onNotify(`输出被上限截断，正在自动接着写（第 ${attempt}/${total} 段）…`)
        }
      )
      setRawText(raw)
      const parsed = parseOutline(raw, topic.trim())
      if (!parsed.root) {
        setError('模型没有返回可解析的大纲，原文见下面')
        return
      }
      if (parsed.warnings.length > 0) onNotify(parsed.warnings.join('；'))
      /**
       * 续写用尽仍被截断 → 如实告知（否则用户拿到的是一张"看似完整"的浅图）。
       * 这也是「AI 只写了粗分」最常见的原因，而 finish_reason 以前根本没人看。
       */
      if (truncated) {
        onNotify(
          '注意：自动续写数段后仍被服务商的**输出上限**截断，结果可能只是前一部分。' +
            '可以在「AI 设置 → 单次输出上限」调大，或把「详细程度」改为骨架后重试。'
        )
      }
      setOutline(parsed.root)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const apply = (): void => {
    const store = useEditor.getState()

    if (task === 'polish') {
      if (!selectedTopic || polished.trim().length === 0) return
      if (polished.trim() === selectedTopic.title) {
        onNotify('润色结果与原文一致，没有改动')
        onClose()
        return
      }
      store.setTitle(selectedTopic.id, polished.trim())
      onNotify('已替换标题，可用 Ctrl+Z 撤回')
      onClose()
      return
    }

    if (task === 'expand') {
      if (!selectedTopic || flat.length === 0) return
      const added = store.addChildTitles(selectedTopic.id, flat)
      onNotify(`已添加 ${added} 个子主题，可用 Ctrl+Z 撤回`)
      onClose()
      return
    }

    if (!outline) return

    // 生成新导图 → 在新窗口里成为独立文档（不动当前文档）
    if (target === 'newWindow') {
      onGenerateInNewWindow(outline, outline.title)
      onClose()
      return
    }

    const applied = store.applyOutlineTree(selectedTopic?.id ?? '', outline)
    onNotify(`已生成 ${applied} 个主题，可用 Ctrl+Z 撤回`)
    onClose()
  }

  const canApply =
    !busy &&
    ((task === 'generate' &&
      outline !== null &&
      // 挂到已有主题下时必须有选中的主题，否则无处可挂（「新窗口」不需要）
      (target === 'newWindow' || selectedTopic !== null)) ||
      (task === 'expand' && flat.length > 0) ||
      (task === 'polish' && polished.trim().length > 0))

  const totalPreview = outline ? countOutlineNodes(outline) : flat.length
  const notedPreview = outline ? countNotedNodes(outline) : 0

  return (
    <Modal
      title={titles}
      icon={task === 'polish' ? <Wand2 size={18} /> : <Sparkles size={18} />}
      onMaskClick={busy ? undefined : onClose}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void run()}>
            {busy ? '正在请求…' : rawText.length > 0 ? '重新生成' : '生成'}
          </button>
          <button type="button" className="btn btn--primary" disabled={!canApply} onClick={apply}>
            {task === 'polish' ? '替换标题' : '应用到画布'}
          </button>
        </>
      }
    >
      <div className="ai-form">
        {task === 'generate' && (
          <>
            <div className="ai-field">
              <span className="ai-field__label">主题</span>
              <input
                className="input"
                placeholder="例如：如何在一个月内学会做菜"
                value={topic}
                autoFocus
                onChange={(event) => setTopic(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return
                  if (event.key === 'Enter') void run()
                }}
              />
            </div>
            <div className="ai-field ai-field--row">
              <span className="ai-field__label">详细程度</span>
              <div className="ai-choices">
                <button
                  type="button"
                  className={detail === 'detailed' ? 'ai-choice ai-choice--active' : 'ai-choice'}
                  title="覆盖尽量多的考点，每个节点配解释，关键考点补真题（内容多、耗时略长）"
                  onClick={() => setDetail('detailed')}
                >
                  详细
                </button>
                <button
                  type="button"
                  className={detail === 'skeleton' ? 'ai-choice ai-choice--active' : 'ai-choice'}
                  title="只出骨架：短标题、快速起图，细节之后再补"
                  onClick={() => setDetail('skeleton')}
                >
                  骨架
                </button>
              </div>
            </div>
            <div className="ai-field ai-field--row">
              <span className="ai-field__label">层级</span>
              <input
                type="range"
                min={2}
                max={5}
                value={depth}
                onChange={(event) => setDepth(Number(event.target.value))}
              />
              <span className="ai-field__value">{depth} 层</span>
            </div>
            <div className="ai-field">
              <span className="ai-field__label">补充要求（可留空）</span>
              <input
                className="input"
                placeholder="例如：面向零基础、偏实操、每点一句话"
                value={extra}
                onChange={(event) => setExtra(event.target.value)}
              />
            </div>
            <div className="ai-field">
              <span className="ai-field__label">生成到</span>
              <div className="ai-choices">
                <button
                  type="button"
                  className={target === 'newWindow' ? 'ai-choice ai-choice--active' : 'ai-choice'}
                  title="在**新窗口**里成为一份独立文档，不影响当前导图"
                  onClick={() => setTarget('newWindow')}
                >
                  新窗口
                </button>
                <button
                  type="button"
                  className={target === 'child' ? 'ai-choice ai-choice--active' : 'ai-choice'}
                  disabled={!selectedTopic}
                  title={selectedTopic ? `挂到「${selectedTopic.title}」下面` : '请先选中一个主题'}
                  onClick={() => setTarget('child')}
                >
                  选中主题的子主题
                </button>
              </div>
            </div>
          </>
        )}

        {task === 'expand' && (
          <>
            <div className="ai-context">
              当前主题：<b>{selectedTopic?.title ?? '（未选中）'}</b>
              {selectedTopic && selectedTopic.children.length > 0 && (
                <>
                  <br />
                  已有子主题：{selectedTopic.children.map((child) => child.title).join('、')}
                </>
              )}
            </div>
            <div className="ai-field ai-field--row">
              <span className="ai-field__label">数量</span>
              <input
                type="range"
                min={3}
                max={12}
                value={count}
                onChange={(event) => setCount(Number(event.target.value))}
              />
              <span className="ai-field__value">{count} 个</span>
            </div>
          </>
        )}

        {task === 'polish' && (
          <>
            <div className="ai-context">
              当前文字：<b>{selectedTopic?.title ?? '（未选中）'}</b>
            </div>
            <div className="ai-field">
              <span className="ai-field__label">风格</span>
              <input
                className="input"
                value={style}
                onChange={(event) => setStyle(event.target.value)}
              />
            </div>
          </>
        )}

        {error && (
          <div className="ai-error">
            <AlertTriangle size={14} />
            <span>{error}</span>
          </div>
        )}

        {outline && (
          <div className="ai-preview">
            <div className="ai-preview__head">
              <Check size={13} /> 解析出 {totalPreview} 个主题
              {notedPreview > 0 ? `（其中 ${notedPreview} 个带解释）` : ''}
              ，预览：
            </div>
            <div className="ai-preview__body">
              <OutlinePreview node={outline} />
            </div>
          </div>
        )}

        {task === 'expand' && flat.length > 0 && (
          <div className="ai-preview">
            <div className="ai-preview__head">
              <Check size={13} /> 将新增 {flat.length} 个子主题：
            </div>
            <div className="ai-preview__body">
              {flat.map((item, index) => (
                <div
                  key={`${item}-${index}`}
                  className="ai-preview__row"
                  style={{ paddingLeft: 8 }}
                >
                  <span className="ai-preview__dot" />
                  {item}
                </div>
              ))}
            </div>
          </div>
        )}

        {task === 'polish' && polished.length > 0 && (
          <div className="ai-preview">
            <div className="ai-preview__head">
              <Check size={13} /> 润色结果：
            </div>
            <div className="ai-preview__body">
              <div className="ai-preview__row" style={{ paddingLeft: 8 }}>
                <span className="ai-preview__dot" />
                {polished}
              </div>
            </div>
          </div>
        )}

        {rawText.length > 0 && (
          <details className="ai-raw">
            <summary>查看模型原文</summary>
            <pre>{rawText}</pre>
          </details>
        )}

        <div className="ai-note">
          AI 只在点「生成」时联网，其余功能全程离线。结果会记成<b>一步操作</b>，不满意直接 `Ctrl+Z`
          撤回。
        </div>
      </div>
    </Modal>
  )
}
