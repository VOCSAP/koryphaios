import type { RoadmapDateField, RoadmapDateFilter } from '@shared/types'

export type DatePreset = 'today' | '7d' | '30d'

export type DateFilterShape =
  | { kind: 'preset'; preset: DatePreset }
  | { kind: 'range'; from: string | null; through: string | null }

export type CustomRangeResult =
  | { ok: true; filter: RoadmapDateFilter }
  | { ok: false; reason: 'empty' | 'format' | 'order' }

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

// Built from calendar fields, never by adding 86400000: a civil day lasts 23 or
// 25 hours on a DST change, and the broker compares absolute instants.
function localMidnight(year: number, monthIndex: number, day: number): Date {
  const d = new Date(2000, 0, 1)
  d.setFullYear(year, monthIndex, day)
  d.setHours(0, 0, 0, 0)
  return d
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

export function formatLocalDay(d: Date): string {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function todayRange(now: Date): { since: string; before: string } {
  const start = localMidnight(now.getFullYear(), now.getMonth(), now.getDate())
  const end = localMidnight(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return { since: start.toISOString(), before: end.toISOString() }
}

export function parseLocalDay(text: string): Date | null {
  const m = DAY_RE.exec(text.trim())
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (year < 1 || month < 1 || month > 12 || day < 1) return null
  const d = localMidnight(year, month - 1, day)
  // Date rolls an impossible day into the next month instead of refusing it.
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null
  return d
}

/**
 * Rolling presets are sent as broker-relative durations, so every poll of
 * request B re-reads "the last 7 days" against the broker's clock; Today is a
 * civil day and is pinned at click time.
 */
export function presetDateFilter(
  field: RoadmapDateField,
  preset: DatePreset,
  now: Date
): RoadmapDateFilter {
  if (preset === 'today') return { field, ...todayRange(now) }
  return { field, since: preset }
}

/** A typed range whose `through` day is INCLUDED, turned into the broker's [since, before). */
export function customDateFilter(
  field: RoadmapDateField,
  fromText: string,
  throughText: string
): CustomRangeResult {
  const fromBlank = fromText.trim() === ''
  const throughBlank = throughText.trim() === ''
  if (fromBlank && throughBlank) return { ok: false, reason: 'empty' }
  const from = fromBlank ? null : parseLocalDay(fromText)
  const through = throughBlank ? null : parseLocalDay(throughText)
  if ((!fromBlank && !from) || (!throughBlank && !through)) return { ok: false, reason: 'format' }
  const before = through
    ? localMidnight(through.getFullYear(), through.getMonth(), through.getDate() + 1)
    : null
  if (from && before && from.getTime() >= before.getTime()) return { ok: false, reason: 'order' }
  if (from && before) {
    return { ok: true, filter: { field, since: from.toISOString(), before: before.toISOString() } }
  }
  if (from) return { ok: true, filter: { field, since: from.toISOString() } }
  return { ok: true, filter: { field, before: (before as Date).toISOString() } }
}

function parseIso(iso: string | undefined): Date | null {
  if (iso === undefined) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? new Date(ms) : null
}

/** A Today applied on an earlier day reads as its explicit day, not as Today. */
export function classifyDateFilter(date: RoadmapDateFilter, now: Date): DateFilterShape {
  if (date.before === undefined && (date.since === '7d' || date.since === '30d')) {
    return { kind: 'preset', preset: date.since }
  }
  const today = todayRange(now)
  if (
    date.since !== undefined &&
    date.before !== undefined &&
    Date.parse(date.since) === Date.parse(today.since) &&
    Date.parse(date.before) === Date.parse(today.before)
  ) {
    return { kind: 'preset', preset: 'today' }
  }
  const since = parseIso(date.since)
  const before = parseIso(date.before)
  const lastDay = before
    ? localMidnight(before.getFullYear(), before.getMonth(), before.getDate() - 1)
    : null
  return {
    kind: 'range',
    from: since ? formatLocalDay(since) : null,
    through: lastDay ? formatLocalDay(lastDay) : null
  }
}
