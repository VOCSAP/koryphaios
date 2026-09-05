import { bannerKind } from '@shared/status-banner'
import { roadmapConflictCount, useDeck } from '../store'
import { useT } from '../i18n'
import { GLYPH_BADGES } from './icons'

/**
 * Persistent full-width banner at the top of the window (PLAN O5): shown while
 * a broker state degrades what the operator can do. Disappears on its own when
 * the state clears. Deliberately a banner and not a toast: an outage is a
 * STATE, not an event.
 *
 * Four states, ONE bar: the banner is a fixed overlay, so two of them would
 * stack over the window. Which one wins is `bannerKind` in `@shared`, pure and
 * unit-tested, because the states genuinely overlap — an upstream that comes
 * back replaces the offline banner with the conflicts it just produced, in the
 * same tick.
 *
 * - the local broker is unreachable — red, blocking: announces, the operator
 *   inbox and graph drafts are all degraded;
 * - cards await arbitration — warning tone and the only banner carrying an
 *   ACTION, since the operator can only clear it from the Roadmap view;
 * - the upstream refused changes — warning tone: the link is up, so this is
 *   not an outage, but the changes are not leaving either;
 * - the upstream is unreachable — neutral info tone, not an error: every local
 *   agent keeps working, the roadmap keeps being written, and the pending
 *   changes leave as soon as the link returns. Only the sharing with the other
 *   machines is paused, so painting this red would claim a breakage that is
 *   not one.
 */
export function StatusBanner(): React.JSX.Element | null {
  const t = useT()
  const status = useDeck((s) => s.brokerStatus)
  const dismissed = useDeck((s) => s.offlineBannerDismissed)
  const dismiss = useDeck((s) => s.dismissOfflineBanner)
  const sync = useDeck((s) => s.roadmapSync.status)
  // This project's conflicts, the same producer as the rail badge: a banner
  // counting the broker's cross-project total would send the operator to a
  // board showing none.
  const conflicts = useDeck(roadmapConflictCount)
  const setView = useDeck((s) => s.setView)

  const kind = bannerKind({
    brokerUp: status === null ? null : status.up,
    // Dismiss is per-outage: hiding this outage's banner must not hide the
    // next one's (a new outage carries a new `since`). The NavRail red dot
    // stays as the residual indicator while hidden.
    brokerDismissed: status !== null && dismissed === status.since,
    conflicts,
    status: sync
  })

  if (kind === 'broker-down' && status !== null) {
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

  // The conflicts appear exactly when the offline banner goes away, so without
  // this the reconnection reads as "everything is fine again" while the board
  // silently fills with cards nobody arbitrated.
  if (kind === 'conflicts') {
    return (
      <div className="status-banner status-banner-warn" role="status">
        <span className="status-banner-text">
          {GLYPH_BADGES.scales} {t('banner.roadmapConflicts', { count: conflicts })}
        </span>
        <button className="status-banner-action" onClick={() => setView('roadmap')}>
          {t('banner.openRoadmap')}
        </button>
      </div>
    )
  }

  // A refusal is a validation the upstream will keep rejecting, so no Retry:
  // `last_error` names it, and only an edit to the card can clear it.
  if (kind === 'refused') {
    return (
      <div className="status-banner status-banner-warn" role="status">
        <span className="status-banner-text" title={sync.last_error ?? undefined}>
          {GLYPH_BADGES.warning} {t('banner.pushRefused', { count: sync.refused ?? 0 })}
          {sync.last_error ? (
            <span className="status-banner-detail"> — {sync.last_error}</span>
          ) : null}
        </span>
      </div>
    )
  }

  // The local broker answers; only its upstream does not. No Retry: the
  // replication loop re-arms itself, and a button that cannot shorten the
  // outage would only invite the operator to press it.
  if (kind === 'replica-offline') {
    return (
      <div className="status-banner status-banner-info" role="status">
        <span className="status-banner-text" title={sync.upstream_url}>
          {GLYPH_BADGES.beacon} {t('banner.replicaOffline', { count: sync.pending_push ?? 0 })}
          {sync.last_error ? (
            <span className="status-banner-detail"> — {sync.last_error}</span>
          ) : null}
        </span>
      </div>
    )
  }

  return null
}
