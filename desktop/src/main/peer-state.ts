export const PEER_POLL_MS = 4000

export interface TilePeerBinding {
  peer_id: string
  status: 'active' | 'dormant'
}

export interface TilePeerPollDeps {
  /** Every tile the Deck holds, live or not; ids and desk_session tokens are the same value. */
  tileIds(): string[]
  isAlive(id: string): boolean
  /** undefined once the tile is gone. */
  currentPeer(id: string): string | null | undefined
  /** Index-aligned with `deskSessions`; rejects on any broker failure. */
  fetch(deskSessions: string[]): Promise<(TilePeerBinding | null)[]>
  setPeer(id: string, next: string | null, previous: string | null): void
  report(error: unknown): void
}

/** The broker, not the local cache files, owns a tile's peer_id: descendants of a tile can rewrite those files. */
export class TilePeerPoller {
  private inFlight = false
  private failing = false

  constructor(private readonly deps: TilePeerPollDeps) {}

  /** Resolves true when at least one tile's peer changed. */
  async tick(): Promise<boolean> {
    if (this.inFlight) return false
    const live = this.deps.tileIds().filter((id) => this.deps.isAlive(id))
    this.inFlight = true
    let resolved: (TilePeerBinding | null)[] | null = null
    try {
      resolved = live.length ? await this.deps.fetch(live) : []
      this.failing = false
    } catch (e) {
      if (!this.failing) this.deps.report(e)
      this.failing = true
    } finally {
      this.inFlight = false
    }
    const answered = new Map<string, string | null>()
    resolved?.forEach((binding, i) => {
      const id = live[i]
      if (id !== undefined) answered.set(id, binding?.peer_id ?? null)
    })
    let changed = false
    for (const id of this.deps.tileIds()) {
      const previous = this.deps.currentPeer(id)
      if (previous === undefined) continue
      let next: string | null
      if (!this.deps.isAlive(id)) next = null
      else if (answered.has(id)) next = answered.get(id) ?? null
      else continue
      if (next !== previous) {
        this.deps.setPeer(id, next, previous)
        changed = true
      }
    }
    return changed
  }
}
