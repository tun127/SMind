import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from 'react'
import { ArrowDown, Settings2 } from 'lucide-react'
import { readableIpcError, DEFAULT_QUALITY_TIER, type QualityTier } from '@shared/ai'
import type { ExtractedDocument } from '@shared/document'
import { buildTitleIndex } from '@shared/agent'
import type { LicenseView } from '@shared/license'
import { activeRoot } from '@shared/model/tree'
// 导图文件的判定走共享原语（E1 收敛：本文件里原本有两份同样的正则）
import { MINDMAP_FILE_RE } from '@shared/openfile'
import { viewportActions } from '../render/viewport'
import { useEditor } from '../store/editor'
import ChatHeader from './chat/chat-header'
import ChatInput from './chat/chat-input'
import ConfirmBar from './chat/confirm-bar'
import DocChips from './chat/doc-chips'
import { QUICK_PROMPTS } from './chat/format'
import LicenseBar from './chat/license-bar'
import MessageList from './chat/message-list'
import type { ChatDoc } from './chat/types'
import { useChatLoop } from './chat/use-chat-loop'
interface Props {
  onClose(): void
  /** 面板自己不做配置界面，只负责把用户送去「AI 设置」 */
  onOpenSettings(): void
  /**
   * AI 要动**第一笔**改动之前调用。
   * App 层用它存一份盘上快照——撤销栈在内存里，崩溃就没了，这是第二层保险。
   */
  onBeforeAiWrite(): void
}

/**
 * 历史不再用「截断 N 条」处理：截断会让模型忘掉之前干过什么，用户说"继续"时它从零重读一遍导图。
 * 现在走 `compressHistory`（三期）：最近几轮保留原文，更早的折叠成「此前做过什么」。
 */

/**
 * AI 聊天面板（三期）。
 *
 * 循环：用户提问 → 模型（可能要求调工具）→ 本地执行 → 结果回喂 → 模型继续，直到不再要求调工具。
 *
 * 工具的两种命运：
 * - **只读**（看结构）：立刻执行，没有副作用；
 * - **写**（改画布）：解析成「操作意图」再落到 store，**破坏性操作会停下来先问用户**。
 *
 * 安全网：整个回合的改动并成**一步撤销**（`beginAiTurn`/`commitAiTurn`），
 * 回合中锁住用户的撤销键，开动前请 App 存一份盘上快照。
 */
