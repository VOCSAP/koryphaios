// Pure slice of index.ts's Deck-side idle-lock watch (PLAN K2, card e344fa79
// lineage). index.ts imports electron, so nothing in it is unit-testable
// under bun -- this module holds no electron/node-pty import so its one rule
// gets an EXECUTABLE pin instead of resting on a comment a future
// simplification could silently defeat (same reason inbox-session.ts and
// approval-verdict.ts were extracted the same way).

/**
 * Decides whether `watchIdleLocks` (index.ts) may auto-release a roadmap
 * card's work-lock because one of THIS Deck's own tiles looks like the idle
 * owner.
 *
 * `locked_by` alone is only unique PER GROUP (peers.UNIQUE(peer_id,
 * group_id) -- card e344fa79's finding): a legitimate homonym peer_id
 * registered in a DIFFERENT group on the same broker would otherwise satisfy
 * a bare `locked_by` comparison, letting a Deck in group A release a lock
 * that actually belongs to a peer in group B, silently and without any
 * human gesture. This predicate closes that gap by also requiring the
 * item's OWN `locked_group` to match this Deck's `activeGroupId`.
 *
 * FAILS CLOSED on `itemLockedGroup === null` (a row that predates this
 * column, or an otherwise-unresolved owner group): never auto-releases in
 * that case. This is the OPPOSITE of the broker's own `matchesLockOwner`
 * (shared/roadmap-lock.ts), which fails OPEN on the same null -- a
 * deliberate asymmetry (team-lead arbitration, card e344fa79 LOT D1):
 * skipping this Deck's opportunistic sweep on an unresolved row costs
 * nothing, because the broker's own TTL + owner-gone sweep still owns that
 * row regardless; releasing a lock nobody could positively attribute to
 * this Deck's own group would be the expensive, silent mistake.
 *
 * Reads `activeGroupId` as a plain argument rather than closing over
 * `activeScope` (index.ts): `activeScope.groupId` is MUTABLE at runtime (a
 * restored workspace can adopt a different scope without relaunching --
 * scope.ts's own "DESIGN 6.6" comment), so the caller must read it fresh on
 * every tick rather than this module capturing a stale value once.
 *
 * No startup gap despite that mutability: `activeScope` is initialized
 * SYNCHRONOUSLY at module load (index.ts's `let activeScope: Scope =
 * computeScope(...)`, always a non-empty secret), and `watchIdleLocks`'s
 * timer is only armed later (`lockWatchTimer = setInterval(...)`) -- there
 * is no tick where `activeGroupId` could be read before it exists.
 *
 * The identity pair this predicate compares (`candidatePeerId`,
 * `activeGroupId`) does NOT actually desynchronize despite `activeScope`
 * being mutable, for a reason nowhere written down before this comment --
 * via TWO different straps on the same underlying property (is this
 * session's PTY alive right now?), not one:
 * - FAST strap (instant, what actually closes the window): `toRuntime`
 *   (session-service.ts) computes `status` FRESH from `pty.isAlive(def.id)`
 *   on every single `.list()` call, never cached, and `watchIdleLocks`'s own
 *   `.find()` predicate checks `s.status !== 'exited'` before ever calling
 *   this function -- so a candidate reaching `ownsIdleLock` at all means its
 *   PTY is alive AT THAT EXACT SYNCHRONOUS CALL, which means
 *   `hasLiveSessions()` (`this.defs.some(d => this.pty.isAlive(d.id))`, the
 *   same primitive) would also read true if checked at that same moment --
 *   the very first line `adoptScope` (the SOLE writer of `activeScope`)
 *   checks before doing anything else (`if (service.hasLiveSessions())
 *   return`).
 * - SLOW strap (up to `PEER_POLL_MS` = 4s behind, session-service.ts): only
 *   `pollPeerIds` keeps `s.peerId` ITSELF pointing at the right identity over
 *   time -- it plays no part in whether this predicate ever runs; the FAST
 *   strap above alone gates that.
 * So any tick where a real candidate peerId reaches this function,
 * `activeScope` cannot have just been reassigned underneath it -- via the
 * fast strap, not the slow one. This chain breaks silently, with nothing to
 * redden it, the day `hasLiveSessions()`'s definition changes.
 */
export function ownsIdleLock(
  itemLockedBy: string | null,
  itemLockedGroup: string | null,
  candidatePeerId: string | null,
  activeGroupId: string
): boolean {
  // Defensive against a null-vs-null coincidence: a tile with no resolved
  // peer_id yet (SessionRuntime.peerId is nullable) must never read as
  // "owns" an unlocked item's absent locked_by.
  if (itemLockedBy === null || candidatePeerId === null) return false
  if (itemLockedBy !== candidatePeerId) return false
  if (itemLockedGroup === null) return false
  return itemLockedGroup === activeGroupId
}
