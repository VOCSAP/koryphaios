import { useEffect } from 'react'

export interface ContextMenuItem {
  /** Item content: plain text or JSX (e.g. a glyph + text, DESIGN.md §5). */
  label: React.ReactNode
  onSelect: () => void
  /** Greyed out + non-clickable when true. */
  disabled?: boolean
  /** Paint the label in the danger colour on hover. */
  danger?: boolean
}

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
  items: ContextMenuItem[]
  onClose: () => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
        className="context-menu"
        style={{ left: x, top: y }}
        role="menu"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {items.map((it, i) => (
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
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