export default function ChatPanel({
  onClose,
  onOpenSettings,
  onBeforeAiWrite
}: Props): ReactElement {
  const [draft, setDraft] = useState('')
  /** null = 还没查完；false = 没配 Key（显示引导）；true = 可用 */
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  /** 生成质量档位（在主进程的 AI 配置里，启动时读一次；改档位去「AI 设置」） */
  const [tier, setTier] = useState<QualityTier>(DEFAULT_QUALITY_TIER)
  /**
   * 许可状态（Pro / 试用剩余）。
   *
   * **闸门不在这一层**——由主进程决定下发哪些工具；这里只负责让用户看得见
   * （还差几次、以及去哪输入许可码），以及让提示词如实说明现在能不能改。
   */
  const [license, setLicense] = useState<LicenseView | null>(null)
  const [activateOpen, setActivateOpen] = useState(false)
  const [licenseKey, setLicenseKey] = useState('')
  const [licenseMessage, setLicenseMessage] = useState<string | null>(null)
  /** 输入区上方的一句临时提示（粘贴失败之类），几秒后自己消失 */
  const [hint, setHint] = useState<string | null>(null)
  /**
   * 挂在这个会话上的文档（拖进面板 / 点 📎 选进来的）。
   *
   * 只有正文，没有路径——读取与解析都在主进程做完了。AI 用 `readDocument` 工具
   * 按关键词或分段读它，于是"这份文档讲了什么"可以在对话里问，而不必先出一张图。
   */
  const [docs, setDocs] = useState<ChatDoc[]>([])
  /** 工具上下文要读它（回调里拿得到最新的），所以另存一份 ref */
  const docsRef = useRef<ChatDoc[]>([])
  useEffect(() => {
    docsRef.current = docs
  }, [docs])

  /** 挂一份文档（读取与解析都在主进程，渲染层不碰文件系统） */
  const attachDocumentBytes = useCallback((extracted: ExtractedDocument): void => {
    setDocs((prev) => [
      ...prev.filter((doc) => doc.name !== extracted.name),
      { name: extracted.name, text: extracted.text }
    ])
    setHint(
      `已挂上《${extracted.name}》（${extracted.label} · ${extracted.chars.toLocaleString()} 字）` +
        '——可以直接问它里面的内容（只在本次会话有效）'
    )
  }, [])

  const attachDocumentFile = useCallback(
    (file: File): void => {
      void (async () => {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer())
          attachDocumentBytes(await window.api.documentExtract(file.name, bytes))
        } catch (error) {
          setHint(readableIpcError((error as Error).message))
        }
      })()
    },
    [attachDocumentBytes]
  )

  const pickDocument = useCallback((): void => {
    void (async () => {
      try {
        const extracted = await window.api.documentPick()
        if (extracted) attachDocumentBytes(extracted)
      } catch (error) {
        setHint(readableIpcError((error as Error).message))
      }
    })()
  }, [attachDocumentBytes])
  const filePath = useEditor((s) => s.filePath)
  const workbook = useEditor((s) => s.workbook)
  /** 标题索引：把回复里提到的节点变成可点击引用（按首字分桶，大文档也不卡） */
  const titleIndex = useMemo(() => buildTitleIndex(activeRoot(workbook)), [workbook])

  const listRef = useRef<HTMLDivElement | null>(null)
  /** 输入框：便捷粘贴要把内容插到光标处 */
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    void window.api
      .aiConfigGet()
      .then((view) => {
        setHasKey(view.hasKey)
        setTier(view.tier)
      })
      .catch(() => setHasKey(false))
  }, [])

  /**
   * 就地切「思考强度」（生成质量档位）。
   *
   * 写回主进程的 AI 配置：这样关掉面板再开、或去设置里看，都是同一个值——
   * 只存在组件 state 里的档位会在下次挂载时被配置覆盖回去，用户会以为"改了没用"。
   */
  const changeTier = useCallback((next: QualityTier): void => {
    setTier(next)
    void window.api
      .aiConfigSave({ tier: next })
      .catch((error: unknown) => setHint(readableIpcError((error as Error).message)))
  }, [])

  /** 读许可状态；读不到就当"未知"（面板少显示一个徽标，绝不拦住用户用软件） */
  const refreshLicense = useCallback((): void => {
    void window.api
      .licenseGet()
      .then(setLicense)
      .catch(() => undefined)
  }, [])

  useEffect(() => refreshLicense(), [refreshLicense])

  /** 临时提示几秒后自己消失：不占地方、也不用用户去关 */
  useEffect(() => {
    if (hint === null) return
    const timer = window.setTimeout(() => setHint(null), 8000)
    return () => window.clearTimeout(timer)
  }, [hint])

  /**
   * 是否「贴着底」。
   *
   * 以前是**无条件**滚到底：模型边输出边刷新，用户想上滑看历史根本拉不住——
   * 每一片增量都把他拽回底部（真被投诉过）。现在只在用户本来就贴着底时才跟随；
   * 上滑看历史期间不再打扰，右下角给一个「回到最新」回到底部。
   */
  const [atBottom, setAtBottom] = useState(true)

  // AI 回合的 runtime（消息 / 流式状态 / 工具执行 / ref 环）住在 chat/use-chat-loop.ts。
  // 这一行刻意放在原来「按文档恢复聊天记录」那个 effect 的位置：
  // hook 内部那几个 effect 的声明顺序因此与拆分前逐一对应。
  const {
    messages,
    activity,
    streaming,
    plan,
    pendingWrite,
    rememberSkip,
    sessionTokens,
    send,
    stop,
    resolvePending,
    setRememberSkip,
    clearChat
  } = useChatLoop({
    filePath,
    license,
    tier,
    titleIndex,
    docsRef,
    onBeforeAiWrite,
    refreshLicense,
    setAtBottom,
    setDraft
  })

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const onScroll = (): void => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      setAtBottom((prev) => (prev === near ? prev : near))
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // 新内容到达就滚到底——但**只在用户贴着底时**（正在翻历史的用户不该被打断）
  useEffect(() => {
    const el = listRef.current
    if (el && atBottom) el.scrollTop = el.scrollHeight
  }, [messages, activity, atBottom])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    // isComposing：中文输入法回车选词时不能当作发送
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      send(draft)
    }
  }

  /**
   * 便捷粘贴：走主进程读剪贴板（比渲染层的 clipboard API 稳——无焦点/权限时会抛），
   * 插到光标处。Ctrl+V 本来就能用；这个按钮给的是「不想碰键盘」和「Ctrl+V 被别的
   * 程序占住」时的第二条路，多行文本照贴。
   */
  const pasteFromClipboard = (): void => {
    void window.api
      .readClipboardText()
      .then((text) => {
        const clip = text
          .replace(/\r\n?/g, '\n')
          .replace(/[ \t]+$/gm, '')
          .trim()
        if (clip.length === 0) {
          // 剪贴板里没有文字（多半是图片）——静悄悄没反应最容易被当成「功能坏了」
          setHint(
            '剪贴板里没有文字。如果复制的是图片：聊天目前只能发文字，可以把图里的文字打出来，或直接问我。'
          )
          return
        }
        const el = inputRef.current
        const start = el && el.selectionStart !== null ? el.selectionStart : draft.length
        const end = el && el.selectionEnd !== null ? el.selectionEnd : draft.length
        const next = draft.slice(0, start) + clip + draft.slice(end)
        setDraft(next)
        window.requestAnimationFrame(() => {
          if (el) {
            el.focus()
            el.setSelectionRange(start + clip.length, start + clip.length)
          }
        })
      })
      .catch(() => undefined)
  }

  /** 回复 → 画布的反向链接：选中并居中（沿用搜索面板的定位方式） */
  const goToNode = (topicId: string): void => {
    useEditor.getState().select(topicId)
    window.requestAnimationFrame(() => viewportActions.centerOn(topicId))
  }

  return (
    <div
      className="side-panel chat-panel"
      /* 拖文件到这里 = 挂成"可问答的上下文"。
         导图文件（.xmind 等）不接：那是「打开文档」的事，交给窗口层。 */
      onDragOver={(event) => {
        const files = event.dataTransfer?.files
        const first = files && files.length > 0 ? files[0] : null
        if (first && !MINDMAP_FILE_RE.test(first.name)) {
          event.preventDefault()
          event.stopPropagation()
        }
      }}
      onDrop={(event) => {
        const picked = Array.from(event.dataTransfer?.files ?? []).find(
          (item) => !MINDMAP_FILE_RE.test(item.name)
        )
        if (!picked) return
        event.preventDefault()
        event.stopPropagation()
        attachDocumentFile(picked)
      }}
    >
      <ChatHeader
        license={license}
        sessionTokens={sessionTokens}
        streaming={streaming}
        messagesLength={messages.length}
        onOpenSettings={onOpenSettings}
        onClose={onClose}
        onClear={clearChat}
      />

      {hasKey === false ? (
        <div className="side-panel__body">
          <div className="side-panel__empty">
            还没有配置 AI 服务。填入 BaseURL 与 API Key 后（支持 DeepSeek / OpenAI / 通义 / 智谱 /
            Kimi / 本地 Ollama），就能直接用自然语言聊这页导图。
          </div>
          <button type="button" className="btn btn--primary" onClick={onOpenSettings}>
            <Settings2 size={14} />
            打开 AI 设置
          </button>
        </div>
      ) : (
        <>
          <MessageList
            messages={messages}
            plan={plan}
            streaming={streaming}
            activity={activity}
            listRef={listRef}
            titleIndex={titleIndex}
            onGoToNode={goToNode}
          />

          <div className="chat-panel__quick">
            {QUICK_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="chat-panel__chip"
                disabled={streaming}
                onClick={() => send(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>

          {pendingWrite && (
            <ConfirmBar
              pendingWrite={pendingWrite}
              rememberSkip={rememberSkip}
              onRememberSkipChange={setRememberSkip}
              onResolve={resolvePending}
            />
          )}

          {license && !license.canWrite && (
            <LicenseBar
              license={license}
              activateOpen={activateOpen}
              licenseKey={licenseKey}
              licenseMessage={licenseMessage}
              setActivateOpen={setActivateOpen}
              setLicenseKey={setLicenseKey}
              setLicenseMessage={setLicenseMessage}
              setLicense={setLicense}
            />
          )}

          {hint && <div className="chat-panel__activate-msg chat-panel__hint">{hint}</div>}

          {docs.length > 0 && (
            <DocChips
              docs={docs}
              onRemove={(name) => setDocs((prev) => prev.filter((item) => item.name !== name))}
            />
          )}

          {!atBottom && (
            <button
              type="button"
              className="chat-panel__jump"
              title="回到最新消息（重新开始自动跟随）"
              onClick={() => {
                setAtBottom(true)
                const el = listRef.current
                if (el) el.scrollTop = el.scrollHeight
              }}
            >
              <ArrowDown size={13} />
              回到最新
            </button>
          )}

          <ChatInput
            draft={draft}
            setDraft={setDraft}
            inputRef={inputRef}
            streaming={streaming}
            tier={tier}
            onKeyDown={onKeyDown}
            onImagePaste={() =>
              setHint(
                '剪贴板里是图片：聊天目前只能发文字。图片可以直接粘到画布的主题上，文字请用截图里的文字或直接描述。'
              )
            }
            onChangeTier={changeTier}
            onPickDocument={pickDocument}
            onPasteFromClipboard={pasteFromClipboard}
            onStop={stop}
            onSend={() => send(draft)}
          />
        </>
      )}
    </div>
  )
}
