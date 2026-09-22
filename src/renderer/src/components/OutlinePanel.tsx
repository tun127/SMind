import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from 'react'
import {
  ChevronRight,
  FileText,
  Image as ImageIcon,
  Link2,
  ListTree,
  Paperclip,
  Sigma,
  StickyNote,
  Tag,
  X
} from 'lucide-react'
import { activeRoot, activeSheet, findParent, findTopic, isRootDetached } from '@shared/model/tree'
import { canvasLayoutNode } from './canvas/layout-memory'
import { OUTLINE_FORMATS, outlineRows, type OutlineFormat } from '@shared/outline'
import { useEditor } from '../store/editor'

interface Props {
  onClose(): void
  onNotify(message: string): void
}

/**
 * 大纲视图。
 *
 * 双向实时同步不是靠「同步代码」，而是靠**共用同一份 store**：
 * 大纲与画布读的都是 store.workbook，任何一边改了另一边立刻重渲染，
 * 因此不存在两个视图数据不一致的可能。
 */
export default function OutlinePanel({ onClose, onNotify }: Props): ReactElement {
  const workbook = useEditor((s) => s.workbook)
  const selection = useEditor((s) => s.selection)
  const sheet = useMemo(() => activeSheet(workbook), [workbook])
  const rows = useMemo(() => outlineRows(sheet.rootTopic, { skipCollapsed: true }), [sheet])
  const selectedId = selection[0] ?? null

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)

  const titleOf = useCallback(
    (id: string): string => findTopic(activeRoot(workbook), id)?.title ?? '',
    [workbook]
  )

  const rowElement = (id: string): HTMLElement | null =>
    listRef.current?.querySelector<HTMLElement>(`[data-outline-id="${CSS.escape(id)}"]`) ?? null

  const focusRow = useCallback((id: string): void => {
    // 等这一帧的 DOM 更新完成再聚焦，否则新行还不存在
    window.requestAnimationFrame(() => rowElement(id)?.focus())
  }, [])

  /** 把正在编辑的那行写回去（内容没变就不写，避免白记一次撤销） */
  const commitInline = useCallback((): void => {
    if (!editingId) return
    const id = editingId
    const next = draft
    setEditingId(null)
    if (titleOf(id) !== next) useEditor.getState().setTitle(id, next)
  }, [editingId, draft, titleOf])

  const startEdit = useCallback(
    (id: string): void => {
      setEditingId(id)
      setDraft(titleOf(id))
    },
    [titleOf]
  )

  const createSiblingOf = useCallback(
    (id: string): void => {
      const store = useEditor.getState()
      commitInline()
      const newId = store.addSibling(id)
      // 画布上的就地编辑器立刻收掉，改由大纲这一行输入
      store.commitEdit(newId)
      setEditingId(newId)
      setDraft('')
      focusRow(newId)
    },
    [commitInline, focusRow]
  )

  /** 降级：变成上一个同级主题的子主题 */
  const indent = useCallback(
    (id: string): void => {
      const store = useEditor.getState()
      const root = activeRoot(store.workbook)
      const parent = findParent(root, id)
      if (!parent) return
      const index = parent.children.findIndex((child) => child.id === id)
      if (index <= 0) return
      commitInline()
      const previous = parent.children[index - 1]
      if (previous) store.moveNode(id, previous.id)
      focusRow(id)
    },
    [commitInline, focusRow]
  )

  /** 升级：变成父节点的下一个同级主题 */
  const outdent = useCallback(
    (id: string): void => {
      const store = useEditor.getState()
      const root = activeRoot(store.workbook)
      const parent = findParent(root, id)
      if (!parent) return

      // 已经是独立主题：Shift+Tab 放回结构（缺省挂回中心主题下）
      if (isRootDetached(root, id)) {
        commitInline()
        if (store.attachBackFromFloating(id)) onNotify('已放回结构，位置偏移已清除')
        focusRow(id)
        return
      }

      // 一级主题：Shift+Tab 脱离成独立主题（位置按画布旧坐标反算，视觉原地）
      if (parent.id === root.id) {
        const node = canvasLayoutNode(id)
        const rootNode = canvasLayoutNode(root.id)
        const position =
          node && rootNode ? { x: node.x - rootNode.x, y: node.y - rootNode.y } : undefined
        commitInline()
        if (store.detachToFloating(id, position)) {
          onNotify('已变为独立主题；右键「放回结构」可回到树里')
        }
        focusRow(id)
        return
      }
      const grand = findParent(root, parent.id)
      if (!grand) return
      const parentIndex = grand.children.findIndex((child) => child.id === parent.id)
      commitInline()
      store.moveNode(id, grand.id, parentIndex + 1)
      focusRow(id)
    },
    [commitInline, focusRow, onNotify]
  )

  const navigateRow = useCallback(
    (id: string, delta: number): void => {
      const index = rows.findIndex((row) => row.id === id)
      const next = rows[index + delta]
      if (index < 0 || !next) return
      commitInline()
      useEditor.getState().select(next.id)
      focusRow(next.id)
    },
    [rows, commitInline, focusRow]
  )

  /** 画布上换了选择时，把大纲滚到对应行（只滚动，不抢焦点，免得打断画布编辑） */
  useEffect(() => {
    if (!selectedId) return
    rowElement(selectedId)?.scrollIntoView({ block: 'nearest' })
  }, [selectedId, rows])

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // 输入法组词中的按键交还输入法
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    const target = (event.target as HTMLElement).closest('[data-outline-id]') as HTMLElement | null
    const id = target?.dataset['outlineId']
    if (!id) return

    const store = useEditor.getState()
    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault()
        navigateRow(id, -1)
        break
      case 'ArrowDown':
        event.preventDefault()
        navigateRow(id, 1)
        break
      case 'Enter':
        event.preventDefault()
        createSiblingOf(id)
        break
      case 'Tab':
        event.preventDefault()
        if (event.shiftKey) outdent(id)
        else indent(id)
        break
      case 'F2':
        event.preventDefault()
        startEdit(id)
        break
      case 'Delete':
      case 'Backspace':
        event.preventDefault()
        store.select(id)
        store.deleteSelection()
        break
      case ' ':
        event.preventDefault()
        store.toggleCollapse(id)
        break
      default:
        break
    }
  }

  const onEditorKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    const id = editingId
    if (event.key === 'Enter') {
      event.preventDefault()
      commitInline()
      if (id) createSiblingOf(id)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      commitInline()
      if (!id) return
      if (event.shiftKey) outdent(id)
      else indent(id)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setEditingId(null)
    }
  }

  const exportOutline = async (format: OutlineFormat): Promise<void> => {
    commitInline()
    try {
      const path = await window.api.exportOutline(useEditor.getState().workbook, format)
      if (path) onNotify(`已导出大纲：${path}`)
    } catch (error) {
      onNotify(`导出失败：${(error as Error).message}`)
    }
  }

  const activeFormatLabel = OUTLINE_FORMATS.map((item) => item.label).join(' / ')

  return (
    <div className="outline-panel">
      <div className="outline-panel__header">
        <span className="outline-panel__title">
          <ListTree size={15} /> 大纲
        </span>
        <div
          className="outline-panel__exports"
          title={`导出当前画布的大纲（${activeFormatLabel}）`}
        >
          {OUTLINE_FORMATS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="outline-export-btn"
              title={`导出为 ${item.label}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void exportOutline(item.id)}
            >
              {item.id === 'opml' ? <FileText size={12} /> : null}
              {item.id.toUpperCase()}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="tool-btn"
          title="关闭大纲"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            commitInline()
            onClose()
          }}
        >
          <X size={16} />
        </button>
      </div>

      <div className="outline-panel__list" ref={listRef} onKeyDown={onListKeyDown}>
        {rows.map((row) => {
          const selected = row.id === selectedId
          return (
            <div
              key={row.id}
              className={selected ? 'outline-row outline-row--selected' : 'outline-row'}
              data-outline-id={row.id}
              tabIndex={0}
              style={{ paddingLeft: 6 + row.depth * 16 }}
              onMouseDown={(event) => {
                // 点在任何位置都先选中；点箭头只做展开/折叠
                if ((event.target as HTMLElement).closest('.outline-row__toggle')) return
                if (editingId !== row.id) commitInline()
                useEditor.getState().select(row.id)
              }}
              onDoubleClick={() => startEdit(row.id)}
            >
              {row.hasChildren ? (
                <button
                  type="button"
                  className={
                    row.collapsed
                      ? 'outline-row__toggle'
                      : 'outline-row__toggle outline-row__toggle--open'
                  }
                  title={row.collapsed ? '展开' : '折叠'}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => useEditor.getState().toggleCollapse(row.id)}
                >
                  <ChevronRight size={13} />
                </button>
              ) : (
                <span className="outline-row__toggle outline-row__toggle--empty" />
              )}

              {editingId === row.id ? (
                <input
                  className="outline-row__editor"
                  autoFocus
                  value={draft}
                  placeholder="输入主题文字"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onEditorKeyDown}
                  onBlur={commitInline}
                />
              ) : (
                <span className="outline-row__text" title={row.title}>
                  {row.title.length > 0 ? (
                    row.title
                  ) : (
                    <em className="outline-row__empty">（空主题）</em>
                  )}
                </span>
              )}

              <span className="outline-row__badges">
                {row.markerCount > 0 && (
                  <span className="outline-badge" title={`${row.markerCount} 个标记图标`}>
                    {row.markerCount > 1 ? row.markerCount : ''}★
                  </span>
                )}
                {row.labelCount > 0 && (
                  <span className="outline-badge" title={`${row.labelCount} 个标签`}>
                    <Tag size={11} />
                  </span>
                )}
                {row.hasNotes && (
                  <span className="outline-badge" title="有备注">
                    <StickyNote size={11} />
                  </span>
                )}
                {row.hasLink && (
                  <span className="outline-badge" title="有超链接">
                    <Link2 size={11} />
                  </span>
                )}
                {row.hasAttachment && (
                  <span className="outline-badge" title="有附件">
                    <Paperclip size={11} />
                  </span>
                )}
                {row.hasImage && (
                  <span className="outline-badge" title="有图片">
                    <ImageIcon size={11} />
                  </span>
                )}
                {row.hasFormula && (
                  <span className="outline-badge" title="有公式">
                    <Sigma size={11} />
                  </span>
                )}
              </span>
            </div>
          )
        })}
      </div>

      <div className="outline-panel__hint">
        <b>Enter</b> 新建同级 · <b>Tab</b> 降级 · <b>Shift+Tab</b> 升级 · <b>双击</b> 改文字 ·{' '}
        <b>空格</b> 折叠 · <b>Delete</b> 删除
        <br />
        大纲与导图共用同一份数据，改哪边另一边都会立刻跟着变。
      </div>
    </div>
  )
}
