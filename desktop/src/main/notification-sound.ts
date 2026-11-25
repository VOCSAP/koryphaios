import type { NotificationSoundKind } from '../shared/types'

export interface SoundApproval {
  id: string
  kind: string
  status: string
  informational?: boolean
  origin: { tile_ref: string }
}

export interface SoundAppearance {
  sound: boolean
  dndUntil: number | null
}

export interface NotificationSounderDeps {
  enabled(): boolean
  /** Read only when a sound is requested or about to play, never per poll tick. */
  appearance(): SoundAppearance
  now(): number
  /** True once the sound was handed to a live renderer; false when there is none to receive it. */
  play(kind: NotificationSoundKind): boolean
  later(delayMs: number, run: () => void): void
  report(text: string, err?: unknown): void
}

export interface NotificationSounder {
  /** Every successful poll, and before the needs-you edges that list raises. */
  noteApprovals(list: readonly SoundApproval[]): void
  noteAttention(tileId: string): void
  /**
   * A tile's needs-you edge. The approval row behind it may still be on its way,
   * so `refresh` runs until a row of the tile exists or the tile stops waiting;
   * attention rings only if neither happened after ATTENTION_WAIT_MS.
   */
  noteNeedsYou(tileId: string, refresh: () => Promise<unknown>, stillWaiting: () => boolean): void
  /** The tile stopped waiting: an attention sound held for it is dropped. */
  noteAttentionCleared(tileId: string): void
  /** No list can be read, so no tile counts as waiting on a row. */
  approvalsUnavailable(): void
  /** The renderer subscribed to sounds: the one sound held before that is sent. */
  rendererReady(): void
  /** The renderer reloads or crashed: its listener is gone until the next ready signal. */
  rendererNotReady(): void
}

export const MIN_SOUND_GAP_MS = 1500
export const ATTENTION_WAIT_MS = 5000
/** A hook row lands within a few hundred ms: short enough to ring it promptly, ten polls at most per wait. */
export const ATTENTION_POLL_MS = 500

type RowKind = Exclude<NotificationSoundKind, 'attention'>

function awaitsOperator(approval: SoundApproval): boolean {
  const open = approval.status === 'pending' || approval.status === 'expired_notif'
  return open && approval.informational !== true
}

export function createNotificationSounder(deps: NotificationSounderDeps): NotificationSounder {
  const signalled = new Set<string>()
  let waitingTiles = new Set<string>()
  // What a sound not yet played is about: its kind is derived when it plays.
  const heldRows = new Map<string, RowKind>()
  const heldTiles = new Set<string>()
  let lastPlayedAt = Number.NEGATIVE_INFINITY
  let ready = false
  let timerArmed = false

  const heldKind = (): NotificationSoundKind | null => {
    if (heldRows.size > 0) return [...heldRows.values()].includes('permission') ? 'permission' : 'question'
    return heldTiles.size > 0 ? 'attention' : null
  }

  const dropHeld = (): void => {
    heldRows.clear()
    heldTiles.clear()
  }

  const muted = (): boolean => {
    if (!deps.enabled()) return true
    const appearance = deps.appearance()
    if (!appearance.sound) return true
    const until = appearance.dndUntil
    return until !== null && Number.isFinite(until) && until > deps.now()
  }

  const guarded = (run: () => void): void => {
    try {
      run()
    } catch (e) {
      deps.report('notification sound failed', e)
    }
  }

  const deliver = (): void => {
    const kind = heldKind()
    if (!ready || timerArmed || kind === null) return
    const now = deps.now()
    const elapsed = now - lastPlayedAt
    if (elapsed >= 0 && elapsed < MIN_SOUND_GAP_MS) {
      deps.later(MIN_SOUND_GAP_MS - elapsed, onTimer)
      timerArmed = true
      return
    }
    const rows = [...heldRows]
    const tiles = [...heldTiles]
    dropHeld()
    if (deps.play(kind)) {
      lastPlayedAt = now
      return
    }
    for (const [id, rowKind] of rows) heldRows.set(id, rowKind)
    for (const tile of tiles) heldTiles.add(tile)
  }

  /** A held sound is judged again: Do Not Disturb may have started while it waited. */
  const resume = (): void => {
    if (heldKind() === null) return
    if (muted()) dropHeld()
    else deliver()
  }

  function onTimer(): void {
    timerArmed = false
    guarded(resume)
  }

  /** False when the sound was neither queued nor silenced on purpose, so the caller asks again. */
  const request = (queue: () => void): boolean => {
    try {
      if (muted()) return true
      queue()
    } catch (e) {
      deps.report('notification sound failed', e)
      return false
    }
    guarded(deliver)
    return true
  }

  const noteAttention = (tileId: string): void => {
    if (!waitingTiles.has(tileId)) request(() => heldTiles.add(tileId))
  }

  return {
    noteApprovals(list) {
      const open = list.filter(awaitsOperator)
      waitingTiles = new Set(open.map((a) => a.origin.tile_ref).filter((tile) => tile !== ''))
      const openIds = new Set(open.map((a) => a.id))
      for (const id of signalled) if (!openIds.has(id)) signalled.delete(id)
      for (const id of heldRows.keys()) if (!openIds.has(id)) heldRows.delete(id)
      for (const tile of heldTiles) if (waitingTiles.has(tile)) heldTiles.delete(tile)
      const fresh = open.filter((a) => !signalled.has(a.id))
      if (fresh.length === 0) return
      const queued = request(() => {
        for (const a of fresh) heldRows.set(a.id, a.kind === 'permission' ? 'permission' : 'question')
      })
      if (queued) for (const a of fresh) signalled.add(a.id)
    },
    noteAttention,
    noteNeedsYou(tileId, refresh, stillWaiting) {
      let done = false
      let reported = false
      const deadline = (): void => {
        if (done) return
        done = true
        guarded(() => {
          if (stillWaiting()) noteAttention(tileId)
        })
      }
      const check = (): void => {
        guarded(() => {
          if (done) return
          if (waitingTiles.has(tileId) || !stillWaiting()) done = true
          else deps.later(ATTENTION_POLL_MS, poll)
        })
      }
      function poll(): void {
        if (done) return
        // A later microtask: whatever raises the row in answer to this edge has started by then.
        void Promise.resolve()
          .then(refresh)
          .then(check, (e: unknown) => {
            if (!reported) deps.report('notification sound could not wait for the approvals', e)
            reported = true
            check()
          })
      }
      guarded(() => deps.later(ATTENTION_WAIT_MS, deadline))
      poll()
    },
    noteAttentionCleared(tileId) {
      heldTiles.delete(tileId)
    },
    approvalsUnavailable() {
      waitingTiles = new Set()
    },
    rendererNotReady() {
      ready = false
    },
    rendererReady() {
      ready = true
      guarded(resume)
    }
  }
}
