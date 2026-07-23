// Usage-limits modal: the subscription quota gauges of the detected frontier
// CLIs (Claude Code / Codex / Antigravity), one stacked section per provider
// so the "which account is almost burnt?" comparison is a single glance.
// Data comes from the main-side usage-service (3-min cache; the refresh
// button bypasses it). Foreground modal like RoadmapItemModal: closes on
// backdrop click, ✕ or Escape. Gauges colour-shift amber past 70 % and red
// past 90 % (colour = state, DESIGN.md §2).

import { useCallback, useEffect, useState } from 'react'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { GLYPH_ACTIONS } from './icons'
import type { UsageProviderReport, UsageSnapshot, UsageWindow } from '@shared/types'

/** Proper nouns, deliberately not translated. */
const PROVIDER_LABELS: Record<UsageProviderReport['provider'], string> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity'
}

type T = ReturnType<typeof useT>

function levelClass(pct: number): string {
  if (pct >= 90) return ' is-hot'
  if (pct >= 70) return ' is-warn'
  return ''
}

/** "resets in 4 h 10" under a day, weekday + clock beyond. */
function formatReset(resetsAt: number | null, t: T): string | null {
  if (resetsAt === null) return null
  const delta = resetsAt - Date.now()
  if (delta <= 0) return t('usage.resetsNow')
  if (delta < 24 * 3600_000) {
    const h = Math.floor(delta / 3600_000)
    const m = Math.round((delta % 3600_000) / 60_000)
    return t('usage.resetsIn', { time: h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min` })
  }
  const time = new Date(resetsAt).toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })
  return t('usage.resetsAt', { time })
}

function windowLabel(w: UsageWindow, t: T): string {
  // '3p' is Antigravity's non-Gemini pool id — the one label worth translating.
  const pool = w.label === '3p' ? t('usage.pool3p') : w.label
  if (w.key === 'session') {
    return pool ? t('usage.win.sessionOf', { name: pool }) : t('usage.win.session')
  }
  if (w.key === 'week') return pool ? t('usage.win.weekOf', { name: pool }) : t('usage.win.week')
  return t('usage.win.weekModel', { name: pool ?? '' })
}

function GaugeRow({ w, t }: { w: UsageWindow; t: T }): React.JSX.Element {
  const level = levelClass(w.usedPercent)
  const reset = formatReset(w.resetsAt, t)
  return (
    <div className="usage-row">
      <div className="usage-row-head">
        <span className="usage-row-label">{windowLabel(w, t)}</span>
        <span className={`usage-row-pct${level}`}>{t('usage.used', { pct: `${w.usedPercent}` })}</span>
      </div>
      <div className="usage-bar">
        <div className={`usage-bar-fill${level}`} style={{ width: `${w.usedPercent}%` }} />
      </div>
      {reset && <div className="usage-row-reset">{reset}</div>}
    </div>
  )
}

const fmtCredit = (n: number): string =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function ProviderSection({ r, t }: { r: UsageProviderReport; t: T }): React.JSX.Element {
  return (
    <section className="usage-provider">
      <div className="usage-provider-head">
        <h4>{PROVIDER_LABELS[r.provider]}</h4>
        {r.plan && <span className="usage-plan-badge">{r.plan}</span>}
      </div>
      {r.status === 'not-connected' && <p className="usage-note">{t('usage.notConnected')}</p>}
      {r.status === 'error' && (
        <p className="usage-note usage-note-error">
          {t('usage.error')}
          {r.error ? ` — ${r.error}` : ''}
        </p>
      )}
      {r.status === 'ok' && (
        <>
          {r.windows.map((w, i) => (
            <GaugeRow key={`${w.key}-${w.label ?? i}`} w={w} t={t} />
          ))}
          {r.credits && (
            <div className="usage-credits">
              <span className="usage-row-label">{t('usage.credits')}</span>
              <span className="usage-credits-value">
                {!r.credits.enabled
                  ? t('usage.creditsOff')
                  : r.credits.used !== null && r.credits.limit !== null
                    ? `${fmtCredit(r.credits.used)} / ${fmtCredit(r.credits.limit)}`
                    : r.credits.utilization !== null
                      ? t('usage.used', { pct: `${r.credits.utilization}` })
                      : t('usage.creditsOn')}
              </span>
            </div>
          )}
          {r.stale && <p className="usage-note">{t('usage.stale')}</p>}
        </>
      )}
    </section>
  )
}

export function UsageLimitsModal(): React.JSX.Element {
  const t = useT()
  const openUsage = useDeck((s) => s.openUsage)
  const onClose = useCallback(() => openUsage(false), [openUsage])

  const [snap, setSnap] = useState<UsageSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async (refresh: boolean): Promise<void> => {
    setLoading(true)
    setFailed(false)
    try {
      setSnap(await window.api.usageRead(refresh))
    } catch (err) {
      // IPC failure (not a per-provider error — those come back in the snapshot).
      setFailed(true)
      window.api.reportError('usage', String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal usage-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="usage-head">
          <h3>{t('usage.title')}</h3>
          <button
            className="icon-btn"
            title={t('usage.refresh')}
            disabled={loading}
            onClick={() => void load(true)}
          >
            {GLYPH_ACTIONS.refresh}
          </button>
          <button className="icon-btn" title={t('common.close')} onClick={onClose}>
            {GLYPH_ACTIONS.close}
          </button>
        </header>
        <div className="usage-body">
          {failed && <p className="usage-note usage-note-error">{t('usage.failed')}</p>}
          {!failed && !snap && loading && <p className="usage-note">{t('usage.loading')}</p>}
          {snap && snap.providers.length === 0 && <p className="usage-note">{t('usage.none')}</p>}
          {snap?.providers.map((r) => <ProviderSection key={r.provider} r={r} t={t} />)}
        </div>
        {snap && (
          <footer className="usage-foot">
            {t('usage.updated', {
              time: new Date(snap.fetchedAt).toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit'
              })
            })}
          </footer>
        )}
      </div>
    </div>
  )
}
