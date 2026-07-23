// Directive cards (CT1/CT3): pure helpers mapping a directive command to its
// CODE-CONSTANT keystroke text and resolving a card's target_peer_ids against
// the live sessions. No electron/node imports so `bun test` covers it directly
// (same convention as dispatch.ts / workflow.ts).
//
// SECURITY (C8 / three-hostile-inputs #2): the keystroke text is a fixed code
// constant here; a directive card's payload only ever SELECTS which constant and
// which live tile — no broker/repo/peer string is ever typed into a PTY verbatim.

import type { RoadmapDirective, SessionRuntime } from '@shared/types'

/**
 * The keystroke text the Deck types for each directive. magic_compact types
 * /magic-compact; the availability + /compact fallback decision lives in the
 * executor (CT4), not here.
 */
export const DIRECTIVE_KEYS: Record<RoadmapDirective, string> = {
  clear: '/clear',
  compact: '/compact',
  magic_compact: '/magic-compact'
}

/** Peer-id charset guard mirroring the broker's PEER_ID_REGEX (defense in depth). */
const PEER_ID_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/

/** True when `cmd` is a known directive command (re-validates a broker value). */
export function isDirectiveCommand(cmd: unknown): cmd is RoadmapDirective {
  return typeof cmd === 'string' && Object.prototype.hasOwnProperty.call(DIRECTIVE_KEYS, cmd)
}

/** The keystroke text for a directive command. */
export function directiveKeys(cmd: RoadmapDirective): string {
  return DIRECTIVE_KEYS[cmd]
}

export interface DirectiveTargets {
  /** Live sessions matching the card's target_peer_ids (tile id + peerId). */
  matched: { id: string; peerId: string }[]
  /** Requested peer_ids with no live, non-exited, peer-resolved session. */
  missing: string[]
}

/**
 * Resolve a directive card's target_peer_ids against the current sessions:
 * well-formed ids mapping to a live (non-exited, peer-resolved) tile become
 * `matched`; every other requested id — malformed, dormant, or absent — is
 * `missing` so the caller can journal it (never a silent drop).
 */
export function resolveDirectiveTargets(
  targetPeerIds: string[],
  sessions: SessionRuntime[]
): DirectiveTargets {
  const live = sessions.filter((s) => s.status !== 'exited' && s.peerId)
  const matched: { id: string; peerId: string }[] = []
  const missing: string[] = []
  const seen = new Set<string>()
  for (const raw of targetPeerIds) {
    const p = raw.trim()
    if (seen.has(p)) continue
    seen.add(p)
    if (!PEER_ID_RE.test(p)) {
      missing.push(raw)
      continue
    }
    const hit = live.find((s) => s.peerId === p)
    if (hit) matched.push({ id: hit.id, peerId: p })
    else missing.push(p)
  }
  return { matched, missing }
}
