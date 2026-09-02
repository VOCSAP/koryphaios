import { useState } from 'react'
import type {
  RoadmapFacetBucket,
  RoadmapFacets,
  RoadmapKind,
  RoadmapLevel,
  RoadmapPriority,
  RoadmapQuery,
  RoadmapStatus
} from '@shared/types'
import { GLYPH_ACTIONS, GLYPH_BADGES } from './icons'
import { KIND_ICONS } from './RoadmapItemModal'
import type { TFn } from '../i18n'

// Card 3b0fda5f: LEFT SIDE PANEL (not a modal), one collapsible section per
// filter dimension, checkbox + facet count per value, per-section Reset and
// a global Clear. Every "checkbox" here is the GLYPH_BADGES.checkboxOn/Off
// button pattern already used by ModelPicker's multi-select rows, never a
// native <input type="checkbox"> (DESIGN.md: no control keeps its native
// look). Facet counts come from roadmap-data.ts's always-unfiltered call A;
// a null `facets` (older broker) renders every row with no counter at all,
// never a false "(0)".

const KINDS: RoadmapKind[] = ['feature', 'bug', 'debt', 'idea', 'chore', 'directive']
// 'archived' is deliberately excluded (review round 2, point 4): the
// dedicated "show archived" toggle above already owns that dimension, and
// its facet count comes from the SAME reference set the toggle bypasses --
// measured against a real broker, checking this box showed "(0)" while
// clicking it returned 1 card, because `computeRoadmapFacets` counts over
// the include_archived-narrowed reference set while `statuses:['archived']`
// makes handleRoadmapList skip that narrowing entirely. Two controls for one
// dimension was the defect, not the mismatched count on its own.
const STATUSES: RoadmapStatus[] = ['idea', 'planned', 'in_progress', 'done']
const PRIORITIES: RoadmapPriority[] = ['must', 'should', 'could', 'wont']
const LEVELS: RoadmapLevel[] = ['low', 'medium', 'high']

function bucketCount(buckets: RoadmapFacetBucket[] | undefined, value: string): number | null {
  const b = buckets?.find((x) => x.value === value)
  return b ? b.count : null
}

function toggled<T extends string>(list: T[] | undefined, v: T): T[] {
  const cur = list ?? []
  return cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]
}

