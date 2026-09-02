import type { RoadmapQuery } from '@shared/types'
import { GLYPH_ACTIONS, GLYPH_BADGES } from './icons'
import type { TFn } from '../i18n'

// Removable chips for every active criterion, reachable outside the collapsible
// filter panel so an active filter is visible without reopening it.
// includeArchived is separate state that must be passed and rendered as its own
// chip, and Clear-all here must reset it too, or it silently diverges from the
// panel's own Clear.
// hideInactive is the deliberate inverse of includeArchived (archive hides by
// default and opts in, inactive shows by default and opts out) and renders here
// permanently, so this row never returns null even with zero criteria and
// archive off.

interface Chip {
  key: string
  label: string
  onRemove: () => void
}

const ARRAY_KEYS = ['kinds', 'statuses', 'priorities', 'efforts', 'values', 'tags'] as const

function removeFromArray<T extends string>(list: T[] | undefined, v: T): T[] | undefined {
  const next = (list ?? []).filter((x) => x !== v)
  return next.length > 0 ? next : undefined
}

// Dimension-prefixed label for each array key: efforts/values otherwise both
// render bare `t('roadmap.level.<v>')` ('high'/'high'), two chips reading
// identically with no way to tell which one a click would remove (review
// round 2, point 7). kinds/statuses/priorities are unambiguous on their own
// (their value sets never collide) but get the same prefix treatment for
// consistency rather than special-casing tags/kinds out of it.
const DIMENSION_LABEL: Record<(typeof ARRAY_KEYS)[number], string> = {
  kinds: 'roadmap.filter.kind',
  statuses: 'roadmap.filter.status',
  priorities: 'roadmap.filter.priority',
  efforts: 'roadmap.filter.effort',
  values: 'roadmap.filter.value',
  tags: 'roadmap.filter.tags'
}

const VALUE_KEY: Record<(typeof ARRAY_KEYS)[number], string> = {
  kinds: 'roadmap.kind',
  statuses: 'roadmap.status',
  priorities: 'roadmap.priority',
  efforts: 'roadmap.level',
  values: 'roadmap.level',
  tags: ''
}

export interface RoadmapFilterChipsProps {
  criteria: RoadmapQuery
  setCriteria: (next: RoadmapQuery) => void
  includeArchived: boolean
  setIncludeArchived: (next: boolean) => void
  /** Card 442084b7: opt-out display filter, default false (inactive cards show). */
  hideInactive: boolean
  setHideInactive: (next: boolean) => void
  /**
   * Card 442084b7 (review B1): how many cards this toggle is currently
   * hiding -- 0 whenever `hideInactive` is false. The toggle is the ONLY
   * reactivation entry point once a card is hidden (RoadmapItemModal has no
   * `inactive` control), so the count is what stops the operator from having
   * to guess it exists: the permanent chip itself says "N hidden", not just
   * on/off.
   */
  hiddenInactiveCount: number
  t: TFn
}

export function RoadmapFilterChips({
  criteria,
  setCriteria,
  includeArchived,
  setIncludeArchived,
  hideInactive,
  setHideInactive,
  hiddenInactiveCount,
  t
}: RoadmapFilterChipsProps): React.JSX.Element {
  const chips: Chip[] = []

  if (criteria.q && criteria.q.trim() !== '') {
    chips.push({
      key: 'q',
      label: `${t('roadmap.filter.search')}: ${criteria.q}`,
      onRemove: () => setCriteria({ ...criteria, q: undefined })
    })
  }

  for (const key of ARRAY_KEYS) {
    const values = criteria[key]
    if (!values) continue
    for (const v of values) {
      const valueLabel = key === 'tags' ? `#${v}` : t(`${VALUE_KEY[key]}.${v}`)
      chips.push({
        key: `${key}:${v}`,
        label: `${t(DIMENSION_LABEL[key])}: ${valueLabel}`,
        onRemove: () =>
          setCriteria({
            ...criteria,
            [key]: removeFromArray(values, v)
          })
      })
    }
  }

  if (includeArchived) {
    chips.push({
      key: 'includeArchived',
      label: t('roadmap.showArchived'),
      onRemove: () => setIncludeArchived(false)
    })
  }

  return (
    <div className="rm-filter-chips">
      {/* Permanent control (never gated behind chips.length): the operator
          must be able to hide inactive cards without any other filter
          active, and without opening the collapsible panel. The count in the
          label (review B1) is the ONLY signal that cards are hidden at all --
          without it, a card an operator just parked can vanish from the
          board with nothing on screen explaining why. torchOut/torchLit
          already name "reconnecting/host gone" in App.tsx's RemoteLinkOverlay,
          mounted as a SIBLING of this view in both the desktop and mobile
          trees (App.tsx), so it can be in the DOM at the same time as this
          badge/chip -- reused anyway (team-lead's call, deck-design pass, no
          icon in the registry fits "deliberately set aside" better). The
          overlay is a full-screen MODAL, `position:fixed; inset:0; z-index:
          5000` at 92% opacity with a 3px blur (styles.css's `.remote-overlay`)
          -- it visually covers and obscures everything beneath it while
          mounted, so the two glyphs are never both READABLE at once, even
          though both may exist in the DOM simultaneously. */}
      <button
        type="button"
        className={`rm-filter-chip rm-filter-chip-toggle${hideInactive ? ' is-on' : ''}`}
        title={t('roadmap.filter.hideInactiveHint')}
        aria-pressed={hideInactive}
        onClick={() => setHideInactive(!hideInactive)}
      >
        {GLYPH_BADGES.torchOut}
        <span className="rm-filter-chip-label">
          {t('roadmap.filter.hideInactive')}
          {hideInactive && hiddenInactiveCount > 0 ? ` (${hiddenInactiveCount})` : ''}
        </span>
      </button>
      {chips.map((c) => (
        <button
          type="button"
          key={c.key}
          className="rm-filter-chip"
          title={t('roadmap.filter.removeChip')}
          onClick={c.onRemove}
        >
          <span className="rm-filter-chip-label">{c.label}</span>
          {GLYPH_ACTIONS.close}
        </button>
      ))}
      {chips.length > 0 && (
        <button
          type="button"
          className="rm-filter-chip rm-filter-chip-clear"
          onClick={() => {
            setCriteria({})
            setIncludeArchived(false)
            setHideInactive(false)
          }}
        >
          {t('roadmap.filter.clearAll')}
        </button>
      )}
    </div>
  )
}
