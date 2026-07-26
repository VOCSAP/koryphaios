// Settings > Notifications: the enrolment screen for remote approvals.
//
// One row per channel — glyph, name, live state, Connect/Disconnect — plus the
// multi-PC link. The bot token is typed here and handed to the BROKER, which
// holds the single gateway; it is never read back, so a configured channel only
// ever shows a 4-character hint of it.

import { useCallback, useEffect, useState } from 'react'
import type { ApprovalChannelStatus } from '@shared/types'
import { GLYPH_BADGES } from './icons'

type Kind = ApprovalChannelStatus['kind']

/** Greek metaphor per channel — never a brand logo (DESIGN.md §5). */
const CHANNEL_GLYPH: Record<Kind, keyof typeof GLYPH_BADGES> = {
  telegram: 'talaria',
  discord: 'salpinx',
  ntfy: 'beacon'
}

const CHANNEL_LABEL: Record<Kind, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  ntfy: 'Koryphaios mobile'
}

interface Props {
  t: (key: string) => string
  enabled: boolean
}

export function NotificationChannels({ t, enabled }: Props): React.JSX.Element {
  const [channels, setChannels] = useState<ApprovalChannelStatus[]>([])
  const [busy, setBusy] = useState<Kind | null>(null)
  const [editing, setEditing] = useState<Kind | null>(null)
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [pairing, setPairing] = useState<{ kind: Kind; code: string } | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setChannels(await window.api.approvalChannels())
    } catch (e) {
      // A broker that is down must not blank the screen: keep what we had.
      void window.api.reportError?.('notifications: could not list channels', String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const connect = async (kind: Kind): Promise<void> => {
    if (kind === 'ntfy') return
    setBusy(kind)
    setError('')
    try {
      const res = await window.api.approvalConnect(kind, token.trim())
      setPairing({ kind, code: res.pairing_code })
      setEditing(null)
      setToken('')
      await refresh()
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async (kind: Kind): Promise<void> => {
    setBusy(kind)
    try {
      await window.api.approvalDisconnect(kind)
      if (pairing?.kind === kind) setPairing(null)
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="notif-channels">
      {channels.map((channel) => {
        const soon = channel.kind === 'ntfy'
        const state = soon
          ? t('notifications.soon')
          : channel.connected
            ? t('notifications.connected')
            : channel.configured
              ? t('notifications.starting')
              : t('notifications.notConnected')
        return (
          <div className="notif-row" key={channel.kind}>
            <span className={`notif-glyph${channel.connected ? ' is-on' : ''}`}>
              {GLYPH_BADGES[CHANNEL_GLYPH[channel.kind]]}
            </span>
            <span className="notif-name">
              {CHANNEL_LABEL[channel.kind]}
              <small>
                {state}
                {channel.bot_label ? ` · @${channel.bot_label}` : ''}
                {channel.token_hint ? ` · ${channel.token_hint}` : ''}
                {channel.paired > 0 ? ` · ${channel.paired} ${t('notifications.paired')}` : ''}
              </small>
            </span>
            {channel.configured ? (
              <button
                className="btn danger"
                disabled={!!busy || soon}
                onClick={() => void disconnect(channel.kind)}
              >
                {t('notifications.disconnect')}
              </button>
            ) : (
              <button
                className="btn"
                disabled={!!busy || soon || !enabled}
                onClick={() => {
                  setEditing(editing === channel.kind ? null : channel.kind)
                  setError('')
                }}
              >
                {t('notifications.connect')}
              </button>
            )}
          </div>
        )
      })}

      {editing && (
        <div className="notif-connect">
          <label className="field">
            <span>{t(`notifications.token.${editing}`)}</span>
            <input
              type="password"
              value={token}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('notifications.tokenPlaceholder')}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <small className="field-check-help">{t(`notifications.help.${editing}`)}</small>
          <div className="modal-actions">
            <button className="btn" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </button>
            <button
              className="btn primary"
              disabled={!token.trim() || !!busy}
              onClick={() => void connect(editing)}
            >
              {t('notifications.connect')}
            </button>
          </div>
        </div>
      )}

      {error && <p className="notif-error">{error}</p>}

      {pairing && (
        <div className="notif-pairing">
          <p>{t(`notifications.pair.${pairing.kind}`)}</p>
          <code>{pairing.code}</code>
        </div>
      )}

      {!enabled && <small className="field-check-help">{t('notifications.disabledHint')}</small>}
    </div>
  )
}
