import { useEffect, useState } from 'react'
import qrcode from 'qrcode-generator'
import type { CompanionInfo } from '@shared/types'
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

  useEffect(() => {
    void window.api
      .companionStatus()
      .then(setInfo)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    return window.api.onCompanionChanged(setInfo)
  }, [])

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

  const pairUrl =
    info?.running && info.url && info.pairingToken ? `${info.url}/#t=${info.pairingToken}` : null

  return (
    <div className="modal-backdrop" onMouseDown={() => openCompanion(false)}>
      <div className="modal companion-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>📱 {t('companion.title')}</h2>
          <button className="icon-btn" onClick={() => openCompanion(false)}>
            ✕
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
            <button disabled={busy} onClick={() => void stop()}>
              {t('companion.stop')}
            </button>
          )}
          {error && <div className="companion-error">{error}</div>}
        </div>
      </div>
    </div>
  )
}
