/**
 * 工具栏上的下拉菜单（自 Toolbar.tsx 原样搬出，代码未改）。
 *
 * 菜单渲染在 **document.body 的传送门**里，而不是按钮旁边：
 * 工具栏是横排容器（窗口变窄时会换行/滚动），绝对定位的菜单会被它裁掉——
 * 之前「点 AI 没反应」就是这个原因。用传送门 + fixed 定位后不再受任何祖先容器影响。
 */

import { ChevronDown, Pin, PinOff } from 'lucide-react'
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  icon: ReactNode
  label: string
  title: string
  items: Array<{
    key: string
    label: string
    hint?: string
    icon?: ReactNode
    onSelect(): void
    /** 提供时在行尾显示「移回快捷栏」小按钮（收纳进来的功能用） */
    onUnpin?(): void
    /** 提供时在行尾显示「拿出到快捷栏」小按钮（还在「更多」里的功能用） */
    onTakeOut?(): void
  }>
  iconOnly?: boolean
}

export default function ToolMenu({
  icon,
  label,
  title,
  items,
  iconOnly = false
}: Props): ReactElement {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const open = position !== null

  const openMenu = (): void => {
    const el = buttonRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const width = 236
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    // 下方放不下就往上弹（菜单高度按固定值估算，条目数是动态的，不参与判断）
    const estimatedHeight = 60
    const top =
      rect.bottom + 6 + estimatedHeight > window.innerHeight - 8 && rect.top > 240
        ? Math.max(8, rect.top - 6 - 300)
        : rect.bottom + 6
    setPosition({ top, left })
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target && (listRef.current?.contains(target) || buttonRef.current?.contains(target)))
        return
      setPosition(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPosition(null)
    }
    // 滚动/改窗口大小后按钮位置会变，直接收起最省心
    const onScrollOrResize = (): void => setPosition(null)

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onScrollOrResize)
    window.addEventListener('scroll', onScrollOrResize, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onScrollOrResize)
      window.removeEventListener('scroll', onScrollOrResize, true)
    }
  }, [open])

  const menu = (
    <div
      ref={listRef}
      className="tool-menu__list"
      style={{ position: 'fixed', top: position?.top ?? 0, left: position?.left ?? 0 }}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className="tool-menu__item"
          title={item.hint}
          onClick={() => {
            setPosition(null)
            item.onSelect()
          }}
        >
          <span className="tool-menu__icon">{item.icon}</span>
          <span className="tool-menu__text">
            {item.label}
            {item.hint ? <em className="tool-menu__hint">{item.hint}</em> : null}
          </span>
          {item.onUnpin ? (
            <span
              className="tool-menu__pin"
              title="移回快捷栏"
              onClick={(event) => {
                event.stopPropagation()
                item.onUnpin?.()
                setPosition(null)
              }}
            >
              <PinOff size={13} />
            </span>
          ) : null}
          {item.onUnpin ? null : item.onTakeOut ? (
            <span
              className="tool-menu__pin"
              title="拿出到快捷栏"
              onClick={(event) => {
                event.stopPropagation()
                item.onTakeOut?.()
                setPosition(null)
              }}
            >
              <Pin size={13} />
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )

  return (
    <span className="tool-menu">
      <button
        ref={buttonRef}
        type="button"
        className={['tool-btn', iconOnly ? '' : 'tool-btn--labeled', open ? 'tool-btn--active' : '']
          .filter(Boolean)
          .join(' ')}
        title={title}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (open) setPosition(null)
          else openMenu()
        }}
      >
        {icon}
        {iconOnly ? null : label}
        {iconOnly ? null : <ChevronDown size={13} />}
      </button>

      {open && position ? createPortal(menu, document.body) : null}
    </span>
  )
}
