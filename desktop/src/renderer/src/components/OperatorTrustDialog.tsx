import { useEffect, useRef, useState } from 'react'
import type { OperatorTrustState } from '@shared/types'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { GLYPH_ACTIONS, GLYPH_BADGES } from './icons'

/** The banner sentence doubles as the dialog's state line: one wording per state, never two. */
export const OPERATOR_TRUST_TEXT: Partial<Record<OperatorTrustState, string>> = {
  unconfigured: 'banner.operatorUnconfigured',
  'not-trusted': 'banner.operatorNotTrusted',
  incompatible: 'banner.operatorIncompatible',
  'identity-unreadable': 'banner.operatorIdentityUnreadable',
  invalid: 'banner.operatorInvalid',
  unreachable: 'banner.operatorUnreachable'
}

const HELP: Partial<Record<OperatorTrustState, string>> = {
  unconfigured: 'operatorTrust.help.unconfigured',
  'not-trusted': 'operatorTrust.help.notTrusted',
  incompatible: 'operatorTrust.help.incompatible',
  'identity-unreadable': 'operatorTrust.help.identityUnreadable',
  invalid: 'operatorTrust.help.invalid',
  unreachable: 'operatorTrust.help.unreachable'
}

const FOCUSABLE = 'button:not(:disabled), [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'

// A command, a runbook path and a 64-character fingerprint do not fit the 38px banner line.
export function OperatorTrustDialog(): React.JSX.Element | null {
  const t = useT()
  const status = useDeck((s) => s.operatorTrustStatus)
  const retrying = useDeck((s) => s.operatorTrustRetrying)
  const open = useDeck((s) => s.openOperatorTrustDialog)
  const retry = useDeck((s) => s.retryOperatorTrust)
  const copyFingerprint = useDeck((s) => s.copyOperatorFingerprint)
  const [unchanged, setUnchanged] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  const text = OPERATOR_TRUST_TEXT[status.state]
  const shown = text !== undefined

  useEffect(() => {
    if (!shown) open(false)
  }, [shown, open])

  useEffect(() => {
    if (shown) closeRef.current?.focus()
  }, [shown])

  // Capture phase + stopPropagation, as RoadmapConflictDialog does: one Escape
  // closes one layer, and a text field outside the dialog keeps its own Escape.
  useEffect(() => {
    if (!shown) return
    const onKey = (e: KeyboardEvent): void => {
      const modal = modalRef.current
      if (!modal) return
      const inside = e.target instanceof Node && modal.contains(e.target)
      if (e.key === 'Escape') {
        if (!inside && e.target instanceof HTMLElement && e.target.matches('input, textarea')) return
        e.stopPropagation()
        open(false)
        return
      }
      if (e.key !== 'Tab') return
      const items = [...modal.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (items.length === 0) return
      const first = items[0]!
      const last = items[items.length - 1]!
      if (e.shiftKey ? !inside || document.activeElement === first : !inside || document.activeElement === last) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [shown, open])

  if (!text) return null

  const help = HELP[status.state]
  const fingerprint = status.fingerprint

  const onRetry = async (): Promise<void> => {
    setUnchanged(false)
    const outcome = await retry()
    if (outcome === 'unchanged') setUnchanged(true)
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => open(false)}>
      <div
        ref={modalRef}
        className="modal operator-trust-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="operator-trust-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2 id="operator-trust-title">{t('operatorTrust.dialogTitle')}</h2>
          <button ref={closeRef} className="icon-btn" title={t('common.close')} aria-label={t('common.close')} onClick={() => open(false)}>
            {GLYPH_ACTIONS.close}
          </button>
        </header>
        <p className={`operator-trust-state operator-trust-state-${status.state}`}>
          {GLYPH_BADGES.warning} {t(text)}
        </p>
        {help && <p className="operator-trust-help">{t(help)}</p>}
        {fingerprint && (
          <div className="operator-trust-fingerprint">
            <span className="operator-trust-label">{t('operatorTrust.fingerprint')}</span>
            <div className="operator-trust-fingerprint-row">
              <code className="operator-trust-fingerprint-value">{fingerprint}</code>
              <button
                className="icon-btn"
                title={t('operatorTrust.copyFingerprint')}
                aria-label={t('operatorTrust.copyFingerprint')}
                onClick={() => void copyFingerprint(fingerprint)}
              >
                {GLYPH_ACTIONS.copy}
              </button>
            </div>
          </div>
        )}
        <p className="operator-trust-note">{t('operatorTrust.newSessionsOnly')}</p>
        {unchanged && (
          <p className="operator-trust-unchanged" role="status">
            {t('operatorTrust.unchanged')}
          </p>
        )}
        <div className="modal-actions">
          <button onClick={() => open(false)}>{t('common.close')}</button>
          <button className="primary" disabled={retrying} onClick={() => void onRetry()}>
            {retrying ? t('operatorTrust.retrying') : t('banner.retry')}
          </button>
        </div>
      </div>
    </div>
  )
}
