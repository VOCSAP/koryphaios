// Generic bottom sheet (PLAN MB3): the mobile substitute for context menus
// and small dialogs. Tap the backdrop or the grab handle to dismiss; the
// panel stops propagation like every canvas overlay in the app.

export function MobileSheet({
  onClose,
  title,
  children
}: {
  onClose: () => void
  title?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="msheet-backdrop" onMouseDown={onClose} onTouchStart={onClose}>
      <div
        className="msheet"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        <div className="msheet-handle" onClick={onClose} />
        {title && <div className="msheet-title">{title}</div>}
        {children}
      </div>
    </div>
  )
}
