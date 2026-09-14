import { useEffect, useRef, useState, type MouseEvent, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Eraser,
  Italic,
  List,
  RotateCcw,
  Strikethrough,
  Subscript as SubscriptIcon,
  Superscript as SuperscriptIcon,
  Settings2,
  Underline
} from 'lucide-react'
import { useFormatStore, type RichEditor } from '../editor/formatStore'
import { patchAppSettings, useEditor } from '../store/editor'
import type { AppSettings } from '@shared/ipc'

/** 默认字体下拉的可选项（null＝跟随主题） */
const FONT_OPTIONS: Array<{ label: string; value: string | null }> = [
  { label: '跟随主题', value: null },
  { label: '微软雅黑', value: '微软雅黑' },
  { label: '宋体', value: '宋体' },
  { label: '黑体', value: '黑体' },
  { label: '楷体', value: '楷体' },
  { label: '仿宋', value: '仿宋' },
  { label: '等线', value: '等线' },
  { label: 'Arial', value: 'Arial' },
  { label: 'Segoe UI', value: 'Segoe UI' },
  { label: 'Times New Roman', value: 'Times New Roman' },
  { label: 'Courier New', value: 'Courier New' }
]

const FONT_SIZES = [12, 13, 14, 15, 16, 18, 19, 22, 28]
const DEFAULT_COLORS = [
  '#1f2328',
  '#EB5757',
  '#F2994A',
  '#E2B93B',
  '#27AE60',
  '#2D9CDB',
  '#2F6BFF',
  '#9B51E0'
]

/**
 * 「默认样式」面板：在这里选的字体 / 字号 / 颜色 / 对齐就是**全局默认**——
 * 之后新建的节点（新建子主题、AI 生成、粘贴）都长这样；
 * 也可以一键把当前格式存为默认，或把默认样式刷到全部现有节点上。
 */
