import type { RoadmapQuery } from '@shared/types'
import { GLYPH_ACTIONS } from './icons'
import type { TFn } from '../i18n'

// Card 3b0fda5f: removable chips for every active criterion, reachable
// OUTSIDE the (collapsible, easy-to-forget-open) filter panel -- the
// operator should be able to see and clear an active filter without
// reopening the panel. Renders nothing at all when idle (zero criteria and
// `includeArchived` off), so it costs no layout space in the common case.
//
// Review round 2 (2026-08-10): `includeArchived` is a real, separate piece of
// state (the panel's dedicated toggle, card 3b0fda5f point 4), not a member
// of `criteria` -- it MUST be passed in and rendered as its own chip, or an
// active "show archived" is invisible outside the panel, and "Clear all"
// here must reset it too, or it silently diverges from the panel's own
// Clear (which resets both).

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
  t: TFn
}

export function RoadmapFilterChips({
  criteria,
  setCriteria,
  includeArchived,
  setIncludeArchived,
  t
}: RoadmapFilterChipsProps): React.JSX.Element | null {
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

  if (chips.length === 0) return null

  return (
    <div className="rm-filter-chips">
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
      <button
        type="button"
        className="rm-filter-chip rm-filter-chip-clear"
        onClick={() => {
          setCriteria({})
          setIncludeArchived(false)
        }}
      >
        {t('roadmap.filter.clearAll')}
      </button>
    </div>
  )
}
