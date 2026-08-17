// Courrier lot 1B/1D (cards 54b1c71a / 1e81ee7b): the pure slice of index.ts's
// operator-inbox session lifecycle. Extracted for the same reason
// approval-verdict.ts was: index.ts imports electron, so nothing in it is
// unit-testable under bun -- this module holds no electron/node-pty import
// (node:crypto only) so its two rules get an EXECUTABLE pin instead of
// resting on a comment a future simplification could silently defeat.

import { randomUUID } from 'node:crypto'

/**
 * Courrier lot 1B (card 54b1c71a, design doc section 6.2/6.1): mints the
 * cursor key the broker's operator_inbox_sessions table keys on. IN-MEMORY,
 * NEVER PERSISTED -- a value written to disk would collide between two Deck
 * windows of the same OS account, which is a NOMINAL case here (index.ts has
 * no requestSingleInstanceLock; store.ts already handles "already owned by
 * another live window").
 *
 * Re-minted on GROUP CHANGE, not merely at process launch: `getGroupId()`'s
 * underlying value (index.ts's `activeScope.groupId`) is MUTABLE at runtime
 * (index.ts's own "DESIGN 6.6" comment: a freshly-opened app can adopt a
 * restored workspace's scope without relaunching), and the frozen broker's
 * session upsert (broker.ts, handleOperatorInbox) does NOT migrate a
 * session_id's group_id on conflict -- it only refreshes last_seen_at.
 * Reusing the same session_id across a group switch would silently
 * read/write the WRONG group's cursor (message ids are a single global
 * autoincrement space, so a stale last_id from group A can accidentally skip
 * or misalign group B's rows). Re-minting per attachment sidesteps that gap
 * entirely without touching broker.ts.
 *
 * This is the rule tests/desktop-inbox-session.test.ts pins: a reader who
 * simplifies the body to an unconditional `return sessionId` reopens the gap
 * above, and that test reddens the moment they do.
 */
export function createInboxSessionTracker(getGroupId: () => string): () => string {
  let sessionId = randomUUID()
  let sessionGroupId = getGroupId()
  return function currentInboxSessionId(): string {
    const groupId = getGroupId()
    if (sessionGroupId !== groupId) {
      sessionId = randomUUID()
      sessionGroupId = groupId
    }
    return sessionId
  }
}

/**
 * Courrier lot 1D (card 1e81ee7b): the pure core of the session-scope purge.
 * `clearLocal` runs UNCONDITIONALLY after the broker purge attempt --
 * including when `purgeBroker` REJECTS. This is the half the purgeInboxSession
 * comment in index.ts names as the trap: purging broker-side without
 * truncating the local journal leaves dead entries ON SCREEN, so a broker
 * failure must never skip the local truncate (the two are independent
 * best-effort writers, not a single transaction).
 *
 * tests/desktop-inbox-session.test.ts pins this by injecting a `purgeBroker`
 * that rejects and asserting `clearLocal` still ran exactly once.
 */
export async function purgeInboxSessionCore(deps: {
  purgeBroker: () => Promise<void>
  clearLocal: () => void
  onPurgeError: (e: unknown) => void
}): Promise<void> {
  try {
    await deps.purgeBroker()
  } catch (e) {
    deps.onPurgeError(e)
  }
  deps.clearLocal()
}

/**
 * Courrier lot 1E (card 1e81ee7b), hardening follow-up: `inbox:delete`'s IPC
 * payload is a hostile input (renderer/companion-supplied array, CLAUDE.md's
 * five-hostile-input table) -- the handler used to check it WAS an array but
 * never validated its ELEMENTS, so string-shaped ids silently no-op both
 * broker-side (`deleted: 0`, no error) and locally (Set membership never
 * matches): a "delete this one" gesture that visibly does nothing.
 *
 * Filters to `Number.isInteger` elements. The one case this does NOT resolve
 * silently: a NON-EMPTY input that filters down to nothing (every element
 * invalid) is `rejected: true`, distinguishable from a genuinely empty input
 * (`valid: [], rejected: false`, the existing 0-effect no-op). DECISION,
 * written down per the team-lead's ask: the broker was separately patched to
 * answer 400 for this exact shape ("ids non-empty, none valid") -- but this
 * function's caller (ipc.ts) does NOT forward an emptied array to let that
 * fire; it rejects HERE instead, so exactly one layer answers this case
 * rather than both silently agreeing to a no-op. See ipc.ts's regHandle
 * ('inbox:delete', ...) for the reportError trace + promise rejection this
 * decision produces.
 */
export function classifyInboxDeleteIds(raw: unknown): { valid: number[]; rejected: boolean } {
  if (!Array.isArray(raw)) return { valid: [], rejected: false }
  const valid = raw.filter((id): id is number => Number.isInteger(id))
  return { valid, rejected: raw.length > 0 && valid.length === 0 }
}
