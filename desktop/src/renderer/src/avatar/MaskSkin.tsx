import { useId } from 'react'
import type { AvatarDeckStatus, AvatarSummary } from '@shared/avatar-state'
import {
  BADGE,
  EYE_CENTERS,
  FACE_GEOMETRY,
  FIGURE_VIEWBOX,
  HALO_SCALE,
  MASK_CENTER,
  MASK_CRACK,
  MASK_NOSE,
  MASK_ORIGIN,
  MASK_OUTLINE,
  PILL,
  STAGE,
  STAGE_MARKER,
  stageMarkerSize,
  stagePoint,
  stageSlots,
  type FaceGeometry
} from '@shared/avatar-mask-geometry'
import { GLYPHS, GLYPH_BADGES } from '../components/icons'

export const PILL_KINDS = ['fault', 'lost', 'quota', 'working', 'idle'] as const

export type AvatarPillKind = (typeof PILL_KINDS)[number]

/** One marker per deck, the most urgent condition of that deck alone. */
export function pillKind(deck: AvatarDeckStatus): AvatarPillKind {
  if (deck.torchOut) return 'fault'
  if (deck.counters.exited > 0) return 'lost'
  if (deck.counters.rateLimited > 0) return 'quota'
  if (deck.counters.working > 0) return 'working'
  return 'idle'
}

export function deckIdentityKey(deck: AvatarDeckStatus): string {
  return JSON.stringify([deck.identity.deckRunId, deck.identity.broker_url])
}

const URGENCY: Record<AvatarPillKind, number> = { fault: 0, lost: 1, quota: 2, working: 3, idle: 4 }

/** Past the stage capacity, the most urgent decks keep a slot (in their own
 * order) and the rest is counted by the "+N" marker. */
export function stageDecks(decks: AvatarDeckStatus[]): { shown: AvatarDeckStatus[]; hidden: number } {
  if (decks.length <= STAGE_MARKER.capacity) return { shown: decks, hidden: 0 }
  const keep = STAGE_MARKER.capacity - 1
  const kept = decks
    .map((deck, index) => ({ deck, index }))
    .sort((a, b) => URGENCY[pillKind(a.deck)] - URGENCY[pillKind(b.deck)] || a.index - b.index)
    .slice(0, keep)
    .sort((a, b) => a.index - b.index)
  return { shown: kept.map((entry) => entry.deck), hidden: decks.length - keep }
}

function badgeCount(value: number): string {
  return value > 99 ? '99+' : String(value)
}

const PILL_GLYPHS = {
  fault: GLYPH_BADGES.torchOut,
  lost: GLYPH_BADGES.warning,
  quota: GLYPH_BADGES.clepsydra
} as const

function GlyphAt({ x, y, size, children }: { x: number; y: number; size: number; children: React.ReactNode }): React.JSX.Element {
  const s = size / 24
  return <g transform={`translate(${x - size / 2} ${y - size / 2}) scale(${s})`}>{children}</g>
}

function Pill({ deck, t, size }: { deck: AvatarDeckStatus; t: number; size: number }): React.JSX.Element {
  const kind = pillKind(deck)
  const { x, y } = stagePoint(t)
  const base = y - PILL.lift
  const key = deckIdentityKey(deck)
  if (kind === 'fault' || kind === 'lost' || kind === 'quota') {
    return (
      <g className={`avatar-pill-glyph is-${kind}`} data-deck={key} data-kind={kind}>
        <g className="avatar-glyph-under">
          <GlyphAt x={x} y={base - size / 2} size={size}>{PILL_GLYPHS[kind]}</GlyphAt>
        </g>
        <GlyphAt x={x} y={base - size / 2} size={size}>{PILL_GLYPHS[kind]}</GlyphAt>
      </g>
    )
  }
  return (
    <rect
      className={`avatar-pill is-${kind}`}
      data-deck={key}
      data-kind={kind}
      x={x - PILL.width / 2}
      y={base - PILL.height}
      width={PILL.width}
      height={PILL.height}
      rx={PILL.width / 2}
    />
  )
}

function Strokes({ g, clipIds }: { g: FaceGeometry; clipIds: readonly [string, string] }): React.JSX.Element {
  return (
    <>
      <path className="avatar-outline" d={MASK_OUTLINE} />
      <path className="avatar-brow" d={g.brows} />
      <path className="avatar-opening" d={g.eyes[0]} />
      <path className="avatar-opening" d={g.eyes[1]} />
      {g.gaze &&
        EYE_CENTERS.map((c, i) => (
          <g key={i} clipPath={`url(#${clipIds[i]})`}>
            <circle className="avatar-gaze" cx={c.x + g.gaze!.dx} cy={c.y + g.gaze!.dy} r={3} />
          </g>
        ))}
      <path className="avatar-nose" d={MASK_NOSE} />
      <path className="avatar-opening" d={g.mouth} />
      {g.crack && <path className="avatar-crack" d={MASK_CRACK} />}
    </>
  )
}

