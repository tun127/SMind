/**
 * 「拖一份文档进来，AI 读完做成导图」。
 *
 * 两种走法（自动选）：
 * - **短文档**（≤ 一段的量）：一次通读，直接出详细大纲；
 * - **长文档**：按段落切成若干段，**逐段细读**提取结构与要点，
 *   再把各段结果**合并去重**成一份完整大纲——
 *   一份几万字的报告塞不进一次请求，硬塞的结果就是模型只读了开头，
 *   那正是"分析得很粗"的来源。
 *
 * 输出仍是缩进大纲 + `> ` 解释行（解释进节点备注），走过与「按主题生成」同一套
 * 解析与落地路径，所以行为的边界（层级、备注、预览、撤销）完全一致。
 */
import { useState, type ReactElement } from 'react'
import { AlertTriangle, Check, FileText } from 'lucide-react'
import {
  buildDocumentChunkMessages,
  buildDocumentMergeMessages,
  buildDocumentOutlineMessages,
  countOutlineNodes,
  parseOutline,
  readableIpcError,
  type OutlineNode
} from '@shared/ai'
import { splitDocument, type ExtractedDocument } from '@shared/document'
import { activeRoot, findTopic } from '@shared/model/tree'
import { runOutlineChat } from '../ai/outlineRun'
import { Modal } from './Dialogs'
import { OutlinePreview, countNotedNodes } from './OutlinePreview'
import { useEditor } from '../store/editor'

/** 单段字符上限：大约 6k~12k token，多数模型一次读得下 */
const CHUNK_CHARS = 9000
/** 最多分几段：再长就是"整本书"了，先做取舍并**如实告知**用户 */
const MAX_CHUNKS = 8

interface Props {
  document: ExtractedDocument
  onClose(): void
  onNotify(message: string): void
  onGenerateInNewWindow(root: OutlineNode, title: string): void
}

