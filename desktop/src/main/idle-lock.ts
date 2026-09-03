// Pure slice of index.ts's Deck-side idle-lock watch (PLAN K2, card e344fa79
// lineage). index.ts imports electron, so nothing in it is unit-testable
// under bun -- this module holds no electron/node-pty import so its one rule
// gets an EXECUTABLE pin instead of resting on a comment a future
// simplification could silently defeat (same reason inbox-session.ts and
// approval-verdict.ts were extracted the same way).

/**
 * Fails closed on a null locked_group: releasing a lock nobody can attribute to
 * this Deck's group is the expensive mistake, skipping a sweep costs nothing.
 * locked_by alone is only unique per group, so this also requires the item's
 * own locked_group to match activeGroupId -- a homonym peer_id in a different
 * group could otherwise let this Deck release a lock it doesn't own.
 * @param activeGroupId read fresh on every tick since activeScope.groupId is
 * mutable at runtime (a restored workspace can adopt a different scope without
 * relaunching).
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
