// Pure geometry/severity helpers for the sidebar's context-fill ring
// (Sidebar.tsx -> ContextRing.tsx). No React/DOM import, so this loads
// under `bun test` from the repo root exactly like peer-table.ts.
//
// `contextPct` is `SessionLiveStatus.contextPct`: a percentage already
// clamped to [0, 100] main-side, or null (early in a session, or right
// after /compact). These helpers re-clamp defensively rather than trust
// that upstream guarantee, since a rendering helper is the last line before
// pixels -- a NaN or out-of-range value here must degrade to the same
// "unknown" reading as an honest null, never draw a bogus arc.

export type RingSeverity = 'unknown' | 'normal' | 'warn' | 'critical'

/** Clamp to [0, 100]; a non-finite input (NaN, ±Infinity) becomes 0. */
export function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0
  return Math.min(100, Math.max(0, pct))
}

/**
 * Severity band for the ring's colour. Thresholds mirror the amphora gauge's
 * 70/90 bands (DESIGN.md §2 / shared/usage.ts), read on the USED side here
 * (contextPct is "how full", the amphora's fraction is "how much is left").
 * null/NaN -> 'unknown': no reading yet, never guessed as 'normal'.
 */
export function ringSeverity(pct: number | null): RingSeverity {
  if (pct === null || Number.isNaN(pct)) return 'unknown'
  const p = clampPct(pct)
  if (p >= 90) return 'critical'
  if (p >= 70) return 'warn'
  return 'normal'
}

/**
 * SVG stroke-dasharray/-offset for a ring of the given circumference.
 * - A real percentage draws a SOLID arc, clockwise from 12 o'clock (pair
 *   with `transform="rotate(-90 …)"` on the circle so 0% starts at the top).
 * - null/NaN draws an evenly-dashed full ring (the "unknown" state) instead
 *   of a bogus 0%-filled arc, so "no reading yet" cannot be mistaken for
 *   "measured at 0%".
 */
export function ringDash(
  pct: number | null,
  circumference: number
): { dasharray: string; dashoffset: number } {
  if (pct === null || Number.isNaN(pct)) {
    const dash = circumference * 0.08
    return { dasharray: `${dash} ${dash}`, dashoffset: 0 }
  }
  const filled = (clampPct(pct) / 100) * circumference
  return { dasharray: `${circumference} ${circumference}`, dashoffset: circumference - filled }
}

/**
 * Compact token-count label: "200k", "1M", "1.5M". Mirrors how Claude Code's
 * own statusLine/CLI abbreviate context-window sizes, so the badge reads the
 * same unit the operator already knows. Negative/non-finite -> "0".
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${trimOneDecimal(n / 1_000_000)}M`
  if (n >= 1_000) return `${trimOneDecimal(n / 1_000)}k`
  return String(Math.round(n))
}

function trimOneDecimal(v: number): string {
  const rounded = Math.round(v * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}
