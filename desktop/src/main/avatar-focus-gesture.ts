import type { AvatarAttachRequest } from '../shared/avatar-protocol'
import type { AvatarDeckIdentity } from '../shared/avatar-state'
import type { AvatarCommandResult } from './avatar-server'
import { logInfo, reportError } from './log'

export interface DeckFocusGestureDeps {
  platform: NodeJS.Platform
  attachedDecks(): AvatarAttachRequest[]
  isAlive(pid: number): boolean
  isDeckBound(identity: AvatarDeckIdentity): boolean
  /** The process owning the Deck's bound WebSocket; null when it cannot be told. Windows only. */
  socketOwnerPid(identity: AvatarDeckIdentity): Promise<number | null>
  allowForeground(pid: number): Promise<boolean>
  focusDeck(identity: AvatarDeckIdentity): Promise<AvatarCommandResult>
  report?: typeof reportError
  info?: typeof logInfo
}

/** False on EPERM too: a process this user may not signal is not a Deck of this user. */
export function deckProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function deckKey(identity: AvatarDeckIdentity): string {
  return JSON.stringify([identity.deckRunId, identity.broker_url])
}

export function createDeckFocusGesture(deps: DeckFocusGestureDeps): (identity: AvatarDeckIdentity) => Promise<void> {
  const report = deps.report ?? reportError
  const info = deps.info ?? logInfo
  const inFlight = new Set<string>()

  const run = async (identity: AvatarDeckIdentity): Promise<void> => {
    const deck = deps.attachedDecks().find((candidate) => deckKey(candidate) === deckKey(identity))
    if (!deck) {
      report('avatar-focus', `refused to focus Deck ${identity.deckRunId}: it is no longer attached`)
      return
    }
    if (!deps.isAlive(deck.deckPid)) {
      report('avatar-focus', `refused to focus Deck ${identity.deckRunId}: its process ${deck.deckPid} is not alive`)
      return
    }
    if (!deps.isDeckBound(identity)) {
      report('avatar-focus', `refused to focus Deck ${identity.deckRunId}: it is not bound to the Avatar`)
      return
    }
    if (deps.platform === 'win32') {
      let owner: number | null
      try {
        owner = await deps.socketOwnerPid(identity)
      } catch (error) {
        report('avatar-focus', `refused to focus Deck ${identity.deckRunId}: the owner of its WebSocket could not be read`, error)
        return
      }
      if (owner !== deck.deckPid) {
        report(
          'avatar-focus',
          `refused to focus Deck ${identity.deckRunId}: its WebSocket belongs to process ${owner ?? 'unknown'}, not to the declared ${deck.deckPid}`
        )
        return
      }
      if (!(await deps.allowForeground(deck.deckPid))) {
        report('avatar-focus', `could not cede the foreground to Deck ${identity.deckRunId}; its window may only flash`)
      }
    }
    try {
      const result = await deps.focusDeck(identity)
      if (result.ok) info('avatar-focus', `Deck ${identity.deckRunId} brought to front`)
      else report('avatar-focus', `Deck ${identity.deckRunId} refused the focus: ${result.error ?? 'no reason given'}`)
    } catch (error) {
      report('avatar-focus', `focus of Deck ${identity.deckRunId} failed`, error)
    }
  }

  return async (identity) => {
    const key = deckKey(identity)
    if (inFlight.has(key)) {
      report('avatar-focus', `refused to focus Deck ${identity.deckRunId}: a focus is already in flight`)
      return
    }
    inFlight.add(key)
    try {
      await run(identity)
    } finally {
      inFlight.delete(key)
    }
  }
}
