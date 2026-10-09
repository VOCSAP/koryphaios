import { useState } from 'react'
import { hookRowsForTile } from '../../../shared/hook-await'
import { useDeck } from '../store'
import { useT } from '../i18n'
import { GLYPH_ACTIONS, GLYPH_BADGES } from './icons'
import { HookApprovalAnswer } from './HookApprovalAnswer'
import { ApprovalRequestBody } from './ApprovalRequestBody'
import { formQuestions } from './approval-answers'
import { canAnswerVerdict } from './verdict-remote'

/**
 * The answer a tile's own module waits on, docked over the bottom of the
 * terminal: the tile shows no native menu while it waits, so the panel opens
 * by itself for each new row. Folding is remembered for THAT row only, so a
 * newer row opens again. Two rows on one tile: the oldest is served first,
 * the others are counted and stay reachable in the Courrier.
 */
export function TileApprovalPanel({ tileId }: { tileId: string }): React.JSX.Element | null {
  const t = useT()
  const approvals = useDeck((s) => s.pendingApprovals)
  const remote = useDeck((s) => s.remote)
  const [foldedId, setFoldedId] = useState<string | null>(null)

  const rows = hookRowsForTile(approvals, tileId)
  const row = rows[0]
  if (!row || !canAnswerVerdict(remote)) return null
  const folded = foldedId === row.id
  const others = rows.length - 1

  return (
    <div
      className={`tile-approval${folded ? ' is-folded' : ''}`}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="tile-approval-head">
        <span className="tile-approval-glyph">{GLYPH_BADGES.clepsydra}</span>
        <span className="tile-approval-title">{row.title || t('inbox.familyBlocking')}</span>
        {others > 0 && <span className="tile-approval-more">{t('tile.approvalMore', { n: others })}</span>}
        <button
          type="button"
          className="icon-btn tile-approval-fold"
          title={t(folded ? 'tile.approvalUnfold' : 'tile.approvalFold')}
          aria-expanded={!folded}
          onClick={(e) => {
            e.stopPropagation()
            setFoldedId(folded ? null : row.id)
          }}
        >
          {folded ? GLYPH_ACTIONS.plus : GLYPH_ACTIONS.minus}
        </button>
      </div>
      {!folded && (
        <div className="tile-approval-body">
          {!formQuestions(row) && <ApprovalRequestBody approval={row} className="tile-approval-text" />}
          <HookApprovalAnswer key={row.id} approval={row} actionsClassName="tile-approval-actions approval-actions" />
        </div>
      )}
    </div>
  )
}
