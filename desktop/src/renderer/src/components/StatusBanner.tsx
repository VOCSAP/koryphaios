import { useDeck } from '../store'
import { useT } from '../i18n'
import { GLYPH_BADGES } from './icons'

/**
 * Persistent full-width red banner at the top of the window (PLAN O5): shown
 * while the broker is unreachable so the operator sees the outage at a glance
 * (announces, operator inbox and graph drafts are all degraded meanwhile).
 * Disappears on its own when the broker comes back. Deliberately a banner and
 * not a toast: an outage is a STATE, not an event.
 *
 * Kept generic (banner + optional action) so future blocking states can reuse
 * the .status-banner primitive.
 */
export function StatusBanner(): React.JSX.Element | null {
  const t = useT()
  const status = useDeck((s) => s.brokerStatus)
  const dismissed = useDeck((s) => s.offlineBannerDismissed)
  const dismiss = useDeck((s) => s.dismissOfflineBanner)
  if (!status || status.up) return null
  // Dismiss is per-outage: hiding this outage's banner must not hide the next
  // one's (a new outage carries a new `since`). The NavRail red dot stays as
  // the residual indicator while hidden.
  if (dismissed === status.since) return null
  const since = new Date(status.since).toLocaleTimeString()
  return (
    <div className="status-banner status-banner-error" role="alert">
      <span className="status-banner-text" title={status.lastError ?? undefined}>
        {GLYPH_BADGES.warning} {t('banner.brokerDown', { time: since })}
        {status.lastError ? <span className="status-banner-detail"> — {status.lastError}</span> : null}
      </span>
      <button className="status-banner-action" onClick={() => void window.api.retryBroker()}>
        {t('banner.retry')}
      </button>
      <button className="status-banner-action" onClick={dismiss}>
        {t('banner.dismiss')}
      </button>
    </div>
  )
}
