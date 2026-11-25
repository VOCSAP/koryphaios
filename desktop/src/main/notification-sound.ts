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
  /** Read only when a sound is about to play, never per poll tick. */
  appearance(): SoundAppearance
  now(): number
  /** True once the sound was handed to a live renderer; false when there is none to receive it. */
  play(kind: NotificationSoundKind): boolean
  report(text: string, err?: unknown): void
}

export interface NotificationSounder {
  noteApprovals(list: readonly SoundApproval[]): void
  noteAttention(): void
  /** The renderer subscribed to sounds: the one sound held before that is sent. */
  rendererReady(): void
  /** The renderer reloads or crashed: its listener is gone until the next ready signal. */
  rendererNotReady(): void
}

export const MIN_SOUND_GAP_MS = 1500

const KIND_RANK: Record<NotificationSoundKind, number> = { permission: 3, question: 2, attention: 1 }

/**
 * A tile's own approval is not counted here: its needs-you edge already rings,
 * and a second sound for the same wait would double it.
 */
function awaitsOperatorWithoutTile(approval: SoundApproval): boolean {
  const open = approval.status === 'pending' || approval.status === 'expired_notif'
  return open && approval.informational !== true && approval.origin.tile_ref === ''
}

export function createNotificationSounder(deps: NotificationSounderDeps): NotificationSounder {
  const signalled = new Set<string>()
  let lastPlayedAt = Number.NEGATIVE_INFINITY
  let ready = false
  let pending: NotificationSoundKind | null = null

  const hold = (kind: NotificationSoundKind): void => {
    if (pending === null || KIND_RANK[kind] > KIND_RANK[pending]) pending = kind
  }

  const muted = (): boolean => {
    if (!deps.enabled()) return true
    const appearance = deps.appearance()
    if (!appearance.sound) return true
    const until = appearance.dndUntil
    return until !== null && Number.isFinite(until) && until > deps.now()
  }

  const ring = (kind: NotificationSoundKind): void => {
    try {
      if (muted()) return
      if (!ready) return hold(kind)
      const now = deps.now()
      const elapsed = now - lastPlayedAt
      if (elapsed >= 0 && elapsed < MIN_SOUND_GAP_MS) return
      if (deps.play(kind)) {
        lastPlayedAt = now
        pending = null
      } else hold(kind)
    } catch (e) {
      deps.report('notification sound failed', e)
    }
  }

  return {
    noteApprovals(list) {
      const open = list.filter(awaitsOperatorWithoutTile)
      const openIds = new Set(open.map((a) => a.id))
      for (const id of signalled) if (!openIds.has(id)) signalled.delete(id)
      const fresh = open.filter((a) => !signalled.has(a.id))
      if (fresh.length === 0) return
      for (const a of fresh) signalled.add(a.id)
      ring(fresh.some((a) => a.kind === 'permission') ? 'permission' : 'question')
    },
    noteAttention() {
      ring('attention')
    },
    rendererNotReady() {
      ready = false
    },
    rendererReady() {
      ready = true
      const kind = pending
      pending = null
      if (kind !== null) ring(kind)
    }
  }
}
