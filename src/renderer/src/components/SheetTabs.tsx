import { useState, type ReactElement } from 'react'
import { Plus, X } from 'lucide-react'
import { countTopics } from '@shared/model/tree'
import { useEditor } from '../store/editor'

interface Props {
  onNotify(message: string): void
}

/**
 * 画布（工作表）标签栏。
 * 切换画布不写撤销历史；新建 / 改名 / 删除才动内容，可以 Ctrl+Z 撤回。
 */
export default function SheetTabs({ onNotify }: Props): ReactElement {
  const workbook = useEditor((s) => s.workbook)
  const setActiveSheet = useEditor((s) => s.setActiveSheet)
  const addSheet = useEditor((s) => s.addSheet)
  const removeSheet = useEditor((s) => s.removeSheet)
  const renameSheet = useEditor((s) => s.renameSheet)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const commitRename = (): void => {
    if (!editingId) return
    const id = editingId
    const title = draft.trim()
    setEditingId(null)
    const sheet = workbook.sheets.find((item) => item.id === id)
    if (!sheet || title.length === 0 || sheet.title === title) return
    renameSheet(id, title)
  }

  return (
    <div className="sheet-tabs">
      {workbook.sheets.map((sheet) => {
        const active = sheet.id === workbook.activeSheetId
        return (
          <div key={sheet.id} className={active ? 'sheet-tab sheet-tab--active' : 'sheet-tab'}>
            {editingId === sheet.id ? (
              <input
                className="sheet-tab__input"
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return
                  if (event.key === 'Enter') commitRename()
                  else if (event.key === 'Escape') setEditingId(null)
                }}
              />
            ) : (
              <button
                type="button"
                className="sheet-tab__name"
                title={`${sheet.title}（${countTopics(sheet.rootTopic)} 个主题，双击可改名）`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setActiveSheet(sheet.id)}
                onDoubleClick={() => {
                  setEditingId(sheet.id)
                  setDraft(sheet.title)
                }}
              >
                {sheet.title}
              </button>
            )}

            {workbook.sheets.length > 1 && (
              <button
                type="button"
                className="sheet-tab__close"
                title="删除这张画布（可 Ctrl+Z 撤回）"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  removeSheet(sheet.id)
                  onNotify(`已删除画布《${sheet.title}》，可用 Ctrl+Z 撤回`)
                }}
              >
                <X size={11} />
              </button>
            )}
          </div>
        )
      })}

      <button
        type="button"
        className="sheet-tab sheet-tab--add"
        title="新建画布"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          addSheet()
          onNotify('已新建画布')
        }}
      >
        <Plus size={13} />
      </button>
    </div>
  )
}
