// Two polls against the broker's single /roadmap/list endpoint, never one: call
// A (no filter criteria) is the queue truth and facet reference set, call B is
// debounced 250ms and only fires once a criterion is active.
// With zero active criteria the board is call A's result directly, so an idle
// filter panel costs nothing extra.
// queueSourceOf is minted only here; every reorder call site downstream
// receives the already-branded queue, never the raw array.

import { useCallback, useEffect, useState } from 'react'
import type { RoadmapFacets, RoadmapItem, RoadmapQuery } from '@shared/types'
import { queueSourceOf, type QueueSource } from '@shared/workflow'

const POLL_MS = 5000
const DEBOUNCE_MS = 250

/**
 * Any dimension set (beyond the orthogonal `include_archived`) counts as
 * active. Exported (review round 3, D1) so RoadmapView/RoadmapBoard can tell
 * "the roadmap is truly empty" apart from "these filters matched nothing"
 * without re-deriving this predicate a second time and risking drift.
 */
export function hasActiveCriteria(c: RoadmapQuery): boolean {
  return Boolean(
    c.kind ||
      c.status ||
      c.priority ||
      c.tag ||
      c.kinds?.length ||
      c.statuses?.length ||
      c.priorities?.length ||
      c.efforts?.length ||
      c.values?.length ||
      c.tags?.length ||
      (c.q && c.q.trim() !== '')
  )
}

export interface RoadmapData {
  /** Call A's result when no criterion is active, otherwise call B's narrowed result. */
  board: RoadmapItem[]
  /** Facet counts over call A's reference set; null when the broker sent none. */
  facets: RoadmapFacets | null
  /** The TRUE unfiltered queue, branded -- the sole input every reorder builder accepts. */
  queue: QueueSource
  criteria: RoadmapQuery
  setCriteria: (next: RoadmapQuery) => void
  includeArchived: boolean
  setIncludeArchived: (next: boolean) => void
  refresh: () => Promise<void>
  error: string | null
  loaded: boolean
}

export interface UseRoadmapDataOptions {
  /**
   * Whether call A requests facet counts (default true). Review round 2,
   * NIT point 8: RoadmapList.tsx (mobile) renders no filter panel and shows
   * no facet counter at all, but was still requesting `with_facets: true`
   * on every 5s poll -- the broker computes 6 aggregates + a COUNT for
   * nothing every time. The desktop kanban (RoadmapView.tsx) keeps the
   * default; only mobile opts out.
   */
  facets?: boolean
}

export function useRoadmapData(options: UseRoadmapDataOptions = {}): RoadmapData {
  const withFacets = options.facets ?? true
  const [all, setAll] = useState<RoadmapItem[]>([])
  const [facets, setFacets] = useState<RoadmapFacets | null>(null)
  const [board, setBoard] = useState<RoadmapItem[]>([])
  const [criteria, setCriteria] = useState<RoadmapQuery>({})
  const [includeArchived, setIncludeArchived] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  // Call A: unfiltered, polled while the view is mounted (agents write any time).
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await window.api.roadmapSearch({
        include_archived: includeArchived,
        with_facets: withFacets
      })
      setAll(res.items)
      setFacets(res.facets)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoaded(true)
    }
  }, [includeArchived, withFacets])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  // Call B: debounced, gated on >=1 active criterion. Zero criteria -> board
  // tracks call A directly and this effect never touches the network.
  const active = hasActiveCriteria(criteria)
  useEffect(() => {
    if (!active) {
      setBoard(all)
      return
    }
    const timer = setTimeout(() => {
      void window.api
        .roadmapSearch({ include_archived: includeArchived, ...criteria })
        .then((res) => setBoard(res.items))
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [active, criteria, includeArchived, all])

  return {
    board,
    facets,
    queue: queueSourceOf(all),
    criteria,
    setCriteria,
    includeArchived,
    setIncludeArchived,
    refresh,
    error,
    loaded
  }
}
