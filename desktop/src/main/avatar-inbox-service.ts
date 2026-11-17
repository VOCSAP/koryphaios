import type {
  AvatarInboxAction,
  AvatarInboxContent,
  AvatarInboxSnapshotFrame,
  InboxOutcome
} from '../shared/avatar-inbox-protocol'
import type { AvatarDeckIdentity } from '../shared/avatar-state'
import type { AvatarCommandResult, AvatarInboxSink } from './avatar-server'
import type { reportError } from './log'

/**
 * What a gesture became. 'busy' is a second gesture on an id already in
 * flight, 'unknown' an id the Deck's last snapshot does not hold, 'failed' a
 * gesture the Deck could not carry out.
 */
export type AvatarInboxGestureResult =
  | { outcome: InboxOutcome; reason?: string }
  | { outcome: 'busy' | 'unknown' | 'failed' }

export interface AvatarInboxBox extends AvatarInboxContent {
  identity: AvatarDeckIdentity
  scopeGeneration: number
  /** Ids this Avatar settled since the snapshot; the next snapshot is authoritative. */
  settledLocally: ReadonlySet<string>
}

export interface AvatarInboxServiceOptions {
  send(identity: AvatarDeckIdentity, action: AvatarInboxAction): Promise<AvatarCommandResult>
  report: typeof reportError
  changed?(): void
}

export interface AvatarInboxService extends AvatarInboxSink {
  boxes(): AvatarInboxBox[]
  act(identity: AvatarDeckIdentity, action: AvatarInboxAction): Promise<AvatarInboxGestureResult>
}

interface Box {
  identity: AvatarDeckIdentity
  frame: AvatarInboxSnapshotFrame
  settledLocally: Set<string>
}

function deckKey(identity: AvatarDeckIdentity): string {
  return JSON.stringify([identity.deckRunId, identity.broker_url])
}

/** In memory only: a box lives while its Deck's socket is bound, and nothing reaches the disk. */
export function createAvatarInboxService(options: AvatarInboxServiceOptions): AvatarInboxService {
  const boxes = new Map<string, Box>()
  const inFlight = new Set<string>()

  return {
    receive(identity, frame) {
      boxes.set(deckKey(identity), { identity, frame, settledLocally: new Set() })
      options.changed?.()
    },
    clear(identity) {
      if (boxes.delete(deckKey(identity))) options.changed?.()
    },
    boxes() {
      return [...boxes.values()].map((box) => ({
        identity: box.identity,
        scopeGeneration: box.frame.scope_generation,
        approvals: box.frame.approvals,
        messages: box.frame.messages,
        closed: box.frame.closed,
        truncated: box.frame.truncated,
        settledLocally: new Set(box.settledLocally)
      }))
    },
    async act(identity, action) {
      const key = deckKey(identity)
      const box = boxes.get(key)
      if (!box || !box.frame.approvals.some((approval) => approval.id === action.approval_id)) return { outcome: 'unknown' }
      const flight = JSON.stringify([key, action.approval_id])
      if (inFlight.has(flight)) return { outcome: 'busy' }
      inFlight.add(flight)
      try {
        const result = await options.send(identity, action)
        if (!result.ok || result.outcome === undefined) {
          options.report('avatar-inbox', `the Deck could not carry out the ${action.action} gesture (${result.error ?? 'no outcome'})`)
          return { outcome: 'failed' }
        }
        if (result.outcome === 'won') {
          boxes.get(key)?.settledLocally.add(action.approval_id)
          options.changed?.()
        }
        return { outcome: result.outcome, ...(result.reason === undefined ? {} : { reason: result.reason }) }
      } catch (error) {
        options.report('avatar-inbox', `the ${action.action} gesture did not reach the Deck`, error)
        return { outcome: 'failed' }
      } finally {
        inFlight.delete(flight)
      }
    }
  }
}
