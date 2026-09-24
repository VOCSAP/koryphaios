// Codec for the per-tile statusLine report file. The Deck's statusLine script
// (hooks/desk-statusline.ts) encodes Claude Code's statusLine stdin payload
// into `desk-status-<token>.json`; Deck main decodes it on its peer poll.
// Pure (no node/electron import) so both the bun-bundled hook and main use it.
//
// The file lives in the peers dir, which is mounted into sandbox containers:
// its content is attacker-controlled, so decoding rejects rather than repairs.

import type { SessionLiveStatus } from './types'

export const STATUS_FILE_VERSION = 1

/** Hard cap on the raw file size read back; a genuine report is ~150 bytes. */
export const STATUS_FILE_MAX_BYTES = 4096

/** Largest context window accepted, in tokens. */
export const STATUS_MAX_CONTEXT_WINDOW = 10_000_000

const MODEL_RE = /^[A-Za-z0-9 ._()[\]:/-]{1,64}$/

/**
 * Same rule as shared/peer-cache.ts `sanitizeSessionId` and main's
 * desk-session.ts `sanitizeToken` (non-[A-Za-z0-9-] to '_', cap 64), duplicated
 * because peer-cache imports node:fs; parity is asserted by a test.
 */
export function sanitizeStatusToken(token: string | undefined | null): string {
  if (!token) return ''
  const clean = token.replace(/[^A-Za-z0-9-]/g, '_')
  return clean.length > 64 ? clean.slice(0, 64) : clean
}

/** `desk-status-<sanitized token>.json`, or '' when the token sanitizes to nothing. */
export function statusFileName(token: string | undefined | null): string {
  const safe = sanitizeStatusToken(token)
  return safe ? `desk-status-${safe}.json` : ''
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validModel(v: unknown): string | null {
  return typeof v === 'string' && MODEL_RE.test(v) ? v : null
}

/** null unless a finite number; clamped to [0, 100]. */
function validPct(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(100, Math.max(0, v))
}

function validSize(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) return null
  return v > 0 && v <= STATUS_MAX_CONTEXT_WINDOW ? v : null
}

/**
 * Build the file content from a statusLine stdin payload, or null when the
 * payload carries no usable model (nothing worth writing). Applies the same
 * rules as the decoder so the writer never produces a file main would reject.
 */
export function encodeStatusFromPayload(payload: unknown, now: number): string | null {
  if (!isRecord(payload) || !isRecord(payload.model)) return null
  if (!Number.isFinite(now) || now <= 0) return null
  const modelId = validModel(payload.model.id)
  const model = validModel(payload.model.display_name) ?? modelId
  if (!modelId || !model) return null
  const ctx = isRecord(payload.context_window) ? payload.context_window : {}
  return JSON.stringify({
    v: STATUS_FILE_VERSION,
    model_id: modelId,
    model,
    pct: validPct(ctx.used_percentage),
    size: validSize(ctx.context_window_size),
    at: now
  })
}

/**
 * Strict decode of a status file. Returns null when the content is oversized,
 * not JSON, of another version, or when model / model_id / at fail validation.
 * pct and size degrade to null individually when invalid.
 */
export function decodeStatusFile(raw: string): SessionLiveStatus | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > STATUS_FILE_MAX_BYTES) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Callers treat null as "no report"; a torn or tampered file is exactly that.
    return null
  }
  if (!isRecord(parsed) || parsed.v !== STATUS_FILE_VERSION) return null
  const model = validModel(parsed.model)
  const modelId = validModel(parsed.model_id)
  const at = parsed.at
  if (!model || !modelId) return null
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null
  return {
    model,
    modelId,
    contextPct: validPct(parsed.pct),
    contextWindow: validSize(parsed.size),
    at
  }
}

/**
 * Structural equality on the displayed fields, so the poll broadcasts only on
 * a visible change. `at` is left out: the statusLine rewrites it on every
 * refresh, and comparing it would broadcast the whole session list each tick.
 */
export function sameLiveStatus(a: SessionLiveStatus | null, b: SessionLiveStatus | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.model === b.model &&
    a.modelId === b.modelId &&
    a.contextPct === b.contextPct &&
    a.contextWindow === b.contextWindow
  )
}
