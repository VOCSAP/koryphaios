import { useCallback, useEffect, useState } from 'react'
import type { DeckApi, StopMode, StopOutcome, StopReport, StopState } from '@shared/types'
import { GLYPH_ACTIONS } from './icons'
import { ConfirmDialog } from './ConfirmDialog'
import { type TFn } from '../i18n'

// Three distinct operator gestures: pause interrupts every agent and keeps
// their cards locked (reversible); soft asks each to stop at its next turn and
// hand the card back; hard interrupts now and releases every card.
// Soft is the default face of a split button whose arrow flips it to hard; the
// action played is always the one displayed, so the operator never fires a mode
// they cannot see.
// Pause is a separate button, left of the split pair, since it does not share
// the stop semantics — severity then reads left-to-right, least destructive
// first.

/**
 * Typed optional, not decoration: an older packaged preload has no agentsStop,
 * and the control must then degrade to disabled-with-reason instead of throwing
 * on a call to undefined.
 * peerIds absent means every live tile; present and non-empty targets only
 * those; an empty array is refused main-side and must never be sent.
 * Derived from DeckApi rather than redeclared, so a renamed method fails here
 * at compile time instead of silently going dead behind a cast.
 */
type StopApi = Partial<Pick<DeckApi, 'agentsStop' | 'agentsStopState'>>

function stopApi(): StopApi {
  return window.api
}

/**
 * The ONLY outcome that proves a stop: an ESC actually delivered to the pty.
 * Pause and hard stop interrupt the agent, they do not ask it to stop.
 */
function interrupted(r: StopReport): StopOutcome[] {
  return r.outcomes.filter((o) => o.result === 'interrupted')
}

/**
 * `written` only means the pty write succeeded, not that the agent read it or
 * will stop — the message can sit unsubmitted at the prompt.
 * So the copy says "transmitted", never "stopped", and these tiles stay
 * escalable: a soft stop is a request, pause and hard are the guarantees.
 */
function transmitted(r: StopReport): StopOutcome[] {
  return r.outcomes.filter((o) => o.result === 'written')
}

/**
 * The whole point of the report: an agent still busy did NOT take the stop, and
 * an agent that never goes idle again is exactly the one the operator clicked
 * for. Swallowing this case would make the control lie.
 */
function stragglers(r: StopReport): StopOutcome[] {
  return r.outcomes.filter((o) => o.result === 'busy-timeout')
}

function unreachable(r: StopReport): StopOutcome[] {
  return r.outcomes.filter((o) => o.result === 'no-terminal' || o.result === 'error')
}

/**
 * The screen-state guard refused to write anything at all — not busy, not
 * unreachable, not confirmed-sent — because the tile looked like an open dialog
 * where either gesture could quit the session or accept something in the
 * operator's name.
 * Reachable from two separate guards: soft's own injectCommand guard and
 * pause's own interrupt gate on the same union; hard is deliberately ungated
 * and never lands here.
 * Kept as its own bucket rather than folded into stragglers (would falsely
 * claim the agent is still busy) or unreachable (would falsely claim the tile
 * could not be reached at all).
 */
function refusedModal(r: StopReport): StopOutcome[] {
  return r.outcomes.filter((o) => o.result === 'refused-modal')
}

/**
 * The stragglers an escalation can actually reach. A straggler whose `peerId`
 * is null owns a tile but no peer, so no `peerIds` entry can name it: it is
 * excluded from the subset and reported to the operator rather than silently
 * dropped -- or, worse, turned into an escalation over the whole fleet.
 */
function escalable(stuck: StopOutcome[]): string[] {
  return stuck.map((o) => o.peerId).filter((p): p is string => p !== null)
}