function FilterSection<T extends string>({
  titleKey,
  values,
  active,
  buckets,
  labelFor,
  iconFor,
  collapsed,
  onToggleCollapse,
  onToggleValue,
  onReset,
  bodyHead,
  emptyLabel,
  t
}: {
  titleKey: string
  values: readonly T[]
  active: T[]
  buckets: RoadmapFacetBucket[] | undefined
  labelFor: (v: T) => string
  iconFor?: (v: T) => React.JSX.Element | null
  collapsed: boolean
  onToggleCollapse: () => void
  onToggleValue: (v: T) => void
  onReset: () => void
  /** Rendered first inside the open body, above the checkbox rows (card
   *  7dde9434: the tag section's own sifting field). It lives INSIDE the body
   *  and not above the section head so that collapsing the section takes it
   *  away too -- a search box for a list that is not on screen is a control
   *  pointing at nothing. */
  bodyHead?: React.ReactNode
  /** Shown instead of the rows when `values` is empty. A section whose body
   *  can be narrowed needs this: silently rendering nothing reads as a broken
   *  panel, not as "no match". */
  emptyLabel?: string
  t: TFn
}): React.JSX.Element {
  return (
    <div className="rm-filter-section">
      {/* Review round 3 (2026-08-10), MINOR (D2/D3): the reset control used to
          be a `<span role="button">` NESTED INSIDE this row's own toggle
          `<button>` -- not focusable, not keyboard-activatable, and the only
          reason it was a span rather than a button in the first place (a real
          `<button>` cannot nest inside another `<button>`: invalid HTML, same
          reason BoardCard's priority chip in RoadmapBoard.tsx is a span, not a
          button). Fixed by pulling both controls out to siblings under a
          plain div instead of one wrapping the other, so the reset can be a
          genuine `<button>` without nesting. */}
      <div className="rm-filter-section-head">
        <button type="button" className="rm-filter-section-toggle" onClick={onToggleCollapse}>
          {t(titleKey)}
        </button>
        {active.length > 0 && (
          <button
            type="button"
            className="rm-filter-section-reset"
            onClick={(e) => {
              e.stopPropagation()
              onReset()
            }}
          >
            {t('roadmap.filter.reset')}
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="rm-filter-section-body">
          {bodyHead}
          {values.length === 0 && emptyLabel && (
            <div className="rm-filter-section-empty">{emptyLabel}</div>
          )}
          {values.map((v) => {
            const on = active.includes(v)
            const count = bucketCount(buckets, v)
            return (
              <button
                type="button"
                key={v}
                className={`rm-filter-value${on ? ' is-on' : ''}`}
                onClick={() => onToggleValue(v)}
              >
                {on ? GLYPH_BADGES.checkboxOn : GLYPH_BADGES.checkboxOff}
                <span className="rm-filter-value-label">
                  {iconFor?.(v)} {labelFor(v)}
                </span>
                {count !== null && <span className="rm-filter-value-count">{count}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export interface RoadmapFilterPanelProps {
  criteria: RoadmapQuery
  setCriteria: (next: RoadmapQuery) => void
  facets: RoadmapFacets | null
  includeArchived: boolean
  setIncludeArchived: (next: boolean) => void
  /** Panel folded to its rail (card 7a2e76c6), persisted in AppConfig. Named
   *  `folded` rather than `collapsed` for one local reason: this component
   *  already owns a `collapsed` map for its SECTIONS, and two different
   *  collapses under one word is how the wrong one gets read. The CSS class
   *  stays `rm-filter-panel-collapsed`, to match the shipped `.sidebar-collapsed`. */
  folded: boolean
  onToggleFold: () => void
  t: TFn
}

export function RoadmapFilterPanel({
  criteria,
  setCriteria,
  facets,
  includeArchived,
  setIncludeArchived,
  folded,
  onToggleFold,
  t
}: RoadmapFilterPanelProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ tags: true })
  const toggleSection = (key: string): void => setCollapsed((c) => ({ ...c, [key]: !c[key] }))

  // Query state lives next to collapsed, not inside FilterSection, because the
  // section's body unmounts when folded and would silently destroy any state
  // held inside it.
  // Filtering is purely local because computeRoadmapFacets selects tag buckets
  // with no limit or truncation — the renderer already holds the project's
  // whole tag set, so narrowing here cannot hide a value the operator could
  // reach otherwise.
  const [tagQuery, setTagQuery] = useState('')
  const tagNeedle = tagQuery.trim().toLowerCase()
  const activeTags = criteria.tags ?? []
  // An ACTIVE tag survives the needle. Making a checked box disappear under a
  // text filter is the classic trap of this pattern: the filter stays applied
  // to the board while the only control that undoes it is gone from the panel.
  const tagBuckets = (facets?.tags ?? []).filter(
    (b) => !tagNeedle || b.value.toLowerCase().includes(tagNeedle) || activeTags.includes(b.value)
  )

  return (
    // Never mounted conditionally: folding is a modifier class on the same
    // element, so the control that undoes the fold can live inside the panel
    // itself instead of a separate view far away.
    <aside className={`rm-filter-panel${folded ? ' rm-filter-panel-collapsed' : ''}`}>
      {/* Review round 3 (2026-08-10), MAJOR (D5/D6): this header used to carry
          its OWN "Clear all" button, a second one alongside the chip bar's
          (RoadmapFilterChips) -- a scrolled-out-of-view duplicate of a label
          the card's "reachable without opening the panel" requirement was
          already satisfied by the chip bar. Team-lead's ruling: remove this
          one, keep the chip bar's. */}
      <div className="rm-filter-panel-head">
        {/* The fold control comes FIRST and keeps the head's own left padding,
            so it sits at the same pixel folded and unfolded -- the rail width
            (--panel-rail-w) is the sum built around exactly that. */}
        <button
          type="button"
          className="icon-btn rm-filter-fold"
          aria-expanded={!folded}
          title={folded ? t('roadmap.filter.unfoldTitle') : t('roadmap.filter.foldTitle')}
          aria-label={folded ? t('roadmap.filter.unfoldTitle') : t('roadmap.filter.foldTitle')}
          onClick={onToggleFold}
        >
          {folded ? GLYPH_ACTIONS.filterUnfold : GLYPH_ACTIONS.filterFold}
        </button>
        {!folded && (
          <span className="rm-filter-panel-title">
            {GLYPH_ACTIONS.search} {t('roadmap.filter.title')}
          </span>
        )}
      </div>

      {/* Folded, the body is NOT rendered rather than hidden with `display:
          none`: hidden content keeps its tab order, so a folded panel would
          still hand the operator its filters through the keyboard. Same choice
          as the Agents sidebar, which drops its rows in JSX for that reason.

          Unmounting the body normally DESTROYS the state its children hold.
          Here the per-section fold state survives a fold/unfold cycle
          (measured), but read that as a CONDITION, not as a guarantee, because
          nothing in this file enforces it: it holds only as long as
          `collapsed`/`setCollapsed` above live on THIS component and not
          inside the body. Extract a section into a child that owns its own
          `useState` and the preservation disappears the same day, silently --
          no test, no typecheck and no visual review would catch it, since the
          panel still renders correctly. The check is three gestures: fold one
          section, fold the panel, unfold it, and see whether that section is
          still folded. */}
      {!folded && (
        <>
          <button
            type="button"
            className="rm-filter-row rm-filter-archived-toggle"
            onClick={() => setIncludeArchived(!includeArchived)}
          >
            {includeArchived ? GLYPH_BADGES.checkboxOn : GLYPH_BADGES.checkboxOff}
            <span>{t('roadmap.showArchived')}</span>
          </button>

          {/* Review round 3 (2026-08-10), MAJOR (A3): moved AFTER the archived
              toggle (card's specified order) and given an embedded clear button
              -- previously the only way to clear a typed query was to select and
              delete it by hand. */}
          <label className="field rm-filter-search">
            <span>{t('roadmap.filter.search')}</span>
            <span className="rm-filter-search-row">
              {/* Review round 3 web-designer pass (2026-08-10), BLOCKING: the
                  clear button used to be a flex SIBLING of the input, pushed out
                  of the panel's clipping box the moment the input's intrinsic
                  width (value text) exceeded the panel's available width --
                  unclickable, invisible without scrolling. Embedding it
                  absolutely INSIDE the input's own box means it can never
                  overflow the row, by construction, regardless of panel width. */}
              <input
                className="rm-filter-search-input"
                value={criteria.q ?? ''}
                placeholder={t('roadmap.filter.searchPlaceholder')}
                onChange={(e) => setCriteria({ ...criteria, q: e.target.value || undefined })}
              />
              {criteria.q && (
                <button
                  type="button"
                  className="icon-btn rm-filter-search-clear"
                  title={t('roadmap.filter.clearSearch')}
                  onClick={() => setCriteria({ ...criteria, q: undefined })}
                >
                  {GLYPH_ACTIONS.close}
                </button>
              )}
            </span>
          </label>

          <FilterSection
            titleKey="roadmap.filter.kind"
            values={KINDS}
            active={criteria.kinds ?? []}
            buckets={facets?.kind}
            labelFor={(v) => t(`roadmap.kind.${v}`)}
            iconFor={(v) => KIND_ICONS[v]}
            collapsed={!!collapsed.kinds}
            onToggleCollapse={() => toggleSection('kinds')}
            onToggleValue={(v) => setCriteria({ ...criteria, kinds: toggled(criteria.kinds, v) })}
            onReset={() => setCriteria({ ...criteria, kinds: undefined })}
            t={t}
          />
          <FilterSection
            titleKey="roadmap.filter.status"
            values={STATUSES}
            active={criteria.statuses ?? []}
            buckets={facets?.status}
            labelFor={(v) => t(`roadmap.status.${v}`)}
            collapsed={!!collapsed.statuses}
            onToggleCollapse={() => toggleSection('statuses')}
            onToggleValue={(v) => setCriteria({ ...criteria, statuses: toggled(criteria.statuses, v) })}
            onReset={() => setCriteria({ ...criteria, statuses: undefined })}
            t={t}
          />
          <FilterSection
            titleKey="roadmap.filter.priority"
            values={PRIORITIES}
            active={criteria.priorities ?? []}
            buckets={facets?.priority}
            labelFor={(v) => t(`roadmap.priority.${v}`)}
            collapsed={!!collapsed.priorities}
            onToggleCollapse={() => toggleSection('priorities')}
            onToggleValue={(v) =>
              setCriteria({ ...criteria, priorities: toggled(criteria.priorities, v) })
            }
            onReset={() => setCriteria({ ...criteria, priorities: undefined })}
            t={t}
          />
          <FilterSection
            titleKey="roadmap.filter.effort"
            values={LEVELS}
            active={criteria.efforts ?? []}
            buckets={facets?.effort}
            labelFor={(v) => t(`roadmap.level.${v}`)}
            collapsed={!!collapsed.efforts}
            onToggleCollapse={() => toggleSection('efforts')}
            onToggleValue={(v) => setCriteria({ ...criteria, efforts: toggled(criteria.efforts, v) })}
            onReset={() => setCriteria({ ...criteria, efforts: undefined })}
            t={t}
          />
          <FilterSection
            titleKey="roadmap.filter.value"
            values={LEVELS}
            active={criteria.values ?? []}
            buckets={facets?.value}
            labelFor={(v) => t(`roadmap.level.${v}`)}
            collapsed={!!collapsed.values}
            onToggleCollapse={() => toggleSection('values')}
            onToggleValue={(v) => setCriteria({ ...criteria, values: toggled(criteria.values, v) })}
            onReset={() => setCriteria({ ...criteria, values: undefined })}
            t={t}
          />

          {facets && facets.tags.length > 0 && (
            <FilterSection
              titleKey="roadmap.filter.tags"
              values={tagBuckets.map((b) => b.value)}
              active={activeTags}
              // Counts still come from the UNNARROWED facet list: the needle
              // decides which rows are shown, never what a row says.
              buckets={facets.tags}
              labelFor={(v) => `#${v}`}
              collapsed={!!collapsed.tags}
              onToggleCollapse={() => toggleSection('tags')}
              onToggleValue={(v) => setCriteria({ ...criteria, tags: toggled(criteria.tags, v) })}
              onReset={() => setCriteria({ ...criteria, tags: undefined })}
              emptyLabel={t('roadmap.filter.tagSearchEmpty')}
              bodyHead={
                /* Deliberately NOT shaped like the card search above: that one
                   wears a stacked "Search" label and reaches the broker, this
                   one wears the lens inside its own box and only sifts what is
                   already on screen. Two identically-labelled fields a few
                   centimetres apart, with two different reaches, is exactly the
                   confusion the difference in shape exists to prevent -- hence
                   no visible label here, and a placeholder that names its own
                   scope. */
                <label className="rm-tag-search">
                  <span className="rm-tag-search-icon" aria-hidden="true">
                    {GLYPH_ACTIONS.search}
                  </span>
                  <input
                    className="rm-tag-search-input"
                    value={tagQuery}
                    placeholder={t('roadmap.filter.tagSearchPlaceholder')}
                    aria-label={t('roadmap.filter.tagSearchLabel')}
                    onChange={(e) => setTagQuery(e.target.value)}
                  />
                  {tagQuery && (
                    <button
                      type="button"
                      className="icon-btn rm-tag-search-clear"
                      title={t('roadmap.filter.tagSearchClear')}
                      aria-label={t('roadmap.filter.tagSearchClear')}
                      onClick={() => setTagQuery('')}
                    >
                      {GLYPH_ACTIONS.close}
                    </button>
                  )}
                </label>
              }
              t={t}
            />
          )}
        </>
      )}
    </aside>
  )
}
