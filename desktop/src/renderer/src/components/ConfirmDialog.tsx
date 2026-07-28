import { useT } from '../i18n'

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  tone = 'danger',
  onConfirm,
  onCancel
}: {
  title: string
  message: string
  confirmLabel?: string
  // 'danger' (default) keeps every existing call site's red destructive
  // confirm button unchanged. 'neutral' is for confirmations that are
  // reversible / delete nothing (e.g. clearing a queue) -- it reuses the
  // plain .primary blue accept/validate archetype (DESIGN.md section 2)
  // instead of inventing a new colour, so it needs no styles.css change.
  tone?: 'danger' | 'neutral'
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal modal-confirm" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p className="confirm-msg">{message}</p>
        <div className="modal-actions">
          <button onClick={onCancel}>{t('common.cancel')}</button>
          <button
            className={tone === 'neutral' ? 'primary' : 'primary danger'}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel ?? t('common.delete')}
          </button>
        </div>
      </div>
    </div>
  )
}
