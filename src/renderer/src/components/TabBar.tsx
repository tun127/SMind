import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { Plus, X } from 'lucide-react'
import { useEditor } from '../store/editor'
import { tabTitleOf, useTabs } from '../store/tabs'

interface Props {
  /** 新建一个空白文档标签 */
  onNewTab(): void
  /** 关闭某个标签（未保存确认由 App 层负责） */
  onCloseTab(id: string): void
}

/**
 * 底部多文档标签栏（浏览器式任务栏）。
 *
 * - 标签上显示文件名，未保存显示 ●，悬停显示完整路径；
 * - 拖拽排序；放不下时左右箭头滚动；
 * - 激活标签的脏标记/名字直接读编辑器（实时），非激活标签用快照里的记录。
 */
export default function TabBar({ onNewTab, onCloseTab }: Props): ReactElement {
  const tabs = useTabs((s) => s.tabs)
  const activeId = useTabs((s) => s.activeId)
  const switchTo = useTabs((s) => s.switchTo)
  const moveTab = useTabs((s) => s.moveTab)
  // 激活标签的实时脏标记与文档名（改名/改动立刻反映在标签上）
  const liveDirty = useEditor((s) => s.dirty)
  const liveWorkbook = useEditor((s) => s.workbook)
  const liveFilePath = useEditor((s) => s.filePath)

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [canScroll, setCanScroll] = useState<{ left: boolean; right: boolean }>({
    left: false,
    right: false
  })
  const dragIdRef = useRef<string | null>(null)

  const updateScrollState = useCallback((): void => {
    const el = scrollerRef.current
    if (!el) return
    const overflow = el.scrollWidth > el.clientWidth + 1
    setCanScroll({
      left: overflow && el.scrollLeft > 1,
      right: overflow && el.scrollLeft < el.scrollWidth - el.clientWidth - 1
    })
  }, [])

  useEffect(() => {
    updateScrollState()
    // 标签数量变化、窗口尺寸变化都可能改变溢出状态
    const onResize = (): void => updateScrollState()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [tabs.length, updateScrollState])

  const scrollBy = (delta: number): void => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollBy({ left: delta, behavior: 'smooth' })
  }

  return (
    <div className="tabbar">
      {canScroll.left && (
        <button
          type="button"
          className="tabbar__arrow"
          title="向左滚动"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => scrollBy(-240)}
        >
          ‹
        </button>
      )}

      <div className="tabbar__tabs" ref={scrollerRef} onScroll={updateScrollState}>
        {tabs.map((tab, index) => {
          const active = tab.id === activeId
          const dirty = active ? liveDirty : tab.dirty
          const title = active
            ? tabTitleOf({ filePath: liveFilePath, workbook: liveWorkbook })
            : tabTitleOf(tab)
          return (
            <div
              key={tab.id}
              className={active ? 'tabbar__tab tabbar__tab--active' : 'tabbar__tab'}
              title={tab.filePath ?? `${title}（未保存过的新文档）`}
              onClick={() => switchTo(tab.id)}
              /* 中键关闭，与浏览器一致 */
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  onCloseTab(tab.id)
                }
              }}
              draggable
              onDragStart={() => {
                // 记住**被拖的那个**标签：它是整个拖拽过程中唯一不变的锚点
                dragIdRef.current = tab.id
              }}
              onDragOver={(e) => {
                e.preventDefault()
                const from = tabs.findIndex((item) => item.id === dragIdRef.current)
                if (from >= 0 && from !== index) {
                  // 跟手：拖到哪就排到哪。`dragIdRef` 必须**始终指向被拖的那个标签**——
                  // 这里曾经多写一行 `dragIdRef.current = tab.id`：而 `tab === tabs[index]`
                  // （map 绑定），且能进本分支的前提就是 `from !== index`，所以那一行
                  // **必然**把"被拖的标签"替换成"被悬停的标签"，此后每次 dragover 都会去移动
                  // 另一个标签（来回拖动时表现为跳位）。
                  moveTab(from, index)
                }
              }}
              onDragEnd={() => {
                dragIdRef.current = null
              }}
            >
              <span className={dirty ? 'tabbar__dot tabbar__dot--dirty' : 'tabbar__dot'} />
              <span className="tabbar__name">{title}</span>
              <button
                type="button"
                className="tabbar__close"
                title="关闭标签"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseTab(tab.id)
                }}
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
      </div>

      {canScroll.right && (
        <button
          type="button"
          className="tabbar__arrow"
          title="向右滚动"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => scrollBy(240)}
        >
          ›
        </button>
      )}

      <button
        type="button"
        className="tabbar__new"
        title="新建文档标签"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onNewTab}
      >
        <Plus size={14} />
      </button>
    </div>
  )
}
