export const AVATAR_HEARTBEAT_MS = 5_000
export const AVATAR_SUSPECT_AFTER_MS = 15_000

export type AvatarFace = 'panne' | 'reclame' | 'perdu' | 'courrier' | 'travaille' | 'endormi' | 'seul'

export interface AvatarDeckIdentity {
  deckRunId: string
  broker_url: string
}

export interface AvatarDeckCounters {
  working: number
  idle: number
  unknown: number
  waiting: number
  exited: number
  rateLimited: number
}

export interface AvatarDeckSnapshot {
  identity: AvatarDeckIdentity
  counters: AvatarDeckCounters
  unread: number
}

export interface AvatarStateTiming {
  heartbeatMs: number
  suspectAfterMs: number
}

export interface AvatarStateOptions {
  now(): number
  heartbeatMs?: number
  suspectAfterMs?: number
}

export interface AvatarDeckStatus extends AvatarDeckSnapshot {
  suspect: boolean
  brokerReachable: boolean
  torchOut: boolean
}

export interface AvatarSummary {
  face: AvatarFace
  counters: AvatarDeckCounters
  unread: number
  decks: AvatarDeckStatus[]
}

interface StoredDeck {
  snapshot: AvatarDeckSnapshot
  lastStateAt: number
}

const ZERO_COUNTERS: AvatarDeckCounters = {
  working: 0,
  idle: 0,
  unknown: 0,
  waiting: 0,
  exited: 0,
  rateLimited: 0
}

function deckKey(identity: AvatarDeckIdentity): string {
  return JSON.stringify([identity.deckRunId, identity.broker_url])
}

function copySnapshot(snapshot: AvatarDeckSnapshot): AvatarDeckSnapshot {
  return {
    identity: { ...snapshot.identity },
    counters: { ...snapshot.counters },
    unread: snapshot.unread
  }
}

function addCounters(left: AvatarDeckCounters, right: AvatarDeckCounters): AvatarDeckCounters {
  return {
    working: left.working + right.working,
    idle: left.idle + right.idle,
    unknown: left.unknown + right.unknown,
    waiting: left.waiting + right.waiting,
    exited: left.exited + right.exited,
    rateLimited: left.rateLimited + right.rateLimited
  }
}

export class AvatarState {
  readonly timing: AvatarStateTiming
  private readonly decks = new Map<string, StoredDeck>()
  private readonly brokers = new Map<string, boolean>()

  constructor(private readonly options: AvatarStateOptions) {
    this.timing = {
      heartbeatMs: options.heartbeatMs ?? AVATAR_HEARTBEAT_MS,
      suspectAfterMs: options.suspectAfterMs ?? AVATAR_SUSPECT_AFTER_MS
    }
  }

  receiveSnapshot(snapshot: AvatarDeckSnapshot): void {
    this.decks.set(deckKey(snapshot.identity), {
      snapshot: copySnapshot(snapshot),
      lastStateAt: this.options.now()
    })
  }

  setBrokerReachable(brokerUrl: string, reachable: boolean): void {
    this.brokers.set(brokerUrl, reachable)
  }

  detach(identity: AvatarDeckIdentity): boolean {
    return this.decks.delete(deckKey(identity))
  }

  removeDeadDeck(identity: AvatarDeckIdentity, confirmedDead: boolean): boolean {
    return confirmedDead && this.detach(identity)
  }

  summary(): AvatarSummary {
    const now = this.options.now()
    const decks = [...this.decks.values()].map(({ snapshot, lastStateAt }) => {
      const suspect = now - lastStateAt >= this.timing.suspectAfterMs
      const brokerReachable = this.brokers.get(snapshot.identity.broker_url) ?? true
      return {
        ...copySnapshot(snapshot),
        suspect,
        brokerReachable,
        torchOut: suspect || !brokerReachable
      }
    })
    const counters = decks.reduce((total, deck) => addCounters(total, deck.counters), { ...ZERO_COUNTERS })
    const unread = decks.reduce((total, deck) => total + deck.unread, 0)

    if (decks.length === 0) return { face: 'seul', counters, unread, decks }
    if (decks.some((deck) => deck.torchOut)) return { face: 'panne', counters, unread, decks }
    if (counters.waiting > 0) return { face: 'reclame', counters, unread, decks }
    if (counters.exited > 0 || counters.rateLimited > 0) return { face: 'perdu', counters, unread, decks }
    if (unread > 0) return { face: 'courrier', counters, unread, decks }
    if (counters.working > 0) return { face: 'travaille', counters, unread, decks }
    return { face: 'endormi', counters, unread, decks }
  }
}
