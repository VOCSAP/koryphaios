import { useEffect, useMemo, useState } from 'react'
import type { RoadmapSyncResolution } from '@shared/types'
import {
  ROADMAP_SYNC_RESOLUTIONS,
  conflictFieldDiffs,
  formatSyncValue,
  type SyncValueLabels
} from '@shared/roadmap-sync'
import { useDeck } from '../store'
import { useT, type TFn } from '../i18n'
import { GLYPH_ACTIONS, GLYPH_BADGES } from './icons'

// Offline replica: the operator arbitrates ONE card that changed on both sides.
// No ConfirmDialog guard on the three choices, deliberately: 'remote' and
// 'local' DO discard the other side's edits, but the full field-by-field diff
// is on screen right above the buttons and each button states its consequence,
// so a second dialog would only repeat what the operator has just read.

/** One choice: its channel value, its label and the one line explaining it. */
const CHOICE_KEYS: Record<RoadmapSyncResolution, { label: string; hint: string }> = {
  remote: { label: 'roadmap.sync.chooseRemote', hint: 'roadmap.sync.chooseRemoteHint' },
  local: { label: 'roadmap.sync.chooseLocal', hint: 'roadmap.sync.chooseLocalHint' },
  merge_reopen: { label: 'roadmap.sync.chooseMerge', hint: 'roadmap.sync.chooseMergeHint' }
}

function valueLabels(t: TFn): SyncValueLabels {
  return {
    empty: t('roadmap.sync.valueEmpty'),
    none: t('roadmap.sync.valueNone'),
    yes: t('roadmap.sync.valueYes'),
    no: t('roadmap.sync.valueNo')
  }
}

export function RoadmapConflictDialog(): React.JSX.Element | null {
  const t = useT()
  const openId = useDeck((s) => s.roadmapConflictId)
  const conflicts = useDeck((s) => s.roadmapSync.conflicts)
  const open = useDeck((s) => s.openRoadmapConflict)
  const resolve = useDeck((s) => s.resolveRoadmapConflict)
  const [busy, setBusy] = useState(false)

  const conflict = openId === null ? null : (conflicts.find((c) => c.local.id === openId) ?? null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') open(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // The poll owns the list: a conflict arbitrated from another Deck (or by the
  // sweep's auto-resolution) simply stops being served, and the dialog must
  // close rather than keep offering three buttons over a card that is settled.
  useEffect(() => {
    if (openId !== null && conflict === null) open(null)
  }, [openId, conflict, open])

  const diffs = useMemo(() => (conflict ? conflictFieldDiffs(conflict) : []), [conflict])

  if (!conflict) return null
  const labels = valueLabels(t)
  const hasBase = conflict.base !== null

  const choose = async (choice: RoadmapSyncResolution): Promise<void> => {
    setBusy(true)
    try {
      // resolveRoadmapConflict goes through the store's guarded(): a failure
      // is logged and toasted there, never thrown back here.
      await resolve(conflict.local.id, choice)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => open(null)}>
      <div className="modal rm-conflict-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>
            {t('roadmap.sync.dialogTitle')} — {conflict.local.title}
          </h2>
          <button className="icon-btn" title={t('common.close')} onClick={() => open(null)}>
            {GLYPH_ACTIONS.close}
          </button>
        </header>

        <p className="rm-conflict-intro">{t('roadmap.sync.dialogIntro')}</p>
        {!hasBase && <p className="rm-conflict-nobase">{t('roadmap.sync.noBase')}</p>}

        <div className={`rm-conflict-diff${hasBase ? ' rm-conflict-with-base' : ''}`}>
          <div className="rm-conflict-row rm-conflict-head">
            <span className="rm-conflict-field">{t('roadmap.sync.colField')}</span>
            <span className="rm-conflict-side">{t('roadmap.sync.colLocal')}</span>
            <span className="rm-conflict-side">{t('roadmap.sync.colRemote')}</span>
            {hasBase && <span className="rm-conflict-side">{t('roadmap.sync.colBase')}</span>}
          </div>
          {diffs.length === 0 && <p className="rm-conflict-nodiff">{t('roadmap.sync.noDiff')}</p>}
          {diffs.map((d) => (
            <div
              key={d.field}
              className={`rm-conflict-row${d.transition ? ' rm-conflict-row-transition' : ''}`}
            >
              <span className="rm-conflict-field">
                {t(`roadmap.sync.field.${d.field}`)}
                {d.transition && (
                  <span className="rm-conflict-lifecycle">{t('roadmap.sync.lifecycle')}</span>
                )}
              </span>
              <span className={`rm-conflict-side${d.localChanged ? ' is-changed' : ''}`}>
                {formatSyncValue(d.local, labels)}
                {d.localChanged && (
                  <span className="rm-conflict-mark">{t('roadmap.sync.changedHere')}</span>
                )}
              </span>
              <span className={`rm-conflict-side${d.remoteChanged ? ' is-changed' : ''}`}>
                {formatSyncValue(d.remote, labels)}
                {d.remoteChanged && (
                  <span className="rm-conflict-mark">{t('roadmap.sync.changedUpstream')}</span>
                )}
              </span>
              {hasBase && (
                <span className="rm-conflict-side rm-conflict-base">
                  {formatSyncValue(d.base, labels)}
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="rm-conflict-choices">
          {ROADMAP_SYNC_RESOLUTIONS.map((choice) => (
            <button
              key={choice}
              type="button"
              className="rm-conflict-choice"
              disabled={busy}
              onClick={() => void choose(choice)}
            >
              <span className="rm-conflict-choice-label">
                {GLYPH_BADGES.scales} {t(CHOICE_KEYS[choice].label)}
              </span>
              <span className="rm-conflict-choice-hint">{t(CHOICE_KEYS[choice].hint)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
