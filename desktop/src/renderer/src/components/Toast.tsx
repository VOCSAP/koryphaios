import { useDeck } from '../store'
import { useT } from '../i18n'

/**
 * Bottom-of-window transient status message. `toast` holds an i18n key, or raw
 * text (an error message) when `toastRaw` is set. Policy (PLAN O5): toasts are
 * for the outcome of a direct user action only -- background failures go to
 * the log/journal/banner, never here.
 */
export function Toast(): React.JSX.Element | null {
  const t = useT()
  const toast = useDeck((s) => s.toast)
  const variant = useDeck((s) => s.toastVariant)
  const raw = useDeck((s) => s.toastRaw)
  const params = useDeck((s) => s.toastParams)
  if (!toast) return null
  return (
    <div className={`toast toast-${variant}`} role={variant === 'error' ? 'alert' : 'status'}>
      {raw ? toast : t(toast, params ?? undefined)}
    </div>
  )
}
