import { useDeck } from '../store'
import { useT } from '../i18n'

/** Background failures use the log, journal or banner so their visibility is not time-limited. */
export function Toast(): React.JSX.Element | null {
  const t = useT()
  const toast = useDeck((s) => s.toast)
  const variant = useDeck((s) => s.toastVariant)
  const raw = useDeck((s) => s.toastRaw)
  const action = useDeck((s) => s.toastAction)
  const params = useDeck((s) => s.toastParams)
  const dismiss = useDeck((s) => s.dismissToast)
  if (!toast) return null
  return (
    <div className={`toast toast-${variant}`} role={variant === 'error' ? 'alert' : 'status'} onClick={dismiss}>
      <span>{raw ? toast : t(toast, params ?? undefined)}</span>
      {action && <button className="toast-action" onClick={action.onClick}>{t(action.label)}</button>}
    </div>
  )
}
