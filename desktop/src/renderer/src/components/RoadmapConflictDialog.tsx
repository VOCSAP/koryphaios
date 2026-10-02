import { useEffect, useMemo, useRef, useState } from 'react'
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

const MOVE_STEP = 16
/** Pixels of the dialog that must stay on screen, so its header can always be grabbed
 *  back: the parked strip also holds the 33px close cross, which never starts a drag. */
const KEEP_VISIBLE = 120

interface Offset {
  x: number
  y: number
}

/** Bounds a move from `from` to `to`: the top never climbs above the backdrop (the
 *  status banner), and at least KEEP_VISIBLE px stay inside the window. */
function clampOffset(modal: HTMLElement, from: Offset, to: Offset): Offset {
  const r = modal.getBoundingClientRect()
  const floor = modal.parentElement?.getBoundingClientRect().top ?? 0
  const left = r.left - from.x + to.x
  const top = r.top - from.y + to.y
  const clampedLeft = Math.min(
    Math.max(left, KEEP_VISIBLE - r.width),
    window.innerWidth - KEEP_VISIBLE
  )
  const clampedTop = Math.min(Math.max(top, floor), window.innerHeight - KEEP_VISIBLE)
  return { x: to.x + clampedLeft - left, y: to.y + clampedTop - top }
}

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.matches('input, textarea') ||
    target.isContentEditable ||
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  )
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
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ px: number; py: number; start: Offset } | null>(null)

  const conflict = openId === null ? null : (conflicts.find((c) => c.local.id === openId) ?? null)
  const isOpen = conflict !== null

  useEffect(() => {
    setOffset({ x: 0, y: 0 })
  }, [openId])

  // The dialog stacks over the card modal, which also closes on Escape from a
  // window listener: capture phase + stopPropagation makes one Escape close one
  // layer. Registered only while open, or it would swallow every Escape in the app,
  // and blind to text fields outside the dialog, whose own onKeyDown owns Escape.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (isTextField(e.target) && !modalRef.current?.contains(e.target as Node)) return
      e.stopPropagation()
      open(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [isOpen, open])

  useEffect(() => {
    if (!isOpen) return
    const onResize = (): void => {
      setOffset((o) => (modalRef.current ? clampOffset(modalRef.current, o, o) : o))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [isOpen])

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

  const moveTo = (to: Offset): void => {
    if (modalRef.current) setOffset(clampOffset(modalRef.current, offset, to))
  }

  const onHeadPointerDown = (e: React.PointerEvent<HTMLElement>): void => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { px: e.clientX, py: e.clientY, start: offset }
    setDragging(true)
  }
  const onHeadPointerMove = (e: React.PointerEvent<HTMLElement>): void => {
    const d = drag.current
    if (!d) return
    moveTo({ x: d.start.x + e.clientX - d.px, y: d.start.y + e.clientY - d.py })
  }
  const onHeadPointerUp = (): void => {
    drag.current = null
    setDragging(false)
  }
  const onHeadKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (e.target !== e.currentTarget) return
    const step: Record<string, Offset> = {
      ArrowLeft: { x: -MOVE_STEP, y: 0 },
      ArrowRight: { x: MOVE_STEP, y: 0 },
      ArrowUp: { x: 0, y: -MOVE_STEP },
      ArrowDown: { x: 0, y: MOVE_STEP }
    }
    const s = step[e.key]
    if (!s) return
    e.preventDefault()
    moveTo({ x: offset.x + s.x, y: offset.y + s.y })
  }

  return (
    <div
      className="modal-backdrop rm-conflict-backdrop"
      onMouseDown={() => {
        // Over a card modal a click outside is aimed at that card, which stays usable.
        if (!document.querySelector('.rm-modal')) open(null)
      }}
    >
      <div
        ref={modalRef}
        className={`modal rm-conflict-modal${dragging ? ' is-dragging' : ''}`}
        style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header
          className="modal-head"
          tabIndex={0}
          onPointerDown={onHeadPointerDown}
          onPointerMove={onHeadPointerMove}
          onPointerUp={onHeadPointerUp}
          onPointerCancel={onHeadPointerUp}
          onKeyDown={onHeadKeyDown}
        >
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
