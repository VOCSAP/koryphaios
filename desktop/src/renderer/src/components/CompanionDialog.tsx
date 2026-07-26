import { useEffect, useState } from 'react'
import qrcode from 'qrcode-generator'
import type { CompanionDevice, CompanionInfo } from '@shared/types'
import { GLYPHS, GLYPH_ACTIONS } from './icons'
import { useDeck } from '../store'
import { useT } from '../i18n'

// Compagnon dialog (PLAN MB2 — EXPLORATION §5.5): the operator's pairing
// ceremony. Start mints a ONE-SHOT token bound to this app run, rendered as a
// QR of `https://<lan-ip>:<port>/#t=<token>`; the phone scans it, the token
// is consumed, and closing the app (or Stop here) revokes everything.

function qrSvg(text: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true })
}

export function CompanionDialog(): React.JSX.Element {
  const t = useT()
  const openCompanion = useDeck((s) => s.openCompanion)
  const [info, setInfo] = useState<CompanionInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [devices, setDevices] = useState<CompanionDevice[]>([])

  const refreshDevices = (): void => {
    void window.api
      .companionDevices()
      .then(setDevices)
      .catch(() => setDevices([]))
  }

  useEffect(() => {
    void window.api
      .companionStatus()
      .then(setInfo)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    refreshDevices()
    // onCompanionChanged fires on start/stop/connect/revoke — keep both in sync.
    const offChanged = window.api.onCompanionChanged((i) => {
      setInfo(i)
      refreshDevices()
    })
    const offConnected = window.api.onCompanionDeviceConnected(refreshDevices)
    return () => {
      offChanged()
      offConnected()
    }
  }, [])

  const revoke = async (id: string): Promise<void> => {
    try {
      await window.api.companionRevoke(id)
      refreshDevices()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const revokeAll = async (): Promise<void> => {
    try {
      await window.api.companionRevokeAll()
      refreshDevices()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setInfo(await window.api.companionStart())
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      window.api.reportError('companion', `start failed: ${msg}`)
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    setBusy(true)
    try {
      setInfo(await window.api.companionStop())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // The token rides in the FRAGMENT (never sent to the server by HTTP); the
  // certificate fingerprint rides beside it so the Android shell can pin this
  // host on first pair (MB6). A browser ignores both.
  const pairUrl =
    info?.running && info.url && info.pairingToken
      ? `${info.url}/#t=${info.pairingToken}${info.certFingerprint ? `&f=${info.certFingerprint}` : ''}`
      : null

  return (
    <div className="modal-backdrop" onMouseDown={() => openCompanion(false)}>
      <div className="modal companion-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{GLYPHS.companion} {t('companion.title')}</h2>
          <button className="icon-btn" onClick={() => openCompanion(false)}>
            {GLYPH_ACTIONS.close}
          </button>
        </header>
        <div className="companion-body">
          {!info?.running && (
            <>
              <p className="companion-hint">{t('companion.hint')}</p>
              <button className="primary" disabled={busy} onClick={() => void start()}>
                {t('companion.start')}
              </button>
            </>
          )}
          {info?.running && pairUrl && (
            <>
              <p className="companion-hint">{t('companion.scanHint')}</p>
              {/* qrcode-generator emits a self-contained <svg>; no user data
                  beyond our own URL+token goes through it. */}
              <div className="companion-qr" dangerouslySetInnerHTML={{ __html: qrSvg(pairUrl) }} />
              <code className="companion-url">{pairUrl}</code>
              <p className="companion-hint companion-warn">{t('companion.certWarn')}</p>
            </>
          )}
          {info?.running && !pairUrl && (
            <p className="companion-hint">
              {t('companion.paired', { count: String(info.clients) })}
            </p>
          )}
          {info?.running && (
            <section className="companion-devices">
              <div className="companion-devices-head">
                <h3>{t('companion.devices')}</h3>
                {devices.length > 0 && (
                  <button className="link-btn" onClick={() => void revokeAll()}>
                    {t('companion.revokeAll')}
                  </button>
                )}
              </div>
              {devices.length === 0 ? (
                <p className="companion-hint">{t('companion.noDevices')}</p>
              ) : (
                <ul className="companion-device-list">
                  {devices.map((d) => (
                    <li key={d.id}>
                      <span className="companion-device-addr">{d.addr}</span>
                      <button className="link-btn" onClick={() => void revoke(d.id)}>
                        {t('companion.revoke')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {info?.running && (
            <button className="btn danger" disabled={busy} onClick={() => void stop()}>
              {t('companion.stop')}
            </button>
          )}
          {error && <div className="companion-error">{error}</div>}
        </div>
      </div>
    </div>
  )
}