export default function DocumentToMapDialog({
  document: doc,
  onClose,
  onNotify,
  onGenerateInNewWindow
}: Props): ReactElement {
  const workbook = useEditor((s) => s.workbook)
  const selection = useEditor((s) => s.selection)
  const selectedId = selection[0] ?? null
  const selectedTopic = selectedId ? findTopic(activeRoot(workbook), selectedId) : null

  const [depth, setDepth] = useState(4)
  const [extra, setExtra] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [outline, setOutline] = useState<OutlineNode | null>(null)
  const [rawText, setRawText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [target, setTarget] = useState<'newWindow' | 'child'>('newWindow')

  const totalPreview = outline ? countOutlineNodes(outline) : 0
  const notedPreview = outline ? countNotedNodes(outline) : 0
  const canApply = !busy && outline !== null && (target === 'newWindow' || selectedTopic !== null)

  /** 文档名去掉扩展名：当作新导图的标题兜底 */
  const fallbackTitle = doc.name.replace(/\.[^.]+$/, '')

  const run = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    setProgress('正在准备…')
    try {
      const { chunks, droppedChars } = splitDocument(doc.text, CHUNK_CHARS, MAX_CHUNKS)
      let raw = ''
      let truncated = false

      if (chunks.length <= 1) {
        setProgress('正在通读全文…')
        const result = await runOutlineChat(
          buildDocumentOutlineMessages({ name: doc.name, text: doc.text, depth, extra }),
          {
            onContinue: (attempt, total) =>
              setProgress(`输出被上限截断，正在自动接着写（${attempt}/${total}）…`)
          }
        )
        raw = result.text
        truncated = result.truncated
      } else {
        const parts: string[] = []
        for (let index = 0; index < chunks.length; index += 1) {
          setProgress(`正在细读第 ${index + 1}/${chunks.length} 段…`)
          const part = await runOutlineChat(
            buildDocumentChunkMessages({
              name: doc.name,
              index: index + 1,
              total: chunks.length,
              text: chunks[index] ?? ''
            }),
            {
              continuations: 1,
              onContinue: (attempt, total) =>
                setProgress(`第 ${index + 1} 段输出被截断，正在接着写（${attempt}/${total}）…`)
            }
          )
          parts.push(part.text)
        }
        setProgress('正在把各段合并成一张导图（去重、归位）…')
        const merged = await runOutlineChat(
          buildDocumentMergeMessages({ name: doc.name, parts, depth }),
          {
            onContinue: (attempt, total) =>
              setProgress(`合并输出被截断，正在接着写（${attempt}/${total}）…`)
          }
        )
        raw = merged.text
        truncated = merged.truncated
      }

      setRawText(raw)
      const parsed = parseOutline(raw, fallbackTitle)
      if (!parsed.root) {
        setError('模型没有返回可解析的大纲，原文见下面')
        return
      }
      if (parsed.warnings.length > 0) onNotify(parsed.warnings.join('；'))
      if (truncated) {
        onNotify(
          '注意：自动续写数段后仍被输出上限截断，结果可能只是前一部分。' +
            '可以在「AI 设置 → 单次输出上限」调大后重试。'
        )
      }
      if (droppedChars > 0) {
        onNotify(
          `文档很长：只细读了前 ${chunks.length} 段（约 ${droppedChars.toLocaleString()} 字未纳入）。` +
            '想要完整覆盖，可以拆成几份分别拖进来。'
        )
      }
      if (doc.note) onNotify(doc.note)
      setOutline(parsed.root)
    } catch (err) {
      setError(readableIpcError((err as Error).message))
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  const apply = (): void => {
    if (!outline) return
    if (target === 'newWindow') {
      onGenerateInNewWindow(outline, outline.title || fallbackTitle)
      onClose()
      return
    }
    if (!selectedTopic) return
    // 与「按主题生成」一致：整棵树一次写入，算一步撤销
    const applied = useEditor.getState().applyOutlineTree(selectedTopic.id, outline)
    onNotify(`已按文档生成 ${applied} 个主题，可用 Ctrl+Z 撤回`)
    onClose()
  }

  return (
    <Modal
      title={`按文档生成导图 · ${doc.name}`}
      icon={<FileText size={18} />}
      onMaskClick={busy ? undefined : onClose}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void run()}>
            {busy ? '正在分析…' : rawText.length > 0 ? '重新分析' : '开始分析'}
          </button>
          <button type="button" className="btn btn--primary" disabled={!canApply} onClick={apply}>
            生成导图
          </button>
        </>
      }
    >
      <div className="ai-form">
        <div className="ai-context">
          文件：<b>{doc.name}</b>（{doc.label} · {doc.chars.toLocaleString()} 字 /{' '}
          {doc.lines.toLocaleString()} 行）
          {doc.note && <div className="ai-field__hint">{doc.note}</div>}
        </div>

        <div className="ai-field ai-field--row">
          <span className="ai-field__label">层级</span>
          <input
            type="range"
            min={2}
            max={5}
            value={depth}
            onChange={(event) => setDepth(Number(event.target.value))}
            disabled={busy}
          />
          <span className="ai-field__value">{depth} 层</span>
        </div>

        <div className="ai-field">
          <span className="ai-field__label">补充要求（可留空）</span>
          <input
            className="input"
            placeholder="例如：只保留结论与数据、面向面试复习、把流程单独拉一支"
            value={extra}
            onChange={(event) => setExtra(event.target.value)}
            disabled={busy}
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
              disabled={busy}
            >
              新窗口
            </button>
            <button
              type="button"
              className={target === 'child' ? 'ai-choice ai-choice--active' : 'ai-choice'}
              title={selectedTopic ? `挂到「${selectedTopic.title}」下面` : '请先选中一个主题'}
              onClick={() => setTarget('child')}
              disabled={busy || !selectedTopic}
            >
              选中主题的子主题
            </button>
          </div>
        </div>

        {busy && (
          <div className="ai-test">
            <span>
              {progress || '正在分析…'}
              <div className="ai-field__hint">
                长文档要分几段分别细读，比按主题生成慢一些；输出被截断时会自动接着写。
              </div>
            </span>
          </div>
        )}

        {error && (
          <div className="ai-test ai-test--fail">
            <AlertTriangle size={14} />
            <span>{error}</span>
          </div>
        )}

        {outline && (
          <div className="ai-preview">
            <div className="ai-preview__head">
              <Check size={13} /> 解析出 {totalPreview} 个主题
              {notedPreview > 0 ? `（其中 ${notedPreview} 个带解释）` : ''}，预览：
            </div>
            <div className="ai-preview__body">
              <OutlinePreview node={outline} />
            </div>
          </div>
        )}

        {error && rawText.length > 0 && (
          <div className="ai-preview">
            <div className="ai-preview__head">模型原文（用于排查）：</div>
            <div className="ai-preview__body ai-preview__body--raw">{rawText}</div>
          </div>
        )}
      </div>
    </Modal>
  )
}