export function AgentStopControls({ t }: { t: TFn }): React.JSX.Element {
  // `null` state = never answered yet; `available` false = channel missing.
  const [state, setState] = useState<StopState | null>(null)
  const [available, setAvailable] = useState(true)
  /** The face of the split button. The played action is always this one. */
  const [mode, setMode] = useState<'soft' | 'hard'>('soft')
  const [confirm, setConfirm] = useState<StopMode | null>(null)
  /** Set while a stop is in flight -- the controls are disabled meanwhile. */
  const [running, setRunning] = useState<StopMode | null>(null)
  const [report, setReport] = useState<StopReport | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  /**
   * Peers targeted by the pending confirm. `null` = the whole fleet (the three
   * buttons); a non-empty list = an escalation over those stragglers only.
   */
  const [targets, setTargets] = useState<string[] | null>(null)

  const refreshState = useCallback(async (): Promise<StopState | null> => {
    const fn = stopApi().agentsStopState
    if (!fn) {
      setAvailable(false)
      return null
    }
    try {
      const s = await fn()
      setAvailable(true)
      setState(s)
      return s
    } catch (e) {
      // Not silent: the operator sees the controls disabled, the journal sees why.
      window.api.reportError('agents:stop-state', e instanceof Error ? e.message : String(e))
      setAvailable(false)
      return null
    }
  }, [])

  useEffect(() => {
    void refreshState()
  }, [refreshState])

  const live = state?.live ?? 0
  const busy = state?.busy ?? 0
  const parked = state?.parkedCards ?? 0
  const idle = available && state !== null && live === 0
  const disabled = !available || idle || running !== null || state === null

  const disabledHint = !available
    ? t('roadmap.stop.unavailable')
    : idle
      ? t('roadmap.stop.noAgents')
      : running !== null
        ? t('roadmap.stop.busy')
        : ''

  /** Always re-read the counts before asking: the confirm announces a number. */
  const ask = async (m: StopMode, peerIds: string[] | null = null): Promise<void> => {
    const s = await refreshState()
    if (!s || s.live === 0) return
    // An escalation with nothing left to target is not a degraded escalation,
    // it is no escalation: never open a confirm over an empty subset.
    if (peerIds !== null && peerIds.length === 0) return
    setTargets(peerIds)
    setConfirm(m)
  }

  const run = async (m: StopMode, peerIds: string[] | null): Promise<void> => {
    setConfirm(null)
    setTargets(null)
    const fn = stopApi().agentsStop
    if (!fn) {
      setAvailable(false)
      return
    }
    setRunning(m)
    setReport(null)
    setFailure(null)
    try {
      // Omit the argument entirely for a fleet-wide stop: `undefined` means
      // "every tile", `[]` means "refuse", and they must never be confused.
      setReport(await fn(m, peerIds && peerIds.length > 0 ? peerIds : undefined))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      window.api.reportError('agents:stop', msg)
      setFailure(msg)
    } finally {
      setRunning(null)
      void refreshState()
    }
  }

  /**
   * The confirm's count and mode must come from the same source as the action
   * actually fired, or a subset confirm can announce the wrong mode for what
   * runs.
   */
  const subsetSuffix = (m: StopMode): string => (m === 'pause' ? 'Pause' : m === 'soft' ? 'Soft' : 'Hard')

  const confirmTitle = (m: StopMode): string => {
    if (targets) return t(`roadmap.stop.confirm${subsetSuffix(m)}Subset`, { count: targets.length })
    return t(`roadmap.stop.confirm${subsetSuffix(m)}`, { count: live })
  }

  const confirmMessage = (m: StopMode): string => {
    // An escalation names the stragglers it targets, and only them: the agents
    // that DID take the soft stop keep their cards.
    if (targets) return t(`roadmap.stop.confirm${subsetSuffix(m)}SubsetMsg`, { count: targets.length })
    if (m === 'pause') return t('roadmap.stop.confirmPauseMsg', { count: live, busy })
    if (m === 'soft') return t('roadmap.stop.confirmSoftMsg', { count: live })
    return t('roadmap.stop.confirmHardMsg', { count: live, parked })
  }

  return (
    <span className="rm-stop-group">
      <button
        type="button"
        className="icon-btn rm-stop-btn"
        disabled={disabled}
        title={disabled ? disabledHint : t('roadmap.stop.pauseHint')}
        aria-label={t('roadmap.stop.pause')}
        onClick={() => void ask('pause')}
      >
        {GLYPH_ACTIONS.pause}
      </button>

      {/* Split button: the left half FIRES the displayed mode, the right half
          only FLIPS it. One control, two faces, the played action visible. */}
      <span className="rm-stop-split">
        <button
          type="button"
          className={`icon-btn rm-stop-btn rm-stop-main${mode === 'hard' ? ' danger' : ''}`}
          disabled={disabled}
          title={disabled ? disabledHint : t(`roadmap.stop.${mode}Hint`)}
          aria-label={t(`roadmap.stop.${mode}`)}
          onClick={() => void ask(mode)}
        >
          {mode === 'soft' ? GLYPH_ACTIONS.stop : GLYPH_ACTIONS.shears}
        </button>
        <button
          type="button"
          className="icon-btn rm-stop-btn rm-stop-flip"
          disabled={!available || running !== null}
          title={mode === 'soft' ? t('roadmap.stop.flipToHard') : t('roadmap.stop.flipToSoft')}
          aria-label={mode === 'soft' ? t('roadmap.stop.flipToHard') : t('roadmap.stop.flipToSoft')}
          onClick={() => setMode((m) => (m === 'soft' ? 'hard' : 'soft'))}
        >
          {GLYPH_ACTIONS.forward}
        </button>
      </span>

      {confirm && (
        <ConfirmDialog
          title={confirmTitle(confirm)}
          message={confirmMessage(confirm)}
          confirmLabel={t(`roadmap.stop.${confirm}`)}
          tone={confirm === 'hard' ? 'danger' : 'neutral'}
          onConfirm={() => void run(confirm, targets)}
          onCancel={() => {
            setConfirm(null)
            setTargets(null)
          }}
        />
      )}

      {(report || failure) && (
        <StopReportModal
          report={report}
          failure={failure}
          t={t}
          onEscalate={(peerIds) => {
            setReport(null)
            setMode('hard')
            void ask('hard', peerIds)
          }}
          onClose={() => {
            setReport(null)
            setFailure(null)
          }}
        />
      )}
    </span>
  )
}

