// Courrier lot 1B/1D (cards 54b1c71a / 1e81ee7b): the pure slice of index.ts's
// operator-inbox session lifecycle. Extracted for the same reason
// approval-verdict.ts was: index.ts imports electron, so nothing in it is
// unit-testable under bun -- this module holds no electron/node-pty import
// (node:crypto only) so its two rules get an EXECUTABLE pin instead of
// resting on a comment a future simplification could silently defeat.

import { randomUUID } from 'node:crypto'

/**
 * In-memory only, never persisted: a value written to disk would collide
 * between two Deck windows of the same OS account, which is a nominal case
 * here.
 * Re-minted on group change, not just at process launch, since the broker's
 * session upsert does not migrate a session_id's group_id on conflict --
 * reusing the same id across a group switch would silently read/write the wrong
 * group's cursor.
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
 * clearLocal runs unconditionally after the broker purge attempt, including
 * when purgeBroker rejects: purging broker-side without truncating the local
 * journal would leave dead entries on screen.
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
 * Filters to Number.isInteger elements: a non-integer id would otherwise no-op
 * silently both broker-side (deleted: 0) and locally (Set membership never
 * matches).
 * A non-empty input that filters down to nothing is `rejected: true`,
 * distinguishable from a genuinely empty input (`valid: [], rejected: false`).
 */
export function classifyInboxDeleteIds(raw: unknown): { valid: number[]; rejected: boolean } {
  if (!Array.isArray(raw)) return { valid: [], rejected: false }
  const valid = raw.filter((id): id is number => Number.isInteger(id))
  return { valid, rejected: raw.length > 0 && valid.length === 0 }
}
