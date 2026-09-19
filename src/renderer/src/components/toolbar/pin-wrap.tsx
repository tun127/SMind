/**
 * 快捷栏按钮的「收纳」外壳（自 Toolbar.tsx 原样搬出，代码未改）：**右键**弹出「收进更多 ▾」。
 *
 * 被收纳的功能从快捷栏消失、出现在「更多 ▾」菜单里，行尾有
 * 「移回快捷栏」按钮——收纳状态持久化在设置里（toolbarHidden）。
 */

import { PinOff } from 'lucide-react'
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  title: string
  /**
   * 补充说明（例如"为什么这个按钮现在点不了"）。
   * 必须挂在外层 span 上：**禁用状态的 button 不弹 title**，
   * 挂在按钮上等于用户永远看不到。
   */
  hint?: string
  /** false＝已收进「更多 ▾」，不占快捷栏的位置 */
  shown: boolean
  /** 右键「收进更多 ▾」的统一收尾（快捷项与「拿出」的菜单项动作不同，由调用方决定） */
  onHide(): void
  children: ReactNode
}

export default function PinWrap({
  title,
  hint,
  shown,
  onHide,
  children
}: Props): ReactElement | null {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menu) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target && listRef.current?.contains(target)) return
      setMenu(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  // 被收纳的功能不占快捷栏的位置（它活在「更多 ▾」里）
  if (!shown) return null

  return (
    <span
      className="tool-btn-wrap"
      title={`${hint ?? title}（右键可收进「更多 ▾」）`}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      {children}
      {menu
        ? createPortal(
            <div
              ref={listRef}
              className="tool-menu__list"
              style={{ position: 'fixed', top: menu.y, left: menu.x }}
            >
              <button
                type="button"
                className="tool-menu__item"
                onClick={() => {
                  onHide()
                  setMenu(null)
                }}
              >
                <span className="tool-menu__icon">
                  <PinOff size={15} />
                </span>
                <span className="tool-menu__text">
                  收进「更多 ▾」
                  <em className="tool-menu__hint">可随时移回快捷栏</em>
                </span>
              </button>
            </div>,
            document.body
          )
        : null}
    </span>
  )
}
