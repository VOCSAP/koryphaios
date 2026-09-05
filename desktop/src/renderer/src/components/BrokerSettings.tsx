import { useEffect } from 'react'
import type { DeckBrokerMode } from '@shared/types'
import { brokerPanelState, shouldReadPeersConfig } from '@shared/broker-panel'
import { useDeck } from '../store'
import { useT } from '../i18n'

/**
 * The three deployment shapes, all three explained side by side rather than
 * only the active one: the operator is deciding whether to opt into the third,
 * and a lone label ("replica") says nothing about what the other two would do
 * instead. Literal key strings, so the locale parity scan sees their producer.
 */
const BROKER_MODES: { id: DeckBrokerMode; label: string; help: string }[] = [
  { id: 'local', label: 'settings.brokerModeLocal', help: 'settings.brokerModeLocalHelp' },
  { id: 'remote', label: 'settings.brokerModeRemote', help: 'settings.brokerModeRemoteHelp' },
  { id: 'replica', label: 'settings.brokerModeReplica', help: 'settings.brokerModeReplicaHelp' }
]

/**
 * Settings > Broker: the claude-peers CORE config, read-only except for the
 * `offline_replica` opt-in. Mounted only while the category is open, so the
 * summary is re-read on every visit -- this file belongs to claude-peers, not
 * to the Deck, and the operator (or another machine's provisioning) can edit
 * it between two openings of this page.
 */
export function BrokerSettings(): React.JSX.Element {
  const t = useT()
  const remote = useDeck((s) => s.remote)
  const peers = useDeck((s) => s.peersConfig)
  const peersError = useDeck((s) => s.peersConfigError)
  const refreshPeersConfig = useDeck((s) => s.refreshPeersConfig)
  const setOfflineReplica = useDeck((s) => s.setOfflineReplica)

  // The companion check precedes the read, not just the rendering: the bridge
  // refuses 'peersConfig:get' remotely, and an issued call would come back as
  // a rejection, raise an error toast and light the error state below.
  useEffect(() => {
    if (shouldReadPeersConfig(remote)) void refreshPeersConfig()
  }, [remote, refreshPeersConfig])

  const state = brokerPanelState({ companion: remote, peers, error: peersError })

  // Never a blank page: a category that renders nothing at all reads as a
  // broken app, and the reportError already emitted main-side is invisible to
  // the operator.
  if (state === 'host-only') {
    return (
      <div className="field">
        <span>{t('settings.brokerHostOnly')}</span>
        <small>{t('settings.brokerHostOnlyHelp')}</small>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="field">
        <span>{t('settings.brokerUnavailable')}</span>
        <small>{t('settings.brokerUnavailableHelp')}</small>
        <div>
          <button className="btn" onClick={() => void refreshPeersConfig()}>
            {t('settings.brokerRetry')}
          </button>
        </div>
      </div>
    )
  }

  // 'loading' is exactly `peers === null` once the two arms above are out of
  // the way; spelled as the null test so the compiler narrows the summary too.
  if (peers === null) {
    return (
      <div className="field">
        <span>{t('settings.brokerLoading')}</span>
      </div>
    )
  }

  return (
    <>
      <div className="field">
        <span>{t('settings.brokerMode')}</span>
        <ul className="settings-broker-modes">
          {BROKER_MODES.map((m) => (
            <li key={m.id} className={`settings-broker-mode${peers.mode === m.id ? ' is-active' : ''}`}>
              <span className="settings-broker-mode-name">{t(m.label)}</span>
              <span className="settings-broker-mode-help">{t(m.help)}</span>
            </li>
          ))}
        </ul>
        <small>{t('settings.brokerModeHelp')}</small>
      </div>

      <div className="field">
        <span>{t('settings.brokerUrl')}</span>
        <div className="settings-broker-value">{peers.brokerUrl ?? t('settings.brokerUrlNone')}</div>
        <small>
          {peers.forcedByEnv.brokerUrl ? t('settings.brokerUrlEnv') : t('settings.brokerUrlHelp')}
        </small>
      </div>

      {/* Yes/no only: the bearer token never crosses the IPC boundary, same
          rule as the local-provider API keys. */}
      <div className="field">
        <span>{t('settings.brokerToken')}</span>
        <div className="settings-broker-value">
          {t(peers.hasToken ? 'settings.brokerTokenYes' : 'settings.brokerTokenNo')}
        </div>
        <small>{t('settings.brokerTokenHelp')}</small>
        {/* The upstream's replication routes answer 403 without one, which
            surfaces to the operator as "upstream unreachable" -- a symptom
            that says nothing about its cause. */}
        {!peers.hasToken ? (
          <small className="settings-broker-note">{t('settings.brokerTokenMissing')}</small>
        ) : null}
      </div>

      {/* Read-only: this decides what the local broker SERVES to other
          machines, not what this Deck consumes. An operator whose replica
          cannot reach its upstream reads a 403 as "unreachable", and this line
          is where the real cause (the upstream not serving replicas, or this
          machine not serving them either) becomes visible. */}
      <div className="field">
        <span>{t('settings.brokerServeReplicas')}</span>
        <div className="settings-broker-value">
          {t(
            peers.serveReplicas
              ? 'settings.brokerServeReplicasYes'
              : 'settings.brokerServeReplicasNo'
          )}
        </div>
        <small>{t('settings.brokerServeReplicasHelp')}</small>
      </div>

      <label
        className="field field-check"
        aria-disabled={
          peers.forcedByEnv.offlineReplica || peers.brokerUrl === null ? 'true' : undefined
        }
      >
        <input
          type="checkbox"
          checked={peers.offlineReplica}
          disabled={peers.forcedByEnv.offlineReplica || peers.brokerUrl === null}
          onChange={(e) => void setOfflineReplica(e.target.checked)}
        />
        <span>{t('settings.offlineReplica')}</span>
      </label>
      <small className="field-check-help">{t('settings.offlineReplicaHelp')}</small>
      {/* A warning, not a disable: the operator can add the token to the same
          file right after ticking this. */}
      {!peers.hasToken ? (
        <small className="field-check-help settings-broker-note">
          {t('settings.brokerTokenMissing')}
        </small>
      ) : null}
      {/* A disabled control with no reason reads as a bug: say which of the two
          conditions is holding it, env first (it outranks the file whatever
          the URL says). */}
      {peers.forcedByEnv.offlineReplica ? (
        <small className="field-check-help settings-broker-note">
          {t('settings.offlineReplicaEnv')}
        </small>
      ) : peers.brokerUrl === null ? (
        <small className="field-check-help settings-broker-note">
          {t('settings.offlineReplicaNoUrl')}
        </small>
      ) : null}
    </>
  )
}
