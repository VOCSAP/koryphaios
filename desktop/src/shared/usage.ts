// Amphora-gauge math (usage limits): pure helpers shared by the nav rail
// (fill level + tone of the amphora glyph) and the bun test suite. The gauge
// reads the REMAINING side of the session (5 h) windows: the jar empties as
// the quota burns.
//
// Pure module — no node/electron imports.

import type { UsageProviderReport, UsageSnapshot } from './types'

/** Mean remaining fraction (0..1) of a provider's session windows, or null. */
function providerSessionRemaining(report: UsageProviderReport): number | null {
  if (report.status !== 'ok') return null
  const sessions = report.windows.filter((w) => w.key === 'session')
  if (sessions.length === 0) return null
  const sum = sessions.reduce((acc, w) => acc + (100 - w.usedPercent), 0)
  return Math.min(1, Math.max(0, sum / sessions.length / 100))
}

/**
 * Fill level of the amphora: the mean remaining session quota over the
 * providers this run actually uses (snapshot.usedProviders), falling back to
 * every reporting provider when nothing was marked yet. Null = no gauge data
 * at all (static amphora).
 */
export function sessionRemainingFraction(snapshot: UsageSnapshot): number | null {
  const reporting = snapshot.providers.filter((p) => providerSessionRemaining(p) !== null)
  const used = reporting.filter((p) => snapshot.usedProviders.includes(p.provider))
  const pool = used.length > 0 ? used : reporting
  if (pool.length === 0) return null
  const sum = pool.reduce((acc, p) => acc + (providerSessionRemaining(p) ?? 0), 0)
  return sum / pool.length
}

export type UsageTone = 'ok' | 'warn' | 'hot'

/** Colour tone for a remaining fraction: mirrors the modal's 70/90 % bands. */
export function usageTone(remaining: number): UsageTone {
  if (remaining <= 0.1) return 'hot'
  if (remaining <= 0.3) return 'warn'
  return 'ok'
}