export function MaskSkin({ summary }: { summary: AvatarSummary }): React.JSX.Element {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const g: FaceGeometry = FACE_GEOMETRY[summary.face]
  const cutId = `${uid}-cut`
  const clipIds = [`${uid}-eye-l`, `${uid}-eye-r`] as const
  const stage = stageDecks(summary.decks)
  const slotCount = stage.shown.length + (stage.hidden > 0 ? 1 : 0)
  const slots = stageSlots(slotCount)
  const markerSize = stageMarkerSize(slotCount)
  const overflowAt = stage.hidden > 0 ? stagePoint(slots[slotCount - 1]!) : null
  const rotate = g.tilt === 0 ? '' : ` rotate(${g.tilt} ${MASK_CENTER.x} ${MASK_CENTER.y})`
  const stageLine = `M${STAGE.p0.x} ${STAGE.p0.y}Q${STAGE.p1.x} ${STAGE.p1.y} ${STAGE.p2.x} ${STAGE.p2.y}`
  const badges: React.JSX.Element[] = []
  if (summary.counters.waiting > 0) {
    const cy = BADGE.rows[badges.length]!
    badges.push(
      <g key="waiting" className="avatar-badge is-waiting" data-count={summary.counters.waiting}>
        <circle className="avatar-badge-knockout" cx={BADGE.cx} cy={cy} r={BADGE.knockout} />
        <circle className="avatar-badge-disc" cx={BADGE.cx} cy={cy} r={BADGE.r} />
        <text className="avatar-badge-text" x={BADGE.cx} y={cy + 5} textAnchor="middle">{badgeCount(summary.counters.waiting)}</text>
      </g>
    )
  }
  if (summary.unread > 0) {
    const cy = BADGE.rows[badges.length]!
    badges.push(
      <g key="unread" className="avatar-badge is-unread" data-count={summary.unread}>
        <circle className="avatar-badge-knockout" cx={BADGE.cx} cy={cy} r={BADGE.knockout} />
        <circle className="avatar-badge-disc" cx={BADGE.cx} cy={cy} r={BADGE.r} />
        <g className="avatar-badge-glyph">
          <GlyphAt x={BADGE.cx - 2} y={cy} size={16}>{GLYPHS.inbox}</GlyphAt>
        </g>
        <text className="avatar-badge-text is-small" x={BADGE.cx + 6} y={cy + 9} textAnchor="middle">{badgeCount(summary.unread)}</text>
      </g>
    )
  }

  return (
    <svg
      className="avatar-skin"
      data-face={summary.face}
      viewBox={`${FIGURE_VIEWBOX.x} ${FIGURE_VIEWBOX.y} ${FIGURE_VIEWBOX.width} ${FIGURE_VIEWBOX.height}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <mask id={cutId} maskUnits="userSpaceOnUse" x={-20} y={-20} width={140} height={150}>
          <rect x={-20} y={-20} width={140} height={150} fill="#fff" />
          <path d={g.eyes[0]} fill="#000" />
          <path d={g.eyes[1]} fill="#000" />
          <path d={g.mouth} fill="#000" />
        </mask>
        <clipPath id={clipIds[0]}>
          <path d={g.eyes[0]} />
        </clipPath>
        <clipPath id={clipIds[1]}>
          <path d={g.eyes[1]} />
        </clipPath>
      </defs>
      <g className="avatar-stage" data-empty={summary.decks.length === 0 ? 'true' : 'false'}>
        <path className="avatar-stage-line" d={stageLine} />
        {stage.shown.map((deck, i) => (
          <Pill key={deckIdentityKey(deck)} deck={deck} t={slots[i]!} size={markerSize} />
        ))}
        {overflowAt && (
          <text className="avatar-stage-overflow" data-overflow={stage.hidden} x={overflowAt.x} y={overflowAt.y - PILL.lift - 3} textAnchor="middle">
            +{stage.hidden}
          </text>
        )}
      </g>
      <g transform={`translate(${MASK_ORIGIN.x} ${MASK_ORIGIN.y})${rotate}`}>
        <g className="avatar-face">
          {g.halo && (
            <g
              className="avatar-halo"
              transform={`translate(${MASK_CENTER.x} ${MASK_CENTER.y}) scale(${HALO_SCALE}) translate(${-MASK_CENTER.x} ${-MASK_CENTER.y})`}
            >
              <path className="avatar-halo-under" d={MASK_OUTLINE} />
              <path className="avatar-halo-ink" d={MASK_OUTLINE} />
            </g>
          )}
          <path className="avatar-plate" d={MASK_OUTLINE} mask={`url(#${cutId})`} />
          <g className="avatar-under">
            <Strokes g={g} clipIds={clipIds} />
          </g>
          <g className="avatar-ink">
            <Strokes g={g} clipIds={clipIds} />
          </g>
        </g>
      </g>
      {badges}
    </svg>
  )
}
