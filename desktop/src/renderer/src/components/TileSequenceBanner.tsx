import type { SequenceWaitingDirective, SessionSequenceView } from '../../../shared/types'
import { useDeck } from '../store'
import { useT, type TFn } from '../i18n'
import { stopFamily } from '../sequence-stop-family'
import { GLYPH_ACTIONS, GLYPH_BADGES } from './icons'

/** A label, never the command: magic_compact may end up typing /compact, so the name cannot predict it. */
function directiveLabel(t: TFn, directive: SequenceWaitingDirective): string {
  return t(`tile.seqDirective.${directive}`)
}

function momentLabel(t: TFn, view: SessionSequenceView): string {
  if (view.moment !== 'stop' || !view.mode) return t(`tile.seqMoment.${view.moment}`)
  return t(view.mode === 'soft' ? 'tile.seqMoment.stopSoft' : 'tile.seqMoment.stopHard')
}

/** No timer hides a done or stopped view: it would hide a stop nobody read. */
export function TileSequenceBanner({ tileId }: { tileId: string }): React.JSX.Element | null {
  const t = useT()
  const view = useDeck((s) => s.sessionSequences[tileId])
  const remote = useDeck((s) => s.remote)
  const inFlight = useDeck((s) => s.sequenceActionsInFlight[tileId] === true)
  const cancelSequence = useDeck((s) => s.cancelSequence)
  const overrideSequence = useDeck((s) => s.overrideSequence)
  const dismissSequence = useDeck((s) => s.dismissSequence)
  if (!view) return null

  const total = String(view.total)
  const live = view.phase === 'running' || view.phase === 'waiting-background'
  const family = view.phase === 'stopped' ? stopFamily(view.reason) : null
  const waiting = view.waitingDirectives
  const queued =
    waiting.length === 0 ? null : t('tile.seqDirectiveQueued', { directives: waiting.map((d) => directiveLabel(t, d)).join(', ') })

  let glyph: React.JSX.Element
  let text: string
  if (view.phase === 'running') {
    glyph = GLYPH_BADGES.salpinx
    text = t('tile.seqRunning', { moment: momentLabel(t, view), step: String(view.step + 1), total })
  } else if (view.phase === 'waiting-background') {
    glyph = GLYPH_BADGES.clepsydra
    text =
      view.background === null
        ? t('tile.seqWaitingNoCount')
        : t('tile.seqWaiting', { count: String(view.background) })
  } else if (view.phase === 'done') {
    glyph = GLYPH_ACTIONS.check
    text = view.total === 1 ? t('tile.seqDoneOne') : t('tile.seqDone', { total })
  } else {
    glyph = GLYPH_BADGES.warning
    text = t('tile.seqStopped', {
      step: String(Math.min(view.step + 1, view.total)),
      total,
      family: t(`tile.seqFamily.${family!.family}`)
    })
  }

  const act =
    (fn: () => unknown) =>
    (e: React.MouseEvent): void => {
      e.stopPropagation()
      void fn()
    }

  return (
    <div
      className={`tile-seq tile-seq-${view.phase}${family?.fault ? ' is-fault' : ''}`}
      role="status"
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <span className="tile-seq-glyph">{glyph}</span>
      <span className="tile-seq-text" title={text}>
        {text}
      </span>
      {family && view.reason && <code className="tile-seq-code">{view.reason}</code>}
      {queued && (
        <span className="tile-seq-queued" title={queued}>
          <span className="tile-seq-queued-glyph">{GLYPH_BADGES.clepsydra}</span>
          <span className="tile-seq-queued-text">{queued}</span>
        </span>
      )}
      <span className="tile-seq-actions">
        {view.phase === 'waiting-background' && !remote && (
          <button type="button" className="btn btn-sm" disabled={inFlight} onClick={act(() => overrideSequence(tileId))}>
            {t('tile.seqOverride')}
          </button>
        )}
        {live ? (
          <button type="button" className="btn btn-sm" disabled={inFlight} onClick={act(() => cancelSequence(tileId))}>
            {t('common.cancel')}
          </button>
        ) : (
          <button type="button" className="btn btn-sm" onClick={act(() => dismissSequence(tileId))}>
            {t('common.close')}
          </button>
        )}
      </span>
    </div>
  )
}