function DefaultStylePanel({
  settings,
  onRenderDefaultsChanged,
  onClose,
  anchor
}: {
  settings: AppSettings
  onRenderDefaultsChanged(): void
  onClose(): void
  anchor: { top: number; left: number }
}): ReactElement {
  const editor = useFormatStore((store) => store.editor)

  const patch = (values: Partial<AppSettings>): void => {
    void patchAppSettings(values).then(onRenderDefaultsChanged)
  }

  /** 把此刻选区上的格式（字号/颜色/对齐）存为默认 */
  const useCurrentAsDefault = (): void => {
    if (!editor) return
    const attributes = editor.getAttributes('textStyle') as { color?: unknown; fontSize?: unknown }
    const size =
      typeof attributes.fontSize === 'string' ? Number.parseFloat(attributes.fontSize) : Number.NaN
    const align: AppSettings['defaultAlign'] = editor.isActive({ textAlign: 'left' })
      ? 'left'
      : editor.isActive({ textAlign: 'right' })
        ? 'right'
        : 'center'
    void patchAppSettings({
      defaultFontSize: Number.isFinite(size) && size > 0 ? size : null,
      defaultColor: typeof attributes.color === 'string' ? attributes.color : null,
      defaultAlign: align
    }).then(onRenderDefaultsChanged)
    onClose()
  }

  /** 把当前默认样式刷到全部现有节点（一步撤销） */
  const applyToAll = (): void => {
    useEditor.getState().applyDefaultsToAll()
    onClose()
  }

  return createPortal(
    <div
      className="default-style"
      style={{ position: 'fixed', top: anchor.top, left: anchor.left }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="default-style__row">
        <span className="default-style__label">字体</span>
        <select
          className="select"
          value={settings.defaultFontFamily ?? ''}
          onChange={(e) => patch({ defaultFontFamily: e.target.value || null })}
        >
          {FONT_OPTIONS.map((option) => (
            <option key={option.label} value={option.value ?? ''}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="default-style__label">字号</span>
        <select
          className="select"
          value={settings.defaultFontSize ?? ''}
          onChange={(e) => patch({ defaultFontSize: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">默认</option>
          {FONT_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </div>

      <div className="default-style__row">
        <span className="default-style__label">颜色</span>
        <button
          type="button"
          className={!settings.defaultColor ? 'color-dot color-dot--active' : 'color-dot'}
          style={{ background: 'linear-gradient(135deg, #bbb 45%, #f66 55%)' }}
          title="跟随主题"
          onClick={() => patch({ defaultColor: null })}
        />
        {DEFAULT_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={settings.defaultColor === color ? 'color-dot color-dot--active' : 'color-dot'}
            style={{ background: color }}
            title={color}
            onClick={() => patch({ defaultColor: color })}
          />
        ))}
      </div>

      <div className="default-style__row">
        <span className="default-style__label">对齐</span>
        {(
          [
            ['left', <AlignLeft key="l" size={14} />],
            ['center', <AlignCenter key="c" size={14} />],
            ['right', <AlignRight key="r" size={14} />]
          ] as const
        ).map(([value, icon]) => (
          <button
            key={value}
            type="button"
            className={settings.defaultAlign === value ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
            onClick={() => patch({ defaultAlign: value })}
          >
            {icon}
          </button>
        ))}
        <span className="default-style__label">视角锁定默认</span>
        <button
          type="button"
          className={settings.defaultViewLock ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="新开文档时是否默认开启「视角锁定」"
          onClick={() => patch({ defaultViewLock: !settings.defaultViewLock })}
        >
          {settings.defaultViewLock ? '开' : '关'}
        </button>
      </div>

      <div className="default-style__row default-style__row--actions">
        <button type="button" className="btn" title="把此刻选区上的字号/颜色/对齐存为默认" onClick={useCurrentAsDefault}>
          用当前格式设为默认
        </button>
        <button type="button" className="btn" title="把默认字体/字号/颜色刷到这张图的所有节点（一步撤销）" onClick={applyToAll}>
          应用到全部现有节点
        </button>
        <button
          type="button"
          className="btn"
          title="清空默认字体/字号/颜色（对齐回到居中）"
          onClick={() => {
            void patchAppSettings({
              defaultFontFamily: null,
              defaultFontSize: null,
              defaultColor: null,
              defaultAlign: 'center'
            }).then(onRenderDefaultsChanged)
          }}
        >
          <RotateCcw size={13} /> 恢复默认
        </button>
      </div>
    </div>,
    document.body
  )
}

const COLORS = ['#1f2328', '#EB5757', '#F2994A', '#E2B93B', '#27AE60', '#2D9CDB', '#2F6BFF', '#9B51E0']
const SIZES = [12, 14, 16, 18, 22, 28]

type Chain = ReturnType<RichEditor['chain']>

interface Props {
  /** 「默认样式」里改了对齐等渲染兜底值后，让测量缓存失效（App 提供） */
  onRenderDefaultsChanged?(): void
}

/** 仅在进入编辑态时出现，作用于当前节点内的文本 */
export default function RichFormatBar({ onRenderDefaultsChanged }: Props): ReactElement | null {
  const editor = useFormatStore((store) => store.editor)
  const state = useFormatStore((store) => store.state)
  const settings = useEditor((s) => s.appSettings)

  const [styleAnchor, setStyleAnchor] = useState<{ top: number; left: number } | null>(null)
  const gearRef = useRef<HTMLButtonElement | null>(null)

  const openDefaultStyle = (): void => {
    const el = gearRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const width = 420
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    const top = rect.top > 320 ? Math.max(8, rect.top - 190) : rect.bottom + 6
    setStyleAnchor({ top, left })
  }

  // 只让按钮不抢焦点；下拉框必须保留默认行为才能展开
  const keepFocus = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement | null
    if (target && target.closest('button')) event.preventDefault()
  }

  if (!editor) return null

  /**
   * 行内格式（加粗/颜色/字号等）在「光标折叠、没有选中文字」时，
   * 只会影响接下来输入的字，用户会以为点了没反应。
   * 所以没有选区时先全选整个节点，应用后再把光标放回原处。
   */
  const applyInline = (run: (chain: Chain) => Chain): void => {
    const selection = editor.state.selection
    if (selection.empty) {
      const caret = selection.from
      run(editor.chain().focus().selectAll()).run()
      if (caret <= editor.state.doc.content.size) editor.commands.setTextSelection(caret)
    } else {
      run(editor.chain().focus()).run()
    }
  }

  /** 段落级格式（对齐、列表）直接作用于光标所在段落 */
  const chain = (): Chain => editor.chain().focus()

  /**
   * 上/下标是「一次性」格式：光标折叠（没选中文字）时**不能**像加粗那样全选整个节点——
   * 那会把整段文字都变成下标。正确做法是直接 toggle：设置/取消「接下来输入的格式」，
   * 打完上标再点一下（或光标贴着下标后面直接打字）就恢复正常。
   */
  const toggleScript = (mark: 'superscript' | 'subscript'): void => {
    editor.chain().focus().toggleMark(mark).run()
  }

  // 当前字号不在预设列表里时，补进选项，避免下拉框显示为空
  const sizeOptions =
    state.fontSize !== null && !SIZES.includes(state.fontSize)
      ? [...SIZES, state.fontSize].sort((a, b) => a - b)
      : SIZES

  /* 默认样式面板开着时，点面板以外的地方就收起 */
  useEffect(() => {
    if (!styleAnchor) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target && (gearRef.current?.contains(target) || (event.target as HTMLElement)?.closest?.('.default-style')))
        return
      setStyleAnchor(null)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [styleAnchor])

  return (
    <div className="formatbar" onMouseDown={keepFocus}>
      <div className="formatbar__group">
        <button
          type="button"
          className={state.bold ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="加粗（未选中文字时作用于整个节点）"
          onClick={() => applyInline((c) => c.toggleBold())}
        >
          <Bold size={15} />
        </button>
        <button
          type="button"
          className={state.italic ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="倾斜"
          onClick={() => applyInline((c) => c.toggleItalic())}
        >
          <Italic size={15} />
        </button>
        <button
          type="button"
          className={state.underline ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="下划线"
          onClick={() => applyInline((c) => c.toggleUnderline())}
        >
          <Underline size={15} />
        </button>
        <button
          type="button"
          className={state.strike ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="删除线"
          onClick={() => applyInline((c) => c.toggleStrike())}
        >
          <Strikethrough size={15} />
        </button>
        <button
          type="button"
          className={state.script === 'super' ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="上标（也可以打 ^x^，如 a^2^；再点一次恢复正常输入）"
          onClick={() => toggleScript('superscript')}
        >
          <SuperscriptIcon size={15} />
        </button>
        <button
          type="button"
          className={state.script === 'sub' ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="下标（也可以打 ~x~，如 a~1~；再点一次恢复正常输入）"
          onClick={() => toggleScript('subscript')}
        >
          <SubscriptIcon size={15} />
        </button>
      </div>

      <div className="formatbar__divider" />

      <div className="formatbar__group">
        <span className="formatbar__label">字号</span>
        <select
          className="fmt-select"
          value={state.fontSize ?? ''}
          onChange={(event) => {
            const value = event.target.value
            applyInline((c) => (value === '' ? c.unsetFontSize() : c.setFontSize(`${value}px`)))
          }}
        >
          <option value="">默认</option>
          {sizeOptions.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </div>

      <div className="formatbar__divider" />

      <div className="formatbar__group">
        <span className="formatbar__label">颜色</span>
        {COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={state.color === color ? 'color-dot color-dot--active' : 'color-dot'}
            style={{ background: color }}
            title={color}
            onClick={() => applyInline((c) => c.setColor(color))}
          />
        ))}
        <button
          type="button"
          className="fmt-btn"
          title="恢复默认颜色"
          onClick={() => applyInline((c) => c.unsetColor())}
        >
          <Eraser size={14} />
        </button>
      </div>

      <div className="formatbar__divider" />

      <div className="formatbar__group">
        <button
          type="button"
          className={state.align === 'left' ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="左对齐"
          onClick={() => chain().setTextAlign('left').run()}
        >
          <AlignLeft size={15} />
        </button>
        <button
          type="button"
          className={state.align === 'center' ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="居中"
          onClick={() => chain().setTextAlign('center').run()}
        >
          <AlignCenter size={15} />
        </button>
        <button
          type="button"
          className={state.align === 'right' ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="右对齐"
          onClick={() => chain().setTextAlign('right').run()}
        >
          <AlignRight size={15} />
        </button>
        <button
          type="button"
          className={state.bullet ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="项目符号"
          onClick={() => chain().toggleBulletList().run()}
        >
          <List size={15} />
        </button>
      </div>

      <div className="formatbar__divider" />

      {/* 默认样式：在这里配置的字体/字号/颜色/对齐对之后新建的节点全局生效 */}
      <div className="formatbar__group">
        <button
          ref={gearRef}
          type="button"
          className={styleAnchor ? 'fmt-btn fmt-btn--active' : 'fmt-btn'}
          title="默认样式：设置新建节点的默认字体 / 字号 / 颜色 / 对齐（全局生效）"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => (styleAnchor ? setStyleAnchor(null) : openDefaultStyle())}
        >
          <Settings2 size={15} />
          <span className="fmt-btn__text">默认</span>
        </button>
      </div>

      {styleAnchor && (
        <DefaultStylePanel
          settings={settings}
          onRenderDefaultsChanged={() => onRenderDefaultsChanged?.()}
          onClose={() => setStyleAnchor(null)}
          anchor={styleAnchor}
        />
      )}
    </div>
  )
}
