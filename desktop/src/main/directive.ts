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
  /** Requested peer_ids with no single live, non-exited, peer-resolved session -- absent, dormant, malformed, or matching SEVERAL live tiles. */
  missing: string[]
  /**
   * Subset of `missing`: peer_ids that resolved to MORE THAN ONE live tile
   * (see the collision guard below). A detail of WHY an id is missing, not a
   * competing bucket -- every entry here is also in `missing`, which stays
   * complete and unchanged so a caller reading only `{matched, missing}`
   * (both current callers, today) sees no behaviour change. Lets a caller
   * that wants to say "ambiguous" rather than "unknown" do so by reading
   * this field, instead of re-deriving liveness/counting itself.
   */
  ambiguous: string[]
}

/**
 * Resolve a directive card's target_peer_ids against the current sessions:
 * well-formed ids mapping to EXACTLY ONE live (non-exited, peer-resolved)
 * tile become `matched`; every other requested id — malformed, dormant,
 * absent, or ambiguous (see below) — is `missing` so the caller can journal
 * it (never a silent drop).
 *
 * Deliberately no owner/authority dimension: this resolver only maps a
 * peer_id to a live tile, it never asks whether the card's author may act
 * on that tile. That question WAS put to the operator on 2026-08-25 and he
 * decided NOT to treat it -- risk accepted explicitly, see
 * docs/DESIGN-QUEUE-WRITE-AUTHORITY.md section 4 ("Le cas `directive` a ete
 * arbitre, ne pas le rouvrir"). No AUTHORITY check enforces it anywhere
 * today, broker included; a guard here would reopen a closed arbitrage in
 * the wrong layer.
 */
export function resolveDirectiveTargets(
  targetPeerIds: string[],
  sessions: SessionRuntime[]
): DirectiveTargets {
  const live = sessions.filter((s) => s.status !== 'exited' && s.peerId)
  // Peer-id collision guard (measured 2026-08-27: two live tiles can share a
  // peerId). Array.find would silently pick the first match and let a
  // destructive directive (e.g. clear) hit an unintended tile. Count live
  // tiles per peerId up front so a duplicate fails CLOSED into `missing`
  // instead of being picked -- `ambiguous` only annotates WHY within that
  // same bucket, both existing callers still see a complete, unchanged
  // `missing`. Counting is scoped to `live` on purpose: an `exited` tile
  // sharing an id with a live one is not a collision.
  const liveCounts = new Map<string, number>()
  for (const s of live) {
    // `live`'s filter predicate is not a type guard, so `s.peerId` is still
    // `string | null` here -- guard explicitly rather than assert it away
    // (same discipline as broadcastStop's settled-array guard, agent-stop.ts).
    // Unreachable today (the filter above already requires a truthy peerId);
    // it exists so the count stays correct if that filter ever loosens.
    const id = s.peerId
    if (!id) continue
    liveCounts.set(id, (liveCounts.get(id) ?? 0) + 1)
  }
  const matched: { id: string; peerId: string }[] = []
  const missing: string[] = []
  const ambiguous: string[] = []
  const seen = new Set<string>()
  for (const raw of targetPeerIds) {
    const p = raw.trim()
    if (seen.has(p)) continue
    seen.add(p)
    if (!PEER_ID_RE.test(p)) {
      missing.push(raw)
      continue
    }
    if ((liveCounts.get(p) ?? 0) > 1) {
      missing.push(p)
      ambiguous.push(p)
      continue
    }
    const hit = live.find((s) => s.peerId === p)
    if (hit) matched.push({ id: hit.id, peerId: p })
    else missing.push(p)
  }
  return { matched, missing, ambiguous }
}
