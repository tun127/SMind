import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { activeRoot, activeSheet, findTopic } from '@shared/model/tree'
import { useEditor } from '../store/editor'
import OverlayBranch from './nodePanel/overlay-branch'
import TopicBranch from './nodePanel/topic-branch'
import { PanelHeader, defaultCodeLanguage } from './nodePanel/panel-parts'

interface Props {
  onClose(): void
  onNotify(message: string): void
}

/**
 * 节点属性面板的入口：三条分支（画布元素 / 未选中 / 选中主题）+ 面板级草稿状态。
 *
 * 面板级草稿 `useState`、聚焦 ref 与相关 effect **刻意留在这一层**：分支组件会随选中对象
 * 挂载/卸载，草稿一旦搬下去，它的生命周期就跟着挂载点变了（任务表 A4 的高危点）。
 * 两条分支组件只收原样 props，JSX 与处理器逐字未改。
 *
 * 2026-09-19 修（回归）：入口原来在 `{body}` 外面**又包了一层** `.side-panel` + `PanelHeader`，
 * 而两条分支组件**各自也带一份**（它们的 JSX 是从原实现的三条 early-return 整块搬来的，
 * 每块本来就自带外壳）→ 选中主题 / 画布元素时 DOM 里出现嵌套面板与**两个关闭按钮**。
 * 现在恢复成"每条分支渲染自己的外壳"，与拆分前的 DOM 逐字一致（空态那条分支也补回外壳）。
 *
 * 备注与超链接用本地草稿 + 失焦提交：既不怕输入法打断，也不需要每敲一个字就写历史。
 */
export default function NodePanel({ onClose, onNotify }: Props): ReactElement {
  const workbook = useEditor((s) => s.workbook)
  const selection = useEditor((s) => s.selection)

  const sheet = useMemo(() => activeSheet(workbook), [workbook])

  const id = selection[0] ?? null
  const topic = useMemo(() => (id ? findTopic(activeRoot(workbook), id) : null), [workbook, id])

  // 选中的是画布级元素（概要 / 边界 / 关系线）：它也有文字与字体，照样能改
  const selectedOverlay = useEditor((s) => s.selectedOverlay)
  const overlayItem = useMemo(() => {
    const target = selectedOverlay
    if (!target) return null
    const list =
      target.kind === 'summary'
        ? sheet.summaries
        : target.kind === 'boundary'
          ? sheet.boundaries
          : sheet.relationships
    return list.find((item) => item.id === target.id) ?? null
  }, [selectedOverlay, sheet])

  const codeFocusTick = useEditor((s) => s.codeFocusTick)
  const formulaFocusTick = useEditor((s) => s.formulaFocusTick)
  const notesFocusTick = useEditor((s) => s.notesFocusTick)

  const [labelDraft, setLabelDraft] = useState('')
  const [notesDraft, setNotesDraft] = useState('')
  const [hrefDraft, setHrefDraft] = useState('')
  const [formulaDraft, setFormulaDraft] = useState('')
  const [codeDraft, setCodeDraft] = useState('')
  // 新建代码块的语言初始值：来自「默认样式」面板的设置（null = 纯文本）
  const [codeLangDraft, setCodeLangDraft] = useState(() => defaultCodeLanguage())
  const codeAreaRef = useRef<HTMLTextAreaElement | null>(null)
  const formulaAreaRef = useRef<HTMLTextAreaElement | null>(null)
  const notesAreaRef = useRef<HTMLTextAreaElement | null>(null)

  // Alt+C 的落点：面板一打开（或已打开时收到信号）就把焦点交给代码输入框
  useEffect(() => {
    if (codeFocusTick > 0) codeAreaRef.current?.focus()
  }, [codeFocusTick])

  // 快捷栏「公式」的落点：同理聚焦公式输入框
  useEffect(() => {
    if (formulaFocusTick > 0) formulaAreaRef.current?.focus()
  }, [formulaFocusTick])

  // 画布上的备注指示图标点击：聚焦备注输入框（面板随 requestNotesFocus 自动打开）
  useEffect(() => {
    if (notesFocusTick > 0) notesAreaRef.current?.focus()
  }, [notesFocusTick])

  /**
   * 切换所选节点、或**该节点已提交的内容变了**（撤销 / 重做、AI 改、别处改）时同步草稿；
   * 输入过程中绝不覆盖用户正在敲的内容——草稿只在失焦时才写回 store，所以这些依赖
   * 不会因为"打字"而变化。
   *
   * 2026-09-19 修（老缺陷，审计发现）：以前只依赖 `[id]`，于是**撤销之后草稿仍是撤销前的文本**
   * （选中的还是同一个节点，effect 不会重跑），用户再点别处失焦就会把撤销掉的内容又盖回去。
   */
  useEffect(() => {
    // 「换了对象就把草稿重置掉」这类同步 setState 规则会报警，但这里正是它的经典场景：
    // 依赖数组限定为节点与其已提交字段而**不是**草稿本身，所以用户打字时不会被覆盖。
    // 想彻底消除告警得改 remount 或派生状态，代价是面板里其它状态（滚动、焦点）一起丢。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLabelDraft('')
    setNotesDraft(topic?.notes ?? '')
    setHrefDraft(topic?.href ?? '')
    setFormulaDraft(topic?.formula ?? '')
    setCodeDraft(topic?.code?.text ?? '')
    // 节点已有代码块用它自己的语言；没有（准备新建）时用默认语言
    setCodeLangDraft(topic?.code?.language || defaultCodeLanguage())
  }, [id, topic?.notes, topic?.href, topic?.formula, topic?.code?.text, topic?.code?.language])

  // 三条分支互斥（选中画布元素时 `selection` 已被清空），与原实现的 early return 一一对应；
  // 每条分支**自带** `.side-panel` 外壳与 `PanelHeader`（见文件头 2026-09-19 那条）
  let body: ReactElement
  if (selectedOverlay && overlayItem) {
    body = (
      <OverlayBranch
        selectedOverlay={selectedOverlay}
        overlayItem={overlayItem}
        onClose={onClose}
      />
    )
  } else if (!topic || !id) {
    body = (
      <div className="side-panel">
        <PanelHeader onClose={onClose} />
        <div className="side-panel__body">
          <div className="side-panel__empty">
            请先在画布上选中一个主题，再设置它的标记图标、标签、备注与超链接。
          </div>
        </div>
      </div>
    )
  } else {
    body = (
      <TopicBranch
        topic={topic}
        topicId={id}
        sheet={sheet}
        labelDraft={labelDraft}
        setLabelDraft={setLabelDraft}
        notesDraft={notesDraft}
        setNotesDraft={setNotesDraft}
        hrefDraft={hrefDraft}
        setHrefDraft={setHrefDraft}
        formulaDraft={formulaDraft}
        setFormulaDraft={setFormulaDraft}
        codeDraft={codeDraft}
        setCodeDraft={setCodeDraft}
        codeLangDraft={codeLangDraft}
        setCodeLangDraft={setCodeLangDraft}
        notesAreaRef={notesAreaRef}
        formulaAreaRef={formulaAreaRef}
        codeAreaRef={codeAreaRef}
        onClose={onClose}
        onNotify={onNotify}
      />
    )
  }

  return body
}
