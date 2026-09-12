import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Download, Plus, Trash2, Upload, X } from 'lucide-react'
import type { ThemeColors } from '@shared/model/types'
import { activeSheet } from '@shared/model/tree'
import {
  BUILTIN_THEMES,
  DEFAULT_THEME,
  deriveCustomTheme,
  themeNameOf,
  type ThemeDefinition
} from '@shared/theme'
import { themeColorsOf, useEditor } from '../store/editor'

const COLOR_FIELDS: Array<{ key: keyof ThemeColors; label: string }> = [
  { key: 'canvas', label: '画布背景' },
  { key: 'grid', label: '网格点' },
  { key: 'rootFill', label: '中心主题底色' },
  { key: 'rootText', label: '中心主题文字' },
  { key: 'level1Fill', label: '一级主题底色' },
  { key: 'level1Text', label: '一级主题文字' },
  { key: 'deepText', label: '深层文字' }
]

interface Props {
  onClose(): void
  onNotify(message: string): void
}

export default function ThemePanel({ onClose, onNotify }: Props): ReactElement {
  const workbook = useEditor((s) => s.workbook)
  const applyTheme = useEditor((s) => s.applyTheme)
  const updateThemeColors = useEditor((s) => s.updateThemeColors)

  const colors = useMemo(() => themeColorsOf(workbook), [workbook])
  const sheet = activeSheet(workbook)
  const currentId = sheet.theme?.id ?? DEFAULT_THEME.id
  const currentName = themeNameOf(sheet.theme)

  const [customThemes, setCustomThemes] = useState<ThemeDefinition[]>([])
  const [newName, setNewName] = useState('')

  const refreshCustom = async (): Promise<void> => {
    try {
      setCustomThemes(await window.api.themesList())
    } catch {
      setCustomThemes([])
    }
  }

  useEffect(() => {
    void refreshCustom()
  }, [])

  const currentTheme: ThemeDefinition = { id: currentId, name: currentName, builtin: false, colors }

  const handleSaveCustom = async (): Promise<void> => {
    const name = newName.trim() || `${currentName} 副本`
    try {
      await window.api.themesSave(deriveCustomTheme(currentTheme, name, `custom-${Date.now().toString(36)}`))
      await refreshCustom()
      setNewName('')
      onNotify(`已保存主题「${name}」`)
    } catch (error) {
      onNotify(`保存主题失败：${(error as Error).message}`)
    }
  }

  const handleDelete = async (id: string): Promise<void> => {
    try {
      await window.api.themesDelete(id)
      await refreshCustom()
      onNotify('已删除该主题')
    } catch (error) {
      onNotify(`删除失败：${(error as Error).message}`)
    }
  }

  const handleImport = async (): Promise<void> => {
    try {
      const theme = await window.api.themesImport()
      if (!theme) return
      await window.api.themesSave(theme)
      await refreshCustom()
      onNotify(`已导入主题「${theme.name}」`)
    } catch (error) {
      onNotify(`导入失败：${(error as Error).message}`)
    }
  }

  const handleExport = async (): Promise<void> => {
    try {
      if (await window.api.themesExport(currentTheme)) onNotify('主题已导出')
    } catch (error) {
      onNotify(`导出失败：${(error as Error).message}`)
    }
  }

  /** 调色时用 coalesceKey，把连续拖动合并成一步撤销 */
  const setBranch = (index: number, value: string): void => {
    const next = [...colors.branches]
    next[index] = value
    updateThemeColors({ branches: next }, `theme-branch-${index}`)
  }

  return (
    <div className="side-panel">
      <div className="side-panel__header">
        <span>主题</span>
        <button type="button" className="tool-btn" title="关闭" onMouseDown={(e) => e.preventDefault()} onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      <div className="side-panel__body">
        <div className="side-panel__section">
          <div className="side-panel__title">内置主题</div>
          <div className="theme-grid">
            {BUILTIN_THEMES.map((item) => (
              <ThemeCard
                key={item.id}
                theme={item}
                active={item.id === currentId}
                onApply={() => applyTheme(item)}
              />
            ))}
          </div>
        </div>

        <div className="side-panel__section">
          <div className="side-panel__title">我的主题</div>
          {customThemes.length === 0 ? (
            <div className="side-panel__empty">还没有自定义主题。调整下面的配色后点「保存为我的主题」。</div>
          ) : (
            <div className="theme-grid">
              {customThemes.map((item) => (
                <ThemeCard
                  key={item.id}
                  theme={item}
                  active={item.id === currentId}
                  onApply={() => applyTheme(item)}
                  onDelete={() => void handleDelete(item.id)}
                />
              ))}
            </div>
          )}
          <div className="side-panel__row">
            <input
              className="input"
              placeholder="新主题名称"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <button type="button" className="btn btn--primary" onClick={() => void handleSaveCustom()}>
              保存为我的主题
            </button>
          </div>
        </div>

        <div className="side-panel__section">
          <div className="side-panel__title">微调当前配色</div>
          <div className="theme-colors">
            {COLOR_FIELDS.map((field) => (
              <label key={field.key} className="theme-color-row">
                <span>{field.label}</span>
                <input
                  type="color"
                  value={String(colors[field.key])}
                  onChange={(event) =>
                    updateThemeColors(
                      { [field.key]: event.target.value } as Partial<ThemeColors>,
                      `theme-${field.key}`
                    )
                  }
                />
              </label>
            ))}
          </div>

          <div className="theme-color-row">
            <span>连线粗细</span>
            <input
              type="range"
              min={0.5}
              max={6}
              step={0.1}
              value={colors.edgeWidth}
              onChange={(event) => updateThemeColors({ edgeWidth: Number(event.target.value) }, 'theme-edgeWidth')}
            />
            <em>{colors.edgeWidth.toFixed(1)}</em>
          </div>

          <div className="theme-color-row">
            <span>连线浓淡</span>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={colors.edgeOpacity}
              onChange={(event) => updateThemeColors({ edgeOpacity: Number(event.target.value) }, 'theme-edgeOpacity')}
            />
            <em>{Math.round(colors.edgeOpacity * 100)}%</em>
          </div>

          <div className="side-panel__title side-panel__title--sub">分支配色</div>
          <div className="theme-branches">
            {colors.branches.map((color, index) => (
              <div key={index} className="theme-branch">
                <input type="color" value={color} onChange={(event) => setBranch(index, event.target.value)} />
                {colors.branches.length > 1 && (
                  <button
                    type="button"
                    className="theme-branch__del"
                    title="移除这个颜色"
                    onClick={() => updateThemeColors({ branches: colors.branches.filter((_, i) => i !== index) })}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              className="theme-branch-add"
              title="增加一个分支配色"
              onClick={() => updateThemeColors({ branches: [...colors.branches, '#8b93a1'] })}
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
      </div>

      <div className="side-panel__footer">
        <button type="button" className="btn" onClick={() => void handleImport()}>
          <Upload size={14} />
          导入
        </button>
        <button type="button" className="btn" onClick={() => void handleExport()}>
          <Download size={14} />
          导出
        </button>
        <button type="button" className="btn" onClick={() => applyTheme(DEFAULT_THEME)}>
          恢复默认
        </button>
      </div>
    </div>
  )
}

interface CardProps {
  theme: ThemeDefinition
  active: boolean
  onApply(): void
  onDelete?(): void
}

function ThemeCard({ theme, active, onApply, onDelete }: CardProps): ReactElement {
  const swatches = theme.colors.branches
  return (
    <div
      className={active ? 'theme-card theme-card--active' : 'theme-card'}
      role="button"
      tabIndex={0}
      onClick={onApply}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onApply()
      }}
    >
      <div className="theme-card__preview" style={{ background: theme.colors.canvas }}>
        <span className="theme-card__root" style={{ background: theme.colors.rootFill }} />
        <span className="theme-card__line" style={{ background: swatches[0] ?? theme.colors.rootFill }} />
        <span className="theme-card__dot" style={{ background: swatches[1] ?? theme.colors.rootFill }} />
        <span className="theme-card__dot" style={{ background: swatches[2] ?? theme.colors.rootFill }} />
      </div>
      <div className="theme-card__name">{theme.name}</div>
      {onDelete && (
        <button
          type="button"
          className="theme-card__del"
          title="删除这个主题"
          onClick={(event) => {
            event.stopPropagation()
            onDelete()
          }}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  )
}
