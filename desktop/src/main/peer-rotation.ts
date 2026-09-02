// Pure module (no electron / node-pty import), so bun test exercises both the
// rotation decision and the exact text the Deck sends.
// Detecting a rotation was never the gap — pollPeerIds already compares next
// !== r.peerId on every tick — what was missing was the announce itself, which
// fired only on first resolution rather than on every rotation.
// Declares its own types rather than extending JoinAnnounceIntent, since a
// rotation carries no agent/model/effort intent and widening a shared type for
// it would couple two unrelated events.
// The wording is composed here too, not at the call site, because a source scan
// proves which symbols a caller reads but is blind to how it composes a
// message.

/** Why nothing is announced, kept explicit so a silent path is never guessed at. */
export type PeerAnnounceSilentReason =
  /** The id did not actually change (pollPeerIds runs on a timer). */
  | 'unchanged'
  /**
   * The tile lost its id (PTY gone, resolution lost). PRESCRIBED to stay
   * silent: an announce naming an empty id would be BELIEVED, which is worse
   * than today's silence.
   */
  | 'disappeared'
  /**
   * First resolution of a session that carries no join intent -- a restored
   * or resumed tile, already announced in a previous life.
   */
  | 'first-resolution-without-intent'

/**
 * 'join' = the pre-existing first-resolution path, unchanged (the caller keeps
 * dispatching its join announce with the intent it already holds). 'rotation'
 * = the new case, carrying the ready-to-send text. 'silent' = send nothing.
 */
export type PeerAnnounceDecision =
  | { kind: 'join' }
  | { kind: 'rotation'; text: string }
  | { kind: 'silent'; reason: PeerAnnounceSilentReason }

export interface PeerAnnounceInput {
  /** The id this tile answered to before this tick; null on first resolution. */
  previousPeerId: string | null
  /** The id it answers to now; null when the tile lost its id. */
  nextPeerId: string | null
  /** Tile name, so a reader can tell WHICH tile moved without cross-referencing. */
  tileName: string
  /** Whether a one-shot join intent is still pending for this tile. */
  hasJoinIntent: boolean
}

/**
 * Trailer mirroring JOIN_NO_REPLY_NOTE (shared/announce.ts): without it,
 * agents treat any inbound announce as a message to answer, and the channel
 * instructions ("respond immediately to peer messages") actively encourage
 * that reflex. A rotation notice is strictly informational -- what a reader
 * must do with it is UPDATE THE ID THEY ADDRESS, not reply to it.
 */
export const ROTATION_NO_REPLY_NOTE =
  'Notification only: do NOT reply. Address that tile by its NEW peer_id from now on; messages to the old id are delivered to no one and raise no error.'

/**
 * The rotation announce text. Names the tile AND both ids: the old one so a
 * reader can match it against whatever id they were addressing, the new one so
 * they can correct it. Naming only the new id would leave every reader to
 * guess which of their correspondents just went silent.
 */
export function composePeerRotationAnnounce(
  tileName: string,
  previousPeerId: string,
  nextPeerId: string
): string {
  const who = tileName.trim() || 'a tile'
  return `Peer id changed: "${who}" now answers to "${nextPeerId}" (was "${previousPeerId}").\n${ROTATION_NO_REPLY_NOTE}`
}

/**
 * Decide what (if anything) to announce for one peer_id transition. Four
 * cases, in the order that makes each one unreachable by the wrong branch:
 * disappearance first (it is the one that MUST stay silent), then no-change,
 * then first resolution (existing behaviour), then rotation.
 */
export function decidePeerAnnounce(input: PeerAnnounceInput): PeerAnnounceDecision {
  const { previousPeerId, nextPeerId, tileName, hasJoinIntent } = input
  // Truthiness, not `=== null`, on BOTH ids (card 6f59c73a, review round 1).
  // The contract above is stated in terms of "the tile LOST its id", and an
  // EMPTY STRING is that too -- but `=== null` let it through, and the
  // measured output was `now answers to ""`, verbatim the announce naming an
  // empty id that the 'disappeared' doc declares prescribed against. Not
  // reachable from today's only caller (its emit sits under `if (next)`, and
  // r.peerId only ever holds null or a truthy value), but this module is PURE
  // and EXPORTED: its guarantee has to hold for the values its own type
  // admits, not only for those one caller happens to pass.
  if (!nextPeerId) return { kind: 'silent', reason: 'disappeared' }
  if (previousPeerId === nextPeerId) return { kind: 'silent', reason: 'unchanged' }
  if (!previousPeerId) {
    return hasJoinIntent ? { kind: 'join' } : { kind: 'silent', reason: 'first-resolution-without-intent' }
  }
  return { kind: 'rotation', text: composePeerRotationAnnounce(tileName, previousPeerId, nextPeerId) }
}
