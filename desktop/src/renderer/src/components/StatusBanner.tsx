import { useDeck } from '../store'
import { useT } from '../i18n'
import { GLYPH_BADGES } from './icons'

/**
 * Persistent full-width banner at the top of the window (PLAN O5): shown while
 * a broker state degrades what the operator can do. Disappears on its own when
 * the state clears. Deliberately a banner and not a toast: an outage is a
 * STATE, not an event.
 *
 * Two states, exclusive by construction so the fixed overlay never stacks two
 * bars over the window:
 *
 * - the local broker is unreachable — red, blocking: announces, the operator
 *   inbox and graph drafts are all degraded;
 * - the local broker is a replica whose UPSTREAM is unreachable — info tone,
 *   not an error: every local agent keeps working, the roadmap keeps being
 *   written, and the pending changes leave as soon as the link returns. Only
 *   the sharing with the other machines is paused, so painting this red would
 *   claim a breakage that is not one.
 */
export function StatusBanner(): React.JSX.Element | null {
  const t = useT()
  const status = useDeck((s) => s.brokerStatus)
  const dismissed = useDeck((s) => s.offlineBannerDismissed)
  const dismiss = useDeck((s) => s.dismissOfflineBanner)
  const sync = useDeck((s) => s.roadmapSync.status)

  const brokerDown = status !== null && !status.up
  // Dismiss is per-outage: hiding this outage's banner must not hide the next
  // one's (a new outage carries a new `since`). The NavRail red dot stays as
  // the residual indicator while hidden.
  if (brokerDown && dismissed !== status.since) {
    const since = new Date(status.since).toLocaleTimeString()
    return (
      <div className="status-banner status-banner-error" role="alert">
        <span className="status-banner-text" title={status.lastError ?? undefined}>
          {GLYPH_BADGES.warning} {t('banner.brokerDown', { time: since })}
          {status.lastError ? (
            <span className="status-banner-detail"> — {status.lastError}</span>
          ) : null}
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

  // The local broker answers; only its upstream does not. No Retry: the
  // replication loop re-arms itself, and a button that cannot shorten the
  // outage would only invite the operator to press it.
  if (!brokerDown && sync.mode === 'replica' && sync.online === false) {
    return (
      <div className="status-banner status-banner-info" role="status">
        <span className="status-banner-text" title={sync.upstream_url}>
          {GLYPH_BADGES.beacon} {t('banner.replicaOffline', { count: sync.pending_push ?? 0 })}
        </span>
      </div>
    )
  }

  return null
}
