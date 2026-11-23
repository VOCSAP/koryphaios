import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface ContextMenuItem {
  /** Item content: plain text or JSX (e.g. a glyph + text, DESIGN.md §5). */
  label: React.ReactNode
  onSelect: () => void
  /** Greyed out + non-clickable when true. */
  disabled?: boolean
  /** Paint the label in the danger colour. */
  danger?: boolean
  /** A second, smaller line under the label; stays legible on a disabled item, unlike a title. */
  hint?: React.ReactNode
}

export interface ContextMenuSeparator {
  separator: true
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator

const EDGE = 8

/**
 * A minimal right-click menu anchored at viewport coordinates (x, y). A
 * transparent full-screen backdrop captures the next click/contextmenu to close
 * it; Escape closes it too. Built generic so new items can be added later
 * without touching the call sites' wiring -- just append to `items`.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: ContextMenuEntry[]
  onClose: () => void
}): React.JSX.Element {
  const menuRef = useRef<HTMLUListElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Opened near the bottom or right edge, the menu is pulled back inside the
  // viewport before paint, or its last entries are cut off.
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const left = Math.max(EDGE, Math.min(x, window.innerWidth - r.width - EDGE))
    const top = Math.max(EDGE, Math.min(y, window.innerHeight - r.height - EDGE))
    setPos((p) => (p.left === left && p.top === top ? p : { left, top }))
  }, [x, y, items])

  return (
    <div
      className="context-menu-backdrop"
      // stopPropagation so closing the menu does not also select/trigger the
      // row this menu is rendered inside.
      onMouseDown={(e) => {
        e.stopPropagation()
        onClose()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }}
    >
      <ul
        ref={menuRef}
        className="context-menu"
        style={{ left: pos.left, top: pos.top }}
        role="menu"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {items.map((it, i) =>
          'separator' in it ? (
            <li key={i} role="separator" className="context-menu-sep" />
          ) : (
            <li key={i} role="none">
              <button
                type="button"
                role="menuitem"
                className={`context-menu-item${it.danger ? ' context-menu-item-danger' : ''}`}
                disabled={it.disabled}
                onClick={(e) => {
                  e.stopPropagation()
                  if (it.disabled) return
                  it.onSelect()
                  onClose()
                }}
              >
                {it.label}
                {it.hint && <span className="context-menu-hint">{it.hint}</span>}
              </button>
            </li>
          )
        )}
      </ul>
    </div>
  )
}