function StopReportModal({
  report,
  failure,
  t,
  onEscalate,
  onClose
}: {
  report: StopReport | null
  failure: string | null
  t: TFn
  onEscalate: (peerIds: string[]) => void
  onClose: () => void
}): React.JSX.Element {
  const took = report ? interrupted(report) : []
  const written = report ? transmitted(report) : []
  const stuck = report ? stragglers(report) : []
  const lost = report ? unreachable(report) : []
  const refused = report ? refusedModal(report) : []
  /* Escalation targets unconfirmed transmissions, busy refusals, AND
     screen-guard refusals. The asymmetry is deliberate: `busy-timeout`
     proves nothing was sent, a write only proves a write, and
     `refused-modal` proves the Deck chose not to touch the tile at all --
     none of the three is an observed stop, so all three deserve the
     hard-stop offer. A refused tile in particular has NO other lever: the
     soft path structurally cannot write into it (that is the whole point of
     the guard), so hard stop is its only recourse. Hard stop's own
     interrupt() already sends an unconditional bare Escape to every tile
     regardless of screen state (session-service.ts, `interrupt()`'s own
     doc) -- escalating a refused tile exposes it to a risk hard stop
     already accepts for every OTHER tile, not a new one. */
  const escalatable = [...written, ...stuck, ...refused]
  const targets = escalable(escalatable)
  const locks = report?.locks ?? {}
  const title = report ? t(`roadmap.stop.report.${report.mode}`) : t('roadmap.stop.report.failed')

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal rm-stop-report" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
        </div>

        {failure && <p className="rm-stop-failure">{t('roadmap.stop.failed', { error: failure })}</p>}

        {report && (
          <>
            <ul className="rm-stop-tally">
              {/* Rendered only when non-zero: a soft stop interrupts nobody, and
                  "0 agents took the stop" next to "transmitted to 1" reads as a
                  failure when it is merely the wrong sentence for that mode. */}
              {took.length > 0 && (
                <li className="rm-stop-took">{t('roadmap.stop.took', { count: took.length })}</li>
              )}
              {written.length > 0 && (
                <li className="rm-stop-written">{t('roadmap.stop.written', { count: written.length })}</li>
              )}
              {stuck.length > 0 && (
                <li className="rm-stop-stuck">{t('roadmap.stop.notTook', { count: stuck.length })}</li>
              )}
              {refused.length > 0 && (
                <li className="rm-stop-stuck">{t('roadmap.stop.refused', { count: refused.length })}</li>
              )}
              {lost.length > 0 && (
                <li className="rm-stop-lost">{t('roadmap.stop.unreachable', { count: lost.length })}</li>
              )}
              {/* Lock movement is never implicit: a hard stop that hands back 12
                  cards without saying so is a surprise. Absent in soft mode. */}
              {locks.parked !== undefined && (
                <li className="rm-stop-locks">{t('roadmap.stop.parked', { count: locks.parked })}</li>
              )}
              {locks.released !== undefined && (
                <li className="rm-stop-locks">{t('roadmap.stop.released', { count: locks.released })}</li>
              )}
              {locks.error !== undefined && (
                <li className="rm-stop-lost">{t('roadmap.stop.lockError', { error: locks.error })}</li>
              )}
            </ul>

            {/* Written, not acknowledged. Kept OUT of the amber block on
                purpose: amber says "refused, still busy", which is a measured
                fact for a straggler and an invention here. All the Deck knows
                is that it wrote to the pty. */}
            {written.length > 0 && (
              <div className="rm-stop-stragglers rm-stop-written-box">
                <h3>{t('roadmap.stop.writtenTitle')}</h3>
                <ul>
                  {written.map((o) => (
                    <li key={o.id}>
                      <span className="rm-stop-peer">{o.peerId ?? t('roadmap.stop.noPeer')}</span>
                      <span className="rm-stop-tile">{o.id.slice(0, 8)}</span>
                    </li>
                  ))}
                </ul>
                <p className="rm-stop-note">{t('roadmap.stop.writtenNote')}</p>
              </div>
            )}

            {stuck.length > 0 && (
              <div className="rm-stop-stragglers">
                <h3>{t('roadmap.stop.stragglers')}</h3>
                <ul>
                  {stuck.map((o) => (
                    <li key={o.id}>
                      {/* peerId is nullable by contract -- rendering it raw would
                          print the string "null" on the operator's screen. */}
                      <span className="rm-stop-peer">{o.peerId ?? t('roadmap.stop.noPeer')}</span>
                      <span className="rm-stop-tile">{o.id.slice(0, 8)}</span>
                    </li>
                  ))}
                </ul>
                {report.mode === 'hard' && (
                  <p className="rm-stop-note">{t('roadmap.stop.hardStragglers', { count: stuck.length })}</p>
                )}
              </div>
            )}

            {/* Own box, own honest label (team-lead, 2026-08-17): a screen-guard
                refusal is neither a straggler ("still busy" would be false --
                the tile may be sitting idle at a dialog) nor written-unconfirmed
                (nothing was sent at all). Reuses the stragglers box archetype
                (amber, same shape) rather than inventing new CSS -- the copy
                below is what carries the actual distinction. */}
            {refused.length > 0 && (
              <div className="rm-stop-stragglers">
                <h3>{t('roadmap.stop.refusedTitle')}</h3>
                <ul>
                  {refused.map((o) => (
                    <li key={o.id}>
                      <span className="rm-stop-peer">{o.peerId ?? t('roadmap.stop.noPeer')}</span>
                      <span className="rm-stop-tile">{o.id.slice(0, 8)}</span>
                    </li>
                  ))}
                </ul>
                <p className="rm-stop-note">{t('roadmap.stop.refusedNote')}</p>
              </div>
            )}

            {/* Requested peer ids that matched NO live tile. Distinct from a
                straggler, and rendered even when there is none of those: a
                straggler refused the stop, a missing target was never asked.
                Absent (not zero) when the caller targeted the whole fleet. */}
            {report.missing !== undefined && report.missing.length > 0 && (
              <div className="rm-stop-stragglers rm-stop-missing">
                <p className="rm-stop-note">
                  {t('roadmap.stop.missing', { count: report.missing.length })}
                </p>
                <ul>
                  {report.missing.map((p) => (
                    <li key={p}>
                      <span className="rm-stop-peer">{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Escalation copy sits with the BUTTON, not inside one of the
                blocks, because it now speaks for all three of them. Priority
                mirrors the pre-existing written-vs-stuck choice (neither is
                exhaustively enumerated for every combination, same as
                before): written wins when present, then a refused-only
                report gets its own honest hint ("nothing was sent" is a
                different fact from "still running"), else the generic
                still-busy hint. */}
            {report.mode !== 'hard' && targets.length > 0 && (
              <p className="rm-stop-note">
                {written.length > 0
                  ? t('roadmap.stop.escalateUnconfirmed', { count: targets.length })
                  : refused.length > 0
                    ? t('roadmap.stop.escalateRefused', { count: targets.length })
                    : t('roadmap.stop.escalateHint', { count: targets.length })}
              </p>
            )}
            {/* A target with no peer id cannot be named in `peerIds`. Saying so
                beats an escalation that silently skips it. */}
            {targets.length < escalatable.length && (
              <p className="rm-stop-note">
                {t('roadmap.stop.escalateNoPeer', { count: escalatable.length - targets.length })}
              </p>
            )}
          </>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>{t('common.close')}</button>
          {/* Escalation is a GESTURE, never automatic, and never offered on a
              report that already is the hard stop. */}
          {report && report.mode !== 'hard' && targets.length > 0 && (
            <button className="primary danger" onClick={() => onEscalate(targets)}>
              {t('roadmap.stop.hard')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
